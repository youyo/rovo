import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { newTaskId, sampleInput, taskStub } from "./helpers";
import {
  app,
  audits,
  completedResult,
  createTask,
  pushChildCommit,
  REPO,
  runToCompleted,
  runToCompletedDraft,
  type TaskStub,
} from "./pr-helpers";

// TaskDO の PR 操作の入口（D9）: review_policy の保存、task_result の pr / review_policy、prContext（条件の判定）、recordPrAction（記録と監査）。

const OWNER = 801;
const gl = (stub: TaskStub) =>
  runInDurableObject(
    stub,
    (_i, s) =>
      s.storage.sql.exec("SELECT * FROM github_link").toArray()[0] as Record<string, unknown>,
  );

describe("review_policy の保存", () => {
  it("既定は client_review。task_status にも出る", async () => {
    const a = await createTask();
    const sa = await a.stub.getStatus(OWNER);
    expect(sa.ok && sa.task.review_policy).toBe("client_review");
    const b = await createTask({ review_policy: "client_review" });
    const sb = await b.stub.getStatus(OWNER);
    expect(sb.ok && sb.task.review_policy).toBe("client_review");
  });

  it("不正な review_policy の入力は invalid_input", async () => {
    const id = newTaskId();
    const r = await taskStub(id).ensureCreated(sampleInput(id, OWNER, { review_policy: "auto" }));
    expect(r).toEqual({ ok: false, code: "invalid_input" });
  });

  it("worker_review は review_model が無ければ invalid_input にする", async () => {
    const id = newTaskId();
    const r = await taskStub(id).ensureCreated(
      sampleInput(id, OWNER, { review_policy: "worker_review" }),
    );
    expect(r).toEqual({ ok: false, code: "invalid_input" });
  });

  it("旧 merge_policy を渡すと invalid_input（黙って無視しない）", async () => {
    for (const old of ["agent_merge", "human_review"]) {
      const id = newTaskId();
      const r = await taskStub(id).ensureCreated(sampleInput(id, OWNER, { merge_policy: old }));
      expect(r).toEqual({ ok: false, code: "invalid_input" });
    }
  });
});

describe("task_result: review_policy と pr の状態", () => {
  it("COMPLETED の結果に review_policy と pr.draft / pr.merged が入る。完了で自動の Ready になるので draft は false", async () => {
    const { stub, head } = await runToCompleted();
    const r = await stub.result(OWNER);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result.review_policy).toBe("client_review");
    expect(r.result.pr).toMatchObject({
      head_sha: head,
      head_matches_verified: true,
      draft: false,
      merged: false,
    });
  });

  it("PR が無い（作成前に失敗した）結果の review_policy も出る", async () => {
    const t = await createTask();
    await t.stub.cancel(OWNER);
    await t.stub.advance();
    const c = await t.stub.result(OWNER);
    expect(c.ok && c.result.review_policy).toBe("client_review");
  });
});

describe("prContext: 条件の判定", () => {
  it("ready: 所有者・COMPLETED・PR あり。リポジトリ・PR 番号・ブランチはタスクの記録から返る", async () => {
    const { id, stub, branch } = await runToCompleted();
    const pr = app()
      .pulls(REPO)
      .find((p) => p.head === branch);
    const r = await stub.prContext(OWNER, "ready");
    expect(r).toEqual({
      ok: true,
      repository: REPO,
      number: pr?.number,
      pr_url: expect.stringMatching(/\/pull\/\d+$/),
      branch,
      review_policy: "client_review",
      head_sha: expect.stringMatching(/^[0-9a-f]{40}$/),
    });
    expect(branch).toBe(`agent/task-${id}`);
  });

  it("所有者でなければ not_found（authz_denied を監査）", async () => {
    const { stub } = await runToCompleted();
    expect(await stub.prContext(OWNER + 1, "ready")).toMatchObject({
      ok: false,
      code: "not_found",
    });
    const audit = await audits(stub);
    expect(audit.some((a) => a.event === "authz_denied" && a.reason === "not_owner")).toBe(true);
  });

  it("終端でない（RUNNING）は not_ready、COMPLETED 以外の終端（CANCELLED）は conflict。どちらも pr_denied を監査", async () => {
    const running = await createTask();
    await running.stub.advance();
    expect(await running.stub.prContext(OWNER, "ready")).toMatchObject({
      ok: false,
      code: "not_ready",
    });
    const cancelled = await createTask();
    await cancelled.stub.advance();
    await cancelled.stub.cancel(OWNER);
    await cancelled.stub.advance();
    expect(await cancelled.stub.prContext(OWNER, "ready")).toMatchObject({
      ok: false,
      code: "conflict",
    });
    expect(await cancelled.stub.prContext(OWNER, "merge")).toMatchObject({
      ok: false,
      code: "conflict",
    });
    const audit = await audits(cancelled.stub);
    expect(audit.filter((a) => a.event === "pr_denied")).toEqual([
      expect.objectContaining({
        taskId: cancelled.id,
        userId: OWNER,
        caller: "parent",
        kind: "ready",
        reason: "not_completed",
        review_policy: "client_review",
      }),
      expect.objectContaining({ kind: "merge", reason: "not_completed" }),
    ]);
  });

  it("FAILED のタスクは ready を拒否する（conflict）", async () => {
    const t = await createTask();
    await t.stub.advance();
    await t.agent.setPhase("failed", "boom");
    await t.stub.advance();
    const st = await t.stub.getStatus(OWNER);
    expect(st.ok && st.task.status).toBe("FAILED");
    expect(await t.stub.prContext(OWNER, "ready")).toMatchObject({ ok: false, code: "conflict" });
  });

  it("merge: review_policy によらず、head が検証済みの commit と一致していれば、検証済みの sha を返す", async () => {
    const { stub, head } = await runToCompleted();
    expect(await stub.prContext(OWNER, "merge")).toMatchObject({
      ok: true,
      review_policy: "client_review",
      head_sha: head,
    });
  });

  it("merge: head が検証済みの commit と一致しない（head_matches_verified が false）なら conflict", async () => {
    const t = await createTask();
    await t.stub.advance();
    const head = await pushChildCommit(t.branch);
    // 検証した commit と、push された commit が違う
    await t.agent.setProgram({ result: completedResult("f".repeat(40), { pushedSha: head }) });
    await t.agent.setPhase("completed");
    await t.stub.advance();
    expect((await gl(t.stub)).head_matches).toBe(0);
    const r = await t.stub.prContext(OWNER, "merge");
    expect(r).toMatchObject({ ok: false, code: "conflict" });
    expect((await audits(t.stub)).find((a) => a.event === "pr_denied")).toMatchObject({
      reason: "head_not_verified",
    });
    // ready は通る（Ready にするだけなら head の不一致は妨げない）
    expect(await t.stub.prContext(OWNER, "ready")).toMatchObject({ ok: true });
  });

  it("merge: task_result の warnings が 1 件でもあれば conflict（warnings_present）。ready は通る", async () => {
    const t = await createTask();
    await t.stub.advance();
    const head = await pushChildCommit(t.branch);
    await t.agent.setProgram({
      result: completedResult(head, { warnings: ["test config changed: vitest.config.ts"] }),
    });
    await t.agent.setPhase("completed");
    await t.stub.advance();
    // head は検証済みと一致している（warnings だけが理由で拒否される）
    expect((await gl(t.stub)).head_matches).toBe(1);
    const r = await t.stub.prContext(OWNER, "merge");
    expect(r).toMatchObject({ ok: false, code: "conflict" });
    expect((r as { message: string }).message).toContain("warnings");
    expect((await audits(t.stub)).find((a) => a.event === "pr_denied")).toMatchObject({
      kind: "merge",
      reason: "warnings_present",
      review_policy: "client_review",
    });
    expect(await t.stub.prContext(OWNER, "ready")).toMatchObject({ ok: true });
  });

  it("merge: GitHub 側で足された warnings（github_link.warnings）でも拒否する", async () => {
    const { stub } = await runToCompleted();
    await runInDurableObject(stub, (_i, s) => {
      s.storage.sql.exec("UPDATE github_link SET warnings = ?", JSON.stringify(["from github"]));
    });
    expect(await stub.prContext(OWNER, "merge")).toMatchObject({ ok: false, code: "conflict" });
  });

  it("merge: head をまだ読めていない（終端の処理が終わっていない）なら not_ready", async () => {
    const { stub } = await runToCompleted();
    await runInDurableObject(stub, (_i, s) => {
      s.storage.sql.exec("UPDATE github_link SET head_matches = NULL, head_sha = NULL");
    });
    expect(await stub.prContext(OWNER, "merge")).toMatchObject({ ok: false, code: "not_ready" });
  });

  it("PR が無い（github_link に PR 番号が無い）COMPLETED は conflict（no_pr）", async () => {
    const { stub } = await runToCompleted();
    await runInDurableObject(stub, (_i, s) => {
      s.storage.sql.exec("UPDATE github_link SET pr_number = NULL, pr_url = NULL");
    });
    expect(await stub.prContext(OWNER, "ready")).toMatchObject({ ok: false, code: "conflict" });
  });
});

describe("recordPrAction: 記録と監査", () => {
  it("ready 成功: pr_draft を 0 にし、pr_ready を監査（taskId・userId・review_policy 付き）", async () => {
    const { id, stub } = await runToCompletedDraft();
    await stub.recordPrAction(OWNER, { kind: "ready", outcome: "done" });
    expect((await gl(stub)).pr_draft).toBe(0);
    const r = await stub.result(OWNER);
    expect(r.ok && r.result.pr).toMatchObject({ draft: false, merged: false });
    expect((await audits(stub)).find((a) => a.event === "pr_ready")).toMatchObject({
      audit: true,
      taskId: id,
      userId: OWNER,
      caller: "parent",
      kind: "ready",
      review_policy: "client_review",
    });
  });

  it("merge 成功: pr_merged を 1 にし、pr_merged を監査", async () => {
    const { id, stub } = await runToCompletedDraft();
    await stub.recordPrAction(OWNER, { kind: "merge", outcome: "done" });
    expect((await gl(stub)).pr_merged).toBe(1);
    const r = await stub.result(OWNER);
    expect(r.ok && r.result.pr).toMatchObject({ draft: false, merged: true });
    expect((await audits(stub)).find((a) => a.event === "pr_merged")).toMatchObject({
      taskId: id,
      userId: OWNER,
      kind: "merge",
      review_policy: "client_review",
    });
  });

  it("すでに Ready / マージ済みだった（changed: false）なら、状態は合わせるが pr_ready / pr_merged は監査しない", async () => {
    const { stub } = await runToCompletedDraft();
    await stub.recordPrAction(OWNER, { kind: "ready", outcome: "done", changed: false });
    await stub.recordPrAction(OWNER, { kind: "merge", outcome: "done", changed: false });
    expect(await gl(stub)).toMatchObject({ pr_draft: 0, pr_merged: 1 });
    const events = (await audits(stub)).map((a) => a.event);
    expect(events).not.toContain("pr_ready");
    expect(events).not.toContain("pr_merged");
  });

  it("拒否: GitHub 側の拒否も pr_denied で監査（reason は固定のコード）。状態は変えない", async () => {
    const { stub } = await runToCompletedDraft();
    await stub.recordPrAction(OWNER, { kind: "merge", outcome: "denied", reason: "merge_blocked" });
    expect((await gl(stub)).pr_merged).toBe(0);
    expect((await audits(stub)).find((a) => a.event === "pr_denied")).toMatchObject({
      kind: "merge",
      reason: "merge_blocked",
      review_policy: "client_review",
    });
  });

  it("所有者以外の記録は無視する（状態も監査も変えない）", async () => {
    const { stub } = await runToCompletedDraft();
    await stub.recordPrAction(OWNER + 1, { kind: "ready", outcome: "done" });
    expect((await gl(stub)).pr_draft).toBe(1);
    expect((await audits(stub)).some((a) => a.event === "pr_ready")).toBe(false);
  });
});

describe("closed_empty の PR", () => {
  it("task_pr_ready / task_pr_merge は conflict（pr_denied: pr_closed_empty を監査）", async () => {
    const { stub } = await runToCompleted();
    await runInDurableObject(stub, (_i, s) => {
      s.storage.sql.exec("UPDATE github_link SET closed_empty = 1");
    });
    expect(await stub.prContext(OWNER, "ready")).toMatchObject({ ok: false, code: "conflict" });
    expect(await stub.prContext(OWNER, "merge")).toMatchObject({ ok: false, code: "conflict" });
    const denied = (await audits(stub)).filter((a) => a.event === "pr_denied");
    expect(denied.map((a) => a.reason)).toEqual(["pr_closed_empty", "pr_closed_empty"]);
  });
});

describe("完了時の自動の Ready（client_review）", () => {
  const warningCodes = (stub: TaskStub) =>
    runInDurableObject(stub, (_i, s) =>
      s.storage.sql
        .exec<{ payload: string }>("SELECT payload FROM events WHERE type = 'warning'")
        .toArray()
        .map((r) => (JSON.parse(r.payload) as { code?: string }).code),
    );
  const graphqlCalls = () =>
    app()
      .requests()
      .filter((r) => r.path === "/graphql");
  const draftOf = (branch: string) =>
    app()
      .pulls(REPO)
      .find((p) => p.head === branch)?.draft;

  it("COMPLETED で PR が Ready になる。GraphQL は Installation Token で呼ぶ。task_result の pr.draft は false、pr_ready を system として監査", async () => {
    const { id, stub, branch } = await runToCompleted();
    expect(draftOf(branch)).toBe(false);
    expect(graphqlCalls().length).toBe(1);
    expect(graphqlCalls()[0]?.auth).toBe("token");
    expect((await gl(stub)).pr_draft).toBe(0);
    const r = await stub.result(OWNER);
    expect(r.ok && r.result.pr).toMatchObject({ draft: false, merged: false });
    expect(r.ok && r.result.review_policy).toBe("client_review");
    expect((await audits(stub)).find((a) => a.event === "pr_ready")).toMatchObject({
      taskId: id,
      caller: "system",
      kind: "ready",
      reason: "auto_ready",
      review_policy: "client_review",
    });
  });

  it("Ready にできなくても（GitHub の障害）タスクは COMPLETED のまま。PR は Draft で、warning イベントを残す。warnings には足さない（task_pr_merge を止めない）", async () => {
    app().setFault({ pattern: "^POST /graphql$", status: 502 });
    const { stub, branch } = await runToCompleted();
    const st = await stub.getStatus(OWNER);
    expect(st.ok && st.task.status).toBe("COMPLETED");
    expect(draftOf(branch)).toBe(true);
    const r = await stub.result(OWNER);
    expect(r.ok && r.result.pr).toMatchObject({ draft: true });
    expect(r.ok && r.result.warnings).toEqual([]);
    expect(await warningCodes(stub)).toContain("auto_ready_failed");
    // task_pr_ready は使える（冪等な手動の Ready）
    expect(await stub.prContext(OWNER, "ready")).toMatchObject({ ok: true });
  });

  it("PR の node_id を読めない（応答に node_id が無い）ときは GraphQL を呼ばず、COMPLETED のまま warning イベントを残す", async () => {
    // 終端の処理の最初の GET /pulls/1 だけ、node_id の無い応答にする
    app().setFault({
      pattern: "^GET /repos/acme/widgets/pulls/1$",
      status: 200,
      count: 1,
      body: {
        number: 1,
        html_url: "https://github.test/acme/widgets/pull/1",
        draft: true,
        state: "open",
        body: "",
        head: { sha: "a".repeat(40) },
        base: { ref: "main" },
      },
    });
    const { stub, branch } = await runToCompleted();
    const st = await stub.getStatus(OWNER);
    expect(st.ok && st.task.status).toBe("COMPLETED");
    expect(graphqlCalls()).toEqual([]);
    expect(draftOf(branch)).toBe(true);
    expect(await warningCodes(stub)).toContain("auto_ready_failed");
  });

  it("FAILED では Ready にしない（Draft のまま）", async () => {
    const t = await createTask();
    await t.stub.advance();
    await pushChildCommit(t.branch);
    await t.agent.setPhase("failed", "boom");
    await t.stub.advance();
    const st = await t.stub.getStatus(OWNER);
    expect(st.ok && st.task.status).toBe("FAILED");
    expect(draftOf(t.branch)).toBe(true);
    expect(graphqlCalls()).toEqual([]);
  });

  it("CANCELLED では Ready にしない", async () => {
    const t = await createTask();
    await t.stub.advance();
    await t.stub.cancel(OWNER);
    await t.stub.advance();
    expect(draftOf(t.branch)).toBe(true);
    expect(graphqlCalls()).toEqual([]);
  });

  it("push が無い（pushedSha が無い）COMPLETED は Ready にしない", async () => {
    const t = await createTask();
    await t.stub.advance();
    const head = await pushChildCommit(t.branch);
    await t.agent.setProgram({ result: completedResult(head, { pushedSha: undefined }) });
    await t.agent.setPhase("completed");
    await t.stub.advance();
    expect(graphqlCalls()).toEqual([]);
  });

  it("すでに Ready の PR（Draft 不可の環境など）には GraphQL を呼ばない", async () => {
    app().setDraftUnsupported(true);
    try {
      await runToCompleted();
      expect(graphqlCalls()).toEqual([]);
    } finally {
      app().setDraftUnsupported(false);
    }
  });
});
