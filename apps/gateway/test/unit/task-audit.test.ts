import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { AuditRecord } from "@rovo/audit";
import { describe, expect, it } from "vitest";
import type { ResultDto } from "../../src/agent/contract";
import { getFakeApp, type UnitGitHubEnv } from "../support/unit-github";
import { fakeAgent, newTaskId, sampleInput, taskStub } from "./helpers";

const OWNER = 901;
const OTHER = 902;
const REPO = "acme/widgets";
const app = () => getFakeApp(env as unknown as UnitGitHubEnv);

type TaskStub = ReturnType<typeof taskStub>;

function rows<T>(stub: TaskStub, sql: string, ...b: unknown[]): Promise<T[]> {
  return runInDurableObject(
    stub,
    (_i, state) => state.storage.sql.exec(sql, ...b).toArray() as T[],
  );
}

async function setEnv(stub: TaskStub, patch: Record<string, string | undefined>) {
  await runInDurableObject(stub, (i) => {
    const o = i as unknown as { env: Record<string, unknown> };
    o.env = { ...o.env, ...patch };
  });
}

/** ENVIRONMENT=test にして、DO の中に監査の記録（test_audit）を残すようにする。 */
async function createTask(opts: { testEnv?: boolean } = {}) {
  const id = newTaskId();
  const stub = taskStub(id);
  const r = await stub.ensureCreated(sampleInput(id, OWNER));
  if (!r.ok) throw new Error(`ensureCreated failed: ${r.code}`);
  if (opts.testEnv !== false) await setEnv(stub, { ENVIRONMENT: "test" });
  return { id, stub, agent: fakeAgent(id), branch: `agent/task-${id}` };
}

const sink = (stub: TaskStub): Promise<AuditRecord[]> =>
  runInDurableObject(stub, (i) => (i as unknown as { testAudit(): AuditRecord[] }).testAudit());
const sinkOf = async (stub: TaskStub, event: string) =>
  (await sink(stub)).filter((r) => r.event === event);
const auditEvents = async (stub: TaskStub) =>
  (
    await rows<{ payload: string }>(
      stub,
      "SELECT payload FROM events WHERE type = 'audit' ORDER BY seq",
    )
  ).map((e) => JSON.parse(e.payload) as Record<string, unknown>);
const eventTypes = async (stub: TaskStub) =>
  (await rows<{ type: string }>(stub, "SELECT type FROM events ORDER BY seq")).map((e) => e.type);

async function warp(stub: TaskStub, ms: number) {
  const clock = () => Date.now() + ms;
  await runInDurableObject(stub, (i) => {
    (i as unknown as { now: () => number }).now = clock;
  });
  app().now = clock;
}

function completedResult(commitSha: string): ResultDto {
  return {
    status: "completed",
    summary: "ok",
    verification: {
      commands: [{ argv: ["npm", "test"] }],
      results: [{ argv: ["npm", "test"], exitCode: 0, timedOut: false, output: "ok" }],
      verified: true,
      attempts: 1,
      commitSha,
    },
    warnings: [],
    patchTooLarge: false,
    pushedSha: commitSha,
    usage: {
      costUsd: 1,
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
  } as unknown as ResultDto;
}

describe("test 用シンク（TaskDO）", () => {
  it("production では記録も読み出し口も無い（test_audit テーブルも作らない）", async () => {
    const { stub } = await createTask({ testEnv: false });
    await stub.advance();
    await stub.cancel(OWNER);
    await expect(
      runInDurableObject(stub, (i) => {
        (i as unknown as { testAudit(): unknown }).testAudit();
      }),
    ).rejects.toThrow(/test only/);
    const tables = await rows<{ name: string }>(
      stub,
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'test_audit'",
    );
    expect(tables).toEqual([]);
  });

  it("production でも欠落してはならない事象は events に積む（シンクとは無関係）", async () => {
    const { stub } = await createTask({ testEnv: false });
    await stub.advance();
    expect(await auditEvents(stub)).toEqual([{ code: "credential_issued", kind: "start" }]);
  });
});

describe("task_cancelled（cancel の監査）", () => {
  it("cancel で task_cancelled を出し、events には既存の cancelled がある。取り消し済みへの再 cancel は出さない", async () => {
    const { id, stub } = await createTask();
    await stub.advance();
    expect(await stub.cancel(OWNER)).toMatchObject({ ok: true, changed: true });
    expect(await eventTypes(stub)).toContain("cancelled");
    const [rec, ...rest] = await sinkOf(stub, "task_cancelled");
    expect(rest).toEqual([]);
    expect(rec).toMatchObject({
      audit: true,
      event: "task_cancelled",
      taskId: id,
      userId: OWNER,
      caller: "parent",
      reason: "parent_requested",
    });
    expect(await stub.cancel(OWNER)).toMatchObject({ ok: true, changed: false });
    expect(await sinkOf(stub, "task_cancelled")).toHaveLength(1);
  });
});

describe("authz_denied（他人のタスクの操作）", () => {
  it("owner でない呼び出しは not_found のまま返し、authz_denied(not_owner) を出す。events は増やさない", async () => {
    const { id, stub } = await createTask();
    await stub.advance();
    const before = await eventTypes(stub);
    expect(await stub.getStatus(OTHER)).toEqual({ ok: false, code: "not_found" });
    expect(await stub.cancel(OTHER)).toEqual({ ok: false, code: "not_found" });
    expect(await stub.result(OTHER)).toEqual({ ok: false, code: "not_found" });
    expect(await stub.answer(OTHER, "q1", "x")).toEqual({ ok: false, code: "not_found" });
    expect(await stub.steer(OTHER, "msg")).toEqual({ ok: false, code: "not_found" });
    expect(await stub.wait(OTHER, undefined, 0)).toEqual({ ok: false, code: "not_found" });
    const denied = await sinkOf(stub, "authz_denied");
    expect(denied).toHaveLength(6);
    for (const r of denied) {
      expect(r).toMatchObject({ taskId: id, userId: OTHER, caller: "parent", reason: "not_owner" });
    }
    expect(await eventTypes(stub)).toEqual(before);
    // 他人の cancel は効かない
    expect((await stub.getStatus(OWNER)).ok && (await stub.getStatus(OWNER))).toMatchObject({
      task: { status: "RUNNING" },
    });
  });

  it("まだ作られていないタスク（行が無い）への操作では出さない", async () => {
    const stub = taskStub(newTaskId());
    await setEnv(stub, { ENVIRONMENT: "test" });
    expect(await stub.getStatus(OWNER)).toEqual({ ok: false, code: "not_found" });
    expect(await sink(stub)).toEqual([]);
  });
});

describe("credential_issued / credential_revoked（トークンの発行と失効）", () => {
  it("start のトークン発行を events（audit）と監査ログの両方に出す。トークンの値は出さない", async () => {
    const { id, stub } = await createTask();
    await stub.advance();
    expect(await auditEvents(stub)).toEqual([{ code: "credential_issued", kind: "start" }]);
    const issued = await sinkOf(stub, "credential_issued");
    expect(issued).toHaveLength(1);
    expect(issued[0]).toMatchObject({ taskId: id, caller: "system", kind: "start" });
    const everything = JSON.stringify(await sink(stub)) + JSON.stringify(await auditEvents(stub));
    for (const t of app().tokenList()) expect(everything).not.toContain(t.token);
    expect(everything).not.toContain("ghs_");
  });

  it("task_wait で見える（events の type は audit、payload は固定コードだけ）", async () => {
    const { stub } = await createTask();
    await stub.advance();
    const w = await stub.wait(OWNER, undefined, 0);
    if (!w.ok) throw new Error("wait failed");
    const e = w.events.find((x) => x.type === "audit");
    expect(e?.payload).toEqual({ code: "credential_issued", kind: "start" });
  });

  it("期限の前の更新（refresh）と、渡せた後の古いトークンの失効を出す", async () => {
    const { stub, agent } = await createTask();
    await stub.advance();
    await warp(stub, 50 * 60_000);
    await runDurableObjectAlarm(stub).catch(() => {});
    void agent;
    const codes = (await auditEvents(stub)).map((e) => `${e.code}:${e.kind ?? ""}`);
    expect(codes).toContain("credential_issued:refresh");
    expect((await sinkOf(stub, "credential_issued")).map((r) => r.kind)).toEqual([
      "start",
      "refresh",
    ]);
    expect(await sinkOf(stub, "credential_revoked")).toHaveLength(1);
  });

  it("終端のトークンの失効を events（audit）と監査ログの両方に出す", async () => {
    const { stub, agent, branch } = await createTask();
    await stub.advance();
    await agent.setProgram({ result: completedResult(app().branch(REPO, branch) as string) });
    await agent.setPhase("completed");
    await stub.advance();
    expect(
      app()
        .tokenList()
        .every((t) => t.revoked),
    ).toBe(true);
    const revoked = (await auditEvents(stub)).filter((e) => e.code === "credential_revoked");
    expect(revoked.length).toBeGreaterThanOrEqual(1);
    expect(revoked[0]).toMatchObject({ code: "credential_revoked", kind: "start" });
    expect((await sinkOf(stub, "credential_revoked")).length).toBe(revoked.length);
  });

  it("失効を諦めたら credential_revoke_given_up を監査ログに出す（events は既存の warning: token_revoke_failed）", async () => {
    app().setFault({ pattern: "^DELETE /installation/token$", status: 403 });
    const { stub, agent, branch } = await createTask();
    await stub.advance();
    await agent.setProgram({ result: completedResult(app().branch(REPO, branch) as string) });
    await agent.setPhase("completed");
    await stub.advance();
    const given = await sinkOf(stub, "credential_revoke_given_up");
    expect(given).toHaveLength(1);
    expect(given[0]).toMatchObject({ caller: "system", reason: "not_retryable" });
    const warnings = (
      await rows<{ payload: string }>(stub, "SELECT payload FROM events WHERE type = 'warning'")
    ).map((r) => JSON.parse(r.payload));
    expect(warnings).toContainEqual({ code: "token_revoke_failed" });
    // warning で足りるので audit は二重に積まない
    expect((await auditEvents(stub)).some((e) => e.code === "credential_revoke_given_up")).toBe(
      false,
    );
  });

  it("App の設定が失われて失効できないときは、audit イベントで記録を残す", async () => {
    const { stub, agent, branch } = await createTask();
    await stub.advance();
    await agent.setProgram({ result: completedResult(app().branch(REPO, branch) as string) });
    await setEnv(stub, { GITHUB_APP_PRIVATE_KEY: undefined });
    await agent.setPhase("completed");
    await stub.advance();
    expect(await auditEvents(stub)).toContainEqual({
      code: "credential_revoke_given_up",
      kind: "start",
    });
    expect(await sinkOf(stub, "credential_revoke_given_up")).toHaveLength(1);
  });

  it("発行に失敗したら credential_issue_failed を監査ログに出す（固定コードだけ）", async () => {
    app().setFault({
      pattern: "^POST /app/installations/.*/access_tokens$",
      status: 500,
      count: 1,
    });
    const { stub } = await createTask();
    await stub.advance();
    const failed = await sinkOf(stub, "credential_issue_failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ kind: "start", reason: "github_error_500" });
    expect(JSON.stringify(failed)).not.toContain("ghs_");
  });
});

describe("task_ended_by_limit（上限による終了）", () => {
  it("予算超過（BUDGET_EXCEEDED）で出す。events は既存の status_changed の reason のまま", async () => {
    const { id, stub, agent } = await createTask();
    await stub.advance();
    await agent.setPhase("budget_exceeded", "budget_exceeded");
    await stub.advance();
    const [rec] = await sinkOf(stub, "task_ended_by_limit");
    expect(rec).toMatchObject({ taskId: id, caller: "system", reason: "budget_exceeded" });
    const changed = (
      await rows<{ payload: string }>(
        stub,
        "SELECT payload FROM events WHERE type = 'status_changed'",
      )
    ).map((r) => JSON.parse(r.payload));
    expect(changed).toContainEqual(
      expect.objectContaining({ status: "BUDGET_EXCEEDED", reason: "budget_exceeded" }),
    );
    expect((await auditEvents(stub)).some((e) => e.code === "task_ended_by_limit")).toBe(false);
  });

  it("予算の延長の質問への無応答（BUDGET_EXCEEDED の reason: budget_extension_timeout）は、監査で budget_exceeded と区別できる", async () => {
    const { stub, agent } = await createTask();
    await stub.advance();
    await agent.setPhase("budget_exceeded", "budget_extension_timeout");
    await stub.advance();
    expect((await sinkOf(stub, "task_ended_by_limit")).map((r) => r.reason)).toEqual([
      "budget_extension_timeout",
    ]);
  });

  it("deadline と input_timeout（FAILED の reason）で出す。無関係な FAILED では出さない", async () => {
    for (const reason of ["deadline", "input_timeout"]) {
      const { stub, agent } = await createTask();
      await stub.advance();
      await agent.setPhase("failed", reason);
      await stub.advance();
      expect((await sinkOf(stub, "task_ended_by_limit")).map((r) => r.reason)).toEqual([reason]);
    }
    const { stub, agent } = await createTask();
    await stub.advance();
    await agent.setPhase("failed", "verification_failed");
    await stub.advance();
    expect(await sinkOf(stub, "task_ended_by_limit")).toEqual([]);
  });
});

describe("delivery_given_up（配送の打ち切り）", () => {
  it("終端で未配送の回答と steer を取りやめたとき、種別ごとに events（audit）と監査ログへ出す", async () => {
    const { id, stub, agent } = await createTask();
    await stub.advance();
    await agent.ask("q1", "which?", ["a"]);
    await stub.advance();
    await agent.setProgram({ answer: ["not_ok"], steer: ["not_ok"] });
    expect((await stub.answer(OWNER, "q1", "a")).ok).toBe(true);
    const s = await stub.steer(OWNER, "more");
    expect(s.ok).toBe(true);
    await stub.cancel(OWNER);
    const given = await sinkOf(stub, "delivery_given_up");
    expect(given.map((r) => r.kind).sort()).toEqual(["answer", "steer"]);
    for (const r of given) {
      expect(r).toMatchObject({ taskId: id, caller: "system", reason: "skipped_on_terminal" });
    }
    expect(await auditEvents(stub)).toEqual(
      expect.arrayContaining([
        { code: "delivery_given_up", kind: "answer" },
        { code: "delivery_given_up", kind: "steer" },
      ]),
    );
  });

  it("start を送る前に終端になったとき（skipped）も出す", async () => {
    const { stub } = await createTask();
    await stub.cancel(OWNER);
    await stub.advance();
    const given = await sinkOf(stub, "delivery_given_up");
    expect(given.map((r) => r.kind)).toEqual(["start"]);
    expect(await auditEvents(stub)).toContainEqual({ code: "delivery_given_up", kind: "start" });
  });

  it("配送するものが残っていない終端では出さない", async () => {
    const { stub, agent } = await createTask();
    await stub.advance();
    await agent.setPhase("failed", "verification_failed");
    await stub.advance();
    expect(await sinkOf(stub, "delivery_given_up")).toEqual([]);
  });
});

describe("allowlist（二重化した audit イベントも固定コードだけ）", () => {
  it("audit イベントの payload は {code, kind?} の固定コードだけ", async () => {
    const { stub, agent, branch } = await createTask();
    await stub.advance();
    await agent.setProgram({ result: completedResult(app().branch(REPO, branch) as string) });
    await agent.setPhase("completed");
    await stub.advance();
    const events = await auditEvents(stub);
    expect(events.length).toBeGreaterThan(0);
    for (const p of events) {
      expect(Object.keys(p).every((k) => k === "code" || k === "kind")).toBe(true);
      for (const v of Object.values(p)) expect(String(v)).toMatch(/^[a-z0-9_]{1,64}$/);
    }
  });
});
