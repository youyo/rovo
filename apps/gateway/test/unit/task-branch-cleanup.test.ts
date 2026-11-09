import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import type { BranchCleanupOutcome } from "../../src/tasks/task-do";
import { FP, fakeAgent, newUserId, sampleInput, taskStub, userStub } from "./helpers";
import {
  app,
  audits,
  clearTaskAlarms,
  completedResult,
  createTask,
  pushChildCommit,
  REPO,
  runToCompleted,
  type TaskStub,
} from "./pr-helpers";

// issue #185「3. 削除の判断」「4. 監査とタスク記録」: TaskDO.cleanupBranch（1 タスクの掃除を判断して実行する RPC）。
// 誰がいつ呼ぶか（sweep・Cron）は別のタスク。ここでは判断の順・理由コード・記録・監査・トークンの失効を確かめる。

afterEach(clearTaskAlarms);

const extraStubs: TaskStub[] = [];
afterEach(async () => {
  const stubs = extraStubs.splice(0);
  await Promise.all(
    stubs.map((s) => runInDurableObject(s, (_i, state) => state.storage.deleteAlarm())),
  );
});

type Cleanable = { cleanupBranch(): Promise<BranchCleanupOutcome> };
const cleanup = (stub: TaskStub): Promise<BranchCleanupOutcome> =>
  (stub as unknown as Cleanable).cleanupBranch();

const exec = (stub: TaskStub, q: string, ...b: unknown[]) =>
  runInDurableObject(stub, (_i, s) => {
    s.storage.sql.exec(q, ...b);
  });

const glOf = (stub: TaskStub) =>
  runInDurableObject(
    stub,
    (_i, s) =>
      s.storage.sql.exec("SELECT * FROM github_link").toArray()[0] as Record<string, unknown>,
  );

const cleanupAudits = async (stub: TaskStub) =>
  (await audits(stub)).filter((a) => a.event === "branch_cleanup");

/** Installation Token で呼んだ GitHub の要求の数（App の JWT・利用者のトークンは除く） */
const tokenCalls = () =>
  app()
    .requests()
    .filter((r) => r.auth === "token").length;

/** COMPLETED まで進め、終了処理（head_matches の記録）まで済んだタスク。PR の番号と最初の commit も返す */
async function finished(owner = newUserId()) {
  const t = await runToCompleted({}, owner);
  const gl = await glOf(t.stub);
  expect(gl.finalize_done).toBe(1);
  expect(gl.head_matches).toBe(1);
  return {
    ...t,
    owner,
    pr: gl.pr_number as number,
    prUrl: gl.pr_url as string,
    initial: gl.initial_sha as string,
  };
}

type Finished = Awaited<ReturnType<typeof finished>>;

/** 外（GitHub の UI など）でマージされた状態にする */
const mergeOutside = (t: Finished) => app().markMerged(REPO, t.pr);

describe("TaskDO.cleanupBranch: 判断の順と理由コード", () => {
  it("1: 終端でないタスクは not_finished（done: false）。記録も監査もしない", async () => {
    const t = await createTask({}, newUserId());
    const r = await cleanup(t.stub);
    expect(r).toEqual({ reason: "not_finished", done: false });
    const gl = await glOf(t.stub);
    expect(gl.branch_cleanup_reason).toBeNull();
    expect(gl.branch_cleanup_done).toBe(0);
    expect(await cleanupAudits(t.stub)).toEqual([]);
  });

  it("2: PR が無いタスクは no_pr（done）。GitHub を呼ばない", async () => {
    const t = await finished();
    await exec(t.stub, "UPDATE github_link SET pr_number = NULL, pr_url = NULL");
    const before = tokenCalls();
    expect(await cleanup(t.stub)).toEqual({ reason: "no_pr", done: true });
    expect(tokenCalls()).toBe(before);
  });

  it("2: branch が空（task_review のような作業ブランチを持たないタスク）も no_pr（done）", async () => {
    const t = await finished();
    await exec(t.stub, "UPDATE github_link SET branch = ''");
    expect(await cleanup(t.stub)).toEqual({ reason: "no_pr", done: true });
  });

  it("3: 記録がすでに branch_deleted = 1 なら deleted（done）。GitHub を呼ばない", async () => {
    const t = await finished();
    await exec(t.stub, "UPDATE github_link SET branch_deleted = 1");
    const before = tokenCalls();
    expect(await cleanup(t.stub)).toEqual({ reason: "deleted", done: true });
    expect(tokenCalls()).toBe(before);
    expect(app().branch(REPO, t.branch)).not.toBeNull();
  });

  it("4: delete_branch: false を明示したタスクは kept_by_request（done）。消さない", async () => {
    const t = await finished();
    mergeOutside(t);
    await exec(t.stub, "UPDATE github_link SET branch_kept_by_request = 1");
    expect(await cleanup(t.stub)).toEqual({ reason: "kept_by_request", done: true });
    expect(app().branch(REPO, t.branch)).not.toBeNull();
  });

  it("6: head_matches_verified が false なら head_not_verified（done）。消さない", async () => {
    const t = await finished();
    mergeOutside(t);
    await exec(t.stub, "UPDATE github_link SET head_matches = 0");
    expect(await cleanup(t.stub)).toEqual({ reason: "head_not_verified", done: true });
    expect(app().branch(REPO, t.branch)).not.toBeNull();
  });

  it("6: 空の PR を閉じたタスク（closed_empty）は initial_sha を head として使い、消せる", async () => {
    const t = await finished();
    // 変更なしで終わった状態の再現: ブランチの先頭が初期コミットのまま、PR は rovo が閉じた
    app().setBranch(REPO, t.branch, t.initial);
    app().closePull(REPO, t.pr);
    await exec(t.stub, "UPDATE github_link SET head_matches = 0, closed_empty = 1");
    expect(await cleanup(t.stub)).toEqual({ reason: "deleted", done: true });
    expect(app().branch(REPO, t.branch)).toBeNull();
  });

  it("7: installation_id が無いタスクは app_unavailable（done: false）", async () => {
    const t = await finished();
    mergeOutside(t);
    await exec(t.stub, "UPDATE task SET installation_id = NULL");
    expect(await cleanup(t.stub)).toEqual({ reason: "app_unavailable", done: false });
    expect(app().branch(REPO, t.branch)).not.toBeNull();
  });

  it("7: Installation Token を発行できない（403）なら app_unavailable（done: false）", async () => {
    const t = await finished();
    mergeOutside(t);
    app().setFault({
      pattern: "^POST /app/installations/\\d+/access_tokens$",
      status: 403,
      count: 1,
    });
    expect(await cleanup(t.stub)).toEqual({ reason: "app_unavailable", done: false });
    expect(app().branch(REPO, t.branch)).not.toBeNull();
  });

  it("8: PR の head のブランチが記録と違えば pr_mismatch（done）。消さない", async () => {
    const t = await finished();
    mergeOutside(t);
    const other = `other/${t.id}`;
    app().setBranch(REPO, other, t.head);
    await exec(t.stub, "UPDATE github_link SET branch = ?", other);
    expect(await cleanup(t.stub)).toEqual({ reason: "pr_mismatch", done: true });
    expect(app().branch(REPO, other)).not.toBeNull();
  });

  it("8: PR が open なら pr_open（done: false）。消さない", async () => {
    const t = await finished();
    expect(await cleanup(t.stub)).toEqual({ reason: "pr_open", done: false });
    expect(app().branch(REPO, t.branch)).not.toBeNull();
  });

  it("9: そのブランチを base にした open な PR があれば base_of_open_pr（done: false）。消さない", async () => {
    const t = await finished();
    mergeOutside(t);
    const stacked = `stacked/${t.id}`;
    app().setBranch(REPO, stacked, t.head);
    app().seedPull(REPO, { head: stacked, base: t.branch });
    expect(await cleanup(t.stub)).toEqual({ reason: "base_of_open_pr", done: false });
    expect(app().branch(REPO, t.branch)).not.toBeNull();
    const q = app()
      .requests()
      .filter((r) => r.method === "GET" && r.path === "/repos/acme/widgets/pulls")
      .at(-1)?.query;
    expect(q).toMatchObject({ state: "open", base: t.branch, per_page: "1" });
  });

  it("10: ブランチがすでに無ければ already_gone（done）", async () => {
    const t = await finished();
    mergeOutside(t);
    app().deleteBranch(REPO, t.branch);
    expect(await cleanup(t.stub)).toEqual({ reason: "already_gone", done: true });
  });

  it("10: DELETE が 422 / 404（消す直前に他で消えた）なら already_gone（done）", async () => {
    for (const status of [422, 404]) {
      const t = await finished();
      mergeOutside(t);
      app().setFault({
        pattern: `^DELETE /repos/acme/widgets/git/refs/heads/agent/task-${t.id}$`,
        status,
        count: 1,
      });
      expect(await cleanup(t.stub)).toEqual({ reason: "already_gone", done: true });
    }
  });

  it("10: ブランチの先頭が記録した head と違えば head_changed（done）。消さない", async () => {
    const t = await finished();
    mergeOutside(t);
    const moved = await pushChildCommit(t.branch);
    expect(await cleanup(t.stub)).toEqual({ reason: "head_changed", done: true });
    expect(app().branch(REPO, t.branch)).toBe(moved);
  });

  it("10: 外でマージされ、先頭が記録どおりなら消して deleted（done）。記録に branch_deleted = 1・理由・done", async () => {
    const t = await finished();
    mergeOutside(t);
    expect(await cleanup(t.stub)).toEqual({ reason: "deleted", done: true });
    expect(app().branch(REPO, t.branch)).toBeNull();
    const gl = await glOf(t.stub);
    expect(gl).toMatchObject({
      branch_deleted: 1,
      branch_cleanup_reason: "deleted",
      branch_cleanup_done: 1,
    });
    // 2 回目は記録から deleted（GitHub を呼ばない）
    const before = tokenCalls();
    expect(await cleanup(t.stub)).toEqual({ reason: "deleted", done: true });
    expect(tokenCalls()).toBe(before);
  });

  it("10: マージせずに閉じた PR でも、先頭が記録どおりなら消す", async () => {
    const t = await finished();
    app().closePull(REPO, t.pr);
    expect(await cleanup(t.stub)).toEqual({ reason: "deleted", done: true });
    expect(app().branch(REPO, t.branch)).toBeNull();
  });

  it("消えたら task_status と task_result の pr に branch_deleted: true が付く", async () => {
    const t = await finished();
    const before = await t.stub.result(t.owner);
    expect(before.ok && before.value.pr).not.toHaveProperty("branch_deleted");
    mergeOutside(t);
    await cleanup(t.stub);
    const res = await t.stub.result(t.owner);
    expect(res.ok && res.value.pr).toMatchObject({ branch_deleted: true });
    const st = await t.stub.getStatus(t.owner);
    expect(st.ok && (st.task as { pr?: unknown }).pr).toMatchObject({ branch_deleted: true });
  });

  it("レート制限（403 + x-ratelimit-remaining: 0）は rate_limited: true・done: false。理由は前回の理由、無ければ rate_limited", async () => {
    const t = await finished();
    mergeOutside(t);
    app().setFault({
      pattern: `^GET /repos/acme/widgets/pulls/${t.pr}$`,
      status: 403,
      count: 1,
      headers: { "x-ratelimit-remaining": "0" },
      message: "API rate limit exceeded",
    });
    expect(await cleanup(t.stub)).toEqual({
      reason: "rate_limited",
      done: false,
      rate_limited: true,
    });

    const u = await finished();
    expect(await cleanup(u.stub)).toEqual({ reason: "pr_open", done: false });
    app().setFault({
      pattern: `^GET /repos/acme/widgets/pulls/${u.pr}$`,
      status: 429,
      count: 1,
    });
    expect(await cleanup(u.stub)).toEqual({ reason: "pr_open", done: false, rate_limited: true });
    expect(app().branch(REPO, u.branch)).not.toBeNull();
  });

  it("予期しない GitHub のエラー（500）は github_error（done: false）", async () => {
    const t = await finished();
    mergeOutside(t);
    app().setFault({ pattern: `^GET /repos/acme/widgets/pulls/${t.pr}$`, status: 500, count: 1 });
    expect(await cleanup(t.stub)).toEqual({ reason: "github_error", done: false });
    expect(app().branch(REPO, t.branch)).not.toBeNull();
  });
});

describe("TaskDO.cleanupBranch: 監査とトークン", () => {
  it("監査 branch_cleanup は理由が変わったときと done のときだけ出る。reason と done だけで、ブランチ名・PR の URL・トークンを出さない", async () => {
    const t = await finished();
    await cleanup(t.stub); // pr_open
    await cleanup(t.stub); // pr_open（同じ理由の再試行。出さない）
    let a = await cleanupAudits(t.stub);
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ reason: "pr_open", done: false });
    expect((await glOf(t.stub)).branch_cleanup_reason).toBe("pr_open");

    mergeOutside(t);
    await cleanup(t.stub); // deleted（done）
    a = await cleanupAudits(t.stub);
    expect(a).toHaveLength(2);
    expect(a[1]).toMatchObject({ reason: "deleted", done: true, taskId: t.id });
    for (const rec of a) {
      expect(Object.keys(rec).sort()).toEqual(
        ["audit", "caller", "done", "event", "reason", "taskId", "ts"].sort(),
      );
      const s = JSON.stringify(rec);
      expect(s).not.toContain(t.branch);
      expect(s).not.toContain("agent/task");
      expect(s).not.toContain(t.prUrl);
      expect(s).not.toMatch(/gh[a-z]_/);
    }
    // done の後の呼び出し（記録から deleted）では、もう出さない
    await cleanup(t.stub);
    expect(await cleanupAudits(t.stub)).toHaveLength(2);
  });

  it("done になった理由（kept_by_request など）も 1 回だけ監査に出る", async () => {
    const t = await finished();
    await exec(t.stub, "UPDATE github_link SET branch_kept_by_request = 1");
    await cleanup(t.stub);
    await cleanup(t.stub);
    const a = await cleanupAudits(t.stub);
    expect(a).toEqual([expect.objectContaining({ reason: "kept_by_request", done: true })]);
    expect(await glOf(t.stub)).toMatchObject({
      branch_cleanup_reason: "kept_by_request",
      branch_cleanup_done: 1,
      branch_deleted: 0,
    });
  });

  it("発行した Installation Token は、消せたときも途中で止まったときも失効される", async () => {
    for (const merge of [true, false]) {
      const t = await finished();
      if (merge) mergeOutside(t);
      const known = new Set(
        app()
          .tokenList()
          .map((x) => x.token),
      );
      const r = await cleanup(t.stub);
      expect(r.reason).toBe(merge ? "deleted" : "pr_open");
      const fresh = app()
        .tokenList()
        .filter((x) => !known.has(x.token));
      expect(fresh.length).toBeGreaterThan(0);
      expect(fresh.every((x) => x.revoked)).toBe(true);
      // DO の記録も失効済みで、暗号文は残さない
      const rows = await runInDurableObject(t.stub, (_i, s) =>
        s.storage.sql
          .exec<{ revoked: number; enc: string }>(
            "SELECT revoked, enc FROM git_token WHERE kind = 'cleanup'",
          )
          .toArray(),
      );
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((x) => x.revoked === 1 && x.enc === "")).toBe(true);
    }
  });

  it("GitHub のエラーで止まってもトークンは失効される", async () => {
    const t = await finished();
    mergeOutside(t);
    const known = new Set(
      app()
        .tokenList()
        .map((x) => x.token),
    );
    app().setFault({ pattern: `^GET /repos/acme/widgets/pulls/${t.pr}$`, status: 500, count: 1 });
    expect((await cleanup(t.stub)).reason).toBe("github_error");
    const fresh = app()
      .tokenList()
      .filter((x) => !known.has(x.token));
    expect(fresh.length).toBeGreaterThan(0);
    expect(fresh.every((x) => x.revoked)).toBe(true);
  });
});

describe("TaskDO.cleanupBranch: 積み足し（branch_lock・branch_chain）", () => {
  /** 積み足しを試すための利用者（同時実行の上限を上げる） */
  async function owner() {
    const id = newUserId();
    const user = userStub(id);
    await runInDurableObject(user, (i) => {
      const inst = i as unknown as { env: Record<string, unknown> };
      inst.env = { ...inst.env, MAX_CONCURRENT_TASKS: "4" };
    });
    return { id, user };
  }

  /** 根 R の PR に積み足した C1 を COMPLETED まで進める（task-continue.test.ts の continuedOn と同じ作り方） */
  async function continuedOn(o: Awaited<ReturnType<typeof owner>>, root: Finished) {
    const r = await o.user.reserve("c1", FP, { branch: root.branch, continueOf: root.id });
    if (!r.ok) throw new Error(`reserve failed: ${r.code}`);
    const id = r.task_id;
    const stub = taskStub(id);
    extraStubs.push(stub);
    const created = await stub.ensureCreated(sampleInput(id, o.id, { base_sha: root.head }));
    if (!created.ok) throw new Error(`ensureCreated failed: ${created.code}`);
    await runInDurableObject(stub, (i) => {
      const inst = i as unknown as { env: Record<string, unknown> };
      inst.env = { ...inst.env, ENVIRONMENT: "test" };
    });
    await stub.advance();
    await exec(stub, "UPDATE task SET continuation_of = ?, continuation_root = ?", root.id, root.id);
    await exec(
      stub,
      "UPDATE github_link SET branch = ?, pr_number = ?, pr_url = ?, initial_sha = ?",
      root.branch,
      root.pr,
      root.prUrl,
      root.head,
    );
    const head = await pushChildCommit(root.branch);
    await fakeAgent(id).setProgram({ result: completedResult(head) });
    await fakeAgent(id).setPhase("completed");
    for (let i = 0; i < 5; i++) {
      await stub.advance();
      if ((await stub.result(o.id)).ok) break;
    }
    expect((await stub.result(o.id)).ok).toBe(true);
    return { id, stub, head };
  }

  const lockRows = (o: Awaited<ReturnType<typeof owner>>) =>
    runInDurableObject(o.user, (_i, s) =>
      s.storage.sql.exec("SELECT branch, task_id FROM branch_lock").toArray(),
    );

  it("UserDO.branchCleanupGate: 行が無ければ ok（積み足しされていない PR）", async () => {
    const o = await owner();
    expect(await o.user.branchCleanupGate("agent/task-X", "X")).toBe("ok");
  });

  it("5: 同じブランチに積み足しの鍵（branch_lock）があれば continuation_active（done: false）。消さない", async () => {
    const o = await owner();
    const root = await finished(o.id);
    mergeOutside(root);
    const r = await o.user.reserve("c1", FP, { branch: root.branch, continueOf: root.id });
    expect(r.ok).toBe(true);
    expect(await lockRows(o)).toHaveLength(1);
    expect(await o.user.branchCleanupGate(root.branch, root.id)).toBe("continuation_active");
    const before = tokenCalls();
    expect(await cleanup(root.stub)).toEqual({ reason: "continuation_active", done: false });
    expect(tokenCalls()).toBe(before);
    expect(app().branch(REPO, root.branch)).not.toBeNull();
  });

  it("5: 連なりの末尾でないタスクは not_chain_tail（done）。末尾のタスクは消せる（deleted）", async () => {
    const o = await owner();
    const root = await finished(o.id);
    const c1 = await continuedOn(o, root);
    // 積み足しが終わって鍵が開いた状態（finishTask の後）
    await runInDurableObject(o.user, (_i, s) => {
      s.storage.sql.exec("DELETE FROM branch_lock WHERE branch = ?", root.branch);
    });
    mergeOutside(root);
    expect(await o.user.branchCleanupGate(root.branch, root.id)).toBe("not_chain_tail");
    expect(await o.user.branchCleanupGate(root.branch, c1.id)).toBe("ok");

    expect(await cleanup(root.stub)).toEqual({ reason: "not_chain_tail", done: true });
    expect(app().branch(REPO, root.branch)).toBe(c1.head);

    expect(await cleanup(c1.stub)).toEqual({ reason: "deleted", done: true });
    expect(app().branch(REPO, root.branch)).toBeNull();
    expect(await glOf(c1.stub)).toMatchObject({ branch_deleted: 1, branch_cleanup_done: 1 });
  });
});
