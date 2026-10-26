import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { ConsultRequest, ConsultResult } from "../../src/agent/contract";
import { readWorkerAudit } from "../../src/audit-sink";
import type { Principal } from "../../src/tasks/service";
import { consultServiceWith, okResult } from "../support/consult-agent";
import { clearWorkerAudit, newUserId, userStub } from "./helpers";

// consult の tools（#135）のユースケース層: 入力の検査・tool calling の対応の確認（予約より前）・予約額・監査。
// vitest.config.ts の AGENT_MODELS: sonnet（既定）・haiku・gpt-6-sol・Workers AI の gpt-oss

function principal(): Principal {
  return { githubUserId: newUserId(), login: "alice" };
}

function fakeAgent(steps: ConsultResult[] = []) {
  const requests: ConsultRequest[] = [];
  return {
    requests,
    agent: (_consultId: string) => ({
      consult: async (req: ConsultRequest): Promise<ConsultResult> => {
        requests.push(structuredClone(req));
        return steps.shift() ?? okResult({ model: req.model });
      },
    }),
  };
}

const input = (over: Record<string, unknown> = {}) => ({
  messages: [{ role: "user", content: "What changed in rovo 2.0?" }],
  ...over,
});

beforeEach(() => clearWorkerAudit());

describe("consult: tools（#135）", () => {
  it("重複・web_browse・知らない道具は invalid_input。予約もしない", async () => {
    const fx = fakeAgent();
    const svc = consultServiceWith(env, fx.agent);
    const p = principal();
    for (const tools of [["web_search", "web_search"], ["web_browse"], ["bash"], "web_search"]) {
      expect(await svc.consult(p, input({ tools })), JSON.stringify(tools)).toMatchObject({
        ok: false,
        error: { code: "invalid_input" },
      });
    }
    expect(fx.requests).toHaveLength(0);
    expect(await userStub(p.githubUserId).budgetStatus()).toMatchObject({ spent_usd: 0 });
  });

  it("tool calling に対応しないモデル（Workers AI）に tools を渡すと、予約の前に invalid_input（models_list の tool_calling を案内）", async () => {
    const fx = fakeAgent();
    const svc = consultServiceWith(env, fx.agent);
    const p = principal();
    const r = await svc.consult(
      p,
      input({ model: "workers-ai/@cf/openai/gpt-oss-120b", tools: ["web_search"] }),
    );
    expect(r).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    if (r.ok) throw new Error("unexpected ok");
    expect(r.error.message).toContain("tool_calling");
    expect(fx.requests).toHaveLength(0);
    expect(await userStub(p.githubUserId).budgetStatus()).toMatchObject({
      spent_usd: 0,
      reserved_usd: 0,
    });
    // 道具なしなら同じモデルで通る
    expect(
      await svc.consult(p, input({ model: "workers-ai/@cf/openai/gpt-oss-120b", tools: [] })),
    ).toMatchObject({ ok: true });
  });

  it("tools を渡すと CONSULT_TOOLS_BUDGET_USD（既定 1）を予約し、AgentDO に道具の定義を渡す。道具を呼ばなければ答えは従来の形", async () => {
    const fx = fakeAgent([okResult({ text: "no tools needed", costUsd: 0.002 })]);
    const svc = consultServiceWith(env, fx.agent);
    const p = principal();
    const r = await svc.consult(p, input({ tools: ["web_search"] }));
    expect(r).toMatchObject({ ok: true, value: { text: "no tools needed", cost_usd: 0.002 } });
    if (!r.ok) throw new Error("not ok");
    expect(r.value).not.toHaveProperty("tools_used");
    expect(fx.requests[0]?.budgetUsd).toBe(1);
    expect(fx.requests[0]?.tools?.map((t) => t.name)).toEqual(["web_search"]);
    expect((await userStub(p.githubUserId).budgetStatus()).spent_usd).toBeCloseTo(0.002, 9);
  });

  it("空の配列は道具なしと同じ（予約は CONSULT_BUDGET_USD、道具の定義を渡さない）", async () => {
    const fx = fakeAgent();
    const svc = consultServiceWith(env, fx.agent);
    expect(await svc.consult(principal(), input({ tools: [] }))).toMatchObject({ ok: true });
    expect(fx.requests[0]?.budgetUsd).toBe(0.5);
    expect(fx.requests[0]).not.toHaveProperty("tools");
  });

  it("監査: consult_started / consult_finished に kind: tools、finished に web_search / web_fetch の回数", async () => {
    const fx = fakeAgent();
    const testEnv = { ...env, ENVIRONMENT: "test" } as unknown as Env;
    const svc = consultServiceWith(testEnv, fx.agent);
    const p = principal();
    await svc.consult(p, input({ tools: ["web_search", "web_fetch"] }));
    const records = (await readWorkerAudit(testEnv)).filter((x) => x.userId === p.githubUserId);
    expect(records.map((x) => x.event)).toEqual(["consult_started", "consult_finished"]);
    expect(records[0]).toMatchObject({ kind: "tools" });
    expect(records[1]).toMatchObject({ kind: "tools", web_search: 0, web_fetch: 0 });
  });

  it("道具なしの監査は従来どおり（kind も回数も付けない）", async () => {
    const fx = fakeAgent();
    const testEnv = { ...env, ENVIRONMENT: "test" } as unknown as Env;
    const svc = consultServiceWith(testEnv, fx.agent);
    const p = principal();
    await svc.consult(p, input());
    const records = (await readWorkerAudit(testEnv)).filter((x) => x.userId === p.githubUserId);
    for (const r of records) {
      expect(r).not.toHaveProperty("kind");
      expect(r).not.toHaveProperty("web_search");
    }
  });
});
