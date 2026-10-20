import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { AuditRecord } from "@rovo/audit";
import { describe, expect, it } from "vitest";
import type { ResultDto } from "../../src/agent/contract";
import { getFakeApp, type UnitGitHubEnv } from "../support/unit-github";
import { fakeAgent, newTaskId, sampleInput, taskStub } from "./helpers";

// Phase 7 M2 / D1 案 B: finalize_done = 1 の後に、git_token の暗号文（enc 列）だけを空文字にする。行と id は残す。

const OWNER = 702;
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

async function createTask() {
  const id = newTaskId();
  const stub = taskStub(id);
  const r = await stub.ensureCreated(sampleInput(id, OWNER));
  if (!r.ok) throw new Error(`ensureCreated failed: ${r.code}`);
  await setEnv(stub, { ENVIRONMENT: "test" });
  return { id, stub, agent: fakeAgent(id), branch: `agent/task-${id}` };
}

async function warp(stub: TaskStub, ms: number) {
  const clock = () => Date.now() + ms;
  await runInDurableObject(stub, (i) => {
    (i as unknown as { now: () => number }).now = clock;
  });
  app().now = clock;
}

const tokens = (stub: TaskStub) =>
  rows<{ id: number; enc: string; revoked: number; kind: string }>(
    stub,
    "SELECT id, enc, revoked, kind FROM git_token ORDER BY id",
  );
const finalizeDone = async (stub: TaskStub) =>
  (await rows<{ finalize_done: number }>(stub, "SELECT finalize_done FROM github_link"))[0]
    ?.finalize_done;
const audits = async (stub: TaskStub, event: string) =>
  (
    await runInDurableObject(stub, (i) =>
      (i as unknown as { testAudit(): AuditRecord[] }).testAudit(),
    )
  ).filter((r) => r.event === event);

function completedResult(commitSha: string): ResultDto {
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
    pushedSha: commitSha,
    usage: {
      costUsd: 1.5,
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
  } as unknown as ResultDto;
}

async function runToTerminal() {
  const t = await createTask();
  await t.stub.advance();
  await t.agent.setProgram({ result: completedResult(app().branch(REPO, t.branch) as string) });
  await t.agent.setPhase("completed");
  return t;
}

async function pump(stub: TaskStub, n = 12) {
  for (let i = 1; i <= n; i++) {
    await warp(stub, i * 120_000);
    await runDurableObjectAlarm(stub).catch(() => {});
  }
}

describe("git_token の暗号文の削除（finalize_done の後）", () => {
  it("run 中は暗号文が残る", async () => {
    const t = await createTask();
    await t.stub.advance();
    const toks = await tokens(t.stub);
    expect(toks.length).toBeGreaterThan(0);
    expect(toks.every((x) => x.enc !== "")).toBe(true);
  });

  it("失効の再試行の途中（finalize_done = 0）では残り、finalize_done = 1 の後に空になる。2 回目の alarm でも同じ", async () => {
    app().setFault({ pattern: "^DELETE /installation/token$", status: 500, count: 2 });
    const t = await runToTerminal();
    await t.stub.advance();
    expect(await finalizeDone(t.stub)).toBe(0);
    expect((await tokens(t.stub)).some((x) => x.enc !== "")).toBe(true);

    await pump(t.stub, 3);
    expect(await finalizeDone(t.stub)).toBe(1);
    const after = await tokens(t.stub);
    expect(after.every((x) => x.enc === "")).toBe(true);

    await pump(t.stub, 2);
    expect(await tokens(t.stub)).toEqual(after);
  });

  it("正常な終端: 行と id と revoked は残り、enc だけが空。cred_delivered_id と credential_* の件数は変わらない", async () => {
    const t = await runToTerminal();
    const before = await rows<{ cred_delivered_id: number }>(
      t.stub,
      "SELECT cred_delivered_id FROM github_link",
    );
    await t.stub.advance();
    expect(await finalizeDone(t.stub)).toBe(1);
    const toks = await tokens(t.stub);
    expect(toks.length).toBeGreaterThan(0);
    expect(toks.every((x) => x.enc === "" && x.revoked === 1)).toBe(true);
    expect(toks.map((x) => x.kind)).toContain("start");
    const after = await rows<{ cred_delivered_id: number }>(
      t.stub,
      "SELECT cred_delivered_id FROM github_link",
    );
    expect(after[0]?.cred_delivered_id).toBe(before[0]?.cred_delivered_id);
    const issued = await audits(t.stub, "credential_issued");
    const revoked = await audits(t.stub, "credential_revoked");
    expect(issued).toHaveLength(toks.length);
    expect(revoked).toHaveLength(toks.length);
  });

  it("消した後も task_status / task_result は応答でき、変わらない", async () => {
    const t = await runToTerminal();
    await t.stub.advance();
    expect(await finalizeDone(t.stub)).toBe(1);
    const s1 = await t.stub.getStatus(OWNER);
    const r1 = await t.stub.result(OWNER);
    expect(s1.ok).toBe(true);
    expect(r1.ok).toBe(true);
    await t.stub.advance();
    expect(await t.stub.getStatus(OWNER)).toEqual(s1);
    expect(await t.stub.result(OWNER)).toEqual(r1);
    expect(await runInDurableObject(t.stub, (_i, s) => s.storage.getAlarm())).toBeNull();
  });

  it("SetupFailure（App の設定が失われた）で閉じた場合も空になる", async () => {
    const t = await runToTerminal();
    await setEnv(t.stub, { GITHUB_APP_PRIVATE_KEY: undefined });
    await t.stub.advance();
    expect(await finalizeDone(t.stub)).toBe(1);
    const toks = await tokens(t.stub);
    expect(toks.length).toBeGreaterThan(0);
    expect(toks.every((x) => x.enc === "")).toBe(true);
  });

  it("失効を REVOKE_MAX_ATTEMPTS で打ち切った場合も空になる。打ち切りの途中では残る", async () => {
    app().setFault({ pattern: "^DELETE /installation/token$", status: 500 });
    const t = await runToTerminal();
    await t.stub.advance();
    expect(await finalizeDone(t.stub)).toBe(0);
    expect((await tokens(t.stub)).some((x) => x.enc !== "")).toBe(true);
    await pump(t.stub, 12);
    expect(await finalizeDone(t.stub)).toBe(1);
    const toks = await tokens(t.stub);
    expect(toks.every((x) => x.enc === "" && x.revoked === 1)).toBe(true);
  });

  it("再試行しても直らない 4xx（403）で失効を諦めた場合は、再試行せずその場で空になる", async () => {
    app().setFault({ pattern: "^DELETE /installation/token$", status: 403 });
    const t = await runToTerminal();
    await t.stub.advance();
    // 5xx と違い、1 回目の失敗で打ち切る（backoff の再試行に入らない）
    expect(await finalizeDone(t.stub)).toBe(1);
    const toks = await tokens(t.stub);
    expect(toks.length).toBeGreaterThan(0);
    expect(toks.every((x) => x.enc === "" && x.revoked === 1)).toBe(true);
    const given = await audits(t.stub, "credential_revoke_given_up");
    expect(given.map((r) => (r as unknown as { reason?: string }).reason)).toEqual([
      "not_retryable",
    ]);
    const attempts = await rows<{ revoke_attempts: number }>(
      t.stub,
      "SELECT revoke_attempts FROM github_link",
    );
    expect(attempts[0]?.revoke_attempts).toBe(1);
  });

  it("PR を作る前に FAILED になったタスクでも空になる", async () => {
    app().markMissing(REPO, "0123456789abcdef0123456789abcdef01234567");
    const t = await createTask();
    await t.stub.advance();
    await pump(t.stub, 3);
    expect(await finalizeDone(t.stub)).toBe(1);
    expect((await tokens(t.stub)).every((x) => x.enc === "")).toBe(true);
  });

  it("移行: finalize_done = 1 なのに暗号文が残っている既存の行は、起動時に空になる。冪等", async () => {
    const t = await runToTerminal();
    await t.stub.advance();
    expect(await finalizeDone(t.stub)).toBe(1);
    await runInDurableObject(t.stub, (_i, s) =>
      s.storage.sql.exec("UPDATE git_token SET enc = 'leftover'"),
    );
    expect((await tokens(t.stub)).every((x) => x.enc === "leftover")).toBe(true);
    // 起動時の migrate を再実行する
    const migrate = () =>
      runInDurableObject(t.stub, (i) => (i as unknown as { migrate(): void }).migrate());
    await migrate();
    expect((await tokens(t.stub)).every((x) => x.enc === "")).toBe(true);
    await migrate();
    expect((await tokens(t.stub)).every((x) => x.enc === "")).toBe(true);
  });

  it("移行: finalize_done = 0 の行は触らない", async () => {
    const t = await createTask();
    await t.stub.advance();
    await runInDurableObject(t.stub, (i) => (i as unknown as { migrate(): void }).migrate());
    expect((await tokens(t.stub)).every((x) => x.enc !== "")).toBe(true);
  });

  it("finalize_done の後に workingToken / トークンの発行・復号は呼ばれない（暗号文を読む経路が無い）", async () => {
    const t = await runToTerminal();
    await t.stub.advance();
    expect(await finalizeDone(t.stub)).toBe(1);
    const issuedBefore = app().tokenList().length;
    await runInDurableObject(t.stub, (i) => {
      const o = i as unknown as Record<string, unknown>;
      for (const name of ["workingToken", "decryptToken", "issueToken"]) {
        o[name] = () => {
          throw new Error(`${name} must not be called after finalize_done`);
        };
      }
    });
    await t.stub.advance();
    await t.stub.getStatus(OWNER);
    await t.stub.result(OWNER);
    await runDurableObjectAlarm(t.stub).catch(() => {});
    await warp(t.stub, 3_600_000);
    await t.stub.advance();
    expect(app().tokenList().length).toBe(issuedBefore);
  });
});

describe("テスト用メソッド testTokenState", () => {
  it("暗号文そのものは返さず、行数と enc が空かどうかだけを返す", async () => {
    const t = await runToTerminal();
    await t.stub.advance();
    const state = await runInDurableObject(t.stub, (i) =>
      (i as unknown as { testTokenState(): unknown }).testTokenState(),
    );
    const n = (await tokens(t.stub)).length;
    expect(state).toEqual({ finalizeDone: true, rows: n, encEmpty: n, encPresent: 0 });
  });

  it("ENVIRONMENT=test 以外では throw する", async () => {
    const t = await createTask();
    await setEnv(t.stub, { ENVIRONMENT: "production" });
    await expect(
      runInDurableObject(t.stub, (i) =>
        (i as unknown as { testTokenState(): unknown }).testTokenState(),
      ),
    ).rejects.toThrow();
  });
});
