import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { AuditRecord } from "@rovo/audit";
import { describe, expect, it } from "vitest";
import type { ResultDto } from "../../src/agent/contract";
import type { TaskSummary } from "../../src/tasks/summary";
import { getFakeApp, type UnitGitHubEnv } from "../support/unit-github";
import { fakeAgent, newTaskId, sampleInput, taskStub } from "./helpers";

const OWNER = 911;
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

async function createTask(envPatch: Record<string, string | undefined> = {}) {
  const id = newTaskId();
  const stub = taskStub(id);
  const r = await stub.ensureCreated(sampleInput(id, OWNER, { title: "SECRET-TITLE-xyz" }));
  if (!r.ok) throw new Error(`ensureCreated failed: ${r.code}`);
  await setEnv(stub, { ENVIRONMENT: "test", ...envPatch });
  return { id, stub, agent: fakeAgent(id), branch: `agent/task-${id}` };
}

const sink = (stub: TaskStub): Promise<AuditRecord[]> =>
  runInDurableObject(stub, (i) => (i as unknown as { testAudit(): AuditRecord[] }).testAudit());
const summaries = async (stub: TaskStub) =>
  (await sink(stub)).filter((r) => r.event === "task_summary");
const summaryOf = (stub: TaskStub): Promise<TaskSummary> =>
  runInDurableObject(stub, (i) => (i as unknown as { testSummary(): TaskSummary }).testSummary());
const eventsOf = async (stub: TaskStub, type: string) =>
  (
    await rows<{ payload: string }>(
      stub,
      "SELECT payload FROM events WHERE type = ? ORDER BY seq",
      type,
    )
  ).map((e) => JSON.parse(e.payload) as Record<string, unknown>);

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

async function complete(t: Awaited<ReturnType<typeof createTask>>) {
  await t.agent.setProgram({ result: completedResult(app().branch(REPO, t.branch) as string) });
  await t.agent.setPhase("completed");
  await t.stub.advance();
}

describe("task_summary（終端時の要約）", () => {
  it("完了したタスクで 1 回だけ出す。数値と固定コードだけで、title・taskId 以外の自由な文は無い", async () => {
    const t = await createTask();
    await t.stub.advance();
    await t.agent.setUsage(0.5, {
      inputTokens: 100,
      outputTokens: 40,
      web: { search: 2, fetch: 3, browse: 1 },
      sandbox: { runtimeMs: 7_200_000, restarts: 1, bootRetries: 2 },
    } as never);
    await t.agent.emit("verification", { attempt: 1, passed: false, commitSha: "a".repeat(40) });
    await t.agent.emit("verification", { attempt: 2, passed: true, commitSha: "b".repeat(40) });
    await t.agent.emit("error", { message: "boom with ghs_secretsecret" });
    await t.agent.setUsage(1.25, {
      inputTokens: 120,
      outputTokens: 50,
      web: { search: 2, fetch: 3, browse: 1 },
      sandbox: { runtimeMs: 7_200_000, restarts: 1, bootRetries: 2 },
    } as never);
    await complete(t);

    const recs = await summaries(t.stub);
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({
      audit: true,
      event: "task_summary",
      taskId: t.id,
      userId: OWNER,
      caller: "system",
      kind: "completed",
      metrics: {
        claude_usd: 1.25,
        input_tokens: 120,
        output_tokens: 50,
        sandbox_runtime_ms: 7_200_000,
        sandbox_restarts: 1,
        sandbox_boot_retries: 2,
        web_search: 2,
        web_fetch: 3,
        web_browse: 1,
        verification_attempts: 2,
        verification_passed: 1,
        agent_errors: 1,
      },
    });
    const line = JSON.stringify(recs[0]);
    expect(line).not.toContain("SECRET-TITLE");
    expect(line).not.toContain("ghs_");
    expect(line).not.toContain("OAuth");
    // 回帰: 監査ログの task_summary 行には repository と pr_url を出さない（それらは R2 の summary.json にだけある）
    expect(recs[0]).not.toHaveProperty("repository");
    expect(recs[0]).not.toHaveProperty("pr_url");
    expect(recs[0]).not.toHaveProperty("prUrl");
    expect(line).not.toContain(REPO);
    expect(line).not.toMatch(/pull|https?:/);

    const s = await summaryOf(t.stub);
    expect(s.status).toBe("COMPLETED");
    expect(s.user_id).toBe(OWNER);
    expect(s.repository).toBe(REPO);
    expect(s.transitions.map((x) => x.status)).toEqual(["CREATING", "RUNNING", "COMPLETED"]);
    expect(s.sandbox_usd_estimate).toBeGreaterThan(0);
    expect(JSON.stringify(s)).not.toContain("SECRET-TITLE");
    expect(JSON.stringify(s)).not.toContain("Implement OAuth");

    // もう一度進めても出し直さない
    await t.stub.advance();
    expect(await summaries(t.stub)).toHaveLength(1);
  });

  it("途中の状態では出さない（終端でない・精算前）", async () => {
    const t = await createTask();
    await t.stub.advance();
    expect(await summaries(t.stub)).toEqual([]);
  });

  it("GitHub の終了処理（finalize_done）が済むまで出さず、済んだ後に出す", async () => {
    const t = await createTask();
    await t.stub.advance();
    app().setFault({ pattern: "^DELETE /installation/token$", status: 500, count: 1 });
    await complete(t);
    const [gl] = await rows<{ finalize_done: number }>(
      t.stub,
      "SELECT finalize_done FROM github_link",
    );
    expect(gl?.finalize_done).toBe(0);
    expect(await summaries(t.stub)).toEqual([]);
    const clock = () => Date.now() + 10 * 60_000;
    await runInDurableObject(t.stub, (i) => {
      (i as unknown as { now: () => number }).now = clock;
    });
    app().now = clock;
    await t.stub.advance();
    const [gl2] = await rows<{ finalize_done: number }>(
      t.stub,
      "SELECT finalize_done FROM github_link",
    );
    expect(gl2?.finalize_done).toBe(1);
    expect(await summaries(t.stub)).toHaveLength(1);
  });

  it("Sandbox のカウンタは単調: 後から小さい値の usage が届いても下がらない", async () => {
    const t = await createTask();
    await t.stub.advance();
    const mk = (runtimeMs: number, restarts: number, bootRetries: number) =>
      ({ sandbox: { runtimeMs, restarts, bootRetries } }) as never;
    await t.agent.setUsage(0.1, mk(5_000, 2, 3));
    await t.agent.setUsage(0.2, mk(3_000, 1, 1));
    await t.agent.setUsage(0.3, { web: { search: 5, fetch: 0, browse: 0 } } as never);
    await complete(t);
    const s = await summaryOf(t.stub);
    expect(s.sandbox).toEqual({ observed: true, runtime_ms: 5_000, restarts: 2, boot_retries: 3 });
    expect(s.web.search).toBe(5);
    expect(s.usage.cost_usd).toBeCloseTo(0.3, 9);
  });

  it("sandbox が一度も載らなかったタスクは observed:false・0", async () => {
    const t = await createTask();
    await t.stub.advance();
    await t.agent.setUsage(0.1);
    await complete(t);
    const s = await summaryOf(t.stub);
    expect(s.sandbox).toEqual({ observed: false, runtime_ms: 0, restarts: 0, boot_retries: 0 });
    expect(s.sandbox_usd_estimate).toBe(0);
  });

  it("終端の後に届いた usage（cancel の最終 usage）も要約に反映する", async () => {
    const t = await createTask();
    await t.stub.advance();
    await t.agent.setUsage(0.1, {
      sandbox: { runtimeMs: 1_000, restarts: 0, bootRetries: 0 },
    } as never);
    await t.stub.advance();
    await t.stub.cancel(OWNER);
    await t.agent.setUsage(0.4, {
      sandbox: { runtimeMs: 9_000, restarts: 1, bootRetries: 0 },
    } as never);
    await t.stub.advance();
    await t.stub.advance();
    const recs = await summaries(t.stub);
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({
      kind: "cancelled",
      metrics: { sandbox_runtime_ms: 9_000, sandbox_restarts: 1 },
    });
  });

  it("単価は vars で上書きできる（推定。不正な値は既定値）", async () => {
    const t = await createTask({
      SANDBOX_USD_PER_HOUR: "3.6",
      WEB_USD_PER_1K_SEARCH: "10",
      WEB_USD_PER_1K_FETCH: "bad",
    });
    await t.stub.advance();
    await t.agent.setUsage(0.1, {
      web: { search: 100, fetch: 1000, browse: 0 },
      sandbox: { runtimeMs: 3_600_000, restarts: 0, bootRetries: 0 },
    } as never);
    await complete(t);
    const s = await summaryOf(t.stub);
    expect(s.sandbox_usd_estimate).toBeCloseTo(3.6, 9);
    expect(s.unit_prices.web_usd_per_1k_search).toBe(10);
    expect(s.unit_prices.web_usd_per_1k_fetch).toBe(0);
    expect(s.web_usd_estimate).toBeCloseTo(1, 9);
    const [rec] = await summaries(t.stub);
    expect(rec?.metrics).toMatchObject({ sandbox_usd_estimate: 3.6, web_usd_estimate: 1 });
  });

  it("start を送る前に cancel したタスクでも出す（agent の値は 0）", async () => {
    const t = await createTask();
    await t.stub.cancel(OWNER);
    await t.stub.advance();
    const recs = await summaries(t.stub);
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({ kind: "cancelled" });
  });

  it("question の回数を数える", async () => {
    const t = await createTask();
    await t.stub.advance();
    await t.agent.ask("q1", "which?", ["a"]);
    await t.stub.advance();
    expect((await t.stub.answer(OWNER, "q1", "SECRET-ANSWER")).ok).toBe(true);
    await t.agent.setPhase("running");
    await t.stub.advance();
    await complete(t);
    const s = await summaryOf(t.stub);
    expect(s.questions).toBe(1);
    expect(JSON.stringify(s)).not.toContain("SECRET-ANSWER");
  });

  it("test 以外の環境では testSummary を呼べない", async () => {
    const t = await createTask({ ENVIRONMENT: "production" });
    await expect(summaryOf(t.stub)).rejects.toThrow(/test only/);
  });
});

describe("agent の audit イベントの写し", () => {
  it("固定コードだけを events に audit として積み、gateway の監査ログには出し直さない", async () => {
    const t = await createTask();
    await t.stub.advance();
    await t.agent.emit("audit", { code: "sandbox_privileged_op", op: "set_deadline" });
    await t.agent.emit("audit", { code: "agent_cancelled", note: "leak ghs_x" });
    await t.agent.emit("audit", { code: "weird" });
    await t.stub.advance();
    const audits = await eventsOf(t.stub, "audit");
    expect(audits).toContainEqual({ code: "sandbox_privileged_op", op: "set_deadline" });
    expect(audits).toContainEqual({ code: "agent_cancelled" });
    expect(JSON.stringify(audits)).not.toContain("leak");
    expect(await eventsOf(t.stub, "agent_event")).toContainEqual({ agent_type: "audit" });
    const logged = (await sink(t.stub)).map((r) => r.event);
    expect(logged).not.toContain("sandbox_privileged_op");
    expect(logged).not.toContain("agent_cancelled");
  });

  it("usage イベントの公開 payload に sandbox_* が出る", async () => {
    const t = await createTask();
    await t.stub.advance();
    await t.agent.setUsage(0.1, {
      sandbox: { runtimeMs: 1234, restarts: 1, bootRetries: 0 },
    } as never);
    await t.stub.advance();
    const usage = await eventsOf(t.stub, "usage");
    expect(usage.at(-1)).toMatchObject({
      sandbox_runtime_ms: 1234,
      sandbox_restarts: 1,
      sandbox_boot_retries: 0,
    });
  });
});
