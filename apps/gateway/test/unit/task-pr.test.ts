import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { newTaskId, sampleInput, taskStub } from "./helpers";
import {
  app,
  audits,
  completedResult,
  createTask,
  REPO,
  runToCompleted,
  type TaskStub,
} from "./pr-helpers";

// TaskDO の PR 操作の入口（D9）: merge_policy の保存、task_result の pr / merge_policy、prContext（条件の判定）、recordPrAction（記録と監査）。

const OWNER = 801;
const gl = (stub: TaskStub) =>
  runInDurableObject(
    stub,
    (_i, s) =>
      s.storage.sql.exec("SELECT * FROM github_link").toArray()[0] as Record<string, unknown>,
  );

describe("merge_policy の保存", () => {
  it("既定は human_review。agent_merge を渡せば保存され、task_status にも出る", async () => {
    const a = await createTask();
    const b = await createTask({ merge_policy: "agent_merge" });
    const sa = await a.stub.getStatus(OWNER);
    const sb = await b.stub.getStatus(OWNER);
    expect(sa.ok && sa.task.merge_policy).toBe("human_review");
    expect(sb.ok && sb.task.merge_policy).toBe("agent_merge");
  });

  it("不正な merge_policy の入力は invalid_input", async () => {
    const id = newTaskId();
    const r = await taskStub(id).ensureCreated(sampleInput(id, OWNER, { merge_policy: "auto" }));
    expect(r).toEqual({ ok: false, code: "invalid_input" });
  });

  it("同じ task_id でも merge_policy が違う入力は conflict（別のタスク）", async () => {
    const a = await createTask();
    const r = await a.stub.ensureCreated(sampleInput(a.id, OWNER, { merge_policy: "agent_merge" }));
    expect(r).toEqual({ ok: false, code: "conflict" });
  });
});

describe("task_result: merge_policy と pr の状態", () => {
  it("COMPLETED の結果に merge_policy と pr.draft / pr.merged が入る", async () => {
    const { stub, head } = await runToCompleted({ merge_policy: "agent_merge" });
    const r = await stub.result(OWNER);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result.merge_policy).toBe("agent_merge");
    expect(r.result.pr).toMatchObject({
      head_sha: head,
      head_matches_verified: true,
      draft: true,
      merged: false,
    });
  });

  it("human_review の既定が結果にも出る。PR が無い（作成前に失敗した）結果の merge_policy も出る", async () => {
    const { stub } = await runToCompleted();
    const r = await stub.result(OWNER);
    expect(r.ok && r.result.merge_policy).toBe("human_review");
    const t = await createTask({ merge_policy: "agent_merge" });
    await t.stub.cancel(OWNER);
    await t.stub.advance();
    const c = await t.stub.result(OWNER);
    expect(c.ok && c.result.merge_policy).toBe("agent_merge");
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
      merge_policy: "human_review",
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
    const cancelled = await createTask({ merge_policy: "agent_merge" });
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
        merge_policy: "agent_merge",
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

  it("merge: human_review のタスクは forbidden（policy_human_review）", async () => {
    const { stub, id } = await runToCompleted();
    const r = await stub.prContext(OWNER, "merge");
    expect(r).toMatchObject({ ok: false, code: "forbidden" });
    expect((r as { message: string }).message).toContain("human_review");
    const denied = (await audits(stub)).find((a) => a.event === "pr_denied");
    expect(denied).toMatchObject({
      taskId: id,
      kind: "merge",
      reason: "policy_human_review",
      merge_policy: "human_review",
    });
  });

  it("merge: agent_merge で head が検証済みの commit と一致していれば、検証済みの sha を返す", async () => {
    const { stub, head } = await runToCompleted({ merge_policy: "agent_merge" });
    expect(await stub.prContext(OWNER, "merge")).toMatchObject({
      ok: true,
      merge_policy: "agent_merge",
      head_sha: head,
    });
  });

  it("merge: head が検証済みの commit と一致しない（head_matches_verified が false）なら conflict", async () => {
    const t = await createTask({ merge_policy: "agent_merge" });
    await t.stub.advance();
    const head = app().branch(REPO, t.branch) as string;
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
    const t = await createTask({ merge_policy: "agent_merge" });
    await t.stub.advance();
    const head = app().branch(REPO, t.branch) as string;
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
      merge_policy: "agent_merge",
    });
    expect(await t.stub.prContext(OWNER, "ready")).toMatchObject({ ok: true });
  });

  it("merge: GitHub 側で足された warnings（github_link.warnings）でも拒否する", async () => {
    const { stub } = await runToCompleted({ merge_policy: "agent_merge" });
    await runInDurableObject(stub, (_i, s) => {
      s.storage.sql.exec("UPDATE github_link SET warnings = ?", JSON.stringify(["from github"]));
    });
    expect(await stub.prContext(OWNER, "merge")).toMatchObject({ ok: false, code: "conflict" });
  });

  it("merge: head をまだ読めていない（終端の処理が終わっていない）なら not_ready", async () => {
    const { stub } = await runToCompleted({ merge_policy: "agent_merge" });
    await runInDurableObject(stub, (_i, s) => {
      s.storage.sql.exec("UPDATE github_link SET head_matches = NULL, head_sha = NULL");
    });
    expect(await stub.prContext(OWNER, "merge")).toMatchObject({ ok: false, code: "not_ready" });
  });

  it("PR が無い（github_link に PR 番号が無い）COMPLETED は conflict（no_pr）", async () => {
    const { stub } = await runToCompleted({ merge_policy: "agent_merge" });
    await runInDurableObject(stub, (_i, s) => {
      s.storage.sql.exec("UPDATE github_link SET pr_number = NULL, pr_url = NULL");
    });
    expect(await stub.prContext(OWNER, "ready")).toMatchObject({ ok: false, code: "conflict" });
  });
});

describe("recordPrAction: 記録と監査", () => {
  it("ready 成功: pr_draft を 0 にし、pr_ready を監査（taskId・userId・merge_policy 付き）", async () => {
    const { id, stub } = await runToCompleted({ merge_policy: "agent_merge" });
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
      merge_policy: "agent_merge",
    });
  });

  it("merge 成功: pr_merged を 1 にし、pr_merged を監査", async () => {
    const { id, stub } = await runToCompleted({ merge_policy: "agent_merge" });
    await stub.recordPrAction(OWNER, { kind: "merge", outcome: "done" });
    expect((await gl(stub)).pr_merged).toBe(1);
    const r = await stub.result(OWNER);
    expect(r.ok && r.result.pr).toMatchObject({ draft: false, merged: true });
    expect((await audits(stub)).find((a) => a.event === "pr_merged")).toMatchObject({
      taskId: id,
      userId: OWNER,
      kind: "merge",
      merge_policy: "agent_merge",
    });
  });

  it("すでに Ready / マージ済みだった（changed: false）なら、状態は合わせるが pr_ready / pr_merged は監査しない", async () => {
    const { stub } = await runToCompleted({ merge_policy: "agent_merge" });
    await stub.recordPrAction(OWNER, { kind: "ready", outcome: "done", changed: false });
    await stub.recordPrAction(OWNER, { kind: "merge", outcome: "done", changed: false });
    expect(await gl(stub)).toMatchObject({ pr_draft: 0, pr_merged: 1 });
    const events = (await audits(stub)).map((a) => a.event);
    expect(events).not.toContain("pr_ready");
    expect(events).not.toContain("pr_merged");
  });

  it("拒否: GitHub 側の拒否も pr_denied で監査（reason は固定のコード）。状態は変えない", async () => {
    const { stub } = await runToCompleted({ merge_policy: "agent_merge" });
    await stub.recordPrAction(OWNER, { kind: "merge", outcome: "denied", reason: "merge_blocked" });
    expect((await gl(stub)).pr_merged).toBe(0);
    expect((await audits(stub)).find((a) => a.event === "pr_denied")).toMatchObject({
      kind: "merge",
      reason: "merge_blocked",
      merge_policy: "agent_merge",
    });
  });

  it("所有者以外の記録は無視する（状態も監査も変えない）", async () => {
    const { stub } = await runToCompleted();
    await stub.recordPrAction(OWNER + 1, { kind: "ready", outcome: "done" });
    expect((await gl(stub)).pr_draft).toBe(1);
    expect((await audits(stub)).some((a) => a.event === "pr_ready")).toBe(false);
  });
});

describe("closed_empty の PR", () => {
  it("task_pr_ready / task_pr_merge は conflict（pr_denied: pr_closed_empty を監査）", async () => {
    const { stub } = await runToCompleted({ merge_policy: "agent_merge" });
    await runInDurableObject(stub, (_i, s) => {
      s.storage.sql.exec("UPDATE github_link SET closed_empty = 1");
    });
    expect(await stub.prContext(OWNER, "ready")).toMatchObject({ ok: false, code: "conflict" });
    expect(await stub.prContext(OWNER, "merge")).toMatchObject({ ok: false, code: "conflict" });
    const denied = (await audits(stub)).filter((a) => a.event === "pr_denied");
    expect(denied.map((a) => a.reason)).toEqual(["pr_closed_empty", "pr_closed_empty"]);
  });
});
