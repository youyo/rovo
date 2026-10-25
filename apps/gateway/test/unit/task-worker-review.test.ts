import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ResultDto, ReviewResultDto } from "../../src/agent/contract";
import { newTaskId, sampleInput, taskStub } from "./helpers";
import {
  app,
  audits,
  completedResult,
  createTask,
  pushChildCommit,
  REPO,
  type TaskStub,
} from "./pr-helpers";

// TaskDO の worker_review（review_fix_rounds: 0）。ワーカーの検証が通ったあとの AgentDO のレビューの結果を、PR に COMMENT のレビューとして
// 投稿してから、自動の Ready にする。結果と task_status に review が付き、client_review のタスクには付かない。

const OWNER = 801;
const MODEL = "anthropic/claude-sonnet-5-5";
const workerOver = (over: Record<string, unknown> = {}) => ({
  review_policy: "worker_review",
  review_model: MODEL,
  review_commands: [{ argv: ["pnpm", "test"], cwd: "apps/x", timeout_seconds: 900 }],
  ...over,
});

const rows = <T>(stub: TaskStub, sql: string, ...b: unknown[]) =>
  runInDurableObject(stub, (_i, s) => s.storage.sql.exec(sql, ...b).toArray() as T[]);
const eventsOf = async (stub: TaskStub, type: string) =>
  (await rows<{ payload: string }>(stub, "SELECT payload FROM events WHERE type = ?", type)).map(
    (e) => JSON.parse(e.payload) as Record<string, unknown>,
  );

const reviewDto = (over: Partial<ReviewResultDto> = {}): ReviewResultDto => ({
  stage: "done",
  model: MODEL,
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

/** COMPLETED まで進める。review は AgentDO の結果の review（headSha は PR の head に合わせる） */
async function runWorker(
  over: Record<string, unknown>,
  review: Partial<ReviewResultDto> | "none",
  warnings: string[] = [],
) {
  const t = await createTask(workerOver(over));
  await t.stub.advance();
  const head = await pushChildCommit(t.branch);
  const result: ResultDto = completedResult(head, {
    warnings,
    ...(review === "none" ? {} : { review: reviewDto({ headSha: head, ...review }) }),
  });
  await t.agent.setProgram({ result });
  await t.agent.setPhase("completed");
  await t.stub.advance();
  const pr = app()
    .pulls(REPO)
    .find((p) => p.head === t.branch);
  return { ...t, head, pr };
}

const resultOf = async (stub: TaskStub) => {
  const r = await stub.result(OWNER);
  if (!r.ok) throw new Error(`not ready: ${r.code}`);
  return r.result;
};

describe("worker_review: TaskDO の作成", () => {
  it("review_model・review_commands を保存し、AgentDO への spec に workerReview（fixRounds: 0）を載せる。client_review の spec には載せない", async () => {
    const t = await createTask(workerOver());
    await t.stub.advance();
    const calls = await t.agent.calls();
    expect(calls.specs[0]).toMatchObject({
      workerReview: {
        model: MODEL,
        commands: [{ argv: ["pnpm", "test"], cwd: "apps/x", timeoutSeconds: 900 }],
        fixRounds: 0,
      },
    });
    const c = await createTask();
    await c.stub.advance();
    expect((await c.agent.calls()).specs[0]).not.toHaveProperty("workerReview");
  });

  it("review_model が AGENT_MODELS に無い・無い worker_review は invalid_input。client_review で review_* を渡しても invalid_input", async () => {
    for (const over of [
      { review_model: "nope/none" },
      { review_model: undefined },
      { review_fix_rounds: 2 },
    ]) {
      const id = newTaskId();
      const r = await taskStub(id).ensureCreated(sampleInput(id, OWNER, workerOver(over)));
      expect(r, JSON.stringify(over)).toEqual({ ok: false, code: "invalid_input" });
    }
    for (const over of [
      { review_model: MODEL },
      { review_commands: [] },
      { review_fix_rounds: 0 },
    ]) {
      const id = newTaskId();
      const r = await taskStub(id).ensureCreated(sampleInput(id, OWNER, over));
      expect(r, JSON.stringify(over)).toEqual({ ok: false, code: "invalid_input" });
    }
  });

  it("同じ入力の再作成は同じタスク。review_model が違えば conflict（指紋 v6）", async () => {
    const id = newTaskId();
    const stub = taskStub(id);
    const input = sampleInput(id, OWNER, workerOver());
    expect((await stub.ensureCreated(input)).ok).toBe(true);
    expect(await stub.ensureCreated(input)).toMatchObject({ ok: true, created: false });
    const other = await stub.ensureCreated(
      sampleInput(id, OWNER, workerOver({ review_model: "anthropic/claude-haiku-5-5" })),
    );
    expect(other).toEqual({ ok: false, code: "conflict" });
  });
});

describe("worker_review: task_status の review.stage の遷移", () => {
  it("waiting → commands → reviewing → done。fix_rounds と rounds_used（修正の回は未実装なので 0）が付く。client_review には review が付かない", async () => {
    const t = await createTask(workerOver());
    const st0 = await t.stub.getStatus(OWNER);
    expect(st0.ok && st0.task.review).toEqual({
      stage: "waiting",
      model: MODEL,
      fix_rounds: 0,
      rounds_used: 0,
    });
    await t.stub.advance();
    const stage = async () => {
      const s = await t.stub.getStatus(OWNER);
      return s.ok ? s.task.review?.stage : undefined;
    };
    // 検証が通るまでは waiting（レビューの段のイベントはまだ無い）
    expect(await stage()).toBe("waiting");
    await t.agent.emit("review_started", { model: MODEL, commands: 1 });
    await t.stub.advance();
    expect(await stage()).toBe("commands");
    await t.agent.emit("review_commands_finished", { passed: 0, failed: 1, timed_out: 0 });
    await t.stub.advance();
    expect(await stage()).toBe("reviewing");

    const c = await createTask();
    const sc = await c.stub.getStatus(OWNER);
    expect(sc.ok && sc.task).not.toHaveProperty("review");
  });
});

describe("worker_review: 投稿と Ready（COMPLETED のあと）", () => {
  it("レビューが得られたら、PR に COMMENT（commit_id = 検証した head）を 1 件投稿してから Ready にする。task_result に review が付く", async () => {
    const t = await runWorker({}, {}, ["review_must_fix_unaddressed: 1"]);
    const number = t.pr?.number as number;
    expect(app().reviews(REPO, number)).toEqual([
      expect.objectContaining({ event: "COMMENT", commitId: t.head, body: reviewDto().body }),
    ]);
    const after = app()
      .pulls(REPO)
      .find((p) => p.number === number);
    expect(after?.draft).toBe(false);
    const r = await resultOf(t.stub);
    expect(r).toMatchObject({
      status: "COMPLETED",
      review_policy: "worker_review",
      pr: { draft: false, head_matches_verified: true },
      review: {
        stage: "done",
        model: MODEL,
        comment_url: expect.stringMatching(/#pullrequestreview-\d+$/),
        must_fix_count: 1,
        suggestion_count: 2,
        fix_applied: false,
        final: null,
        commands_unavailable: false,
      },
    });
    expect(r.review?.usage).toMatchObject({ cost_usd: 0.02, estimated: false });
    expect(r.review?.commands[0]).toMatchObject({ argv: ["pnpm", "test"], exit_code: 1 });
    expect(r.review?.body).toBeUndefined();
    expect(r.warnings).toContain("review_must_fix_unaddressed: 1");
    expect(await eventsOf(t.stub, "review_posted")).toEqual([
      expect.objectContaining({ must_fix_count: 1, suggestion_count: 2 }),
    ]);
    expect(await eventsOf(t.stub, "review_finished")).toEqual([{ stage: "done" }]);
    const st = await t.stub.getStatus(OWNER);
    expect(st.ok && st.task.review).toMatchObject({ stage: "done", fix_rounds: 0 });
    const a = await audits(t.stub);
    expect(a.some((x) => x.event === "review_posted")).toBe(true);
  });

  it("must_fix が 0 件でも、コメントは投稿される（suggestions は warnings の review_suggestions）", async () => {
    const t = await runWorker({}, { mustFixCount: 0, suggestionCount: 3 }, [
      "review_suggestions: 3",
    ]);
    const number = t.pr?.number as number;
    expect(app().reviews(REPO, number)).toHaveLength(1);
    const r = await resultOf(t.stub);
    expect(r.warnings).toEqual(["review_suggestions: 3"]);
    expect(r.pr?.draft).toBe(false);
  });

  it("レビューのモデルが失敗（本文なし）: 何も投稿せず、COMPLETED のまま Ready。review は skipped、warnings に review_failed", async () => {
    const t = await runWorker(
      {},
      {
        stage: "skipped",
        body: undefined,
        mustFixCount: 0,
        suggestionCount: 0,
        failure: "model_error",
      },
      ["review_failed: model_error"],
    );
    const number = t.pr?.number as number;
    expect(app().reviews(REPO, number)).toEqual([]);
    const r = await resultOf(t.stub);
    expect(r).toMatchObject({
      status: "COMPLETED",
      pr: { draft: false },
      review: { stage: "skipped", comment_url: null, failure: "model_error" },
    });
    expect(r.warnings).toContain("review_failed: model_error");
    expect(await eventsOf(t.stub, "review_finished")).toEqual([{ stage: "skipped" }]);
    const a = await audits(t.stub);
    expect(a.some((x) => x.event === "review_failed")).toBe(true);
  });

  it("予算で飛ばした: COMPLETED のまま Ready。review_skipped_budget", async () => {
    const t = await runWorker(
      { budget_policy: "stop" },
      { stage: "skipped", body: undefined, mustFixCount: 0, suggestionCount: 0, failure: "budget" },
      ["review_skipped_budget"],
    );
    const r = await resultOf(t.stub);
    expect(r).toMatchObject({
      status: "COMPLETED",
      pr: { draft: false },
      review: { stage: "skipped", failure: "budget" },
    });
    expect(r.warnings).toEqual(["review_skipped_budget"]);
  });

  it("投稿が恒久的に失敗しても Ready にする。warnings に review_comment_failed、本文は task_result の review.body", async () => {
    const t = await createTask(workerOver());
    await t.stub.advance();
    const head = await pushChildCommit(t.branch);
    const number = app()
      .pulls(REPO)
      .find((p) => p.head === t.branch)?.number as number;
    app().setFault({ pattern: `POST /repos/acme/widgets/pulls/${number}/reviews`, status: 403 });
    await t.agent.setProgram({
      result: completedResult(head, { review: reviewDto({ headSha: head }) }),
    });
    await t.agent.setPhase("completed");
    await t.stub.advance();
    app().setFault({ pattern: `POST /repos/acme/widgets/pulls/${number}/reviews`, status: null });
    expect(app().reviews(REPO, number)).toEqual([]);
    const r = await resultOf(t.stub);
    expect(r.warnings).toContain("review_comment_failed");
    expect(r.review).toMatchObject({ comment_url: null, body: reviewDto().body });
    expect(r.pr?.draft).toBe(false);
  });

  it("検証に失敗した（FAILED）worker_review は何も投稿せず Draft のまま。review は skipped で、レビューの失敗の監査も出さない", async () => {
    const t = await createTask(workerOver());
    await t.stub.advance();
    await pushChildCommit(t.branch);
    await t.agent.setProgram({
      result: {
        ...completedResult("a".repeat(40)),
        status: "failed",
        reason: "verification_failed",
      } as ResultDto,
    });
    await t.agent.setPhase("failed");
    await t.stub.advance();
    const number = app()
      .pulls(REPO)
      .find((p) => p.head === t.branch)?.number as number;
    expect(app().reviews(REPO, number)).toEqual([]);
    const r = await resultOf(t.stub);
    expect(r).toMatchObject({
      status: "FAILED",
      pr: { draft: true },
      review: { stage: "skipped" },
    });
    expect((await audits(t.stub)).some((x) => x.event === "review_failed")).toBe(false);
  });

  it("warnings があるので task_pr_merge は拒否される（warnings_present）", async () => {
    const t = await runWorker({}, {}, ["review_must_fix_unaddressed: 1"]);
    const ctx = await t.stub.prContext(OWNER, "merge");
    expect(ctx).toMatchObject({ ok: false, code: "conflict" });
    expect((await audits(t.stub)).some((x) => x.reason === "warnings_present")).toBe(true);
  });

  it("client_review のタスクの結果には review が付かず、レビューは投稿されない", async () => {
    const t = await createTask();
    await t.stub.advance();
    const head = await pushChildCommit(t.branch);
    await t.agent.setProgram({ result: completedResult(head) });
    await t.agent.setPhase("completed");
    await t.stub.advance();
    const r = await resultOf(t.stub);
    expect(r).not.toHaveProperty("review");
    expect(r.pr?.draft).toBe(false);
  });
});

// worker_review の修正の回（review_fix_rounds: 1）。AgentDO が must_fix をワーカーに渡して直させ（review_fix_started、RUNNING）、
// 再実行（VERIFYING）のあとに完了にする。TaskDO は段階（fixing / rechecking）と rounds_used を出し、結果に fix_applied と final を返す。
// レビューのコメントは、修正の回に入ったなら（FAILED でも）PR に残す。
describe("worker_review: 修正の回（review_fix_rounds: 1）", () => {
  it("AgentDO への spec に fixRounds: 1 を載せ、task_status の fix_rounds は 1", async () => {
    const t = await createTask(workerOver({ review_fix_rounds: 1 }));
    await t.stub.advance();
    expect((await t.agent.calls()).specs[0]).toMatchObject({
      workerReview: { model: MODEL, fixRounds: 1 },
    });
    const st = await t.stub.getStatus(OWNER);
    expect(st.ok && st.task.review).toMatchObject({ fix_rounds: 1, rounds_used: 0 });
  });

  it("review.stage: 修正の回に入ったら、RUNNING のあいだは fixing、VERIFYING（再実行）は rechecking。rounds_used は 1", async () => {
    const t = await createTask(workerOver({ review_fix_rounds: 1 }));
    await t.stub.advance();
    const review = async () => {
      const s = await t.stub.getStatus(OWNER);
      return s.ok ? s.task.review : undefined;
    };
    await t.agent.setPhase("verifying");
    await t.agent.emit("review_started", { model: MODEL, commands: 1 });
    await t.agent.emit("review_commands_finished", { passed: 1, failed: 0, timed_out: 0 });
    await t.stub.advance();
    expect(await review()).toMatchObject({ stage: "reviewing", rounds_used: 0 });
    await t.agent.emit("review_fix_started", { must_fix_count: 2 });
    await t.agent.setPhase("running");
    await t.stub.advance();
    expect(await review()).toMatchObject({ stage: "fixing", rounds_used: 1 });
    await t.agent.setPhase("verifying");
    await t.stub.advance();
    expect(await review()).toMatchObject({ stage: "rechecking", rounds_used: 1 });
    // 再実行の検証が通らずワーカーに返ったら、また fixing
    await t.agent.setPhase("running");
    await t.stub.advance();
    expect(await review()).toMatchObject({ stage: "fixing" });
  });

  it("修正して再実行が通った: COMMENT（commit_id はレビューした commit）を投稿して Ready。task_result に fix_applied・fix_commit_sha・final", async () => {
    const t = await createTask(workerOver({ review_fix_rounds: 1 }));
    await t.stub.advance();
    const reviewed = await pushChildCommit(t.branch);
    const fixed = await pushChildCommit(t.branch);
    await t.agent.setProgram({
      result: completedResult(fixed, {
        review: reviewDto({
          headSha: reviewed,
          fixRequested: true,
          fixApplied: fixed,
          final: {
            verificationCommandsPassed: true,
            reviewCommandsPassed: true,
            commands: [{ argv: ["pnpm", "test"], exitCode: 0, timedOut: false, output: "ok" }],
            commandsUnavailable: false,
          },
        }),
      }),
    });
    await t.agent.setPhase("completed");
    await t.stub.advance();
    const number = app()
      .pulls(REPO)
      .find((p) => p.head === t.branch)?.number as number;
    expect(app().reviews(REPO, number)).toEqual([
      expect.objectContaining({ event: "COMMENT", commitId: reviewed }),
    ]);
    const r = await resultOf(t.stub);
    expect(r).toMatchObject({
      status: "COMPLETED",
      pr: { draft: false, head_matches_verified: true },
      review: {
        stage: "done",
        fix_applied: true,
        fix_commit_sha: fixed,
        final: {
          verification_commands_passed: true,
          review_commands_passed: true,
          commands: [{ argv: ["pnpm", "test"], exit_code: 0, timed_out: false, output: "ok" }],
          commands_unavailable: false,
        },
      },
    });
    expect(r.warnings).toEqual([]);
  });

  it("直さなかったときは fix_applied: false、fix_commit_sha: null、final: null", async () => {
    const t = await runWorker({ review_fix_rounds: 1 }, { fixRequested: true }, [
      "review_must_fix_unaddressed: 1",
    ]);
    const r = await resultOf(t.stub);
    expect(r.review).toMatchObject({ fix_applied: false, fix_commit_sha: null, final: null });
    expect(r.warnings).toContain("review_must_fix_unaddressed: 1");
  });

  it("修正の回に入ったあと検証を使い切って FAILED: レビューのコメントは PR に残す（投稿する）が、Draft のまま", async () => {
    const t = await createTask(workerOver({ review_fix_rounds: 1 }));
    await t.stub.advance();
    const reviewed = await pushChildCommit(t.branch);
    await t.agent.setProgram({
      result: {
        ...completedResult("a".repeat(40)),
        status: "failed",
        reason: "verification_failed",
        review: reviewDto({ headSha: reviewed, fixRequested: true }),
      } as ResultDto,
    });
    await t.agent.setPhase("failed");
    await t.stub.advance();
    const number = app()
      .pulls(REPO)
      .find((p) => p.head === t.branch)?.number as number;
    expect(app().reviews(REPO, number)).toEqual([
      expect.objectContaining({ event: "COMMENT", commitId: reviewed }),
    ]);
    const r = await resultOf(t.stub);
    expect(r).toMatchObject({ status: "FAILED", pr: { draft: true } });
    expect(r.review?.comment_url).toEqual(expect.stringMatching(/#pullrequestreview-\d+$/));
  });
});
