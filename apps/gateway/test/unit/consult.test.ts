import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { ConsultRequest, ConsultResult } from "../../src/agent/contract";
import { readWorkerAudit } from "../../src/audit-sink";
import { CONSULT_WAIT_MS, createConsultService } from "../../src/consult";
import type { Principal } from "../../src/tasks/service";
import { consultServiceWith, controllableAgent, okResult } from "../support/consult-agent";
import { clearWorkerAudit, newUserId, userStub } from "./helpers";

// vitest.config.ts の AGENT_MODELS: sonnet（既定）・haiku・gpt-6-sol。CONSULT_BUDGET_USD は未設定（既定 0.5）

function principal(): Principal {
  return { githubUserId: newUserId(), login: "alice" };
}

type Step = ConsultResult | "throw";

/** AgentDO の代わり。受け取った依頼を記録し、台本の応答を返す。 */
function fakeAgent(steps: Step[] = []) {
  const requests: ConsultRequest[] = [];
  const names: string[] = [];
  return {
    requests,
    names,
    agent: (consultId: string) => ({
      consult: async (req: ConsultRequest): Promise<ConsultResult> => {
        names.push(consultId);
        requests.push(req);
        const step = steps.shift() ?? {
          ok: true as const,
          text: "answer",
          model: req.model,
          usage: { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0 },
          costUsd: 0.0012,
        };
        if (step === "throw") throw new Error("agent down");
        return step;
      },
    }),
  };
}

const input = (over: Record<string, unknown> = {}) => ({
  messages: [{ role: "user", content: "How should I design the cache?" }],
  ...over,
});

beforeEach(() => clearWorkerAudit());

describe("consult: 入力", () => {
  it("messages は 1 件以上で、最初と最後が user。role は user | assistant だけ", async () => {
    const fx = fakeAgent();
    const svc = consultServiceWith(env, fx.agent);
    const p = principal();
    const bad: unknown[] = [
      {},
      { messages: [] },
      { messages: [{ role: "assistant", content: "x" }] },
      {
        messages: [
          { role: "user", content: "x" },
          { role: "assistant", content: "y" },
        ],
      },
      { messages: [{ role: "system", content: "x" }] },
      { messages: [{ role: "user", content: "" }] },
      { messages: [{ role: "user", content: 1 }] },
      input({ system: 1 }),
      input({ max_output_tokens: 0 }),
      input({ max_output_tokens: 1.5 }),
      input({ model: "" }),
    ];
    for (const b of bad) {
      expect(await svc.consult(p, b), JSON.stringify(b)).toMatchObject({
        ok: false,
        error: { code: "invalid_input" },
      });
    }
    expect(fx.requests).toHaveLength(0);
    // 不正な入力では予約もしない
    expect((await userStub(p.githubUserId).budgetStatus()).reserved_usd).toBe(0);
  });

  it("入力が大きすぎれば invalid_input", async () => {
    const fx = fakeAgent();
    const svc = consultServiceWith(env, fx.agent);
    const big = "あ".repeat(60_000);
    const r = await svc.consult(
      principal(),
      input({
        system: big,
        messages: [
          { role: "user", content: big },
          { role: "assistant", content: big },
          { role: "user", content: big },
        ],
      }),
    );
    expect(r).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(fx.requests).toHaveLength(0);
  });

  it("使えないモデルは invalid_input（models_list を案内）。予約もしない", async () => {
    const fx = fakeAgent();
    const svc = consultServiceWith(env, fx.agent);
    const p = principal();
    for (const model of ["anthropic/claude-opus-5-5", "openai/gpt-6-astra", "nope"]) {
      const r = await svc.consult(p, input({ model }));
      expect(r, model).toMatchObject({ ok: false, error: { code: "invalid_input" } });
      if (!r.ok) expect(r.error.message).toContain("models_list");
    }
    expect(fx.requests).toHaveLength(0);
    expect((await userStub(p.githubUserId).budgetStatus()).reserved_usd).toBe(0);
  });
});

describe("consult: effort", () => {
  it("不正な値・モデルが対応しない値は invalid_input（使えるレベルを案内）。予約もしない", async () => {
    const fx = fakeAgent();
    const svc = consultServiceWith(env, fx.agent);
    const p = principal();
    expect(await svc.consult(p, input({ effort: "turbo" }))).toMatchObject({
      ok: false,
      error: { code: "invalid_input" },
    });
    const r = await svc.consult(p, input({ model: "openai/gpt-6-sol", effort: "minimal" }));
    expect(r).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    if (!r.ok) expect(r.error.message).toContain("supported efforts:");
    expect(fx.requests).toHaveLength(0);
    expect((await userStub(p.githubUserId).budgetStatus()).reserved_usd).toBe(0);
  });

  it("指定した effort が agent に渡り、応答に effort が付く", async () => {
    const fx = fakeAgent();
    const svc = consultServiceWith(env, fx.agent);
    const r = await svc.consult(principal(), input({ effort: "high" }));
    expect(fx.requests[0]?.effort).toBe("high");
    expect(r).toMatchObject({ ok: true, value: { effort: "high" } });
  });

  it("省略時は CONSULT_EFFORT（未設定は medium）。不正な値は medium", async () => {
    const run = async (consultEffort: string | undefined) => {
      const fx = fakeAgent();
      const svc = consultServiceWith({ ...env, CONSULT_EFFORT: consultEffort }, fx.agent);
      const r = await svc.consult(principal(), input());
      return { sent: fx.requests[0]?.effort, r };
    };
    expect((await run(undefined)).sent).toBe("medium");
    const high = await run("high");
    expect(high.sent).toBe("high");
    expect(high.r).toMatchObject({ ok: true, value: { effort: "high" } });
    expect((await run("bogus")).sent).toBe("medium");
  });

  it("既定のレベルをモデルが受け付けないときは、モデルごとの既定（agent に effort を渡さない）", async () => {
    const fx = fakeAgent();
    // gpt-6-sol は minimal を受け付けない
    const svc = consultServiceWith({ ...env, CONSULT_EFFORT: "minimal" }, fx.agent);
    await svc.consult(principal(), input({ model: "openai/gpt-6-sol" }));
    expect(fx.requests[0]).not.toHaveProperty("effort");
  });
});

describe("consult: 予約と精算", () => {
  it("予約 → AgentDO（consult-<ULID> のインスタンス）→ 実費で精算。応答は {text, model, usage, cost_usd}", async () => {
    const fx = fakeAgent([
      {
        ok: true,
        text: "Use a write-through cache.",
        model: "anthropic/claude-sonnet-5-5",
        usage: { input: 1000, output: 200, cacheRead: 5000, cacheWrite: 300 },
        costUsd: 0.00555,
      },
    ]);
    const svc = consultServiceWith(env, fx.agent);
    const p = principal();
    const r = await svc.consult(
      p,
      input({ system: "You are an architect.", max_output_tokens: 2000 }),
    );
    expect(r).toEqual({
      ok: true,
      value: {
        text: "Use a write-through cache.",
        model: "anthropic/claude-sonnet-5-5",
        usage: { input: 1000, output: 200, cache_read: 5000, cache_write: 300 },
        cost_usd: 0.00555,
        effort: "medium",
      },
    });
    // AgentDO への依頼: 既定のモデル、予約額（CONSULT_BUDGET_USD の既定 0.5）、consult ごとのインスタンス名
    const req = fx.requests[0];
    expect(req).toMatchObject({
      userId: String(p.githubUserId),
      model: "anthropic/claude-sonnet-5-5",
      system: "You are an architect.",
      messages: [{ role: "user", content: "How should I design the cache?" }],
      maxOutputTokens: 2000,
      budgetUsd: 0.5,
    });
    expect(req?.consultId).toMatch(/^consult-[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(fx.names[0]).toBe(req?.consultId);
    // 月の枠: 実費だけが残り、予約は閉じている
    expect(await userStub(p.githubUserId).budgetStatus()).toMatchObject({
      spent_usd: 0.00555,
      reserved_usd: 0,
    });
  });

  it("model を指定すれば AgentDO に渡す（AGENT_MODELS の中だけ）", async () => {
    const fx = fakeAgent();
    const svc = consultServiceWith(env, fx.agent);
    await svc.consult(principal(), input({ model: "openai/gpt-6-sol" }));
    expect(fx.requests[0]?.model).toBe("openai/gpt-6-sol");
  });

  it("実行中は予約が月の枠に載り、同時実行の枠（タスク）は使わない", async () => {
    const p = principal();
    let during: Awaited<ReturnType<ReturnType<typeof userStub>["budgetStatus"]>> | undefined;
    const svc = consultServiceWith(env, () => ({
      consult: async (req: ConsultRequest): Promise<ConsultResult> => {
        during = await userStub(p.githubUserId).budgetStatus();
        return {
          ok: true,
          text: "x",
          model: req.model,
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
          costUsd: 0.000002,
        };
      },
    }));
    await svc.consult(p, input());
    expect(during).toMatchObject({ reserved_usd: 0.5, remaining_usd: 99.5 });
  });

  it("予約に、決まったモデルと所有者を渡す（索引用。M3b）。入力の本文は渡さない", async () => {
    const calls: unknown[][] = [];
    const svc = createConsultService(env, {
      users: () =>
        ({
          reserveConsult: (...a: unknown[]) => {
            calls.push(a);
            return { ok: true as const, reserved_usd: 0.5 };
          },
          startConsult: () => ({ ok: true as const }),
          discardConsult: () => ({ ok: true as const, discarded: true }),
          waitConsult: () => ({
            ok: true as const,
            status: "done" as const,
            value: {
              text: "x",
              model: "anthropic/claude-sonnet-5-5",
              usage: { input: 1, output: 1, cache_read: 0, cache_write: 0 },
              cost_usd: 0.001,
            },
          }),
          settleConsult: () => ({ ok: true as const, applied: true }),
        }) as never,
    });
    const p = principal();
    const r = await svc.consult(p, input({ system: "SECRET-SYSTEM" }));
    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[1]).toBe("anthropic/claude-sonnet-5-5");
    expect(calls[0]?.[2]).toEqual({ id: p.githubUserId, login: "alice" });
    expect(JSON.stringify(calls)).not.toContain("SECRET-SYSTEM");
    expect(JSON.stringify(calls)).not.toContain("design the cache");
  });

  it("月の枠が足りなければ budget_exceeded で、AgentDO は呼ばない", async () => {
    const fx = fakeAgent();
    const svc = consultServiceWith(env, fx.agent);
    const p = principal();
    await userStub(p.githubUserId).reserveConsult("consult-00000000000000000000000000");
    await userStub(p.githubUserId).settleConsult("consult-00000000000000000000000000", 100);
    const r = await svc.consult(p, input());
    expect(r).toMatchObject({ ok: false, error: { code: "budget_exceeded" } });
    expect(fx.requests).toHaveLength(0);
  });

  it("AgentDO がモデルの失敗を返したら upstream_unavailable。かかった費用は精算する", async () => {
    const fx = fakeAgent([
      { ok: false, code: "model_error", message: "the model call failed", costUsd: 0.0004 },
    ]);
    const svc = consultServiceWith(env, fx.agent);
    const p = principal();
    const r = await svc.consult(p, input());
    expect(r).toMatchObject({ ok: false, error: { code: "upstream_unavailable" } });
    expect(await userStub(p.githubUserId).budgetStatus()).toMatchObject({
      spent_usd: 0.0004,
      reserved_usd: 0,
    });
  });

  it("AgentDO がモデルの 4xx を返したら model_rejected（retry_after_seconds なし）。5xx の model_error は従来どおり upstream_unavailable", async () => {
    const fx = fakeAgent([
      { ok: false, code: "model_rejected", message: "the model rejected the request", costUsd: 0 },
    ]);
    const svc = consultServiceWith(env, fx.agent);
    const p = principal();
    const r = await svc.consult(p, input());
    expect(r).toMatchObject({ ok: false, error: { code: "model_rejected" } });
    if (r.ok) throw new Error("expected failure");
    // 待っても直らないので、再試行を促さない
    expect(r.error.retry_after_seconds).toBeUndefined();
    expect(r.error.message).not.toMatch(/retry later/);
    // かかった費用（0）で精算し、予約は閉じる
    expect(await userStub(p.githubUserId).budgetStatus()).toMatchObject({
      spent_usd: 0,
      reserved_usd: 0,
    });
    // model_error は再試行を促す
    const fx2 = fakeAgent([
      { ok: false, code: "model_error", message: "the model call failed", costUsd: 0 },
    ]);
    const r2 = await consultServiceWith(env, fx2.agent).consult(principal(), input());
    expect(r2).toMatchObject({
      ok: false,
      error: { code: "upstream_unavailable", retry_after_seconds: 30 },
    });
  });

  it("AgentDO が入力の大きさ・モデルを拒否したら invalid_input。費用は 0 で精算する", async () => {
    for (const code of ["input_too_large", "unknown_model", "invalid_request"] as const) {
      const fx = fakeAgent([{ ok: false, code, message: "m", costUsd: 0 }]);
      const svc = consultServiceWith(env, fx.agent);
      const p = principal();
      expect(await svc.consult(p, input()), code).toMatchObject({
        ok: false,
        error: { code: "invalid_input" },
      });
      expect(await userStub(p.githubUserId).budgetStatus()).toMatchObject({
        spent_usd: 0,
        reserved_usd: 0,
      });
    }
  });

  it("AgentDO の呼び出しが例外で終わり実費が分からないときは、予約額で精算する（予約より少なく数えない）", async () => {
    const fx = fakeAgent(["throw"]);
    const svc = consultServiceWith(env, fx.agent);
    const p = principal();
    const r = await svc.consult(p, input());
    expect(r).toMatchObject({ ok: false, error: { code: "upstream_unavailable" } });
    expect(await userStub(p.githubUserId).budgetStatus()).toMatchObject({
      spent_usd: 0.5,
      reserved_usd: 0,
    });
  });

  it("例外・壊れた応答で予約額で確定した分は estimated_usd に入る。実費が分かった精算は入らない", async () => {
    const p = principal();
    const bad = consultServiceWith(env, () => ({
      consult: async () => ({ nonsense: true }) as unknown as ConsultResult,
    }));
    await consultServiceWith(env, fakeAgent(["throw"]).agent).consult(p, input());
    await bad.consult(p, input());
    // 実費が分かった consult（既定の応答。0.0012）は estimated_usd に入らない
    await consultServiceWith(env, fakeAgent().agent).consult(p, input());
    const status = await userStub(p.githubUserId).budgetStatus();
    expect(status.estimated_usd).toBeCloseTo(1.0, 9);
    expect(status.spent_usd).toBeCloseTo(1.0012, 9);
  });

  it("agent が costEstimated を立てた応答（失敗・usage の空の成功）は、その費用で確定して estimated_usd に入る", async () => {
    const p = principal();
    const fx = fakeAgent([
      { ok: false, code: "model_error", message: "m", costUsd: 0.5, costEstimated: true },
      {
        ok: true,
        text: "answer",
        model: "anthropic/claude-sonnet-5-5",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        costUsd: 0.4,
        usageMissing: true,
        costEstimated: true,
      },
      // 実費が分かる失敗（costEstimated なし）
      { ok: false, code: "model_error", message: "m", costUsd: 0.01 },
    ]);
    const svc = consultServiceWith(env, fx.agent);
    await svc.consult(p, input());
    await svc.consult(p, input());
    await svc.consult(p, input());
    const status = await userStub(p.githubUserId).budgetStatus();
    expect(status.estimated_usd).toBeCloseTo(0.9, 9);
    expect(status.spent_usd).toBeCloseTo(0.91, 9);
  });

  it("AgentDO の応答が壊れた形でも、予約額で精算して internal を返す", async () => {
    const svc = consultServiceWith(env, () => ({
      consult: async () => ({ nonsense: true }) as unknown as ConsultResult,
    }));
    const p = principal();
    const r = await svc.consult(p, input());
    expect(r).toMatchObject({ ok: false, error: { code: "internal" } });
    expect(await userStub(p.githubUserId).budgetStatus()).toMatchObject({ spent_usd: 0.5 });
  });
});

describe("consult: 監査", () => {
  it("consult_started / consult_finished を出す（userId・model・cost_usd。会話の内容は出さない）", async () => {
    const fx = fakeAgent();
    const testEnv = { ...env, ENVIRONMENT: "test" } as unknown as Env;
    const svc = consultServiceWith(testEnv, fx.agent);
    const p = principal();
    await svc.consult(p, input({ system: "SECRET-SYSTEM" }));
    const records = (await readWorkerAudit(testEnv)).filter((r) => r.userId === p.githubUserId);
    expect(records.map((r) => r.event)).toEqual(["consult_started", "consult_finished"]);
    expect(records[0]).toMatchObject({
      caller: "parent",
      model: "anthropic/claude-sonnet-5-5",
    });
    expect(records[1]).toMatchObject({ model: "anthropic/claude-sonnet-5-5", cost_usd: 0.0012 });
    expect(records[0]?.consult_id).toBe(records[1]?.consult_id);
    const text = JSON.stringify(records);
    expect(text).not.toContain("SECRET-SYSTEM");
    expect(text).not.toContain("How should I design");
  });

  it("usage が返らなかった成功（usageMissing）は、見積りの費用で精算し、consult_finished に reason: usage_missing を残す", async () => {
    const fx = fakeAgent([
      {
        ok: true,
        text: "answer",
        model: "anthropic/claude-sonnet-5-5",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        costUsd: 0.4,
        usageMissing: true,
      },
    ]);
    const testEnv = { ...env, ENVIRONMENT: "test" } as unknown as Env;
    const svc = consultServiceWith(testEnv, fx.agent);
    const p = principal();
    const r = await svc.consult(p, input());
    expect(r).toMatchObject({ ok: true, value: { cost_usd: 0.4 } });
    expect((await userStub(p.githubUserId).budgetStatus()).spent_usd).toBeCloseTo(0.4, 9);
    const records = (await readWorkerAudit(testEnv)).filter((x) => x.userId === p.githubUserId);
    expect(records.find((x) => x.event === "consult_finished")).toMatchObject({
      cost_usd: 0.4,
      reason: "usage_missing",
    });
  });
});

describe("consult: 50 秒以内に終わる（今と同じ応答の形。本文を UserDO に残さない）", () => {
  it("成功の応答に status・consult_id を足さない。答えの行も残らない", async () => {
    const fx = fakeAgent();
    const svc = consultServiceWith(env, fx.agent);
    const p = principal();
    const r = await svc.consult(p, input());
    expect(r).toEqual({
      ok: true,
      value: {
        text: "answer",
        model: "anthropic/claude-sonnet-5-5",
        usage: { input: 1000, output: 200, cache_read: 0, cache_write: 0 },
        cost_usd: 0.0012,
        effort: "medium",
      },
    });
    const rows = await runInDurableObject(userStub(p.githubUserId), (_i, s) =>
      s.storage.sql.exec("SELECT * FROM consult_answer").toArray(),
    );
    expect(rows).toEqual([]);
  });

  it("失敗も今と同じエラー（答えの行は残らない）", async () => {
    const fx = fakeAgent([{ ok: false, code: "model_error", message: "m", costUsd: 0 }, "throw"]);
    const svc = consultServiceWith(env, fx.agent);
    const p = principal();
    expect(await svc.consult(p, input())).toEqual({
      ok: false,
      error: {
        code: "upstream_unavailable",
        message: "the model call failed; retry later",
        retry_after_seconds: 30,
      },
    });
    expect(await svc.consult(p, input())).toEqual({
      ok: false,
      error: {
        code: "upstream_unavailable",
        message: "the consult is temporarily unavailable; retry later",
        retry_after_seconds: 30,
      },
    });
    const rows = await runInDurableObject(userStub(p.githubUserId), (_i, s) =>
      s.storage.sql.exec("SELECT * FROM consult_answer").toArray(),
    );
    expect(rows).toEqual([]);
  });

  it("待つ上限は 50 秒（CONSULT_WAIT_MS）", () => {
    expect(CONSULT_WAIT_MS).toBe(50_000);
  });
});

describe("consult: 50 秒を超える（pending）", () => {
  it("pending を通常の結果で返す。consult_id は予約と同じ。retry_after_seconds は付かない。予約は開いたまま", async () => {
    const agent = controllableAgent();
    const svc = consultServiceWith(env, agent.factory, { waitMs: 30 });
    const p = principal();
    const r = await svc.consult(p, input());
    const id = agent.calls[0]?.consultId;
    expect(id).toMatch(/^consult-[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(r).toEqual({ ok: true, value: { consult_id: id, status: "pending" } });
    expect(await userStub(p.githubUserId).budgetStatus()).toMatchObject({
      reserved_usd: 0.5,
      spent_usd: 0,
      pending_consults: 1,
    });
    // 完了すると、リクエストが終わっていても UserDO が精算し、答えは consult_result で取れる
    agent.release(id as string, okResult({ text: "slow answer", costUsd: 0.25 }));
    const got = await svc.consultResult(p, { consult_id: id, timeout_seconds: 5 });
    expect(got).toEqual({
      ok: true,
      value: {
        consult_id: id,
        status: "done",
        text: "slow answer",
        model: "anthropic/claude-sonnet-5-5",
        usage: { input: 1000, output: 200, cache_read: 0, cache_write: 0 },
        cost_usd: 0.25,
        effort: "medium",
      },
    });
    expect(await userStub(p.githubUserId).budgetStatus()).toMatchObject({
      reserved_usd: 0,
      spent_usd: 0.25,
      pending_consults: 0,
    });
  });

  it("遅い失敗は consult_result が failed（error は 50 秒以内の失敗と同じ形）で返す", async () => {
    const agent = controllableAgent();
    const svc = consultServiceWith(env, agent.factory, { waitMs: 20 });
    const p = principal();
    const r = await svc.consult(p, input());
    const id = agent.calls[0]?.consultId as string;
    expect(r).toMatchObject({ ok: true, value: { status: "pending" } });
    agent.release(id, { ok: false, code: "model_rejected", message: "x", costUsd: 0.01 });
    expect(await svc.consultResult(p, { consult_id: id, timeout_seconds: 5 })).toEqual({
      ok: true,
      value: {
        consult_id: id,
        status: "failed",
        error: {
          code: "model_rejected",
          message:
            "the model rejected the request (a 4xx response, e.g. invalid_request_error); retrying the same request will not help. Change the input or the model",
        },
        cost_usd: 0.01,
      },
    });
  });

  it("consult の待ち時間の間に UserDO への待機が切れても（例外）、pending を返す（consult_id で取り直せる）", async () => {
    const calls: string[] = [];
    const svc = createConsultService(env, {
      users: () =>
        ({
          reserveConsult: () => ({ ok: true as const, reserved_usd: 0.5 }),
          startConsult: () => ({ ok: true as const }),
          waitConsult: () => {
            throw new Error("Durable Object reset");
          },
          settleConsult: (...a: unknown[]) => calls.push(String(a[0])),
        }) as never,
    });
    const r = await svc.consult(principal(), input());
    expect(r).toMatchObject({ ok: true, value: { status: "pending" } });
    expect(calls).toEqual([]);
  });

  it("同時 pending は 4 まで。5 件目は concurrency_limit で、AgentDO を呼ばない", async () => {
    const agent = controllableAgent();
    const svc = consultServiceWith(env, agent.factory, { waitMs: 10 });
    const p = principal();
    for (let i = 0; i < 4; i++) {
      expect(await svc.consult(p, input())).toMatchObject({
        ok: true,
        value: { status: "pending" },
      });
    }
    const fifth = await svc.consult(p, input());
    expect(fifth).toMatchObject({ ok: false, error: { code: "concurrency_limit" } });
    expect(agent.calls).toHaveLength(4);
    expect(await userStub(p.githubUserId).budgetStatus()).toMatchObject({
      pending_consults: 4,
      reserved_usd: 2,
    });
  });
});

describe("consult_result: 入力と各状態", () => {
  const unknownId = "consult-00000000000000000000000000";

  it("consult_id が文字列でない・timeout_seconds が不正（負・小数・文字列）は invalid_input", async () => {
    const svc = consultServiceWith(env, fakeAgent().agent);
    const p = principal();
    for (const bad of [
      {},
      { consult_id: 1 },
      { consult_id: null },
      { consult_id: unknownId, timeout_seconds: -1 },
      { consult_id: unknownId, timeout_seconds: 1.5 },
      { consult_id: unknownId, timeout_seconds: "5" },
    ]) {
      expect(await svc.consultResult(p, bad), JSON.stringify(bad)).toMatchObject({
        ok: false,
        error: { code: "invalid_input" },
      });
    }
  });

  it("形式が不正・存在しない・他人・期限切れは、同じ not_found（同じ文言）", async () => {
    const agent = controllableAgent();
    const svc = consultServiceWith(env, agent.factory, { waitMs: 10 });
    const alice = principal();
    const bob = principal();
    await svc.consult(alice, input());
    const id = agent.calls[0]?.consultId as string;
    agent.release(id);
    expect(await svc.consultResult(alice, { consult_id: id, timeout_seconds: 5 })).toMatchObject({
      ok: true,
      value: { status: "done" },
    });
    const outcomes = [
      await svc.consultResult(bob, { consult_id: id }), // 他人
      await svc.consultResult(alice, { consult_id: unknownId }), // 存在しない
      await svc.consultResult(alice, { consult_id: "consult-x" }), // 形式が不正
      await svc.consultResult(alice, { consult_id: "" }),
      await svc.consultResult(alice, { consult_id: "task-00000000000000000000000000" }),
    ];
    for (const o of outcomes) {
      expect(o).toEqual({
        ok: false,
        error: { code: "not_found", message: "consult not found (it may have expired)" },
      });
    }
  });

  it("timeout_seconds: 省略は 30 秒、上限 50 秒にクランプ、0 は待たない（UserDO には ms で渡す）", async () => {
    const waits: unknown[][] = [];
    const svc = createConsultService(env, {
      users: () =>
        ({
          waitConsult: (...a: unknown[]) => {
            waits.push(a);
            return { ok: true as const, status: "pending" as const };
          },
        }) as never,
    });
    const p = principal();
    await svc.consultResult(p, { consult_id: unknownId });
    await svc.consultResult(p, { consult_id: unknownId, timeout_seconds: 999 });
    await svc.consultResult(p, { consult_id: unknownId, timeout_seconds: 0 });
    await svc.consultResult(p, { consult_id: unknownId, timeout_seconds: 7 });
    expect(waits.map((w) => [w[0], w[1], w[2]])).toEqual([
      [unknownId, p.githubUserId, 30_000],
      [unknownId, p.githubUserId, 50_000],
      [unknownId, p.githubUserId, 0],
      [unknownId, p.githubUserId, 7_000],
    ]);
  });

  it("pending: {consult_id, status: pending}。待機の枠が埋まっていたときだけ retry_after_seconds", async () => {
    const answers = [
      { ok: true as const, status: "pending" as const },
      { ok: true as const, status: "pending" as const, retry_after_seconds: 5 },
    ];
    const svc = createConsultService(env, {
      users: () => ({ waitConsult: () => answers.shift() }) as never,
    });
    const p = principal();
    expect(await svc.consultResult(p, { consult_id: unknownId })).toEqual({
      ok: true,
      value: { consult_id: unknownId, status: "pending" },
    });
    expect(await svc.consultResult(p, { consult_id: unknownId })).toEqual({
      ok: true,
      value: { consult_id: unknownId, status: "pending", retry_after_seconds: 5 },
    });
  });
});

describe("consult: 答えを受け取れたときだけ UserDO の本文を消す", () => {
  const doneValue = {
    text: "x",
    model: "anthropic/claude-sonnet-5-5",
    usage: { input: 1, output: 1, cache_read: 0, cache_write: 0 },
    cost_usd: 0.001,
  };
  const mock = (wait: unknown, discards: unknown[][]) =>
    ({
      reserveConsult: () => ({ ok: true as const, reserved_usd: 0.5 }),
      startConsult: () => ({ ok: true as const }),
      waitConsult: () => wait,
      discardConsult: (...a: unknown[]) => {
        discards.push(a);
        return { ok: true as const, discarded: true };
      },
    }) as never;

  it("done / failed を受け取ったら消す。pending のときは消さない（取りに来られる）", async () => {
    const p = principal();
    for (const [wait, expected] of [
      [{ ok: true, status: "done", value: doneValue }, 1],
      [
        {
          ok: true,
          status: "failed",
          error: { code: "model_rejected", message: "m" },
          cost_usd: 0,
        },
        1,
      ],
      [{ ok: true, status: "pending" }, 0],
    ] as const) {
      const discards: unknown[][] = [];
      const svc = createConsultService(env, { users: () => mock(wait, discards) });
      await svc.consult(p, input());
      expect(discards).toHaveLength(expected);
      if (expected === 1) expect(discards[0]?.[1]).toBe(p.githubUserId);
    }
  });

  it("消すのに失敗しても、受け取った答えは返す", async () => {
    const svc = createConsultService(env, {
      users: () =>
        ({
          reserveConsult: () => ({ ok: true as const, reserved_usd: 0.5 }),
          startConsult: () => ({ ok: true as const }),
          waitConsult: () => ({ ok: true as const, status: "done" as const, value: doneValue }),
          discardConsult: () => {
            throw new Error("boom");
          },
        }) as never,
    });
    expect(await svc.consult(principal(), input())).toEqual({ ok: true, value: doneValue });
  });
});
