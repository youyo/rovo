import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { ConsultRequest, ConsultResult } from "../../src/agent/contract";
import { listModels, resolveModel } from "../../src/models";
import { createTaskService, type Principal } from "../../src/tasks/service";
import { consultServiceWith } from "../support/consult-agent";
import { fakeAgent, newUserId, userStub } from "./helpers";

// D10b: AI Gateway の BYOK のキー（provider_configs）の有無で、使えるモデルが決まる。実 API は呼ばず、fetch は偽物。
// KV のキャッシュはテストをまたいで残るので、テストごとに別の account / gateway の id を使う。

const ALL_MODELS = [
  "anthropic/claude-sonnet-5-5",
  "anthropic/claude-haiku-5-5",
  "openai/gpt-6-sol",
  "workers-ai/@cf/openai/gpt-oss-120b",
  "workers-ai/@cf/openai/gpt-oss-20b",
].join(",");
const SONNET = "anthropic/claude-sonnet-5-5";
const HAIKU = "anthropic/claude-haiku-5-5";
const SOL = "openai/gpt-6-sol";
const OSS120 = "workers-ai/@cf/openai/gpt-oss-120b";
const OSS20 = "workers-ai/@cf/openai/gpt-oss-20b";

let seq = 0;
function setup(over: Record<string, unknown> = {}) {
  seq += 1;
  return {
    ...env,
    ENVIRONMENT: "production",
    CLOUDFLARE_API_TOKEN: "tok-test",
    CLOUDFLARE_ACCOUNT_ID: `macct${seq}`,
    AI_GATEWAY_ID: `mgw${seq}`,
    AGENT_MODELS: ALL_MODELS,
    ...over,
  } as unknown as Env & Record<string, string | undefined>;
}

/** provider_configs の偽の応答。providers は default alias のキーを持つプロバイダー名。 */
function keysFetch(providers: string[] | "fail") {
  const calls: string[] = [];
  const fn = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    if (providers === "fail") return new Response("boom", { status: 500 });
    return new Response(
      JSON.stringify({
        success: true,
        result: providers.map((p) => ({ provider_slug: p, alias: "default" })),
      }),
    );
  }) as typeof fetch;
  return { fn, calls };
}

function principal(): Principal {
  return { githubUserId: newUserId(), login: "alice" };
}

const taskInput = {
  repository: "acme/widgets",
  base_ref: "main",
  base_sha: "0123456789abcdef0123456789abcdef01234567",
  title: "t",
  instructions: "do it",
};

describe("listModels: available / unavailable_reason", () => {
  it("Anthropic のキーだけある: OpenAI のモデルは available: false（no_provider_key）。Workers AI は常に available", async () => {
    const f = keysFetch(["anthropic"]);
    const models = await listModels(setup(), { fetch: f.fn });
    const by = Object.fromEntries(models.map((m) => [m.id, m]));
    expect(by[SONNET]).toMatchObject({ available: true });
    expect(by[SONNET]).not.toHaveProperty("unavailable_reason");
    expect(by[HAIKU]).toMatchObject({ available: true });
    expect(by[SOL]).toMatchObject({ available: false, unavailable_reason: "no_provider_key" });
    expect(by[OSS120]).toMatchObject({ available: true, provider: "workers-ai" });
    expect(by[OSS20]).toMatchObject({ available: true });
  });

  it("どちらのキーも無い: Anthropic と OpenAI は available: false。既定は gpt-oss-120b", async () => {
    const models = await listModels(setup(), { fetch: keysFetch([]).fn });
    expect(models.filter((m) => m.available).map((m) => m.id)).toEqual([OSS120, OSS20]);
    expect(models.filter((m) => m.default).map((m) => m.id)).toEqual([OSS120]);
    for (const m of models.filter((m) => !m.available)) {
      expect(m.unavailable_reason).toBe("no_provider_key");
    }
  });

  it("OpenAI のキーだけある: Anthropic のモデルは使えない。既定は gpt-oss-120b（OpenAI より先）", async () => {
    const models = await listModels(setup(), { fetch: keysFetch(["openai"]).fn });
    expect(models.find((m) => m.id === SONNET)?.available).toBe(false);
    expect(models.find((m) => m.id === SOL)?.available).toBe(true);
    expect(models.filter((m) => m.default).map((m) => m.id)).toEqual([OSS120]);
  });

  it("両方のキーがある: AGENT_MODEL（sonnet）が既定。全部 available", async () => {
    const models = await listModels(setup(), { fetch: keysFetch(["anthropic", "openai"]).fn });
    expect(models.every((m) => m.available)).toBe(true);
    expect(models.filter((m) => m.default).map((m) => m.id)).toEqual([SONNET]);
  });

  it("判定できない（API の失敗・キャッシュ無し / トークン未設定）: 従来どおり AGENT_MODELS の全部が available", async () => {
    for (const [e, f] of [
      [setup(), keysFetch("fail")],
      [setup({ CLOUDFLARE_API_TOKEN: "" }), keysFetch(["anthropic"])],
    ] as const) {
      const models = await listModels(e, { fetch: f.fn });
      expect(models.every((m) => m.available)).toBe(true);
      expect(models.filter((m) => m.default).map((m) => m.id)).toEqual([SONNET]);
    }
  });

  it("available なモデルが 1 つも無ければ default: true のモデルも無い", async () => {
    const models = await listModels(setup({ AGENT_MODELS: `${SONNET},${SOL}` }), {
      fetch: keysFetch([]).fn,
    });
    expect(models.every((m) => !m.available)).toBe(true);
    expect(models.some((m) => m.default)).toBe(false);
  });

  it("キャッシュ: 続けて呼んでも API は 1 回（5 分）", async () => {
    const e = setup();
    const f = keysFetch(["anthropic"]);
    await listModels(e, { fetch: f.fn });
    await listModels(e, { fetch: f.fn });
    expect(f.calls).toHaveLength(1);
  });
});

describe("resolveModel", () => {
  it("指定したモデルが available ならそのまま", async () => {
    const e = setup();
    const f = keysFetch(["anthropic"]);
    expect(await resolveModel(e, HAIKU, { fetch: f.fn })).toEqual({ ok: true, model: HAIKU });
    expect(await resolveModel(e, OSS20, { fetch: f.fn })).toEqual({ ok: true, model: OSS20 });
  });

  it("キーが無いプロバイダーのモデルは model_unavailable（models_list とキー登録を案内。トークンは出さない）", async () => {
    const r = await resolveModel(setup(), SOL, { fetch: keysFetch(["anthropic"]).fn });
    expect(r).toMatchObject({ ok: false, code: "model_unavailable" });
    if (r.ok) throw new Error("unreachable");
    expect(r.message).toContain(SOL);
    expect(r.message).toContain("models_list");
    expect(r.message).toContain("openai");
    expect(r.message).not.toContain("tok-test");
  });

  it("AGENT_MODELS の外は invalid_input のまま", async () => {
    const r = await resolveModel(setup(), "anthropic/claude-opus-5-5", {
      fetch: keysFetch(["anthropic"]).fn,
    });
    expect(r).toMatchObject({ ok: false, code: "invalid_input" });
  });

  it("省略: AGENT_MODEL が available ならそれ。無ければ固定の順序（Anthropic → gpt-oss-120b → …）で選ぶ", async () => {
    expect(await resolveModel(setup(), undefined, { fetch: keysFetch(["anthropic"]).fn })).toEqual({
      ok: true,
      model: SONNET,
    });
    // Anthropic のキーが無い
    expect(await resolveModel(setup(), undefined, { fetch: keysFetch(["openai"]).fn })).toEqual({
      ok: true,
      model: OSS120,
    });
    // AGENT_MODEL を haiku にしても、キーが無ければ gpt-oss-120b
    expect(
      await resolveModel(setup({ AGENT_MODEL: HAIKU }), undefined, { fetch: keysFetch([]).fn }),
    ).toEqual({ ok: true, model: OSS120 });
    // gpt-oss-120b が AGENT_MODELS に無ければ次の候補
    expect(
      await resolveModel(setup({ AGENT_MODELS: `${SONNET},${OSS20}` }), undefined, {
        fetch: keysFetch([]).fn,
      }),
    ).toEqual({ ok: true, model: OSS20 });
  });

  it("省略で available なモデルが 1 つも無ければ model_unavailable", async () => {
    const r = await resolveModel(setup({ AGENT_MODELS: `${SONNET},${SOL}` }), undefined, {
      fetch: keysFetch([]).fn,
    });
    expect(r).toMatchObject({ ok: false, code: "model_unavailable" });
    if (!r.ok) expect(r.message).toContain("models_list");
  });

  it("判定できないとき: 省略は従来どおり AGENT_MODEL", async () => {
    expect(await resolveModel(setup(), undefined, { fetch: keysFetch("fail").fn })).toEqual({
      ok: true,
      model: SONNET,
    });
  });
});

describe("task_start", () => {
  it("available でないモデルは model_unavailable。予約もしない", async () => {
    const p = principal();
    const svc = createTaskService(setup(), undefined, { fetch: keysFetch(["anthropic"]).fn });
    const r = await svc.start(
      p,
      { ...taskInput, model: SOL },
      { repositoryId: 4242, installationId: 77 },
    );
    expect(r).toMatchObject({ ok: false, error: { code: "model_unavailable" } });
    if (!r.ok) expect(r.error.message).toContain("models_list");
    // 予約が残っていない（次の start が concurrency_limit にならない）
    const again = await svc.start(p, taskInput, { repositoryId: 4242, installationId: 77 });
    expect(again).toMatchObject({ ok: true });
  });

  it("省略時は実際に使うモデルが決まって保存され、AgentDO への spec と task_status・task_result に出る（Anthropic のキー無し = gpt-oss-120b）", async () => {
    const p = principal();
    const e = setup();
    const svc = createTaskService(e, undefined, { fetch: keysFetch([]).fn });
    const r = await svc.start(p, taskInput, { repositoryId: 4242, installationId: 77 });
    if (!r.ok) throw new Error(`start failed: ${JSON.stringify(r)}`);
    const id = r.value.task_id;
    expect((await fakeAgent(id).calls()).specs[0]?.model).toBe(OSS120);
    expect(await svc.status(p, id)).toMatchObject({
      ok: true,
      value: { model: OSS120, effort: "low" },
    });
  });

  it("available なモデルが 1 つも無ければ model_unavailable（予約しない）", async () => {
    const p = principal();
    const svc = createTaskService(setup({ AGENT_MODELS: `${SONNET},${SOL}` }), undefined, {
      fetch: keysFetch([]).fn,
    });
    const r = await svc.start(p, taskInput, { repositoryId: 4242, installationId: 77 });
    expect(r).toMatchObject({ ok: false, error: { code: "model_unavailable" } });
    expect((await userStub(p.githubUserId).budgetStatus()).reserved_usd).toBe(0);
  });
});

describe("consult", () => {
  function agentStub() {
    const requests: ConsultRequest[] = [];
    return {
      requests,
      agent: () => ({
        consult: async (req: ConsultRequest): Promise<ConsultResult> => {
          requests.push(req);
          return {
            ok: true,
            text: "answer",
            model: req.model,
            usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
            costUsd: 0.0001,
          };
        },
      }),
    };
  }
  const q = (over: Record<string, unknown> = {}) => ({
    messages: [{ role: "user", content: "How?" }],
    ...over,
  });

  it("available でないモデルは model_unavailable。予約も AgentDO 呼び出しもしない", async () => {
    const a = agentStub();
    const svc = consultServiceWith(setup(), a.agent, {}, { fetch: keysFetch([]).fn });
    const p = principal();
    const r = await svc.consult(p, q({ model: SONNET }));
    expect(r).toMatchObject({ ok: false, error: { code: "model_unavailable" } });
    if (!r.ok) expect(r.error.message).toContain("models_list");
    expect(a.requests).toHaveLength(0);
    expect((await userStub(p.githubUserId).budgetStatus()).reserved_usd).toBe(0);
  });

  it("Workers AI のモデルは、キーが無くても使える。省略時の既定は gpt-oss-120b", async () => {
    const a = agentStub();
    const svc = consultServiceWith(setup(), a.agent, {}, { fetch: keysFetch([]).fn });
    const r1 = await svc.consult(principal(), q({ model: OSS20 }));
    expect(r1).toMatchObject({ ok: true, value: { model: OSS20 } });
    const r2 = await svc.consult(principal(), q());
    expect(r2).toMatchObject({ ok: true, value: { model: OSS120 } });
    expect(a.requests.map((r) => r.model)).toEqual([OSS20, OSS120]);
  });
});
