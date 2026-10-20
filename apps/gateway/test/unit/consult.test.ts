import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { ConsultRequest, ConsultResult } from "../../src/agent/contract";
import { readWorkerAudit } from "../../src/audit-sink";
import { createConsultService } from "../../src/consult";
import type { Principal } from "../../src/tasks/service";
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
    const svc = createConsultService(env, { agent: fx.agent });
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
    const svc = createConsultService(env, { agent: fx.agent });
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
    const svc = createConsultService(env, { agent: fx.agent });
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
    const svc = createConsultService(env, { agent: fx.agent });
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
    const svc = createConsultService(env, { agent: fx.agent });
    await svc.consult(principal(), input({ model: "openai/gpt-6-sol" }));
    expect(fx.requests[0]?.model).toBe("openai/gpt-6-sol");
  });

  it("実行中は予約が月の枠に載り、同時実行の枠（タスク）は使わない", async () => {
    const p = principal();
    let during: Awaited<ReturnType<ReturnType<typeof userStub>["budgetStatus"]>> | undefined;
    const svc = createConsultService(env, {
      agent: () => ({
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
      }),
    });
    await svc.consult(p, input());
    expect(during).toMatchObject({ reserved_usd: 0.5, remaining_usd: 99.5 });
  });

  it("月の枠が足りなければ budget_exceeded で、AgentDO は呼ばない", async () => {
    const fx = fakeAgent();
    const svc = createConsultService(env, { agent: fx.agent });
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
    const svc = createConsultService(env, { agent: fx.agent });
    const p = principal();
    const r = await svc.consult(p, input());
    expect(r).toMatchObject({ ok: false, error: { code: "upstream_unavailable" } });
    expect(await userStub(p.githubUserId).budgetStatus()).toMatchObject({
      spent_usd: 0.0004,
      reserved_usd: 0,
    });
  });

  it("AgentDO が入力の大きさ・モデルを拒否したら invalid_input。費用は 0 で精算する", async () => {
    for (const code of ["input_too_large", "unknown_model", "invalid_request"] as const) {
      const fx = fakeAgent([{ ok: false, code, message: "m", costUsd: 0 }]);
      const svc = createConsultService(env, { agent: fx.agent });
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
    const svc = createConsultService(env, { agent: fx.agent });
    const p = principal();
    const r = await svc.consult(p, input());
    expect(r).toMatchObject({ ok: false, error: { code: "upstream_unavailable" } });
    expect(await userStub(p.githubUserId).budgetStatus()).toMatchObject({
      spent_usd: 0.5,
      reserved_usd: 0,
    });
  });

  it("AgentDO の応答が壊れた形でも、予約額で精算して internal を返す", async () => {
    const svc = createConsultService(env, {
      agent: () => ({ consult: async () => ({ nonsense: true }) as unknown as ConsultResult }),
    });
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
    const svc = createConsultService(testEnv, { agent: fx.agent });
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
});
