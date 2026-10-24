import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { ResultDto, ReviewResultDto } from "../../src/agent/contract";
import type { ReviewPull } from "../../src/tasks/user-do";
import { getFakeApp, UNIT_REPO, type UnitGitHubEnv } from "../support/unit-github";
import { fakeAgent, newTaskId, taskStub } from "./helpers";

// TaskDO の task_review（kind: review）。ブランチ・初期コミット・Draft PR を作らず、クライアントの PR の差分を取って
// AgentDO にレビューの段を頼み、返った本文を PR のレビュー（event: COMMENT）として投稿する。PR の状態は変えない。

const OWNER = 702;
const REPO = UNIT_REPO.fullName;
const BASE = "0123456789abcdef0123456789abcdef01234567";
const app = () => getFakeApp(env as unknown as UnitGitHubEnv);
type TaskStub = ReturnType<typeof taskStub>;

function rows<T>(stub: TaskStub, sql: string, ...b: unknown[]): Promise<T[]> {
  return runInDurableObject(
    stub,
    (_i, state) => state.storage.sql.exec(sql, ...b).toArray() as T[],
  );
}
const eventsOf = async (stub: TaskStub, type: string) =>
  (await rows<{ payload: string }>(stub, "SELECT payload FROM events WHERE type = ?", type)).map(
    (e) => JSON.parse(e.payload) as Record<string, unknown>,
  );

let seq = 0;
async function clientPull() {
  const branch = `feature/review-task-${++seq}-${Date.now()}`;
  const head = await app().addCommit(REPO, BASE, `client work ${branch}`);
  app().setBranch(REPO, "main", BASE);
  app().setBranch(REPO, branch, head);
  const number = app().seedPull(REPO, {
    head: branch,
    base: "main",
    title: "Fix sum",
    body: "please review @octocat",
    draft: false,
  });
  app().seedDiff(REPO, BASE, head, "diff --git a/src/sum.ts b/src/sum.ts\n+fixed\n");
  const pull: ReviewPull = {
    number,
    url: `https://github.test/${REPO}/pull/${number}`,
    headSha: head,
    headRef: branch,
    baseSha: BASE,
    baseRef: "main",
    title: "Fix sum",
    body: "please review @octocat",
    draft: false,
  };
  return { branch, head, number, pull };
}

async function createReview(over: Record<string, unknown> = {}) {
  const p = await clientPull();
  const id = newTaskId();
  const stub = taskStub(id);
  const input = {
    task_id: id,
    owner_id: OWNER,
    owner_login: "alice",
    repository_id: UNIT_REPO.id,
    installation_id: UNIT_REPO.installationId,
    repository: REPO,
    pull_number: p.number,
    review_model: "anthropic/claude-sonnet-5-5",
    review_commands: [{ argv: ["pnpm", "test"], timeout_seconds: 900 }],
    budget_policy: "stop" as const,
    pull: p.pull,
    ...over,
  };
  const r = await stub.ensureReviewCreated(input);
  if (!r.ok) throw new Error(`ensureReviewCreated failed: ${r.code}`);
  return { ...p, id, stub, agent: fakeAgent(id), input };
}

const review = (over: Partial<ReviewResultDto> = {}): ReviewResultDto => ({
  stage: "done",
  model: "anthropic/claude-sonnet-5-5",
  headSha: "x",
  body: "## rovo のレビュー\n\n直すべき点（1 件）",
  mustFixCount: 1,
  suggestionCount: 2,
  commands: [{ argv: ["pnpm", "test"], exitCode: 1, timedOut: false, output: "1 failed" }],
  commandsUnavailable: false,
  usage: {
    costUsd: 0.02,
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    estimated: false,
  },
  ...over,
});

function reviewResult(
  status: "completed" | "failed" | "budget_exceeded",
  rv: ReviewResultDto | undefined,
  over: Record<string, unknown> = {},
): ResultDto {
  return {
    status,
    summary: "",
    verification: { commands: [], results: [], verified: false, attempts: 0 },
    warnings: [],
    patchTooLarge: false,
    usage: {
      costUsd: 0.02,
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      web: { search: 0, fetch: 0, browse: 0 },
    },
    ...(rv ? { review: rv } : {}),
    ...over,
  } as ResultDto;
}

async function finish(
  t: Awaited<ReturnType<typeof createReview>>,
  result: ResultDto,
  phase: "completed" | "failed" | "budget_exceeded" = "completed",
) {
  await t.agent.setProgram({ result });
  await t.agent.setPhase(phase);
  await t.stub.advance();
}

describe("TaskDO: task_review（kind: review）", () => {
  it("準備では作業ブランチ・初期コミット・Draft PR を作らず、差分を取って AgentDO にレビューの段を頼む", async () => {
    const t = await createReview();
    const pullsBefore = app().pulls(REPO).length;
    await t.stub.advance();
    const calls = await t.agent.calls();
    expect(calls.start).toBe(1);
    const spec = calls.specs[0];
    expect(spec).toMatchObject({
      kind: "review",
      branch: "",
      initialSha: t.head,
      repository: REPO,
      instructions: `Review pull request ${REPO}#${t.number} at ${t.head}.`,
      review: {
        pullNumber: t.number,
        headSha: t.head,
        baseSha: BASE,
        model: "anthropic/claude-sonnet-5-5",
        commands: [{ argv: ["pnpm", "test"], timeoutSeconds: 900 }],
        title: "Fix sum",
        body: "please review @octocat",
        diff: "diff --git a/src/sum.ts b/src/sum.ts\n+fixed\n",
        diffTruncated: false,
      },
    });
    expect(spec?.gitCredential.token).toMatch(/^ghs_/);
    // GitHub 側: ブランチも PR も増えない（クライアントの PR に書き込まない）
    expect(app().pulls(REPO).length).toBe(pullsBefore);
    expect(app().branch(REPO, `agent/task-${t.id}`)).toBeNull();
    const reqs = app()
      .requests()
      .map((r) => `${r.method} ${r.path}`);
    expect(reqs.some((r) => r.startsWith("POST /repos/acme/widgets/git/"))).toBe(false);
    expect(reqs.some((r) => r === "POST /repos/acme/widgets/pulls")).toBe(false);
    const st = await t.stub.getStatus(OWNER);
    if (!st.ok) throw new Error("not found");
    expect(st.task).toMatchObject({
      kind: "review",
      status: "RUNNING",
      draft_pr_url: null,
      review: { stage: "waiting", model: "anthropic/claude-sonnet-5-5" },
      target_pr: { repository: REPO, number: t.number, head_sha: t.head, url: t.pull.url },
    });
  });

  it("レビューが得られたら、PR のレビューとして event: COMMENT・commit_id = head で 1 回だけ投稿する。PR の状態は変えない", async () => {
    const t = await createReview();
    await t.stub.advance();
    const before = app()
      .pulls(REPO)
      .find((p) => p.number === t.number);
    await finish(t, reviewResult("completed", review({ headSha: t.head })));
    await t.stub.advance();
    const reviews = app().reviews(REPO, t.number);
    expect(reviews).toEqual([
      expect.objectContaining({ event: "COMMENT", commitId: t.head, body: review().body }),
    ]);
    const after = app()
      .pulls(REPO)
      .find((p) => p.number === t.number);
    expect(after).toMatchObject({
      draft: before?.draft,
      state: before?.state,
      title: before?.title,
      body: before?.body,
      merged: false,
    });
    expect(app().branch(REPO, t.branch)).toBe(t.head);
    const r = await t.stub.result(OWNER);
    if (!r.ok) throw new Error(`not ready: ${r.code}`);
    expect(r.result).toMatchObject({
      status: "COMPLETED",
      kind: "review",
      pr: null,
      target_pr: { repository: REPO, number: t.number, head_sha: t.head },
      review: {
        stage: "done",
        model: "anthropic/claude-sonnet-5-5",
        comment_url: expect.stringMatching(/#pullrequestreview-\d+$/),
        must_fix_count: 1,
        suggestion_count: 2,
        fix_applied: false,
        final: null,
        commands_unavailable: false,
      },
    });
    expect(r.result.review?.usage).toMatchObject({ cost_usd: 0.02, estimated: false });
    expect(r.result.review?.commands[0]).toMatchObject({ argv: ["pnpm", "test"], exit_code: 1 });
    // 投稿できたときは本文を結果に重ねて載せない（PR で読める）
    expect(r.result.review?.body).toBeUndefined();
    expect(await eventsOf(t.stub, "review_posted")).toEqual([
      expect.objectContaining({ must_fix_count: 1, suggestion_count: 2 }),
    ]);
    const st = await t.stub.getStatus(OWNER);
    expect(st.ok && st.task.review?.stage).toBe("done");
  });

  it("投稿が恒久的に失敗したら warnings に review_comment_failed、本文は task_result で読める", async () => {
    const t = await createReview();
    await t.stub.advance();
    app().setFault({ pattern: `POST /repos/acme/widgets/pulls/${t.number}/reviews`, status: 403 });
    await finish(t, reviewResult("completed", review({ headSha: t.head })));
    await t.stub.advance();
    app().setFault({ pattern: `POST /repos/acme/widgets/pulls/${t.number}/reviews`, status: null });
    expect(app().reviews(REPO, t.number)).toEqual([]);
    const r = await t.stub.result(OWNER);
    if (!r.ok) throw new Error(`not ready: ${r.code}`);
    expect(r.result.warnings).toContain("review_comment_failed");
    expect(r.result.review).toMatchObject({ comment_url: null, body: review().body });
  });

  it("投稿が一時的に失敗したら、あとで再試行して 1 回だけ投稿する", async () => {
    const t = await createReview();
    await t.stub.advance();
    app().setFault({
      pattern: `POST /repos/acme/widgets/pulls/${t.number}/reviews`,
      status: 502,
      count: 1,
    });
    await finish(t, reviewResult("completed", review({ headSha: t.head })));
    expect(app().reviews(REPO, t.number)).toEqual([]);
    // 再試行の時刻まで進める
    await runInDurableObject(t.stub, (i) => {
      (i as unknown as { now: () => number }).now = () => Date.now() + 120_000;
    });
    await t.stub.advance();
    await t.stub.advance();
    expect(app().reviews(REPO, t.number)).toHaveLength(1);
    const r = await t.stub.result(OWNER);
    expect(r.ok && r.result.warnings).not.toContain("review_comment_failed");
  });

  it("AgentDO が結果を返せ続けなければ、有限回で投稿を諦めて終了処理を終える（トークンを失効し、alarm を回し続けない）", async () => {
    const t = await createReview();
    await t.stub.advance();
    await t.agent.setProgram({
      result: reviewResult("completed", review({ headSha: t.head })),
      getResultFailures: 1_000,
    });
    await t.agent.setPhase("completed");
    let at = Date.now();
    for (let i = 0; i < 12; i++) {
      at += 10 * 60_000;
      const now = at;
      await runInDurableObject(t.stub, (inst) => {
        (inst as unknown as { now: () => number }).now = () => now;
      });
      await t.stub.advance();
    }
    const [g] = await rows<{ finalize_done: number; warnings: string }>(
      t.stub,
      "SELECT finalize_done, warnings FROM github_link",
    );
    expect(g?.finalize_done).toBe(1);
    expect(JSON.parse(g?.warnings ?? "[]")).toContain("review_comment_failed");
    expect(app().reviews(REPO, t.number)).toEqual([]);
    // トークンの記録は閉じる（DO の時計を進めたので、期限切れとして失効扱いになる）
    const tokens = await rows<{ revoked: number }>(t.stub, "SELECT revoked FROM git_token");
    expect(tokens.length).toBeGreaterThan(0);
    expect(tokens.every((x) => x.revoked === 1)).toBe(true);
  });

  it("レビューが得られなかった（FAILED）タスクは何も投稿しない", async () => {
    const t = await createReview();
    await t.stub.advance();
    await finish(
      t,
      reviewResult(
        "failed",
        review({
          stage: "skipped",
          body: undefined,
          failure: "model_error",
          mustFixCount: 0,
          suggestionCount: 0,
        }),
        {
          reason: "review_failed: model_error",
        },
      ),
      "failed",
    );
    await t.stub.advance();
    expect(app().reviews(REPO, t.number)).toEqual([]);
    const r = await t.stub.result(OWNER);
    if (!r.ok) throw new Error(`not ready: ${r.code}`);
    expect(r.result).toMatchObject({
      status: "FAILED",
      review: { stage: "skipped", comment_url: null, failure: "model_error" },
    });
  });

  it("task_pr_ready / task_pr_merge の対象にならない（rovo の PR ではない）。steer も受け付けない", async () => {
    const t = await createReview();
    await t.stub.advance();
    expect(await t.stub.steer(OWNER, "more", undefined)).toEqual({ ok: false, code: "conflict" });
    await finish(t, reviewResult("completed", review({ headSha: t.head })));
    await t.stub.advance();
    for (const op of ["ready", "merge"] as const) {
      expect(await t.stub.prContext(OWNER, op)).toMatchObject({ ok: false, code: "conflict" });
    }
  });

  it("同じ入力の再作成は同じタスク、違う入力は conflict", async () => {
    const t = await createReview();
    const again = await t.stub.ensureReviewCreated(t.input);
    expect(again).toMatchObject({ ok: true, created: false });
    const other = await t.stub.ensureReviewCreated({
      ...t.input,
      review_model: "anthropic/claude-haiku-5-5",
    });
    expect(other).toEqual({ ok: false, code: "conflict" });
  });

  it("AGENT_MODELS に無いモデル・壊れた入力は invalid_input", async () => {
    const p = await clientPull();
    const id = newTaskId();
    const base = {
      task_id: id,
      owner_id: OWNER,
      owner_login: "alice",
      repository_id: UNIT_REPO.id,
      installation_id: UNIT_REPO.installationId,
      repository: REPO,
      pull_number: p.number,
      review_model: "anthropic/claude-opus-unknown",
      review_commands: [],
      budget_policy: "ask" as const,
      pull: p.pull,
    };
    expect(await taskStub(id).ensureReviewCreated(base)).toMatchObject({
      ok: false,
      code: "invalid_input",
    });
    expect(
      await taskStub(id).ensureReviewCreated({
        ...base,
        review_model: "anthropic/claude-sonnet-5-5",
        pull: { ...p.pull, headSha: "nope" },
      }),
    ).toMatchObject({ ok: false, code: "invalid_input" });
  });

  it("alarm でも準備から投稿まで進む（GitHub の差分の取得の失敗は再試行）", async () => {
    const t = await createReview();
    app().setFault({ pattern: "GET /repos/acme/widgets/compare/", status: 502, count: 1 });
    await t.stub.advance();
    expect((await t.agent.calls()).start).toBe(0);
    await runInDurableObject(t.stub, (i) => {
      (i as unknown as { now: () => number }).now = () => Date.now() + 120_000;
    });
    await runDurableObjectAlarm(t.stub);
    expect((await t.agent.calls()).start).toBe(1);
  });
});
