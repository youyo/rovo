import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { agentModelsOf, defaultModelOf, effortOf, listModels } from "../../src/models";
import { createTaskService, type Principal } from "../../src/tasks/service";
import { fakeAgent, newTaskId, newUserId, sampleInput, taskStub } from "./helpers";

// vitest.config.ts の AGENT_MODELS: sonnet（既定）・haiku・gpt-6-sol
const input = {
  repository: "acme/widgets",
  base_ref: "main",
  base_sha: "0123456789abcdef",
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
