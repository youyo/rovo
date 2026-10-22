import { describe, expect, it } from "vitest";
import {
  buildSelectionQuestions,
  buildSelectionState,
  CLEF_FLASH,
  CLEF_FULL,
  DEFAULT_SELECT_THRESHOLDS,
  eligibleCandidates,
  type SelectionTask,
  selectModel,
} from "../../src/model-selection";
import clef from "../fixtures/model-selection-clef.json";
import samples from "../fixtures/model-selection-samples.json";

// 実際の Clef（2026-10-22 に実測）の確率をそのまま入れた偽の AI.run で、閾値と期待する選択を固定する。
// 測り方: scripts/clef-model-experiment.mjs（見本 20 件 × 2 回。同じ入力は同じ確率だった）。
// 候補は haiku / sonnet / opus の 3 段。閾値は「その段以上」の累積確率 >= 0.5 のうち最も重い段、曖昧な帯 0.3 以上 0.7 未満のときだけ clef で聞き直す。
// 期待（expect）は見本を書いた人の意図。実際の選択（CHOSEN）と食い違うのは KNOWN_MISMATCH の 2 件で、閾値を合わせて消していない。

const HAIKU = "anthropic/claude-haiku-5-5";
const SONNET = "anthropic/claude-sonnet-5-5";
const OPUS = "anthropic/claude-opus-5-5";
const BY_CLASS = { haiku: HAIKU, sonnet: SONNET, opus: OPUS } as const;

/** 実測の結果、現在の質問と閾値で選ばれるモデル */
const CHOSEN: Record<string, string> = {
  "readme-line": HAIKU,
  typo: HAIKU,
  "bump-dep": HAIKU,
  "config-value": HAIKU,
  "rename-fn": SONNET,
  "dashboard-url": SONNET,
  "bug-redirect": SONNET,
  "wait-elapsed": SONNET,
  "consult-limit": SONNET,
  "english-flag": SONNET,
  "vague-fix": OPUS,
  "dark-mode": SONNET,
  "long-log": SONNET,
  "sandbox-scale": OPUS,
  "prod-typeerror": OPUS,
  redos: OPUS,
  "outbox-redesign": OPUS,
  "auth-migration": OPUS,
  "major-upgrade": OPUS,
  "flaky-e2e": OPUS,
};

/** flash が曖昧な帯に入り、clef で聞き直されるもの */
const ASKED_CLEF = ["rename-fn", "vague-fix", "sandbox-scale", "redos", "major-upgrade"];

/** 期待と実際が食い違うもの。rename-fn（7 か所の改名）は flash も clef も sonnet 寄り、vague-fix（原因不明の「直して」）は clef が opus 寄り */
const KNOWN_MISMATCH = ["rename-fn", "vague-fix"];

const candidates = eligibleCandidates([HAIKU, SONNET, OPUS], [HAIKU, SONNET, OPUS], () => true);
const taskOf = (id: string) => {
  const s = samples.find((x) => x.id === id);
  if (!s) throw new Error(`no sample ${id}`);
  return s.task as SelectionTask;
};

/** Clef の応答の形（score の answers.tier。確率は実測そのまま） */
const clefResponse = (probabilities: Record<string, number>, inputTokens: number) => ({
  model: "clef",
  answers: {
    tier: { type: "score", score: 0.5, legend: {}, probabilities, confidence: 0.8 },
  },
  usage: { input_tokens: inputTokens, output_tokens: 0 },
});

describe("実 Clef で測った見本 20 件", () => {
  it("見本と測定結果の件数・並びが揃っている", () => {
    expect(clef.results.map((r) => r.id)).toEqual(samples.map((s) => s.id));
    expect(Object.keys(CHOSEN).sort()).toEqual(samples.map((s) => s.id).sort());
  });

  it("測ったときと同じ質問のまま（質問を変えたら測り直す）", () => {
    expect(buildSelectionQuestions(candidates).tier.criteria).toEqual(clef.tier_criteria);
    expect(candidates.map((c) => c.id)).toEqual(clef.candidates);
  });

  it("入力は窓（24,576 tokens）に十分収まる（最大でも約 2.6k tokens。26,000 文字のログを貼った指示も先頭と末尾に切られる）", () => {
    expect(Math.max(...clef.results.map((r) => r.input_tokens))).toBeLessThan(5_000);
    const state = buildSelectionState(taskOf("long-log"));
    expect(state.length).toBeLessThan(10_000);
  });

  for (const r of clef.results) {
    it(`${r.id}: ${CHOSEN[r.id]?.split("claude-")[1]}`, async () => {
      const calls: string[] = [];
      const ai = {
        async run(model: string) {
          calls.push(model);
          if (model === CLEF_FLASH.id) return clefResponse(r.flash, r.input_tokens);
          if (model === CLEF_FULL.id) return clefResponse(r.clef, r.input_tokens);
          throw new Error("unexpected model");
        },
      };
      const got = await selectModel(
        { ai, gatewayId: "gw", thresholds: DEFAULT_SELECT_THRESHOLDS },
        { candidates, fallback: SONNET, task: taskOf(r.id) },
      );
      expect(got.model).toBe(CHOSEN[r.id]);
      expect(got.selection.chosen).toBe(CHOSEN[r.id]);
      expect(got.selection.reason).toBe(ASKED_CLEF.includes(r.id) ? "clef_cascade" : "clef_flash");
      expect(calls).toEqual(
        ASKED_CLEF.includes(r.id) ? [CLEF_FLASH.id, CLEF_FULL.id] : [CLEF_FLASH.id],
      );
      // 期待との一致は、食い違う 2 件以外は全部
      const matches = got.model === BY_CLASS[r.expect as keyof typeof BY_CLASS];
      expect(matches).toBe(!KNOWN_MISMATCH.includes(r.id));
    });
  }

  it("20 件中 18 件が期待どおり。clef で聞き直すのは 5 件（25%）", () => {
    const matched = clef.results.filter(
      (r) => CHOSEN[r.id] === BY_CLASS[r.expect as keyof typeof BY_CLASS],
    ).length;
    expect(matched).toBe(18);
    expect(ASKED_CLEF).toHaveLength(5);
  });
});
