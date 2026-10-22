import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { CLEF_FLASH } from "../../src/model-selection";
import { autoCandidates } from "../../src/models";
import { createTaskService, type Principal } from "../../src/tasks/service";
import { fakeAgent, newTaskId, newUserId, sampleInput, taskStub, userStub } from "./helpers";

// task_start で model を省略したときの自動選択（Clef）。実 AI は呼ばず、AI バインディングは台本付きの偽物。
// vitest.config.ts の AGENT_MODELS: sonnet（既定）・haiku・gpt-6-sol・gpt-oss-120b・gpt-oss-20b（opus は含まない）。
// 既存の Unit は自動選択を止めてある（AUTO_MODEL_CANDIDATES を空にしている）ので、ここで候補を env に入れて有効にする。

const HAIKU = "anthropic/claude-haiku-5-5";
const SONNET = "anthropic/claude-sonnet-5-5";
const SOL = "openai/gpt-6-sol";
const OSS120 = "workers-ai/@cf/openai/gpt-oss-120b";

const input = {
  repository: "acme/widgets",
  base_ref: "main",
  base_sha: "0123456789abcdef0123456789abcdef01234567",
  title: "README の末尾に 1 行足す",
  instructions: "README.md の末尾に 1 行足してください。",
};

const principal = (): Principal => ({ githubUserId: newUserId(), login: "alice" });
const opts = { repositoryId: 4242, installationId: 77 };

/** 2 段（haiku / sonnet）の Clef の応答。levels は各段の確率 */
const clefResponse = (levels: number[]) => ({
  answers: {
    tier: {
      type: "score",
      score: 0.5,
      probabilities: Object.fromEntries(levels.map((p, i) => [String(i), p])),
      confidence: 0.9,
    },
  },
  usage: { input_tokens: 400, output_tokens: 0 },
});

function fakeAi(script: (unknown | Error)[]) {
  const calls: { model: string; input: Record<string, unknown>; options: unknown }[] = [];
  const queue = [...script];
  const ai = {
    async run(model: string, input: Record<string, unknown>, options: unknown) {
      calls.push({ model, input, options });
      const next = queue.shift();
      if (next === undefined) throw new Error("no scripted response");
      if (next instanceof Error) throw next;
      return next;
    },
  };
  return { ai, calls };
}

function setup(ai: unknown, over: Record<string, unknown> = {}) {
  return {
    ...env,
    ENVIRONMENT: "production",
    AUTO_MODEL_CANDIDATES: `${HAIKU},${SONNET}`,
    // 判定できない構成（トークンなし）= AGENT_MODELS の全部が使える
    CLOUDFLARE_API_TOKEN: "",
    AI: ai,
    AI_GATEWAY_ID: "gw-test",
    ...over,
  } as unknown as Env;
}

const start = (e: Env, p: Principal, extra: Record<string, unknown> = {}, key?: string) =>
  createTaskService(e).start(
    p,
    { ...input, ...extra, ...(key ? { idempotency_key: key } : {}) },
    opts,
  );

describe("task_start: model を省略したときの自動選択", () => {
  it("Clef が安い段を選ぶと haiku で始まり、AgentDO の spec・task_start・task_status・task_result に model と model_selection が出る", async () => {
    const { ai, calls } = fakeAi([clefResponse([0.95, 0.05])]);
    const e = setup(ai);
    const p = principal();
    const r = await start(e, p);
    if (!r.ok) throw new Error(`start failed: ${JSON.stringify(r)}`);
    expect(r.value.model).toBe(HAIKU);
    expect(r.value.model_selection).toMatchObject({
      mode: "auto",
      chosen: HAIKU,
      reason: "clef_flash",
    });
    const id = r.value.task_id;
    expect((await fakeAgent(id).calls()).specs[0]?.model).toBe(HAIKU);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.model).toBe(CLEF_FLASH.id);
    // AI Gateway の metadata は呼び出しの種類と利用者の ID だけ（指示文は入らない）
    expect(calls[0]?.options).toEqual({
      gateway: {
        id: "gw-test",
        metadata: { caller: "model_select", userId: String(p.githubUserId) },
      },
    });
    const svc = createTaskService(e);
    const s = await svc.status(p, id);
    expect(s).toMatchObject({
      ok: true,
      value: {
        model: HAIKU,
        model_selection: { mode: "auto", chosen: HAIKU, reason: "clef_flash" },
      },
    });
    await fakeAgent(id).setPhase("completed");
    await taskStub(id).advance();
    expect(await svc.result(p, id)).toMatchObject({
      ok: true,
      value: { model: HAIKU, model_selection: { mode: "auto", chosen: HAIKU } },
    });
  });

  it("重い段なら sonnet。scores に確率が残る", async () => {
    const { ai } = fakeAi([clefResponse([0.05, 0.95])]);
    const r = await start(setup(ai), principal());
    if (!r.ok) throw new Error("start failed");
    expect(r.value.model).toBe(SONNET);
    expect(r.value.model_selection).toMatchObject({ scores: { [SONNET]: 0.95 } });
  });

  it("model を明示したら Clef を呼ばない。model_selection は explicit", async () => {
    const { ai, calls } = fakeAi([]);
    const p = principal();
    const r = await start(setup(ai), p, { model: SONNET });
    if (!r.ok) throw new Error("start failed");
    expect(calls).toHaveLength(0);
    expect(r.value.model).toBe(SONNET);
    expect(r.value.model_selection).toEqual({
      mode: "explicit",
      chosen: SONNET,
      reason: "explicit",
    });
    expect(await createTaskService(setup(ai)).status(p, r.value.task_id)).toMatchObject({
      ok: true,
      value: { model_selection: { mode: "explicit", reason: "explicit" } },
    });
  });

  it("Clef が失敗しても task_start は成功し、既定のモデルで始まる（fallback_error）", async () => {
    const { ai } = fakeAi([new Error("boom"), new Error("boom")]);
    const r = await start(setup(ai), principal());
    if (!r.ok) throw new Error("start failed");
    expect(r.value.model).toBe(SONNET);
    expect(r.value.model_selection).toMatchObject({ mode: "auto", reason: "fallback_error" });
  });

  it("想定外の応答も既定（fallback_invalid）。AI バインディングが無ければ fallback_unconfigured", async () => {
    const bad = fakeAi([{ nope: 1 }, { nope: 1 }]);
    const r = await start(setup(bad.ai), principal());
    if (!r.ok) throw new Error("start failed");
    expect(r.value.model).toBe(SONNET);
    expect(r.value.model_selection?.reason).toBe("fallback_invalid");
    const none = await start(setup(undefined), principal());
    if (!none.ok) throw new Error("start failed");
    expect(none.value.model_selection?.reason).toBe("fallback_unconfigured");
  });

  it("候補が 1 つ以下なら Clef を呼ばず、既定のモデルで始まる", async () => {
    const { ai, calls } = fakeAi([]);
    const one = await start(setup(ai, { AUTO_MODEL_CANDIDATES: HAIKU }), principal());
    if (!one.ok) throw new Error("start failed");
    expect(one.value.model).toBe(HAIKU);
    expect(one.value.model_selection?.reason).toBe("single_candidate");
    const none = await start(setup(ai, { AUTO_MODEL_CANDIDATES: "" }), principal());
    if (!none.ok) throw new Error("start failed");
    expect(none.value.model).toBe(SONNET);
    expect(none.value.model_selection?.reason).toBe("no_candidates");
    expect(calls).toHaveLength(0);
  });

  it("openai・workers-ai は env に書いても候補にならない", async () => {
    const { ai, calls } = fakeAi([]);
    const r = await start(
      setup(ai, { AUTO_MODEL_CANDIDATES: `${SOL},${OSS120},${SONNET}` }),
      principal(),
    );
    if (!r.ok) throw new Error("start failed");
    expect(r.value.model).toBe(SONNET);
    expect(r.value.model_selection?.reason).toBe("single_candidate");
    expect(calls).toHaveLength(0);
  });

  it("冪等キーの fingerprint は model 省略のまま: 同じキーの再試行は、Clef の答えが変わっても同じタスクで、最初の選択が残る", async () => {
    const { ai } = fakeAi([clefResponse([0.95, 0.05]), clefResponse([0.05, 0.95])]);
    const e = setup(ai);
    const p = principal();
    const first = await start(e, p, {}, "idem-1");
    const second = await start(e, p, {}, "idem-1");
    if (!first.ok || !second.ok) throw new Error(JSON.stringify([first, second]));
    expect(second.value.task_id).toBe(first.value.task_id);
    expect(second.value.model).toBe(HAIKU);
    expect(second.value.model_selection?.chosen).toBe(HAIKU);
  });

  it("予約額は選んだモデルに関係なく TASK_BUDGET_USD", async () => {
    const reserved: number[] = [];
    for (const levels of [
      [0.95, 0.05],
      [0.05, 0.95],
    ]) {
      const p = principal();
      const r = await start(setup(fakeAi([clefResponse(levels)]).ai), p);
      if (!r.ok) throw new Error("start failed");
      reserved.push((await userStub(p.githubUserId).budgetStatus()).reserved_usd);
    }
    expect(reserved[0]).toBe(reserved[1]);
    expect(reserved[0]).toBeGreaterThan(0);
  });
});

describe("task_start の effort と自動選択（検査は選ばれたモデルで行う）", () => {
  it("Clef が選んだモデル（haiku）が受け付ける effort なら、保存され、spec と task_status に出る（haiku の MODEL_EFFORTS = minimal より優先）", async () => {
    const { ai } = fakeAi([clefResponse([0.95, 0.05])]);
    const e = setup(ai);
    const p = principal();
    const r = await start(e, p, { effort: "xhigh" });
    if (!r.ok) throw new Error(`start failed: ${JSON.stringify(r)}`);
    expect(r.value.model).toBe(HAIKU);
    const id = r.value.task_id;
    expect((await fakeAgent(id).calls()).specs[0]).toMatchObject({ model: HAIKU, effort: "xhigh" });
    expect(await createTaskService(e).status(p, id)).toMatchObject({
      ok: true,
      value: { model: HAIKU, effort: "xhigh" },
    });
  });

  it("選ばれたモデルが受け付けない effort は invalid_input（message に選ばれたモデルと使えるレベル）。Clef が失敗して既定のモデルになったときも同じ", async () => {
    // Clef が失敗 → 既定のモデル（AGENT_MODEL = gpt-6-sol）。sol は minimal を受け付けない
    const { ai } = fakeAi([new Error("boom"), new Error("boom")]);
    const p = principal();
    const r = await start(setup(ai, { AGENT_MODEL: SOL }), p, { effort: "minimal" });
    expect(r).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    if (!r.ok) {
      expect(r.error.message).toContain(SOL);
      expect(r.error.message).toContain("off, low, medium, high, xhigh, max");
    }
    // 予約は残らない
    const ok = await start(setup(fakeAi([]).ai, { AGENT_MODEL: SOL }), p, { effort: "low" });
    expect(ok).toMatchObject({ ok: true, value: { model: SOL } });
  });

  it("冪等キー: 同じ入力（effort も同じ）の再試行は、Clef の答えが変わっても同じタスク。effort が違えば conflict", async () => {
    const { ai } = fakeAi([
      clefResponse([0.95, 0.05]),
      clefResponse([0.05, 0.95]),
      clefResponse([0.05, 0.95]),
    ]);
    const e = setup(ai);
    const p = principal();
    const first = await start(e, p, { effort: "high" }, "idem-e1");
    const second = await start(e, p, { effort: "high" }, "idem-e1");
    if (!first.ok || !second.ok) throw new Error(JSON.stringify([first, second]));
    expect(second.value.task_id).toBe(first.value.task_id);
    expect(second.value.model).toBe(HAIKU);
    expect(await start(e, p, { effort: "low" }, "idem-e1")).toMatchObject({
      ok: false,
      error: { code: "conflict" },
    });
  });
});

describe("候補（autoCandidates）", () => {
  it("未設定は既定の 3 つ（haiku / sonnet / opus）∩ AGENT_MODELS", async () => {
    const got = await autoCandidates({
      ...(env as unknown as Record<string, string>),
      AUTO_MODEL_CANDIDATES: undefined,
      CLOUDFLARE_API_TOKEN: "",
      AGENT_MODELS: `${SONNET},${HAIKU},anthropic/claude-opus-5-5`,
    } as never);
    expect(got.map((c) => c.id)).toEqual([HAIKU, SONNET, "anthropic/claude-opus-5-5"]);
  });

  it("AGENT_MODELS の外のモデルは候補にならない（fable は既定に入らない）", async () => {
    const got = await autoCandidates({
      ...(env as unknown as Record<string, string>),
      AUTO_MODEL_CANDIDATES: undefined,
      CLOUDFLARE_API_TOKEN: "",
      AGENT_MODELS: `${SONNET},anthropic/claude-fable-5-1`,
    } as never);
    expect(got.map((c) => c.id)).toEqual([SONNET]);
  });

  it("キーが無いプロバイダーのモデルは候補にならない（AI Gateway の BYOK の判定）", async () => {
    const fetchFn = (async () =>
      new Response(
        JSON.stringify({ success: true, result: [{ provider_slug: "openai", alias: "default" }] }),
      )) as typeof fetch;
    const got = await autoCandidates(
      {
        ...(env as unknown as Record<string, string>),
        ENVIRONMENT: "production",
        AUTO_MODEL_CANDIDATES: `${HAIKU},${SONNET}`,
        AGENT_MODELS: `${SONNET},${HAIKU}`,
        CLOUDFLARE_API_TOKEN: "tok-test",
        CLOUDFLARE_ACCOUNT_ID: "acct-sel-1",
        AI_GATEWAY_ID: "gw-sel-1",
      } as never,
      { fetch: fetchFn },
    );
    expect(got).toEqual([]);
  });
});

describe("TaskDO.ensureCreated の model_selection", () => {
  it("chosen が model と食い違う・形が違うものは invalid_input", async () => {
    const owner = newUserId();
    for (const bad of [
      { mode: "auto", chosen: HAIKU, reason: "clef_flash" }, // model は sonnet
      { mode: "auto", chosen: SONNET, reason: "made_up" },
      { mode: "auto", chosen: SONNET, reason: "clef_flash", scores: { [SONNET]: 2 } },
    ]) {
      const id = newTaskId();
      const r = await taskStub(id).ensureCreated(
        sampleInput(id, owner, { model: SONNET, model_selection: bad }),
      );
      expect(r, JSON.stringify(bad)).toEqual({ ok: false, code: "invalid_input" });
    }
  });

  it("この変更より前に作られたタスク（model_selection なし・fingerprint に既定のモデルが入っている）の再試行は、自動選択の再試行でも同じタスク", async () => {
    const owner = newUserId();
    const id = newTaskId();
    const old = await taskStub(id).ensureCreated(sampleInput(id, owner, { model: SONNET }));
    expect(old.ok).toBe(true);
    const retry = await taskStub(id).ensureCreated(
      sampleInput(id, owner, {
        model: SONNET,
        model_selection: { mode: "auto", chosen: SONNET, reason: "fallback_error" },
      }),
    );
    expect(retry).toMatchObject({ ok: true, created: false });
    // 違う入力は conflict のまま
    const other = await taskStub(id).ensureCreated(
      sampleInput(id, owner, {
        model: SONNET,
        title: "別の入力",
        model_selection: { mode: "auto", chosen: SONNET, reason: "fallback_error" },
      }),
    );
    expect(other).toEqual({ ok: false, code: "conflict" });
  });

  it("保存され、TaskView に出る。model_selection が無いタスク（古いタスク・直接の作成）には付かない", async () => {
    const owner = newUserId();
    const id = newTaskId();
    const sel = {
      mode: "auto",
      chosen: SONNET,
      reason: "clef_flash",
      scores: { [SONNET]: 0.9 },
      latency_ms: 12,
    };
    const r = await taskStub(id).ensureCreated(
      sampleInput(id, owner, { model: SONNET, model_selection: sel }),
    );
    expect(r).toMatchObject({ ok: true, task: { model_selection: sel } });
    const other = newTaskId();
    const plain = await taskStub(other).ensureCreated(sampleInput(other, owner));
    expect(plain.ok).toBe(true);
    if (plain.ok) expect(plain.task).not.toHaveProperty("model_selection");
  });
});
