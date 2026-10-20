import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createTaskService } from "../../src/tasks/service";
import { FakeGitHubFetch, installFakeGitHub } from "./fake-github-fetch";
import { newUserId } from "./helpers";
import { app, audits, createTask, REPO, runToCompleted, type TaskStub } from "./pr-helpers";

// task_pr_ready / task_pr_merge のユースケース層（D9）。TaskDO（条件・対象）→ UserDO（利用者のトークンで GitHub）→ TaskDO（記録・監査）。

async function world(overrides: Record<string, unknown> = {}) {
  const uid = newUserId();
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
  it("COMPLETED のタスクの Draft PR を Ready にする。応答に pr・draft・merge_policy・next_steps、pr_ready を監査", async () => {
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
        merge_policy: "human_review",
        next_steps: expect.stringContaining("人のレビューを待つ"),
      },
    });
    expect(w.pull()?.draft).toBe(false);
    expect(await w.auditOf(w.t.stub, "pr_ready")).toEqual([
      expect.objectContaining({
        taskId: w.t.id,
        userId: w.uid,
        caller: "parent",
        merge_policy: "human_review",
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
  async function readyWorld(overrides: Record<string, unknown> = { merge_policy: "agent_merge" }) {
    const w = await world(overrides);
    const r = await w.service.prReady(w.principal, { task_id: w.t.id });
    expect(r.ok).toBe(true);
    return w;
  }

  it("agent_merge・Ready・head が検証済み: 検証済みの sha でマージする（既定は squash）。pr_merged を監査", async () => {
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
        merge_policy: "agent_merge",
        next_steps: expect.stringContaining("マージした"),
      },
    });
    expect(w.pull()).toMatchObject({ merged: true, mergeMethod: "squash", mergeSha: head });
    expect(app().branch(REPO, w.t.branch)).toBe(head); // ブランチは残す（既定）
    expect(await w.auditOf(w.t.stub, "pr_merged")).toEqual([
      expect.objectContaining({
        taskId: w.t.id,
        userId: w.uid,
        merge_policy: "agent_merge",
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

  it("human_review のタスクは forbidden。GitHub を一切呼ばず、pr_denied（policy_human_review）を監査", async () => {
    const w = await world({ merge_policy: "human_review" });
    await w.service.prReady(w.principal, { task_id: w.t.id });
    const before = w.githubCalls().length;
    const r = await w.service.prMerge(w.principal, { task_id: w.t.id });
    expect(r).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(w.githubCalls()).toHaveLength(before);
    expect(w.pull()?.merged).toBe(false);
    expect(await w.auditOf(w.t.stub, "pr_denied")).toEqual([
      expect.objectContaining({ kind: "merge", reason: "policy_human_review" }),
    ]);
  });

  it("Draft のままなら conflict で、task_pr_ready を先に呼ぶよう返す（マージしない）", async () => {
    const w = await world({ merge_policy: "agent_merge" });
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
        merge_policy: "agent_merge",
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
