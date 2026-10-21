import { describe, expect, it } from "vitest";
import {
  buildDecisionState,
  CLEF_FLASH,
  CLEF_FULL,
  DEFAULT_CLEF_THRESHOLDS,
  decideSandboxSize,
  isAmbiguous,
  parseClefAnswers,
  pickTarget,
  resolveClefThresholds,
  SANDBOX_DECISION_QUESTIONS,
} from "../../src/sandbox-scale-decision";

// Sandbox の大きさを上げるかの判断（Workers AI の決定モデル Clef）。純粋関数と、偽の AI.run を差し込んだ判定のテスト。
// 実験で調整した既定の閾値: 重い確率 < 0.5 は上げない / 重い → 4 vCPU で速い確率 >= 0.4 なら standard-4、そうでなければ standard-3 /
// flash の確率が曖昧な帯（重い 0.2〜0.7、または 4 の確率 0.2〜0.5）のときだけ clef で聞き直す。

type Probs = { heavy: number; fast4: number; choice?: [number, number, number] };

/** Clef の応答の形（answers.<id> が score / choice / noul）。重い確率 = P(2)+P(3) になるように score の確率を作る */
function response(p: Probs, inputTokens = 900) {
  const c = p.choice ?? [0.2, 0.5, 0.3];
  return {
    answers: {
      weight: {
        type: "score",
        score: p.heavy >= 0.5 ? 2 : 0,
        probabilities: {
          "0": (1 - p.heavy) / 2,
          "1": (1 - p.heavy) / 2,
          "2": p.heavy / 2,
          "3": p.heavy / 2,
        },
        confidence: 0.9,
      },
      size: {
        type: "choice",
        choice: "standard-3",
        probabilities: { "standard-2": c[0], "standard-3": c[1], "standard-4": c[2] },
        confidence: 0.8,
      },
      beyond2: { type: "noul", noul: p.fast4 },
    },
    usage: { input_tokens: inputTokens },
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
  return { ai: ai as unknown as Ai, calls };
}

const input = (over: Record<string, unknown> = {}) => ({
  state: '{"command":"pnpm test"}',
  current: "standard-2" as const,
  max: "standard-4" as const,
  ...over,
});

const deps = (ai: Ai, over: Record<string, unknown> = {}) => ({
  ai,
  gatewayId: "gw",
  metadata: { caller: "sandbox_scale", taskId: "t1" },
  sleep: async () => {},
  attemptMs: 50,
  totalMs: 1_000,
  ...over,
});

describe("pickTarget: 確率から大きさを選ぶ", () => {
  const ctx = (
    current: "standard-2" | "standard-3" | "standard-4",
    max: "standard-3" | "standard-4" = "standard-4",
  ) => ({ current, max, thresholds: DEFAULT_CLEF_THRESHOLDS });
  it("重い確率が 0.5 未満なら上げない", () => {
    expect(pickTarget({ heavy: 0.49, fast4: 0.9 }, ctx("standard-2"))).toBeNull();
  });
  it("重くて 4 vCPU で速い確率が 0.4 以上なら standard-4、未満なら standard-3", () => {
    expect(pickTarget({ heavy: 0.5, fast4: 0.4 }, ctx("standard-2"))).toBe("standard-4");
    expect(pickTarget({ heavy: 0.9, fast4: 0.39 }, ctx("standard-2"))).toBe("standard-3");
  });
  it("今の大きさ以下にはしない（上げるだけ）。standard-3 からは standard-4 だけ", () => {
    expect(pickTarget({ heavy: 0.9, fast4: 0.1 }, ctx("standard-3"))).toBeNull();
    expect(pickTarget({ heavy: 0.9, fast4: 0.8 }, ctx("standard-3"))).toBe("standard-4");
    expect(pickTarget({ heavy: 0.9, fast4: 0.8 }, ctx("standard-4"))).toBeNull();
  });
  it("上限を超えない（上限が standard-3 なら standard-4 を選ばず standard-3）", () => {
    expect(pickTarget({ heavy: 0.9, fast4: 0.9 }, ctx("standard-2", "standard-3"))).toBe(
      "standard-3",
    );
  });
});

describe("isAmbiguous: flash の確率が曖昧か", () => {
  const ctx = {
    current: "standard-2" as "standard-2" | "standard-4",
    max: "standard-4" as "standard-3" | "standard-4",
    thresholds: DEFAULT_CLEF_THRESHOLDS,
  };
  it("重い確率が 0.2〜0.7 なら曖昧", () => {
    expect(isAmbiguous({ heavy: 0.2, fast4: 0 }, ctx)).toBe(true);
    expect(isAmbiguous({ heavy: 0.7, fast4: 0.9 }, ctx)).toBe(true);
    expect(isAmbiguous({ heavy: 0.19, fast4: 0.3 }, ctx)).toBe(false);
    expect(isAmbiguous({ heavy: 0.71, fast4: 0.9 }, ctx)).toBe(false);
  });
  it("重いと判断し、standard-4 に届きうるときだけ、4 vCPU の確率 0.2〜0.5 が曖昧", () => {
    expect(isAmbiguous({ heavy: 0.9, fast4: 0.3 }, ctx)).toBe(true);
    expect(isAmbiguous({ heavy: 0.9, fast4: 0.19 }, ctx)).toBe(false);
    // 重くない（上げない）なら 4 の確率は関係ない
    expect(isAmbiguous({ heavy: 0.1, fast4: 0.3 }, ctx)).toBe(false);
    // 上限が standard-3、またはすでに standard-4 なら 4 の確率は関係ない
    expect(isAmbiguous({ heavy: 0.9, fast4: 0.3 }, { ...ctx, max: "standard-3" })).toBe(false);
    expect(isAmbiguous({ heavy: 0.9, fast4: 0.3 }, { ...ctx, current: "standard-4" })).toBe(false);
  });
});

describe("parseClefAnswers: 応答の形", () => {
  it("weight の P(2)+P(3)・beyond2 の noul・size の確率を読む", () => {
    const a = parseClefAnswers(response({ heavy: 0.8, fast4: 0.25, choice: [0.1, 0.6, 0.3] }));
    expect(a?.heavy).toBeCloseTo(0.8);
    expect(a?.fast4).toBeCloseTo(0.25);
    expect(a?.choice).toEqual([0.1, 0.6, 0.3]);
  });
  it("想定外の応答（answers が無い・確率が範囲外・weight の確率が無い）は undefined", () => {
    expect(parseClefAnswers(undefined)).toBeUndefined();
    expect(parseClefAnswers({})).toBeUndefined();
    expect(
      parseClefAnswers({ answers: { weight: { score: 2 }, beyond2: { noul: 0.5 } } }),
    ).toBeUndefined();
    expect(parseClefAnswers(response({ heavy: 0.5, fast4: 2 }))).toBeUndefined();
  });
});

describe("resolveClefThresholds: env で閾値を変える", () => {
  it("未設定・空は既定", () => {
    expect(resolveClefThresholds(undefined).thresholds).toEqual(DEFAULT_CLEF_THRESHOLDS);
    expect(resolveClefThresholds("  ").thresholds).toEqual(DEFAULT_CLEF_THRESHOLDS);
  });
  it("key=value のカンマ区切りで一部だけ上書きできる", () => {
    const r = resolveClefThresholds("heavy=0.6,four=0.5,heavy_band=0.4-0.8,four_band=0.3-0.6");
    expect(r.thresholds).toEqual({
      heavy: 0.6,
      four: 0.5,
      heavyBand: [0.4, 0.8],
      fourBand: [0.3, 0.6],
    });
    expect(resolveClefThresholds("four=0.55").thresholds).toEqual({
      ...DEFAULT_CLEF_THRESHOLDS,
      four: 0.55,
    });
  });
  it("不正な値は既定に戻して ignored に返す（起動はエラーにしない）", () => {
    for (const raw of ["heavy=2", "nope=0.1", "heavy=abc", "heavy_band=0.8-0.2", "heavy"]) {
      const r = resolveClefThresholds(raw);
      expect(r.thresholds).toEqual(DEFAULT_CLEF_THRESHOLDS);
      expect(r.ignored).toBe(raw);
    }
  });
});

describe("質問", () => {
  it("noul には criteria の true / false がある。1 リクエストに 3 問まとめる", () => {
    expect(Object.keys(SANDBOX_DECISION_QUESTIONS).sort()).toEqual(["beyond2", "size", "weight"]);
    const q = SANDBOX_DECISION_QUESTIONS.beyond2;
    expect(q.type).toBe("noul");
    expect(typeof q.criteria.true).toBe("string");
    expect(typeof q.criteria.false).toBe("string");
    expect(SANDBOX_DECISION_QUESTIONS.weight.criteria).toHaveLength(4);
    expect(Object.keys(SANDBOX_DECISION_QUESTIONS.size.criteria)).toEqual([
      "standard-2",
      "standard-3",
      "standard-4",
    ]);
  });
});

describe("buildDecisionState: Clef に渡す state", () => {
  const base = {
    argv: ["pnpm", "test"],
    cwd: "/workspace",
    current: "standard-2" as const,
    max: "standard-4" as "standard-3" | "standard-4",
    facts: "# vitest.config.ts\nmaxWorkers: 4\n",
    recent: [{ command: "pnpm install", seconds: 12.4, exitCode: 0 }],
  };
  it("コマンド・cwd・今の大きさ・各大きさの vCPU とメモリ・リポジトリの事実（生のテキスト）・直近のコマンドが JSON に入る", () => {
    const s = JSON.parse(buildDecisionState(base));
    expect(s.command).toBe("pnpm test");
    expect(s.argv).toEqual(["pnpm", "test"]);
    expect(s.cwd).toBe("/workspace");
    expect(s.current_sandbox).toBe("standard-2 (1 vCPU, 6 GiB)");
    expect(s.sandbox_sizes["standard-4"]).toEqual({ vcpu: 4, memory_gib: 12 });
    expect(s.repository_facts).toBe(base.facts);
    expect(s.recent_commands).toEqual([{ command: "pnpm install", seconds: 12.4, exit_code: 0 }]);
  });
  it("シェルの -c で包まれたコマンドは、中身を command にする（argv は重複させない）", () => {
    const s = JSON.parse(
      buildDecisionState({ ...base, argv: ["bash", "-lc", "make -j4 && pytest"] }),
    );
    expect(s.command).toBe("make -j4 && pytest");
    expect(s.argv).toBeUndefined();
  });
  it("直近は 3 件まで。長いコマンドと事実は切り詰め、秘密らしい値は伏せる", () => {
    const recent = Array.from({ length: 5 }, (_, i) => ({
      command: `c${i}`,
      seconds: i,
      exitCode: 0,
    }));
    const long = "x".repeat(50_000);
    const s = JSON.parse(
      buildDecisionState({
        ...base,
        recent,
        facts: long,
        argv: ["bash", "-c", `curl -H "Authorization: Bearer ghp_${"a".repeat(36)}" ${long}`],
      }),
    );
    expect(s.recent_commands.map((r: { command: string }) => r.command)).toEqual([
      "c2",
      "c3",
      "c4",
    ]);
    expect(s.repository_facts.length).toBeLessThanOrEqual(6_000);
    expect(s.command.length).toBeLessThanOrEqual(2_100);
    expect(s.command).not.toContain("ghp_");
    expect(buildDecisionState({ ...base, facts: long }).length).toBeLessThan(12_000);
  });
  it("上限が standard-3 なら standard-4 を一覧に出さない", () => {
    const s = JSON.parse(buildDecisionState({ ...base, max: "standard-3" }));
    expect(Object.keys(s.sandbox_sizes)).toEqual(["standard-2", "standard-3"]);
  });
});

describe("decideSandboxSize", () => {
  it("flash が重くないと確信 → 上げない。flash だけを 1 回呼び、gateway と metadata を渡す", async () => {
    const { ai, calls } = fakeAi({ [CLEF_FLASH.id]: [response({ heavy: 0.05, fast4: 0.1 })] });
    const r = await decideSandboxSize(deps(ai), input());
    expect(r).toMatchObject({ ok: true, target: null, model: "flash", clefCalls: 1 });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.model).toBe(CLEF_FLASH.id);
    expect(calls[0]?.input.model).toBe(CLEF_FLASH.name);
    expect(calls[0]?.input.state).toBe('{"command":"pnpm test"}');
    expect(calls[0]?.input.questions).toBe(SANDBOX_DECISION_QUESTIONS);
    expect(calls[0]?.options).toEqual({
      gateway: { id: "gw", metadata: { caller: "sandbox_scale", taskId: "t1" } },
    });
    if (r.ok) expect(r.probs?.heavy).toBeCloseTo(0.05);
  });
  it("重くて 4 vCPU で速い → standard-4。重いが 4 では速くない → standard-3", async () => {
    const a = fakeAi({ [CLEF_FLASH.id]: [response({ heavy: 0.95, fast4: 0.9 })] });
    expect(await decideSandboxSize(deps(a.ai), input())).toMatchObject({
      ok: true,
      target: "standard-4",
      model: "flash",
    });
    const b = fakeAi({ [CLEF_FLASH.id]: [response({ heavy: 0.95, fast4: 0.05 })] });
    expect(await decideSandboxSize(deps(b.ai), input())).toMatchObject({
      ok: true,
      target: "standard-3",
    });
  });
  it("重い確率が曖昧なら clef で聞き直し、その答えを使う", async () => {
    const { ai, calls } = fakeAi({
      [CLEF_FLASH.id]: [response({ heavy: 0.3, fast4: 0.9 })],
      [CLEF_FULL.id]: [response({ heavy: 0.1, fast4: 0.1 })],
    });
    const r = await decideSandboxSize(deps(ai), input());
    expect(r).toMatchObject({ ok: true, target: null, model: "clef", clefCalls: 2 });
    expect(calls.map((c) => c.model)).toEqual([CLEF_FLASH.id, CLEF_FULL.id]);
    expect(calls[1]?.input.model).toBe(CLEF_FULL.name);
  });
  it("4 vCPU の確率が曖昧（重いと確信）でも clef で聞き直す", async () => {
    const { ai } = fakeAi({
      [CLEF_FLASH.id]: [response({ heavy: 0.95, fast4: 0.3 })],
      [CLEF_FULL.id]: [response({ heavy: 0.95, fast4: 0.7 })],
    });
    expect(await decideSandboxSize(deps(ai), input())).toMatchObject({
      target: "standard-4",
      model: "clef",
    });
  });
  it("clef が失敗したら flash の答えを使い、迷う 3 と 4 では standard-3 に倒す", async () => {
    const { ai } = fakeAi({
      [CLEF_FLASH.id]: [response({ heavy: 0.95, fast4: 0.45 })],
      [CLEF_FULL.id]: [new Error("x"), new Error("x"), new Error("x")],
    });
    const r = await decideSandboxSize(deps(ai), input());
    expect(r).toMatchObject({ ok: true, target: "standard-3", model: "flash", clefFailed: true });
  });
  it("今の大きさが上限以上なら Clef を呼ばない", async () => {
    const { ai, calls } = fakeAi({});
    const r = await decideSandboxSize(deps(ai), input({ current: "standard-4" }));
    expect(r).toMatchObject({ ok: true, target: null, skipped: true });
    expect(calls).toHaveLength(0);
  });

  describe("失敗と再試行", () => {
    it("例外・想定外の応答は再試行し、3 回目で成功すればそれを使う", async () => {
      const { ai, calls } = fakeAi({
        [CLEF_FLASH.id]: [
          new Error("boom"),
          { answers: {} },
          response({ heavy: 0.95, fast4: 0.05 }),
        ],
      });
      const r = await decideSandboxSize(deps(ai), input());
      expect(r).toMatchObject({ ok: true, target: "standard-3" });
      expect(calls).toHaveLength(3);
    });
    it("3 回失敗したら ok: false（呼び出し側は今の大きさのまま実行する）。例外の文面は返さない", async () => {
      const { ai, calls } = fakeAi({
        [CLEF_FLASH.id]: [
          new Error("secret detail"),
          new Error("secret detail"),
          new Error("secret detail"),
        ],
      });
      const r = await decideSandboxSize(deps(ai), input());
      expect(r.ok).toBe(false);
      expect(calls).toHaveLength(3);
      expect(JSON.stringify(r)).not.toContain("secret detail");
      if (!r.ok) expect(r.reason).toBe("ai_run_failed");
    });
    it("返ってこない呼び出しは 1 回の期限で切り、再試行する", async () => {
      const { ai, calls } = fakeAi({
        [CLEF_FLASH.id]: ["hang", response({ heavy: 0.05, fast4: 0.1 })],
      });
      const r = await decideSandboxSize(deps(ai), input());
      expect(r).toMatchObject({ ok: true, target: null });
      expect(calls).toHaveLength(2);
    });
    it("全体の上限を超えたら再試行しない（時間切れ）", async () => {
      const { ai, calls } = fakeAi({ [CLEF_FLASH.id]: ["hang", "hang", "hang"] });
      const r = await decideSandboxSize(deps(ai, { attemptMs: 40, totalMs: 60 }), input());
      expect(r.ok).toBe(false);
      expect(calls.length).toBeLessThan(3);
      if (!r.ok) expect(r.reason).toBe("timeout");
    });
    it("gateway の ID が空なら AI.run を呼ばずに失敗する", async () => {
      const { ai, calls } = fakeAi({});
      const r = await decideSandboxSize(deps(ai, { gatewayId: "" }), input());
      expect(r).toMatchObject({ ok: false, reason: "ai_gateway_id_missing" });
      expect(calls).toHaveLength(0);
    });
  });
});

describe("帯の中は flash と clef の重い確率の大きいほうで決める", () => {
  it("clef が低くても flash が 0.5 以上なら上げる。clef が失敗したら flash だけで決める", async () => {
    const a = fakeAi({
      [CLEF_FLASH.id]: [response({ heavy: 0.58, fast4: 0.63 })],
      [CLEF_FULL.id]: [response({ heavy: 0.15, fast4: 0.16 })],
    });
    const r = await decideSandboxSize(deps(a.ai), input());
    expect(r).toMatchObject({ ok: true, target: "standard-3", model: "clef" });
    const b = fakeAi({
      [CLEF_FLASH.id]: [response({ heavy: 0.28, fast4: 0.1 })],
      [CLEF_FULL.id]: [new Error("x"), new Error("x"), new Error("x")],
    });
    expect(await decideSandboxSize(deps(b.ai), input())).toMatchObject({
      target: null,
      clefFailed: true,
    });
  });
});

// 実際の Clef（2026-10-22 に実測）の確率をそのまま入れた偽の AI.run で、期待する判断を固定する。
// [コマンド, flash の重い・4 vCPU, clef の重い・4 vCPU（聞き直すときだけ）, 上げるか]
describe("実 Clef で測った 10 コマンドの確率フィクスチャ", () => {
  const table: [string, [number, number], [number, number] | null, boolean][] = [
    ["ls -la", [0.08, 0.13], null, false],
    ["git status", [0.07, 0.11], null, false],
    ["cat package.json", [0.2, 0.23], [0.02, 0.13], false],
    ["pnpm test (maxWorkers 4)", [0.42, 0.5], [0.76, 0.53], true],
    ["pnpm test (maxWorkers 2)", [0.28, 0.06], [0.64, 0.05], true],
    ["pnpm test (singleWorker)", [0.34, 0.08], [0.53, 0.06], true],
    ["make -j4", [0.58, 0.63], [0.15, 0.16], true],
    ["pytest -n auto", [0.57, 0.54], [0.76, 0.68], true],
    ["pnpm build", [0.53, 0.12], [0.29, 0.05], true],
    ["cargo build --release", [0.82, 0.66], null, true],
  ];
  for (const [cmd, f, c, up] of table) {
    it(`${cmd}: ${up ? "上げる" : "上げない"}`, async () => {
      const { ai } = fakeAi({
        [CLEF_FLASH.id]: [response({ heavy: f[0], fast4: f[1] })],
        [CLEF_FULL.id]: c ? [response({ heavy: c[0], fast4: c[1] })] : [],
      });
      const r = await decideSandboxSize(deps(ai), input());
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.target !== null).toBe(up);
    });
  }
});
