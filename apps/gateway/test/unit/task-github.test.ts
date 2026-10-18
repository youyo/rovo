import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { ResultDto } from "../../src/agent/contract";
import { MANAGED_BEGIN, MANAGED_END } from "../../src/github/pr-body";
import { getFakeApp, type UnitGitHubEnv } from "../support/unit-github";
import { fakeAgent, newTaskId, sampleInput, taskStub } from "./helpers";

const OWNER = 701;
const REPO = "acme/widgets";
const app = () => getFakeApp(env as unknown as UnitGitHubEnv);

type TaskStub = ReturnType<typeof taskStub>;

function rows<T>(stub: TaskStub, sql: string, ...b: unknown[]): Promise<T[]> {
  return runInDurableObject(
    stub,
    (_i, state) => state.storage.sql.exec(sql, ...b).toArray() as T[],
  );
}

async function createTask(overrides: Record<string, unknown> = {}) {
  const id = newTaskId();
  const stub = taskStub(id);
  const r = await stub.ensureCreated(sampleInput(id, OWNER, overrides));
  if (!r.ok) throw new Error(`ensureCreated failed: ${r.code}`);
  return { id, stub, agent: fakeAgent(id), branch: `agent/task-${id}` };
}

const status = async (stub: TaskStub) => {
  const r = await stub.getStatus(OWNER);
  if (!r.ok) throw new Error("not found");
  return r.task;
};
const eventTypes = async (stub: TaskStub) =>
  (await rows<{ type: string }>(stub, "SELECT type FROM events ORDER BY seq")).map((e) => e.type);
const eventsOf = async (stub: TaskStub, type: string) =>
  (await rows<{ payload: string }>(stub, "SELECT payload FROM events WHERE type = ?", type)).map(
    (e) => JSON.parse(e.payload) as Record<string, unknown>,
  );
const gl = async (stub: TaskStub) =>
  (await rows<Record<string, unknown>>(stub, "SELECT * FROM github_link"))[0] ?? {};
const failReason = async (stub: TaskStub) =>
  (await eventsOf(stub, "status_changed")).find((e) => e.status === "FAILED")?.reason;

/** DO の時計と偽 GitHub の時計を、同じだけ進める。 */
async function warp(stub: TaskStub, ms: number) {
  const clock = () => Date.now() + ms;
  await runInDurableObject(stub, (i) => {
    (i as unknown as { now: () => number }).now = clock;
  });
  app().now = clock;
}

async function setEnv(stub: TaskStub, patch: Record<string, string | undefined>) {
  await runInDurableObject(stub, (i) => {
    const o = i as unknown as { env: Record<string, unknown> };
    o.env = { ...o.env, ...patch };
  });
}

const pullOf = (branch: string) =>
  app()
    .pulls(REPO)
    .find((p) => p.head === branch);

function completedResult(
  commitSha: string,
  over: Partial<Extract<ResultDto, { summary: string }>> = {},
): ResultDto {
  return {
    status: "completed",
    summary: "All good",
    verification: {
      commands: [{ argv: ["npm", "test"] }],
      results: [{ argv: ["npm", "test"], exitCode: 0, timedOut: false, output: "ok" }],
      verified: true,
      attempts: 1,
      commitSha,
    },
    warnings: [],
    patchTooLarge: false,
    usage: {
      costUsd: 1.5,
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
    ...over,
  } as ResultDto;
}

describe("CREATING: 初期コミット・ブランチ・Draft PR", () => {
  it("決定的な初期コミット → ブランチ → Draft PR → draft_pr_created → トークン付きで AgentDO.start", async () => {
    const { id, stub, agent, branch } = await createTask();
    await stub.advance();

    const [row] = await rows<{ created_at: number }>(stub, "SELECT created_at FROM task");
    const g = await gl(stub);
    const initialSha = g.initial_sha as string;
    const c = app().commit(REPO, initialSha);
    expect(c).toMatchObject({ message: `rovo: start task ${id}`, parents: [expect.any(String)] });
    const date = new Date(row?.created_at ?? 0).toISOString().replace(/\.\d{3}Z$/, "Z");
    expect(c?.author.date).toBe(date);
    expect(c?.committer.date).toBe(date);
    expect(app().branch(REPO, branch)).toBe(initialSha);

    const pr = pullOf(branch);
    expect(pr).toMatchObject({ draft: true, base: "main", title: "Implement authentication" });
    expect(pr?.body).toContain(MANAGED_BEGIN);

    expect(await eventTypes(stub)).toEqual(["created", "draft_pr_created", "status_changed"]);
    const [ev] = await eventsOf(stub, "draft_pr_created");
    expect(ev).toMatchObject({ number: pr?.number, draft: true, branch });
    expect((await status(stub)).draft_pr_url).toBe(
      `https://github.test/${REPO}/pull/${pr?.number}`,
    );
    expect((await status(stub)).status).toBe("RUNNING");

    const { specs } = await agent.calls();
    expect(specs[0]).toMatchObject({ branch, initialSha });
    expect(specs[0]?.gitCredential.token).toMatch(/^ghs_/);
    expect(specs[0]?.gitCredential.expiresAt).toBeGreaterThan(Date.now() + 50 * 60_000);
  });

  it("トークンは repository_ids と permissions を絞って発行され、JWT で認証される", async () => {
    const { stub } = await createTask();
    await stub.advance();
    const issue = app()
      .requests()
      .find((r) => r.path === "/app/installations/77/access_tokens");
    expect(issue).toMatchObject({
      method: "POST",
      auth: "jwt",
      body: {
        repository_ids: [4242],
        permissions: { contents: "write", pull_requests: "write", metadata: "read" },
      },
    });
  });

  it("トークンは暗号化して保存する。spec 列にも平文のトークンは入らない", async () => {
    const { stub, agent } = await createTask();
    await stub.advance();
    const token = (await agent.calls()).specs[0]?.gitCredential.token ?? "";
    const dump = JSON.stringify([
      await rows(stub, "SELECT * FROM git_token"),
      await rows(stub, "SELECT * FROM agent_link"),
      await rows(stub, "SELECT * FROM github_link"),
      await rows(stub, "SELECT * FROM events"),
    ]);
    expect(token).not.toBe("");
    expect(dump).not.toContain(token);
  });

  it("再試行しても初期コミットのリクエスト本文は同じ（SHA が変わらない）", async () => {
    const { stub } = await createTask();
    app().setFault({ pattern: "^POST /repos/.*/git/refs$", status: 500, count: 1 });
    await stub.advance();
    expect((await status(stub)).status).toBe("CREATING");
    // 失敗の直前に、初期コミットの SHA は永続化されている（ref を作る前）
    const g1 = await gl(stub);
    expect(g1.initial_sha).toMatch(/^[0-9a-f]{40}$/);
    expect(g1.branch_ready).toBe(0);
    await warp(stub, 120_000);
    await runDurableObjectAlarm(stub);
    expect((await status(stub)).status).toBe("RUNNING");
    expect((await gl(stub)).initial_sha).toBe(g1.initial_sha);
    const bodies = app()
      .requests()
      .filter((r) => r.method === "POST" && r.path.endsWith("/git/commits"))
      .map((r) => JSON.stringify(r.body));
    expect(new Set(bodies).size).toBe(1);
  });

  it("ブランチが既にあれば compare で確かめる: identical / ahead は使う", async () => {
    for (const mode of ["identical", "ahead"] as const) {
      const { stub, branch } = await createTask();
      app().setFault({ pattern: "^POST /repos/.*/pulls$", status: 500, count: 1 });
      await stub.advance(); // コミットとブランチまで進み、PR で止まる
      const init = (await gl(stub)).initial_sha as string;
      if (mode === "ahead") {
        const next = await app().addCommit(REPO, init, "work");
        app().setBranch(REPO, branch, next);
      }
      // 別の経路（ref の作成が先に済んでいた状況）を再現する: branch_ready を戻して再実行
      await runInDurableObject(stub, (_i, s) =>
        s.storage.sql.exec("UPDATE github_link SET branch_ready = 0"),
      );
      await warp(stub, 120_000);
      await runDurableObjectAlarm(stub);
      expect((await status(stub)).status).toBe("RUNNING");
      expect(app().branch(REPO, branch)).not.toBeNull();
    }
  });

  it("ブランチが behind / diverged なら FAILED（branch_conflict）。削除も force もしない", async () => {
    for (const mode of ["behind", "diverged"] as const) {
      const { stub, branch } = await createTask();
      app().setFault({ pattern: "^POST /repos/.*/pulls$", status: 500, count: 1 });
      await stub.advance();
      const init = (await gl(stub)).initial_sha as string;
      const c = app().commit(REPO, init);
      const parent = c?.parents[0] as string;
      const moved =
        mode === "behind" ? parent : await app().addCommit(REPO, parent, `side-${mode}`);
      app().setBranch(REPO, branch, moved);
      await runInDurableObject(stub, (_i, s) =>
        s.storage.sql.exec("UPDATE github_link SET branch_ready = 0"),
      );
      await warp(stub, 120_000);
      await runDurableObjectAlarm(stub);
      expect((await status(stub)).status).toBe("FAILED");
      expect(await failReason(stub)).toBe("branch_conflict");
      expect(app().branch(REPO, branch)).toBe(moved);
      expect(
        app()
          .requests()
          .some((r) => r.method === "DELETE" && r.path.includes("/git/")),
      ).toBe(false);
    }
  });

  it("既に open な PR があれば（base が一致すれば）それを使い、新しい PR は作らない", async () => {
    const { stub, branch } = await createTask();
    app().setFault({ pattern: "^POST /repos/.*/pulls$", status: 500, count: 1 });
    await stub.advance();
    const number = app().seedPull(REPO, { head: branch, base: "main" });
    await warp(stub, 120_000);
    const posts = () =>
      app()
        .requests()
        .filter((r) => r.method === "POST" && r.path.endsWith("/pulls")).length;
    const before = posts();
    await runDurableObjectAlarm(stub);
    expect((await status(stub)).status).toBe("RUNNING");
    expect(posts()).toBe(before);
    expect((await eventsOf(stub, "draft_pr_created"))[0]).toMatchObject({ number });
  });

  it("既存 PR の base が base_ref と違えば FAILED（pr_base_mismatch）", async () => {
    const { stub, branch } = await createTask();
    app().setFault({ pattern: "^POST /repos/.*/pulls$", status: 500, count: 1 });
    await stub.advance();
    app().seedPull(REPO, { head: branch, base: "develop" });
    await warp(stub, 120_000);
    await runDurableObjectAlarm(stub);
    expect((await status(stub)).status).toBe("FAILED");
    expect(await failReason(stub)).toBe("pr_base_mismatch");
  });

  it("PR の作成が 422（already exists）なら、もう一度 GET して使う", async () => {
    const { stub, branch } = await createTask();
    app().setFault({ pattern: "^POST /repos/.*/pulls$", status: 500, count: 1 });
    await stub.advance();
    const number = app().seedPull(REPO, { head: branch, base: "main" });
    // 最初の一覧は「無い」と答える（作成の競合を再現）
    app().setFault({ pattern: "^GET /repos/.*/pulls$", status: 200, count: 1, body: [] });
    await warp(stub, 120_000);
    await runDurableObjectAlarm(stub);
    expect((await status(stub)).status).toBe("RUNNING");
    expect((await eventsOf(stub, "draft_pr_created"))[0]).toMatchObject({ number });
  });
});

describe("Draft PR を作れない場合（DRAFT_PR_FALLBACK）", () => {
  it("既定（fail）: FAILED（draft_pr_unsupported）。通常の PR は作らない", async () => {
    app().setDraftUnsupported(true);
    const { stub, branch } = await createTask();
    await stub.advance();
    expect((await status(stub)).status).toBe("FAILED");
    expect(await failReason(stub)).toBe("draft_pr_unsupported");
    expect(pullOf(branch)).toBeUndefined();
  });

  it.each(["", "yes", "READY?", "true", "1"])(
    "不正な値 %j は fail として扱う（fail-closed）",
    async (v) => {
      app().setDraftUnsupported(true);
      const { stub, branch } = await createTask();
      await setEnv(stub, { DRAFT_PR_FALLBACK: v });
      await stub.advance();
      expect(await failReason(stub)).toBe("draft_pr_unsupported");
      expect(pullOf(branch)).toBeUndefined();
    },
  );

  it("ready: [WIP] 付きの通常の PR を作り、本文冒頭に注記、警告 draft_pr_unavailable を残す", async () => {
    app().setDraftUnsupported(true);
    const { stub, branch } = await createTask();
    await setEnv(stub, { DRAFT_PR_FALLBACK: "ready" });
    await stub.advance();
    expect((await status(stub)).status).toBe("RUNNING");
    const pr = pullOf(branch);
    expect(pr).toMatchObject({ draft: false, title: "[WIP] Implement authentication" });
    expect(pr?.body.startsWith(">")).toBe(true);
    expect(pr?.body).toMatch(/Do not merge/);
    expect((await eventsOf(stub, "draft_pr_created"))[0]).toMatchObject({ draft: false });
    expect((await eventsOf(stub, "warning")).map((w) => w.code)).toContain("draft_pr_unavailable");
    expect(String((await gl(stub)).warnings)).toContain("draft_pr_unavailable");
  });

  it("ready でも、Draft に関係しない 422 では通常の PR に切り替えず FAILED", async () => {
    app().setFault({
      pattern: "^POST /repos/.*/pulls$",
      status: 422,
      message: "Validation Failed",
      body: { message: "Validation Failed", errors: [{ field: "head", code: "invalid" }] },
    });
    const { stub, branch } = await createTask();
    await setEnv(stub, { DRAFT_PR_FALLBACK: "ready" });
    await stub.advance();
    expect((await status(stub)).status).toBe("FAILED");
    expect(await failReason(stub)).toBe("github_unprocessable");
    expect(pullOf(branch)).toBeUndefined();
  });
});

describe("GitHub のエラー分類と backoff", () => {
  it("base_sha が無ければ FAILED（base_sha_not_found）", async () => {
    app().markMissing(REPO, "0123456789abcdef");
    const { stub } = await createTask();
    await stub.advance();
    expect(await failReason(stub)).toBe("base_sha_not_found");
  });

  it("403（権限不足）は FAILED（github_forbidden）、404（見えない）は FAILED（github_not_found）", async () => {
    app().setFault({ pattern: "^POST /repos/.*/git/commits$", status: 403, count: 1 });
    const a = await createTask();
    await a.stub.advance();
    expect(await failReason(a.stub)).toBe("github_forbidden");

    const b = await createTask({ installation_id: 999 });
    await b.stub.advance();
    expect(await failReason(b.stub)).toBe("github_not_found");
  });

  it("401 は警告（1 回）を出して再試行し、直れば進む", async () => {
    app().setFault({ pattern: "^POST /app/installations/", status: 401, count: 3 });
    const { stub } = await createTask();
    await stub.advance();
    expect((await status(stub)).status).toBe("CREATING");
    expect((await eventsOf(stub, "warning")).map((w) => w.code)).toEqual(["github_auth_failed"]);
    for (let i = 0; i < 2; i++) {
      await warp(stub, (i + 1) * 120_000);
      await runDurableObjectAlarm(stub);
    }
    expect((await eventsOf(stub, "warning")).length).toBe(1);
    await warp(stub, 4 * 120_000);
    await runDurableObjectAlarm(stub);
    expect((await status(stub)).status).toBe("RUNNING");
  });

  it("429 の Retry-After を尊重し、その間は GitHub を呼ばない", async () => {
    app().setFault({
      pattern: "^POST /repos/.*/git/commits$",
      status: 429,
      count: 1,
      headers: { "retry-after": "30" },
    });
    const { stub } = await createTask();
    await stub.advance();
    const g = await gl(stub);
    expect((await status(stub)).status).toBe("CREATING");
    expect(g.setup_retry_at as number).toBeGreaterThanOrEqual(Date.now() + 29_000);
    const n = app().requests().length;
    await runDurableObjectAlarm(stub); // まだ待ち時間の内
    expect(app().requests().length).toBe(n);
    await warp(stub, 31_000);
    await runDurableObjectAlarm(stub);
    expect((await status(stub)).status).toBe("RUNNING");
  });

  it("secondary rate limit（403 + 本文）も再試行する", async () => {
    app().setFault({
      pattern: "^POST /repos/.*/git/commits$",
      status: 403,
      count: 1,
      message: "You have exceeded a secondary rate limit.",
    });
    const { stub } = await createTask();
    await stub.advance();
    expect((await status(stub)).status).toBe("CREATING");
    await warp(stub, 120_000);
    await runDurableObjectAlarm(stub);
    expect((await status(stub)).status).toBe("RUNNING");
  });

  it("5xx は指数 backoff（上限 60 秒）で再試行する", async () => {
    app().setFault({ pattern: "^POST /repos/.*/git/commits$", status: 503 });
    const { stub } = await createTask();
    const delays: number[] = [];
    let clock = 0;
    for (let i = 0; i < 8; i++) {
      await warp(stub, clock);
      await runDurableObjectAlarm(stub).catch(() => {});
      if (i === 0) await stub.advance();
      const g = await gl(stub);
      delays.push((g.setup_retry_at as number) - (Date.now() + clock));
      clock += 61_000;
    }
    const rounded = delays.map((d) => Math.round(d / 1000));
    expect(rounded[0]).toBeGreaterThanOrEqual(1);
    for (let i = 1; i < rounded.length; i++) {
      expect(rounded[i] as number).toBeGreaterThanOrEqual(rounded[i - 1] as number);
    }
    expect(Math.max(...rounded)).toBeLessThanOrEqual(60);
    expect(rounded.at(-1)).toBe(60);
    expect((await status(stub)).status).toBe("CREATING");
  });

  it("CREATING が 10 分を超えたら FAILED（setup_timeout）。予約を返す", async () => {
    app().setFault({ pattern: "^POST /repos/.*/git/commits$", status: 503 });
    const { stub } = await createTask();
    await stub.advance();
    await warp(stub, 11 * 60_000);
    await runDurableObjectAlarm(stub);
    expect((await status(stub)).status).toBe("FAILED");
    expect(await failReason(stub)).toBe("setup_timeout");
    const [l] = await rows<{ finished: number; cancel_state: string }>(
      stub,
      "SELECT * FROM agent_link",
    );
    expect(l).toMatchObject({ finished: 1, cancel_state: "stopped" });
  });

  it("GitHub App が未設定なら FAILED（github_app_not_configured）", async () => {
    const { stub } = await createTask();
    await setEnv(stub, { GITHUB_APP_ID: undefined });
    await stub.advance();
    expect(await failReason(stub)).toBe("github_app_not_configured");
  });

  it("秘密鍵が壊れていても FAILED（トークンやキーの中身は出さない）", async () => {
    const { stub } = await createTask();
    await setEnv(stub, { GITHUB_APP_PRIVATE_KEY: "garbage" });
    await stub.advance();
    expect(await failReason(stub)).toBe("github_app_not_configured");
  });

  it("FAILED になった後、発行済みのトークンは失効する", async () => {
    app().markMissing(REPO, "0123456789abcdef");
    const { stub } = await createTask();
    await stub.advance();
    const toks = app().tokenList();
    expect(toks.length).toBeGreaterThan(0);
    expect(toks.every((t) => t.revoked)).toBe(true);
  });
});

describe("トークンの配送と更新", () => {
  it("start の再送では同じ spec（同じトークン）を送る", async () => {
    const { stub, agent } = await createTask();
    await agent.setProgram({ start: ["lose"] });
    await stub.advance();
    await runDurableObjectAlarm(stub);
    const { specs } = await agent.calls();
    expect(specs.length).toBe(2);
    expect(JSON.stringify(specs[1])).toBe(JSON.stringify(specs[0]));
    expect(app().tokenList().length).toBe(1);
  });

  it("期限の 15 分前になったら新しいトークンを発行して setGitCredential で渡す", async () => {
    const { stub, agent } = await createTask();
    await stub.advance();
    const first = (await agent.calls()).specs[0]?.gitCredential;
    // 期限の 16 分前: まだ更新しない
    await warp(stub, (first?.expiresAt ?? 0) - Date.now() - 16 * 60_000);
    await runDurableObjectAlarm(stub);
    expect((await agent.calls()).setGitCredential).toBe(0);
    // 期限の 14 分前: 更新する
    await warp(stub, (first?.expiresAt ?? 0) - Date.now() - 14 * 60_000);
    await runDurableObjectAlarm(stub);
    const c = await agent.calls();
    expect(c.setGitCredential).toBe(1);
    expect(c.credentials[0]?.token).not.toBe(first?.token);
    expect(c.credentials[0]?.expiresAt).toBeGreaterThan(first?.expiresAt ?? 0);
    // 渡し終えたら、それ以上は発行しない
    const issued = app().tokenList().length;
    await runDurableObjectAlarm(stub);
    expect(app().tokenList().length).toBe(issued);
    expect((await agent.calls()).setGitCredential).toBe(1);
  });

  it("配送は成功するまで同じトークンを再送する（冪等）。再送のたびに発行しない", async () => {
    const { stub, agent } = await createTask();
    await stub.advance();
    const first = (await agent.calls()).specs[0]?.gitCredential;
    await agent.setProgram({ setGitCredential: ["not_ok", "throw", "lose", "ok"] });
    await warp(stub, (first?.expiresAt ?? 0) - Date.now() - 10 * 60_000);
    for (let i = 0; i < 4; i++) await runDurableObjectAlarm(stub);
    const c = await agent.calls();
    expect(c.setGitCredential).toBe(4);
    expect(new Set(c.credentials.map((x) => x.token)).size).toBe(1);
    expect(app().tokenList().length).toBe(2);
    await runDurableObjectAlarm(stub);
    expect((await agent.calls()).setGitCredential).toBe(4);
  });

  it("新しいトークンを渡せたら、古いトークンは失効させる", async () => {
    const { stub, agent } = await createTask();
    await stub.advance();
    const first = (await agent.calls()).specs[0]?.gitCredential;
    await warp(stub, (first?.expiresAt ?? 0) - Date.now() - 10 * 60_000);
    await runDurableObjectAlarm(stub);
    const [old, fresh] = app().tokenList();
    expect(old?.token).toBe(first?.token);
    expect(old?.revoked).toBe(true);
    expect(fresh?.revoked).toBe(false);
  });
});

describe("終端: PR の更新とトークンの失効", () => {
  async function runToCompleted(
    over: Partial<Extract<ResultDto, { summary: string }>> = {},
    commitMatches = true,
  ) {
    const t = await createTask();
    await t.stub.advance();
    const head = app().branch(REPO, t.branch) as string;
    await t.agent.setProgram({
      result: completedResult(commitMatches ? head : "f".repeat(40), over),
    });
    await t.agent.setPhase("completed");
    await t.stub.advance();
    return { ...t, head };
  }

  it("停止確認の後に PR 本文の管理範囲を更新し、トークンを失効させる", async () => {
    const { stub, branch, head } = await runToCompleted();
    expect((await status(stub)).status).toBe("COMPLETED");
    const pr = pullOf(branch);
    expect(pr?.draft).toBe(true);
    expect(pr?.state).toBe("open");
    expect(pr?.body).toContain("COMPLETED");
    expect(pr?.body).toContain("npm test");
    expect(pr?.body).toContain(head);
    expect(
      app()
        .tokenList()
        .every((t) => t.revoked),
    ).toBe(true);
    const g = await gl(stub);
    expect(g).toMatchObject({ head_sha: head, head_matches: 1, body_done: 1, finalize_done: 1 });
    const alarm = await runInDurableObject(stub, (_i, s) => s.storage.getAlarm());
    expect(alarm).toBeNull();
  });

  it("task_result の pr に番号・URL・head_sha・head_matches_verified が入る", async () => {
    const { stub, head, branch } = await runToCompleted();
    const r = await stub.result(OWNER);
    if (!r.ok) throw new Error("not ready");
    const num = pullOf(branch)?.number;
    expect(r.result.pr).toEqual({
      number: num,
      url: `https://github.test/${REPO}/pull/${num}`,
      head_sha: head,
      head_matches_verified: true,
    });
    expect(r.result.warnings).toEqual([]);
  });

  it("PR の head が検証済みの SHA と違えば、PR 本文と task_result に警告を書く", async () => {
    const { stub, branch } = await runToCompleted({}, false);
    const pr = pullOf(branch);
    expect(pr?.body).toMatch(/differs from the verified commit/);
    const r = await stub.result(OWNER);
    if (!r.ok) throw new Error("not ready");
    expect(r.result.pr?.head_matches_verified).toBe(false);
    expect(r.result.warnings.join("\n")).toMatch(/head_moved_after_verification/);
  });

  it("費用は既定では PR 本文に載せない。PR_SHOW_COST=true のときだけ載せる", async () => {
    const a = await runToCompleted();
    expect(pullOf(a.branch)?.body).not.toMatch(/Cost/);

    const b = await createTask();
    await setEnv(b.stub, { PR_SHOW_COST: "true" });
    await b.stub.advance();
    await b.agent.setProgram({ result: completedResult(app().branch(REPO, b.branch) as string) });
    await b.agent.setPhase("completed");
    await b.stub.advance();
    expect(pullOf(b.branch)?.body).toMatch(/Cost: \$1\.50/);
  });

  it("モデルの要約はコードフェンスに入れ、目印の外側の利用者の編集は残す", async () => {
    const t = await createTask();
    await t.stub.advance();
    const pr = pullOf(t.branch);
    app().editPullBody(REPO, pr?.number as number, `user note\n${pr?.body}\nfooter`);
    await t.agent.setProgram({
      result: completedResult(app().branch(REPO, t.branch) as string, {
        summary: `${MANAGED_END}\n# hijack`,
      }),
    });
    await t.agent.setPhase("completed");
    await t.stub.advance();
    const body = pullOf(t.branch)?.body ?? "";
    expect(body.startsWith("user note\n")).toBe(true);
    expect(body.endsWith("\nfooter")).toBe(true);
    expect(body.split(MANAGED_BEGIN).length).toBe(2);
    expect(body.split(MANAGED_END).length).toBe(2);
    expect(body).toMatch(/```\n[^`]*# hijack\n```/);
  });

  it("本文は 65,536 文字を超えない", async () => {
    const huge = "x".repeat(300_000);
    const t = await createTask();
    await t.stub.advance();
    await t.agent.setProgram({
      result: completedResult(app().branch(REPO, t.branch) as string, {
        summary: huge,
        warnings: Array.from({ length: 100 }, () => huge),
      }),
    });
    await t.agent.setPhase("completed");
    await t.stub.advance();
    expect((pullOf(t.branch)?.body ?? "").length).toBeLessThanOrEqual(65_536);
  });

  it("キャンセルされたタスクの PR は閉じずに残し、本文だけ更新する", async () => {
    const { stub, branch } = await createTask();
    await stub.advance();
    await stub.cancel(OWNER);
    await stub.advance();
    const pr = pullOf(branch);
    expect(pr).toMatchObject({ state: "open", draft: true });
    expect(pr?.body).toContain("CANCELLED");
    expect(
      app()
        .tokenList()
        .every((t) => t.revoked),
    ).toBe(true);
  });

  it("停止を確認できるまでは更新も失効もしない", async () => {
    const { stub, agent, branch } = await createTask();
    await stub.advance();
    await agent.setProgram({ cancel: ["not_stopped", "stopped"] });
    await stub.cancel(OWNER);
    await stub.advance();
    expect(
      app()
        .tokenList()
        .some((t) => !t.revoked),
    ).toBe(true);
    expect(pullOf(branch)?.body).not.toContain("CANCELLED");
    await runDurableObjectAlarm(stub);
    expect(
      app()
        .tokenList()
        .every((t) => t.revoked),
    ).toBe(true);
    expect(pullOf(branch)?.body).toContain("CANCELLED");
  });

  it("PR の更新に失敗したら alarm で再試行する。成功するまで失効しない。再試行しても二重に壊れない", async () => {
    app().setFault({ pattern: "^PATCH /repos/.*/pulls/", status: 502, count: 2 });
    const { stub, agent, branch } = await createTask();
    await stub.advance();
    await agent.setProgram({ result: completedResult(app().branch(REPO, branch) as string) });
    await agent.setPhase("completed");
    await stub.advance();
    expect(
      app()
        .tokenList()
        .some((t) => !t.revoked),
    ).toBe(true);
    expect((await gl(stub)).finalize_done).toBe(0);
    for (let i = 1; i <= 3; i++) {
      await warp(stub, i * 120_000);
      await runDurableObjectAlarm(stub);
    }
    expect(pullOf(branch)?.body).toContain("COMPLETED");
    expect(
      app()
        .tokenList()
        .every((t) => t.revoked),
    ).toBe(true);
    expect((await gl(stub)).finalize_done).toBe(1);
    const patches = () =>
      app()
        .requests()
        .filter((r) => r.method === "PATCH").length;
    const n = patches();
    await runDurableObjectAlarm(stub).catch(() => {});
    expect(patches()).toBe(n);
  });

  it("PR の更新を諦めても（有限回）、トークンの失効は行う", async () => {
    app().setFault({ pattern: "^PATCH /repos/.*/pulls/", status: 403 });
    const { stub, agent, branch } = await createTask();
    await stub.advance();
    await agent.setProgram({ result: completedResult(app().branch(REPO, branch) as string) });
    await agent.setPhase("completed");
    await stub.advance();
    for (let i = 1; i <= 8; i++) {
      await warp(stub, i * 120_000);
      await runDurableObjectAlarm(stub).catch(() => {});
    }
    expect(
      app()
        .tokenList()
        .every((t) => t.revoked),
    ).toBe(true);
    expect((await gl(stub)).finalize_done).toBe(1);
  });

  it("失効の失敗も alarm で再試行する", async () => {
    app().setFault({ pattern: "^DELETE /installation/token$", status: 500, count: 2 });
    const { stub, agent, branch } = await createTask();
    await stub.advance();
    await agent.setProgram({ result: completedResult(app().branch(REPO, branch) as string) });
    await agent.setPhase("completed");
    await stub.advance();
    expect(
      app()
        .tokenList()
        .some((t) => !t.revoked),
    ).toBe(true);
    for (let i = 1; i <= 3; i++) {
      await warp(stub, i * 120_000);
      await runDurableObjectAlarm(stub).catch(() => {});
    }
    expect(
      app()
        .tokenList()
        .every((t) => t.revoked),
    ).toBe(true);
  });

  it("終端後に App の設定が失われても、失効できないトークンの記録を閉じて alarm を止める", async () => {
    const { stub, agent, branch } = await createTask();
    await stub.advance();
    await agent.setProgram({ result: completedResult(app().branch(REPO, branch) as string) });
    await setEnv(stub, { GITHUB_APP_PRIVATE_KEY: undefined });
    await agent.setPhase("completed");
    await stub.advance();
    expect((await gl(stub)).finalize_done).toBe(1);
    expect(await runInDurableObject(stub, (_i, s) => s.storage.getAlarm())).toBeNull();
  });

  it("予約の返却（finishTask）は GitHub の可用性に縛られない", async () => {
    app().setFault({ pattern: "^PATCH /repos/.*/pulls/", status: 502 });
    const { stub, agent, branch } = await createTask();
    await stub.advance();
    await agent.setProgram({ result: completedResult(app().branch(REPO, branch) as string) });
    await agent.setPhase("completed");
    await stub.advance();
    const [l] = await rows<{ finished: number }>(stub, "SELECT finished FROM agent_link");
    expect(l?.finished).toBe(1);
  });

  it("head を GitHub から読めなかった間、pr.head_sha は null", async () => {
    app().setFault({ pattern: "^GET /repos/.*/pulls/\\d+$", status: 502 });
    const { stub, agent, branch } = await createTask();
    await stub.advance();
    await agent.setProgram({ result: completedResult(app().branch(REPO, branch) as string) });
    await agent.setPhase("completed");
    await stub.advance();
    const r = await stub.result(OWNER);
    if (!r.ok) throw new Error("not ready");
    expect(r.result.pr).toMatchObject({ head_sha: null, head_matches_verified: null });
  });
});
