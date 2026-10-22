import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { agentModelsOf, defaultModelOf, effortOf, listModels } from "../../src/models";
import { createTaskService, type Principal } from "../../src/tasks/service";
import { fakeAgent, newTaskId, newUserId, sampleInput, taskStub } from "./helpers";

// vitest.config.ts の AGENT_MODELS: sonnet（既定）・haiku・gpt-6-sol
const input = {
  repository: "acme/widgets",
  base_ref: "main",
  base_sha: "0123456789abcdef0123456789abcdef01234567",
  title: "t",
  instructions: "do it",
};

function principal(): Principal {
  return { githubUserId: newUserId(), login: "alice" };
}

const start = (p: Principal, extra: Record<string, unknown> = {}) =>
  createTaskService(env).start(
    p,
    { ...input, ...extra },
    { repositoryId: 4242, installationId: 77 },
  );

describe("AGENT_MODELS（gateway の解釈）", () => {
  it("未設定は AGENT_MODEL（既定 sonnet）だけ。許可リスト外は無視する", () => {
    expect(agentModelsOf({})).toEqual(["anthropic/claude-sonnet-5-5"]);
    expect(agentModelsOf({ AGENT_MODEL: "anthropic/claude-haiku-5-5" })).toEqual([
      "anthropic/claude-haiku-5-5",
    ]);
    expect(
      agentModelsOf({ AGENT_MODELS: "openai/gpt-6-sol, evil/x,anthropic/claude-opus-5-5" }),
    ).toEqual(["openai/gpt-6-sol", "anthropic/claude-opus-5-5", "anthropic/claude-sonnet-5-5"]);
    expect(defaultModelOf({})).toBe("anthropic/claude-sonnet-5-5");
    expect(defaultModelOf({ AGENT_MODEL: "openai/gpt-6-sol" })).toBe("openai/gpt-6-sol");
  });
});

describe("task_start の model", () => {
  it("AGENT_MODELS の外のモデルは invalid_input。予約もしない", async () => {
    const p = principal();
    for (const model of ["anthropic/claude-opus-5-5", "openai/gpt-6-astra", "nope"]) {
      const r = await start(p, { model });
      expect(r, model).toMatchObject({ ok: false, error: { code: "invalid_input" } });
      if (!r.ok) expect(r.error.message).toContain("models_list");
    }
    // 予約が残っていない（次の start が concurrency_limit にならない）
    expect(await start(p)).toMatchObject({ ok: true });
  });

  it("省略時は既定のモデルが TaskDO に保存され、AgentDO への spec と task_status に出る", async () => {
    const p = principal();
    const r = await start(p);
    if (!r.ok) throw new Error("start failed");
    const id = r.value.task_id;
    const { specs } = await fakeAgent(id).calls();
    expect(specs[0]?.model).toBe("anthropic/claude-sonnet-5-5");
    const status = await createTaskService(env).status(p, id);
    expect(status).toMatchObject({ ok: true, value: { model: "anthropic/claude-sonnet-5-5" } });
  });

  it("指定したモデルは保存され、AgentDO へ渡り、task_status・task_result に返る", async () => {
    const p = principal();
    const svc = createTaskService(env);
    const r = await start(p, { model: "anthropic/claude-haiku-5-5" });
    if (!r.ok) throw new Error("start failed");
    const id = r.value.task_id;
    expect((await fakeAgent(id).calls()).specs[0]?.model).toBe("anthropic/claude-haiku-5-5");
    const s = await svc.status(p, id);
    expect(s).toMatchObject({ ok: true, value: { model: "anthropic/claude-haiku-5-5" } });
    await fakeAgent(id).setPhase("completed");
    await taskStub(id).advance();
    const res = await svc.result(p, id);
    expect(res).toMatchObject({ ok: true, value: { model: "anthropic/claude-haiku-5-5" } });
  });

  it("同じ idempotency_key で model が違えば conflict、同じなら同じタスク", async () => {
    const p = principal();
    const a = await start(p, { idempotency_key: "k1", model: "anthropic/claude-haiku-5-5" });
    const b = await start(p, { idempotency_key: "k1", model: "anthropic/claude-haiku-5-5" });
    const c = await start(p, { idempotency_key: "k1" });
    expect(a.ok && b.ok && a.value.task_id === b.value.task_id).toBe(true);
    expect(c).toMatchObject({ ok: false, error: { code: "conflict" } });
  });

  it("TaskDO も AGENT_MODELS の外のモデルは受け付けない（invalid_input）", async () => {
    const id = newTaskId();
    const r = await taskStub(id).ensureCreated(
      sampleInput(id, newUserId(), { model: "anthropic/claude-opus-5-5" }),
    );
    expect(r).toEqual({ ok: false, code: "invalid_input" });
  });
});

// vitest.config.ts の MODEL_EFFORTS: haiku=minimal（初期値 low の上書き）。sonnet=high / sol=medium は初期値のまま
describe("モデルごとの思考レベル（effort。gateway の解釈）", () => {
  it("effortOf: 初期値に MODEL_EFFORTS を重ねる。不正な項目は無視して初期値", () => {
    expect(effortOf({}, "anthropic/claude-sonnet-5-5")).toBe("high");
    expect(effortOf({}, "anthropic/claude-haiku-5-5")).toBe("low");
    expect(effortOf({}, "anthropic/claude-opus-5-5")).toBe("medium");
    expect(effortOf({}, "anthropic/claude-fable-5-1")).toBe("low");
    expect(effortOf({}, "openai/gpt-6-luna")).toBe("low");
    expect(effortOf({}, "openai/gpt-6-sol")).toBe("medium");
    expect(effortOf({}, "openai/gpt-6-astra")).toBe("low");
    expect(
      effortOf(
        { MODEL_EFFORTS: "anthropic/claude-sonnet-5-5=medium,anthropic/claude-haiku-5-5=off" },
        "anthropic/claude-sonnet-5-5",
      ),
    ).toBe("medium");
    expect(
      effortOf({ MODEL_EFFORTS: "anthropic/claude-fable-5-1=off" }, "anthropic/claude-fable-5-1"),
    ).toBe("low"); // fable は off にできない → 無視して初期値
    expect(effortOf({ MODEL_EFFORTS: "nonsense" }, "anthropic/claude-sonnet-5-5")).toBe("high");
  });

  it("listModels の各モデルに effort（最終の値）が付く", async () => {
    const models = await listModels({
      AGENT_MODELS: "anthropic/claude-haiku-5-5,openai/gpt-6-sol",
      MODEL_EFFORTS: "openai/gpt-6-sol=high",
    });
    expect(models.map((m) => [m.id, m.effort])).toEqual([
      ["anthropic/claude-haiku-5-5", "low"],
      ["openai/gpt-6-sol", "high"],
      ["anthropic/claude-sonnet-5-5", "high"],
    ]);
  });

  it("task_status・task_result に、タスクで使った effort を model と並べて返す（既定のモデル = high、haiku = 上書きの minimal）", async () => {
    const p = principal();
    const svc = createTaskService(env);
    const a = await start(p);
    const b = await start(principal(), { model: "anthropic/claude-haiku-5-5" });
    if (!a.ok || !b.ok) throw new Error("start failed");
    expect(await svc.status(p, a.value.task_id)).toMatchObject({
      ok: true,
      value: { model: "anthropic/claude-sonnet-5-5", effort: "high" },
    });
    await fakeAgent(a.value.task_id).setPhase("completed");
    await taskStub(a.value.task_id).advance();
    expect(await svc.result(p, a.value.task_id)).toMatchObject({
      ok: true,
      value: { model: "anthropic/claude-sonnet-5-5", effort: "high" },
    });
  });
});

// effort を指定すると、モデルごとの既定（MODEL_EFFORTS）を、そのタスクだけ上書きする。
// vitest.config.ts: sonnet は全レベル、gpt-6-sol は off / low / medium / high / xhigh / max（minimal は不可）、gpt-oss-120b は low / medium / high だけ
describe("task_start の effort（タスクごとの上書き）", () => {
  const SONNET = "anthropic/claude-sonnet-5-5";
  const HAIKU = "anthropic/claude-haiku-5-5";
  const SOL = "openai/gpt-6-sol";
  const OSS = "workers-ai/@cf/openai/gpt-oss-120b";

  it("指定した effort は保存され、AgentDO への spec に入り、task_status・task_result の effort に出る（MODEL_EFFORTS より優先）", async () => {
    const p = principal();
    const svc = createTaskService(env);
    // 既定のモデル（sonnet）の既定は high。haiku の既定は Unit の MODEL_EFFORTS で minimal
    const a = await start(p, { effort: "xhigh" });
    const b = await start(principal(), { model: HAIKU, effort: "high" });
    if (!a.ok || !b.ok) throw new Error("start failed");
    expect((await fakeAgent(a.value.task_id).calls()).specs[0]).toMatchObject({
      model: SONNET,
      effort: "xhigh",
    });
    expect((await fakeAgent(b.value.task_id).calls()).specs[0]).toMatchObject({
      model: HAIKU,
      effort: "high",
    });
    expect(await svc.status(p, a.value.task_id)).toMatchObject({
      ok: true,
      value: { model: SONNET, effort: "xhigh" },
    });
    await fakeAgent(a.value.task_id).setPhase("completed");
    await taskStub(a.value.task_id).advance();
    expect(await svc.result(p, a.value.task_id)).toMatchObject({
      ok: true,
      value: { model: SONNET, effort: "xhigh" },
    });
  });

  it("off も指定できる（off を受け付けるモデル）。spec にも off が入る", async () => {
    const p = principal();
    const r = await start(p, { effort: "off" });
    if (!r.ok) throw new Error("start failed");
    expect((await fakeAgent(r.value.task_id).calls()).specs[0]?.effort).toBe("off");
    expect(await createTaskService(env).status(p, r.value.task_id)).toMatchObject({
      ok: true,
      value: { effort: "off" },
    });
  });

  it("未指定は従来どおり MODEL_EFFORTS の値（既定のモデル = high、haiku = 上書きの minimal）。spec に effort は付かない", async () => {
    const p = principal();
    const svc = createTaskService(env);
    const a = await start(p);
    const b = await start(principal(), { model: HAIKU });
    if (!a.ok || !b.ok) throw new Error("start failed");
    expect(await svc.status(p, a.value.task_id)).toMatchObject({
      ok: true,
      value: { effort: "high" },
    });
    expect((await fakeAgent(a.value.task_id).calls()).specs[0]).not.toHaveProperty("effort");
    expect((await fakeAgent(b.value.task_id).calls()).specs[0]).not.toHaveProperty("effort");
  });

  it("そのモデルが対応しないレベルは invalid_input。message に使えるレベルの一覧が入り、予約もしない", async () => {
    const p = principal();
    const minimal = await start(p, { model: SOL, effort: "minimal" });
    expect(minimal).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    if (!minimal.ok) {
      expect(minimal.error.message).toContain(SOL);
      expect(minimal.error.message).toContain("minimal");
      expect(minimal.error.message).toContain("off, low, medium, high, xhigh, max");
    }
    const xhigh = await start(p, { model: OSS, effort: "xhigh" });
    expect(xhigh).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    if (!xhigh.ok) expect(xhigh.error.message).toContain("low, medium, high");
    // 予約が残っていない（次の start が concurrency_limit にならない）
    expect(await start(p, { model: SOL, effort: "low" })).toMatchObject({ ok: true });
  });

  it("形が違う値（知らないレベル・文字列以外）は invalid_input", async () => {
    const p = principal();
    for (const effort of ["turbo", "", "HIGH", 3, null]) {
      expect(await start(p, { effort }), String(effort)).toMatchObject({
        ok: false,
        error: { code: "invalid_input" },
      });
    }
  });

  it("検査は最終のモデルで行う。model を省略（自動選択でも既定でも）したときは、実際に使うモデルで検査する", async () => {
    const p = principal();
    // 既定を gpt-6-sol にして、model を省略（自動選択の候補なし = 既定）。sol は minimal を受け付けない
    const sol = { ...env, AGENT_MODEL: SOL } as unknown as Env;
    const ng = await createTaskService(sol).start(
      p,
      { ...input, effort: "minimal" },
      { repositoryId: 4242, installationId: 77 },
    );
    expect(ng).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    if (!ng.ok) expect(ng.error.message).toContain(SOL);
    const ok = await createTaskService(sol).start(
      p,
      { ...input, effort: "off" },
      { repositoryId: 4242, installationId: 77 },
    );
    if (!ok.ok) throw new Error("start failed");
    expect(ok.value.model).toBe(SOL);
    expect(await createTaskService(env).status(p, ok.value.task_id)).toMatchObject({
      ok: true,
      value: { model: SOL, effort: "off" },
    });
  });

  it("同じ idempotency_key で、effort が同じなら同じタスク。違う・指定の有無が違えば conflict（effort も入力の一部）", async () => {
    const p = principal();
    const a = await start(p, { idempotency_key: "e1", effort: "xhigh" });
    const b = await start(p, { idempotency_key: "e1", effort: "xhigh" });
    if (!a.ok || !b.ok) throw new Error("start failed");
    expect(b.value.task_id).toBe(a.value.task_id);
    expect(await start(p, { idempotency_key: "e1", effort: "high" })).toMatchObject({
      ok: false,
      error: { code: "conflict" },
    });
    expect(await start(p, { idempotency_key: "e1" })).toMatchObject({
      ok: false,
      error: { code: "conflict" },
    });
    // 逆: 指定なしで作ったキーに effort を付けて再試行しても conflict
    const q = principal();
    const c = await start(q, { idempotency_key: "e2" });
    if (!c.ok) throw new Error("start failed");
    expect(await start(q, { idempotency_key: "e2", effort: "high" })).toMatchObject({
      ok: false,
      error: { code: "conflict" },
    });
  });

  it("対応しないレベルでキーを使い切らない: 直したあとに同じ idempotency_key で始められる", async () => {
    const p = principal();
    const ng = await start(p, { idempotency_key: "e3", model: SOL, effort: "minimal" });
    expect(ng).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(await start(p, { idempotency_key: "e3", model: SOL, effort: "low" })).toMatchObject({
      ok: true,
    });
  });

  it("TaskDO も対応しないレベルは受け付けない（invalid_input。message に使えるレベル）。何も作らない", async () => {
    const owner = newUserId();
    const id = newTaskId();
    const r = await taskStub(id).ensureCreated(
      sampleInput(id, owner, { model: SOL, effort: "minimal" }),
    );
    expect(r).toMatchObject({ ok: false, code: "invalid_input" });
    if (!r.ok && r.code === "invalid_input") {
      expect(r.message).toContain("off, low, medium, high, xhigh, max");
    }
    const ok = await taskStub(id).ensureCreated(
      sampleInput(id, owner, { model: SOL, effort: "xhigh" }),
    );
    expect(ok).toMatchObject({ ok: true, created: true, task: { effort: "xhigh" } });
  });
});
