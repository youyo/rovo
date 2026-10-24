import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createTaskService } from "../../src/tasks/service";
import { FakeGitHubFetch, installFakeGitHub } from "./fake-github-fetch";
import { newUserId } from "./helpers";
import { app, audits, createTask, REPO, runToCompleted, type TaskStub } from "./pr-helpers";

// task_pr_ready / task_pr_merge のユースケース層（D9）。TaskDO（条件・対象）→ UserDO（利用者のトークンで GitHub）→ TaskDO（記録・監査）。

/**
 * 完了時に rovo が PR を自動で Ready にする（Installation Token の GraphQL）。task_pr_ready を試すテストは Draft のままにしたいので、
 * autoReady: false（既定）のときは、その 1 回の GraphQL を失敗させる（fail-soft で Draft のまま COMPLETED になる）。
 */
async function world(overrides: Record<string, unknown> = {}, autoReady = false) {
  const uid = newUserId();
  if (!autoReady) app().setFault({ pattern: "^POST /graphql$", status: 502, count: 1 });
  const gh = new FakeGitHubFetch();
  gh.user = { id: uid, login: "alice" };
  gh.app = app();
  await installFakeGitHub(uid, gh);
  const t = await runToCompleted(overrides, uid);
  const service = createTaskService(env);
  const principal = { githubUserId: uid, login: "alice" };
  const pull = () =>
    app()
      .pulls(REPO)
      .find((p) => p.head === t.branch);
  const githubCalls = () =>
    app()
      .requests()
      .filter((r) => r.auth === "user");
  const auditOf = async (stub: TaskStub, event: string) =>
    (await audits(stub)).filter((a) => a.event === event);
  return { uid, gh, t, service, principal, pull, githubCalls, auditOf };
}

describe("service.prReady", () => {
  it("COMPLETED のタスクの Draft PR を Ready にする。応答に pr・draft・review_policy・next_steps、pr_ready を監査", async () => {
    const w = await world();
    const r = await w.service.prReady(w.principal, { task_id: w.t.id });
    expect(r).toMatchObject({
      ok: true,
      value: {
        task_id: w.t.id,
        pr_number: w.pull()?.number,
        pr_url: expect.stringMatching(/\/pull\/\d+$/),
        draft: false,
        changed: true,
        review_policy: "client_review",
        next_steps: expect.stringContaining("全体のテスト"),
      },
    });
    expect(w.pull()?.draft).toBe(false);
    expect(await w.auditOf(w.t.stub, "pr_ready")).toEqual([
      expect.objectContaining({
        taskId: w.t.id,
        userId: w.uid,
        caller: "parent",
        review_policy: "client_review",
      }),
    ]);
    // task_result にも反映される
    const res = await w.service.result(w.principal, w.t.id);
    expect(res.ok && res.value.pr).toMatchObject({ draft: false });
  });

  it("冪等: 2 回目も成功（changed: false）。GitHub の GraphQL は 1 回だけ。監査も 1 回", async () => {
    const w = await world();
    await w.service.prReady(w.principal, { task_id: w.t.id });
    const again = await w.service.prReady(w.principal, { task_id: w.t.id });
    expect(again).toMatchObject({ ok: true, value: { draft: false, changed: false } });
    expect(w.githubCalls().filter((c) => c.path === "/graphql")).toHaveLength(1);
    expect(await w.auditOf(w.t.stub, "pr_ready")).toHaveLength(1);
  });

  it("所有者でなければ not_found で、GitHub を呼ばない。ULID でない task_id も not_found", async () => {
    const w = await world();
    const other = { githubUserId: w.uid + 1, login: "mallory" };
    expect(await w.service.prReady(other, { task_id: w.t.id })).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
    expect(await w.service.prReady(w.principal, { task_id: "../../x" })).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
    expect(w.githubCalls()).toHaveLength(0);
    expect(w.pull()?.draft).toBe(true);
  });

  it("FAILED のタスクは conflict（GitHub を呼ばない）。実行中は not_ready", async () => {
    const uid = newUserId();
    const gh = new FakeGitHubFetch();
    gh.user = { id: uid, login: "alice" };
    gh.app = app();
    await installFakeGitHub(uid, gh);
    const failed = await createTask({}, uid);
    await failed.stub.advance();
    await failed.agent.setPhase("failed", "boom");
    await failed.stub.advance();
    const service = createTaskService(env);
    const principal = { githubUserId: uid, login: "alice" };
    expect(await service.prReady(principal, { task_id: failed.id })).toMatchObject({
      ok: false,
      error: { code: "conflict" },
    });
    const running = await createTask({}, uid);
    await running.stub.advance();
    expect(await service.prReady(principal, { task_id: running.id })).toMatchObject({
      ok: false,
      error: { code: "not_ready" },
    });
    expect(
      app()
        .requests()
        .filter((r) => r.auth === "user"),
    ).toHaveLength(0);
  });

  it("入力の他の項目（repository・PR 番号など）は無視され、タスクの記録の PR だけを操作する", async () => {
    const w = await world();
    // 別の PR（人の PR）を用意する。呼び出し元が指定しても操作されない
    const sha = await app().addCommit(
      REPO,
      "0123456789abcdef0123456789abcdef01234567",
      "human work",
    );
    app().setBranch(REPO, "feature/human", sha);
    const humanPr = app().seedPull(REPO, { head: "feature/human", base: "main", draft: true });
    const r = await w.service.prReady(w.principal, {
      task_id: w.t.id,
      repository: "evil/repo",
      pr_number: humanPr,
      number: humanPr,
    });
    expect(r.ok).toBe(true);
    expect(
      app()
        .pulls(REPO)
        .find((p) => p.number === humanPr)?.draft,
    ).toBe(true);
    expect(w.pull()?.draft).toBe(false);
  });

  it("GitHub が拒否したら、そのコードで返し、pr_denied を監査する（Pull requests の write が無い App）", async () => {
    const w = await world();
    app().setUserPermissions({ contents: "write", pull_requests: "read" });
    const r = await w.service.prReady(w.principal, { task_id: w.t.id });
    expect(r).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(await w.auditOf(w.t.stub, "pr_denied")).toEqual([
      expect.objectContaining({ kind: "ready", reason: "forbidden" }),
    ]);
    expect(w.pull()?.draft).toBe(true);
  });

  it("GitHub が一時的に使えないときは upstream_unavailable（retry_after_seconds 付き）で、拒否の監査は出さない", async () => {
    const w = await world();
    app().setFault({ pattern: "^POST /graphql$", status: 502 });
    const r = await w.service.prReady(w.principal, { task_id: w.t.id });
    expect(r).toMatchObject({
      ok: false,
      error: { code: "upstream_unavailable", retry_after_seconds: 30 },
    });
    expect(await w.auditOf(w.t.stub, "pr_denied")).toHaveLength(0);
  });
});

describe("service.prMerge", () => {
  // 完了時に自動で Ready になっている（checks は付いていない）
  async function readyWorld(overrides: Record<string, unknown> = {}) {
    const w = await world(overrides, true);
    expect(w.pull()?.draft).toBe(false);
    return w;
  }

  it("Ready・head が検証済み・check が無い（review_policy は client_review）: 検証済みの sha でマージする（既定は squash）。pr_merged を監査", async () => {
    const w = await readyWorld();
    const head = app().branch(REPO, w.t.branch) as string;
    const r = await w.service.prMerge(w.principal, { task_id: w.t.id });
    expect(r).toMatchObject({
      ok: true,
      value: {
        task_id: w.t.id,
        merged: true,
        already_merged: false,
        merge_method: "squash",
        merge_sha: head,
        branch_deleted: null,
        warnings: [],
        review_policy: "client_review",
        next_steps: expect.stringContaining("マージした"),
      },
    });
    expect(w.pull()).toMatchObject({ merged: true, mergeMethod: "squash", mergeSha: head });
    expect(app().branch(REPO, w.t.branch)).toBe(head); // ブランチは残す（既定）
    expect(await w.auditOf(w.t.stub, "pr_merged")).toEqual([
      expect.objectContaining({
        taskId: w.t.id,
        userId: w.uid,
        review_policy: "client_review",
        kind: "merge",
      }),
    ]);
    const res = await w.service.result(w.principal, w.t.id);
    expect(res.ok && res.value.pr).toMatchObject({ merged: true, draft: false });
  });

  it("merge_method と delete_branch を指定できる", async () => {
    const w = await readyWorld();
    const r = await w.service.prMerge(w.principal, {
      task_id: w.t.id,
      merge_method: "rebase",
      delete_branch: true,
    });
    expect(r).toMatchObject({
      ok: true,
      value: { merge_method: "rebase", branch_deleted: true },
    });
    expect(w.pull()?.mergeMethod).toBe("rebase");
    expect(app().branch(REPO, w.t.branch)).toBeNull();
  });

  it("ブランチを消せなかった場合も、マージは成功として返す（warnings）", async () => {
    const w = await readyWorld();
    app().setFault({ pattern: "^DELETE ", status: 403, message: "nope" });
    const r = await w.service.prMerge(w.principal, { task_id: w.t.id, delete_branch: true });
    expect(r).toMatchObject({ ok: true, value: { merged: true, branch_deleted: false } });
    expect(r.ok && (r.value as { warnings: string[] }).warnings[0]).toContain(
      "branch_delete_failed",
    );
  });

  it("Draft のままなら conflict で、task_pr_ready を先に呼ぶよう返す（マージしない）", async () => {
    const w = await world();
    const r = await w.service.prMerge(w.principal, { task_id: w.t.id });
    expect(r).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(!r.ok && r.error.message).toContain("task_pr_ready");
    expect(w.pull()?.merged).toBe(false);
    expect(await w.auditOf(w.t.stub, "pr_denied")).toEqual([
      expect.objectContaining({ reason: "pr_draft" }),
    ]);
  });

  it("ブランチ保護で拒否されたら merge_blocked と GitHub の理由を返し、pr_denied を監査", async () => {
    const w = await readyWorld();
    app().setMergeBlock(REPO, 'Required status check "ci" is expected.');
    const r = await w.service.prMerge(w.principal, { task_id: w.t.id });
    expect(r).toMatchObject({ ok: false, error: { code: "merge_blocked" } });
    expect(!r.ok && r.error.message).toContain('Required status check "ci" is expected.');
    expect(w.pull()?.merged).toBe(false);
    expect(await w.auditOf(w.t.stub, "pr_denied")).toEqual([
      expect.objectContaining({
        kind: "merge",
        reason: "merge_blocked",
        review_policy: "client_review",
      }),
    ]);
    // 保護が外れれば同じ呼び出しで通る
    app().setMergeBlock(REPO, null);
    expect((await w.service.prMerge(w.principal, { task_id: w.t.id })).ok).toBe(true);
  });

  it("検証後にブランチが動いたら head_moved でマージしない", async () => {
    const w = await readyWorld();
    const head = app().branch(REPO, w.t.branch) as string;
    app().setBranch(REPO, w.t.branch, await app().addCommit(REPO, head, "pushed later"));
    const r = await w.service.prMerge(w.principal, { task_id: w.t.id });
    expect(r).toMatchObject({ ok: false, error: { code: "head_moved" } });
    expect(w.pull()?.merged).toBe(false);
  });

  it("冪等: マージ済みなら成功（already_merged: true）。PUT は 1 回だけ", async () => {
    const w = await readyWorld();
    await w.service.prMerge(w.principal, { task_id: w.t.id });
    const again = await w.service.prMerge(w.principal, { task_id: w.t.id });
    expect(again).toMatchObject({ ok: true, value: { merged: true, already_merged: true } });
    expect(w.githubCalls().filter((c) => c.method === "PUT")).toHaveLength(1);
    expect(await w.auditOf(w.t.stub, "pr_merged")).toHaveLength(1);
  });

  it("入力の検証: merge_method は squash / merge / rebase、delete_branch は真偽値。違えば invalid_input（GitHub を呼ばない）", async () => {
    const w = await readyWorld();
    const before = w.githubCalls().length;
    for (const bad of [{ merge_method: "fast-forward" }, { delete_branch: "yes" }]) {
      expect(await w.service.prMerge(w.principal, { task_id: w.t.id, ...bad })).toMatchObject({
        ok: false,
        error: { code: "invalid_input" },
      });
    }
    expect(w.githubCalls()).toHaveLength(before);
  });

  it("所有者でなければ not_found で、GitHub を呼ばない", async () => {
    const w = await readyWorld();
    const before = w.githubCalls().length;
    expect(
      await w.service.prMerge({ githubUserId: w.uid + 1, login: "x" }, { task_id: w.t.id }),
    ).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(w.githubCalls()).toHaveLength(before);
    expect(w.pull()?.merged).toBe(false);
  });

  it("入力の他の項目（repository・PR 番号・sha）は無視される: 呼び出し元は対象の PR も sha も選べない", async () => {
    const w = await readyWorld();
    const sha = await app().addCommit(
      REPO,
      "0123456789abcdef0123456789abcdef01234567",
      "human work",
    );
    app().setBranch(REPO, "feature/human", sha);
    const humanPr = app().seedPull(REPO, { head: "feature/human", base: "main", draft: false });
    const r = await w.service.prMerge(w.principal, {
      task_id: w.t.id,
      repository: "evil/repo",
      pr_number: humanPr,
      number: humanPr,
      sha,
    });
    expect(r.ok).toBe(true);
    expect(
      app()
        .pulls(REPO)
        .find((p) => p.number === humanPr)?.merged,
    ).toBe(false);
    expect(w.pull()?.merged).toBe(true);
  });
});

describe("service.prMerge: PR の head に付いた GitHub の check", () => {
  async function checksWorld() {
    const w = await world({}, true);
    const head = app().branch(REPO, w.t.branch) as string;
    return { ...w, head };
  }
  const blocked = async (
    w: Awaited<ReturnType<typeof checksWorld>>,
    reason: "checks_failing" | "checks_pending",
  ) => {
    const r = await w.service.prMerge(w.principal, { task_id: w.t.id });
    expect(r).toMatchObject({ ok: false, error: { code: "merge_blocked" } });
    expect(!r.ok && r.error.message).toContain(reason);
    expect(w.pull()?.merged).toBe(false);
    expect(w.githubCalls().filter((c) => c.method === "PUT")).toHaveLength(0);
    expect(await w.auditOf(w.t.stub, "pr_denied")).toEqual([
      expect.objectContaining({ kind: "merge", reason }),
    ]);
  };

  it("check が 1 つも無ければ通す（statuses が 0 件の pending は「無い」とみなす）", async () => {
    const w = await checksWorld();
    expect((await w.service.prMerge(w.principal, { task_id: w.t.id })).ok).toBe(true);
    expect(w.pull()?.merged).toBe(true);
  });

  it("check run も commit status もすべて成功（success / skipped / neutral）なら通す", async () => {
    const w = await checksWorld();
    app().setCheckRuns(REPO, w.head, [
      { name: "ci", status: "completed", conclusion: "success" },
      { name: "lint", status: "completed", conclusion: "skipped" },
      { name: "info", status: "completed", conclusion: "neutral" },
    ]);
    app().setCommitStatuses(REPO, w.head, [{ context: "legacy", state: "success" }]);
    expect((await w.service.prMerge(w.principal, { task_id: w.t.id })).ok).toBe(true);
    expect(w.pull()?.merged).toBe(true);
  });

  it("check run が失敗（failure）なら checks_failing で拒否する。直って再実行されれば同じ呼び出しで通る", async () => {
    const w = await checksWorld();
    app().setCheckRuns(REPO, w.head, [
      { name: "ci", status: "completed", conclusion: "failure" },
      { name: "lint", status: "completed", conclusion: "success" },
    ]);
    await blocked(w, "checks_failing");
    app().setCheckRuns(REPO, w.head, [{ name: "ci", status: "completed", conclusion: "success" }]);
    expect((await w.service.prMerge(w.principal, { task_id: w.t.id })).ok).toBe(true);
  });

  it("check run が実行中（in_progress / queued）なら checks_pending で拒否する", async () => {
    const w = await checksWorld();
    app().setCheckRuns(REPO, w.head, [{ name: "ci", status: "in_progress" }]);
    await blocked(w, "checks_pending");
  });

  it("commit status が failure なら checks_failing で拒否する（check run は成功）", async () => {
    const w = await checksWorld();
    app().setCheckRuns(REPO, w.head, [{ name: "ci", status: "completed", conclusion: "success" }]);
    app().setCommitStatuses(REPO, w.head, [{ context: "legacy-ci", state: "failure" }]);
    await blocked(w, "checks_failing");
  });

  it("commit status が pending なら checks_pending で拒否する", async () => {
    const w = await checksWorld();
    app().setCommitStatuses(REPO, w.head, [{ context: "legacy-ci", state: "pending" }]);
    await blocked(w, "checks_pending");
  });

  it("別の commit に付いた check は見ない（PR の head の SHA だけ）", async () => {
    const w = await checksWorld();
    app().setCheckRuns(REPO, "f".repeat(40), [
      { name: "ci", status: "completed", conclusion: "failure" },
    ]);
    expect((await w.service.prMerge(w.principal, { task_id: w.t.id })).ok).toBe(true);
  });

  it("check を読めない（GitHub が 403・5xx・ネットワークの失敗）ときは、マージを止めずに通す。応答の warnings に checks_unreadable を入れる", async () => {
    for (const status of [403, 404, 502]) {
      const w = await checksWorld();
      app().setFault({ pattern: "check-runs$", status, count: 1 });
      const r = await w.service.prMerge(w.principal, { task_id: w.t.id });
      expect(r, String(status)).toMatchObject({ ok: true, value: { merged: true } });
      const warnings = r.ok ? r.value.warnings : [];
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("checks_unreadable");
      expect(warnings[0]).toContain("Checks");
      expect(w.pull()?.merged).toBe(true);
    }
  });

  it("commit status だけ読めなくても通し、警告を付ける", async () => {
    const w = await checksWorld();
    app().setFault({ pattern: "/status$", status: 500, count: 1 });
    const r = await w.service.prMerge(w.principal, { task_id: w.t.id });
    expect(r).toMatchObject({ ok: true, value: { merged: true } });
    expect(r.ok && r.value.warnings[0]).toContain("checks_unreadable");
  });

  it("読めたときは警告を付けない（check が無い・成功）", async () => {
    const w = await checksWorld();
    const r = await w.service.prMerge(w.principal, { task_id: w.t.id });
    expect(r).toMatchObject({ ok: true, value: { warnings: [] } });
  });

  it("App に Checks / Commit statuses の read 権限が無い（check を読めない）ときも通す。警告で権限の追加を案内する", async () => {
    const w = await checksWorld();
    app().setUserPermissions({ contents: "write", pull_requests: "write" });
    const r = await w.service.prMerge(w.principal, { task_id: w.t.id });
    expect(r).toMatchObject({ ok: true, value: { merged: true } });
    expect(r.ok && r.value.warnings[0]).toContain("checks_unreadable");
    expect(w.pull()?.merged).toBe(true);
  });

  it("マージ済みの冪等な再実行では check を見ない（すでに終わっている）", async () => {
    const w = await checksWorld();
    await w.service.prMerge(w.principal, { task_id: w.t.id });
    app().setCheckRuns(REPO, w.head, [{ name: "ci", status: "completed", conclusion: "failure" }]);
    expect(await w.service.prMerge(w.principal, { task_id: w.t.id })).toMatchObject({
      ok: true,
      value: { already_merged: true },
    });
  });
});
