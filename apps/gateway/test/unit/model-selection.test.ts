import { describe, expect, it, vi } from "vitest";
import {
  buildSelectionQuestions,
  buildSelectionState,
  CLEF_FLASH,
  CLEF_FULL,
  classOf,
  eligibleCandidates,
  isAmbiguous,
  parseCandidates,
  parseTierScores,
  pickTier,
  resolveSelectThresholds,
  type SelectDeps,
  type SelectionTask,
  selectModel,
} from "../../src/model-selection";

// task_start で model を省略したときの自動選択（Workers AI の決定モデル Clef）。
// ここは純粋関数と、偽の AI.run を差し込んだ判定。実 Clef の確率を固定したテストは model-selection-fixtures.test.ts。

const HAIKU = "anthropic/claude-haiku-5-5";
const SONNET = "anthropic/claude-sonnet-5-5";
const OPUS = "anthropic/claude-opus-5-5";
const FABLE = "anthropic/claude-fable-5-1";

const task: SelectionTask = {
  title: "README に 1 行足す",
  instructions: "README.md の末尾に 1 行足してください。",
  acceptance_criteria: ["末尾に 1 行ある"],
  verification_commands: [{ argv: ["pnpm", "test"] }],
  repository: "acme/widgets",
};

const THRESHOLDS = { up: 0.5, band: [0.3, 0.7] as readonly [number, number] };

/** Clef の応答の形。levels は各段の確率（0 番目から）。 */
function response(levels: number[], inputTokens = 700) {
  const probabilities = Object.fromEntries(levels.map((p, i) => [String(i), p]));
  return {
    answers: {
      tier: { type: "score", score: 0.5, legend: {}, probabilities, confidence: 0.9 },
    },
    usage: { input_tokens: inputTokens, output_tokens: 0 },
  };
}

type Call = { model: string; input: Record<string, unknown>; options: unknown };

/** 台本付きの偽 AI。モデルごとに、応答（または例外・永遠に返らない）を順に返す */
function fakeAi(script: Record<string, (unknown | Error | "hang")[]>) {
  const calls: Call[] = [];
  const queues = Object.fromEntries(Object.entries(script).map(([k, v]) => [k, [...v]]));
  const ai = {
    async run(model: string, input: Record<string, unknown>, options: unknown) {
      calls.push({ model, input, options });
      const next = queues[model]?.shift();
      if (next === undefined) throw new Error(`no scripted response for ${model}`);
      if (next === "hang") return new Promise(() => {});
      if (next instanceof Error) throw next;
      return next;
    },
  };
  return { ai, calls };
}

const cands = (...ids: string[]) => eligibleCandidates(ids, ids, () => true);

function deps(ai: SelectDeps["ai"], over: Partial<SelectDeps> = {}): SelectDeps {
  return {
    ai,
    gatewayId: "gw",
    metadata: { caller: "model_select" },
    thresholds: THRESHOLDS,
    sleep: async () => {},
    attemptMs: 50,
    ...over,
  };
}

const run = (d: SelectDeps, candidates = cands(HAIKU, SONNET, OPUS), t = task) =>
  selectModel(d, { candidates, fallback: SONNET, task: t });

describe("候補の決め方", () => {
  it("env はカンマ区切り。空白・空要素・重複を除く", () => {
    expect(parseCandidates(` ${HAIKU}, ,${SONNET},${HAIKU}`)).toEqual([HAIKU, SONNET]);
    expect(parseCandidates(undefined)).toEqual([]);
    expect(parseCandidates("")).toEqual([]);
  });

  it("モデルの等級は id から決まる（haiku < sonnet < opus < fable）。anthropic 以外・知らない id は等級なし", () => {
    expect(classOf(HAIKU)).toBe("haiku");
    expect(classOf(SONNET)).toBe("sonnet");
    expect(classOf(OPUS)).toBe("opus");
    expect(classOf(FABLE)).toBe("fable");
    expect(classOf("openai/gpt-6-sol")).toBeUndefined();
    expect(classOf("workers-ai/@cf/openai/gpt-oss-120b")).toBeUndefined();
    expect(classOf("anthropic/claude-mystery-1")).toBeUndefined();
  });

  it("使えるモデルの集合との積。費用の安い順（等級順）に並べ、openai・workers-ai は env に書いても弾く", () => {
    const got = eligibleCandidates(
      [OPUS, "openai/gpt-6-sol", HAIKU, "workers-ai/@cf/openai/gpt-oss-120b", SONNET],
      [SONNET, HAIKU, OPUS, "openai/gpt-6-sol", "workers-ai/@cf/openai/gpt-oss-120b"],
      () => true,
    );
    expect(got.map((c) => c.id)).toEqual([HAIKU, SONNET, OPUS]);
  });

  it("AGENT_MODELS の外・キーが無い（available でない）モデルは候補にならない", () => {
    const got = eligibleCandidates(
      [HAIKU, SONNET, OPUS],
      [HAIKU, SONNET, OPUS],
      (id) => id !== OPUS,
    );
    expect(got.map((c) => c.id)).toEqual([HAIKU, SONNET]);
    const outside = eligibleCandidates([HAIKU, SONNET, OPUS], [SONNET], () => true);
    expect(outside.map((c) => c.id)).toEqual([SONNET]);
  });

  it("同じ等級が 2 つあるときは env で先に書いたほうだけ", () => {
    const got = eligibleCandidates(
      ["anthropic/claude-sonnet-5-5", "anthropic/claude-sonnet-6-0", HAIKU],
      ["anthropic/claude-sonnet-5-5", "anthropic/claude-sonnet-6-0", HAIKU],
      () => true,
    );
    expect(got.map((c) => c.id)).toEqual([HAIKU, "anthropic/claude-sonnet-5-5"]);
  });
});

describe("質問と state", () => {
  it("段の数は候補の数。質問の文にモデル名や「既定」を書かない", () => {
    const q = buildSelectionQuestions(cands(HAIKU, SONNET, OPUS, FABLE));
    expect(q.tier.type).toBe("score");
    expect(q.tier.criteria).toHaveLength(4);
    const text = JSON.stringify(q).toLowerCase();
    for (const w of ["haiku", "sonnet", "opus", "fable", "claude", "default", "anthropic"]) {
      expect(text).not.toContain(w);
    }
    expect(buildSelectionQuestions(cands(SONNET, OPUS)).tier.criteria).toHaveLength(2);
  });

  it("入力は title・instructions・受け入れ条件・検証コマンド・リポジトリ名（owner は入れない）の JSON", () => {
    const s = JSON.parse(buildSelectionState(task)) as Record<string, unknown>;
    expect(s).toMatchObject({
      title: task.title,
      instructions: task.instructions,
      acceptance_criteria: ["末尾に 1 行ある"],
      verification_commands: ["pnpm test"],
      repository: "widgets",
    });
    expect(JSON.stringify(s)).not.toContain("acme");
  });

  it("秘密らしい値（既知の形式）は state に入る前に伏せる", () => {
    const token = `ghp_${"a1B2".repeat(9)}`;
    const raw = buildSelectionState({
      ...task,
      instructions: `デプロイに ${token} を使う`,
      acceptance_criteria: [`token=${token}`],
      verification_commands: [{ argv: ["curl", "-H", `Authorization: Bearer ${token}`] }],
    });
    expect(raw).not.toContain(token);
  });

  it("長い指示は先頭と末尾を残して切る。元の長さを残す。全体は窓（24,576 tokens）に十分収まる", () => {
    const long = `${"A".repeat(5000)}MIDDLE${"B".repeat(100_000 - 5006 - 5000)}${"C".repeat(5000)}`;
    const big: SelectionTask = {
      ...task,
      instructions: long,
      acceptance_criteria: Array.from({ length: 50 }, () => "あ".repeat(2000)),
      verification_commands: Array.from({ length: 10 }, () => ({ argv: ["x".repeat(1000)] })),
    };
    const raw = buildSelectionState(big);
    const s = JSON.parse(raw) as { instructions: string; instructions_chars: number };
    expect(s.instructions_chars).toBe(long.length);
    expect(s.instructions.startsWith("A")).toBe(true);
    expect(s.instructions.endsWith("C")).toBe(true);
    expect(s.instructions).not.toContain("MIDDLE");
    expect(s.instructions.length).toBeLessThan(8000);
    // 1 文字 1 token を仮定しても窓の半分以下
    expect(raw.length).toBeLessThan(12_000);
  });
});

describe("応答の解釈と選択", () => {
  it("確率は段ごとに読み、その段以上の累積にする", () => {
    expect(parseTierScores(response([0.2, 0.5, 0.3]), 3)).toEqual([1, 0.8, 0.3]);
    expect(parseTierScores(response([1, 0]), 2)).toEqual([1, 0]);
  });

  it("想定外の応答は undefined: 段が足りない・多い・範囲外・合計がおかしい・形が違う", () => {
    expect(parseTierScores(response([0.5, 0.5]), 3)).toBeUndefined();
    expect(parseTierScores(response([0.2, 0.3, 0.3, 0.2]), 3)).toBeUndefined();
    expect(parseTierScores(response([1.4, -0.4, 0]), 3)).toBeUndefined();
    expect(parseTierScores(response([0.1, 0.1, 0.1]), 3)).toBeUndefined();
    expect(parseTierScores({ answers: {} }, 3)).toBeUndefined();
    expect(parseTierScores(null, 3)).toBeUndefined();
    expect(parseTierScores("x", 3)).toBeUndefined();
  });

  it("その段以上の確率が閾値以上のうち、いちばん重い段を選ぶ。どれも届かなければ最も安い段", () => {
    expect(pickTier([1, 0.2, 0.1], THRESHOLDS)).toBe(0);
    expect(pickTier([1, 0.8, 0.1], THRESHOLDS)).toBe(1);
    expect(pickTier([1, 0.9, 0.5], THRESHOLDS)).toBe(2);
    expect(pickTier([1, 0.4, 0.6], THRESHOLDS)).toBe(2);
  });

  it("曖昧な帯（下端を含み、上端は含まない）に段が 1 つでもあれば聞き直す", () => {
    expect(isAmbiguous([1, 0.3, 0.1], THRESHOLDS)).toBe(true);
    expect(isAmbiguous([1, 0.7, 0.1], THRESHOLDS)).toBe(false);
    expect(isAmbiguous([1, 0.95, 0.1], THRESHOLDS)).toBe(false);
    expect(isAmbiguous([1, 0.95, 0.5], THRESHOLDS)).toBe(true);
    expect(isAmbiguous([1, 0.05, 0.01], THRESHOLDS)).toBe(false);
  });

  it("閾値の env は書いたキーだけ上書きする。不正な値は丸ごと既定に戻し ignored に返す", () => {
    const base = resolveSelectThresholds(undefined);
    expect(resolveSelectThresholds("").thresholds).toEqual(base.thresholds);
    expect(resolveSelectThresholds("up=0.6").thresholds).toEqual({ ...base.thresholds, up: 0.6 });
    expect(resolveSelectThresholds("band=0.2-0.8").thresholds).toEqual({
      ...base.thresholds,
      band: [0.2, 0.8],
    });
    expect(resolveSelectThresholds("up=0.6,band=0.1-0.9").thresholds).toEqual({
      up: 0.6,
      band: [0.1, 0.9],
    });
    for (const bad of ["up=2", "up=x", "band=0.9-0.1", "nope=1", "up", "band=0.5"]) {
      const r = resolveSelectThresholds(bad);
      expect(r.thresholds, bad).toEqual(base.thresholds);
      expect(r.ignored, bad).toBe(bad);
    }
  });
});

describe("selectModel", () => {
  it("flash が明確なら flash だけで決める。記録は mode / chosen / reason / scores / latency_ms", async () => {
    const { ai, calls } = fakeAi({ [CLEF_FLASH.id]: [response([0.05, 0.9, 0.05])] });
    const r = await run(deps(ai));
    expect(r.model).toBe(SONNET);
    expect(r.selection).toMatchObject({
      mode: "auto",
      chosen: SONNET,
      reason: "clef_flash",
      scores: { [SONNET]: 0.95, [OPUS]: 0.05 },
    });
    expect(typeof r.selection.latency_ms).toBe("number");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.model).toBe(CLEF_FLASH.id);
    expect(calls[0]?.input.model).toBe("clef-flash");
    expect(calls[0]?.options).toEqual({
      gateway: { id: "gw", metadata: { caller: "model_select" } },
    });
  });

  it("安い段・重い段もそのまま選ぶ", async () => {
    const light = fakeAi({ [CLEF_FLASH.id]: [response([0.95, 0.04, 0.01])] });
    expect((await run(deps(light.ai))).model).toBe(HAIKU);
    const heavy = fakeAi({ [CLEF_FLASH.id]: [response([0.01, 0.04, 0.95])] });
    expect((await run(deps(heavy.ai))).model).toBe(OPUS);
  });

  it("曖昧な帯のときだけ clef で聞き直し、段ごとに大きいほうの確率で決める（reason は clef_cascade）", async () => {
    // flash: sonnet 以上 0.5 → 曖昧。clef: opus 以上 0.8 → opus
    const { ai, calls } = fakeAi({
      [CLEF_FLASH.id]: [response([0.5, 0.4, 0.1])],
      [CLEF_FULL.id]: [response([0.1, 0.1, 0.8])],
    });
    const r = await run(deps(ai));
    expect(r.model).toBe(OPUS);
    expect(r.selection.reason).toBe("clef_cascade");
    expect(calls.map((c) => c.model)).toEqual([CLEF_FLASH.id, CLEF_FULL.id]);
    expect(calls[1]?.input.model).toBe("clef");
  });

  it("clef が失敗したら flash の答えで決める（reason は clef_flash）", async () => {
    const { ai } = fakeAi({
      [CLEF_FLASH.id]: [response([0.4, 0.4, 0.2])],
      [CLEF_FULL.id]: [new Error("boom"), new Error("boom")],
    });
    const r = await run(deps(ai));
    expect(r.model).toBe(SONNET);
    expect(r.selection.reason).toBe("clef_flash");
  });

  it("候補が 1 つなら Clef を呼ばない（single_candidate）", async () => {
    const { ai, calls } = fakeAi({});
    const r = await run(deps(ai), cands(OPUS));
    expect(r.model).toBe(OPUS);
    expect(r.selection).toMatchObject({ mode: "auto", chosen: OPUS, reason: "single_candidate" });
    expect(calls).toHaveLength(0);
  });

  it("候補が 0 なら Clef を呼ばず既定（no_candidates）", async () => {
    const { ai, calls } = fakeAi({});
    const r = await run(deps(ai), []);
    expect(r.model).toBe(SONNET);
    expect(r.selection).toMatchObject({ chosen: SONNET, reason: "no_candidates" });
    expect(calls).toHaveLength(0);
  });

  it("AI バインディングが無ければ Clef を呼ばず既定（fallback_unconfigured）", async () => {
    const r = await run(deps(undefined));
    expect(r.model).toBe(SONNET);
    expect(r.selection.reason).toBe("fallback_unconfigured");
  });

  it("AI Gateway の ID が空なら Clef を呼ばず既定（fallback_unconfigured。agent の昇格の判断・web と同じ fail closed）", async () => {
    const { ai, calls } = fakeAi({ [CLEF_FLASH.id]: [response([0.05, 0.05, 0.9])] });
    for (const gatewayId of ["", undefined]) {
      const r = await run(deps(ai, { gatewayId }));
      expect(r.model).toBe(SONNET);
      expect(r.selection.reason).toBe("fallback_unconfigured");
    }
    expect(calls).toHaveLength(0);
  });

  it("例外が続くと既定（fallback_error）。1 回目の失敗は再試行する", async () => {
    const { ai, calls } = fakeAi({
      [CLEF_FLASH.id]: [new Error("a"), new Error("b")],
    });
    const r = await run(deps(ai));
    expect(r.model).toBe(SONNET);
    expect(r.selection).toMatchObject({ mode: "auto", chosen: SONNET, reason: "fallback_error" });
    expect(calls).toHaveLength(2);
    const retried = fakeAi({
      [CLEF_FLASH.id]: [new Error("a"), response([0.05, 0.05, 0.9])],
    });
    expect((await run(deps(retried.ai))).model).toBe(OPUS);
  });

  it("時間切れは既定（fallback_timeout）。全体の上限を超えて待たない", async () => {
    vi.useFakeTimers();
    try {
      const { ai, calls } = fakeAi({ [CLEF_FLASH.id]: ["hang", "hang", "hang"] });
      const p = run(deps(ai, { attemptMs: 1500, totalMs: 3000, sleep: undefined }));
      await vi.advanceTimersByTimeAsync(10_000);
      const r = await p;
      expect(r.model).toBe(SONNET);
      expect(r.selection.reason).toBe("fallback_timeout");
      expect(r.selection.latency_ms).toBeLessThanOrEqual(3100);
      expect(calls.length).toBeLessThanOrEqual(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("全体の上限（3 秒）は既定値", async () => {
    const m = await import("../../src/model-selection");
    expect(m.SELECT_TOTAL_MS).toBeLessThanOrEqual(3000);
    expect(m.SELECT_ATTEMPT_MS * 2).toBeLessThanOrEqual(m.SELECT_TOTAL_MS);
  });

  it("想定外の応答・候補外の段の答えは使わず既定（fallback_invalid）", async () => {
    // 3 候補なのに 4 段の答え（候補にない段）
    const extra = fakeAi({
      [CLEF_FLASH.id]: [response([0, 0, 0.3, 0.7]), response([0, 0, 0.3, 0.7])],
    });
    const r = await run(deps(extra.ai));
    expect(r.model).toBe(SONNET);
    expect(r.selection.reason).toBe("fallback_invalid");
    const shape = fakeAi({ [CLEF_FLASH.id]: [{ nope: 1 }, { nope: 1 }] });
    expect((await run(deps(shape.ai))).selection.reason).toBe("fallback_invalid");
  });

  it("Clef が選んだモデルは必ず候補の中。既定が候補の外でも、失敗時の既定はそのまま使う", async () => {
    const { ai } = fakeAi({ [CLEF_FLASH.id]: [new Error("x"), new Error("y")] });
    const r = await selectModel(deps(ai), {
      candidates: cands(HAIKU, OPUS),
      fallback: SONNET,
      task,
    });
    expect(r.model).toBe(SONNET);
    const ok = fakeAi({ [CLEF_FLASH.id]: [response([0.1, 0.9])] });
    const r2 = await selectModel(deps(ok.ai), {
      candidates: cands(HAIKU, OPUS),
      fallback: SONNET,
      task,
    });
    expect([HAIKU, OPUS]).toContain(r2.model);
  });

  it("Clef に渡る state は task の JSON。質問は候補の数だけの段", async () => {
    const { ai, calls } = fakeAi({ [CLEF_FLASH.id]: [response([0.05, 0.9, 0.05])] });
    await run(deps(ai));
    const input = calls[0]?.input as { state: string; questions: { tier: { criteria: string[] } } };
    expect(JSON.parse(input.state).title).toBe(task.title);
    expect(input.questions.tier.criteria).toHaveLength(3);
  });

  it("失敗してもログに指示文・例外の文面・トークンを出さない", async () => {
    const secret = "SECRET-INSTRUCTIONS-xyz";
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const { ai } = fakeAi({
        [CLEF_FLASH.id]: [new Error("token abc-secret-token"), new Error("token abc-secret-token")],
      });
      await run(deps(ai), cands(HAIKU, SONNET, OPUS), { ...task, instructions: secret });
      const all = JSON.stringify([...err.mock.calls, ...warn.mock.calls, ...log.mock.calls]);
      expect(all).not.toContain(secret);
      expect(all).not.toContain("abc-secret-token");
    } finally {
      err.mockRestore();
      warn.mockRestore();
      log.mockRestore();
    }
  });

  it("scores は 0〜1 の小数 3 桁まで", async () => {
    const { ai } = fakeAi({ [CLEF_FLASH.id]: [response([0.03333333, 0.91234567, 0.054321])] });
    const r = await run(deps(ai));
    for (const v of Object.values(r.selection.scores ?? {})) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
      expect(Math.round(v * 1000) / 1000).toBe(v);
    }
  });
});
