import { ALLOWED_MODEL_IDS, computeCostUsd, supportedEfforts } from "@rovo/models";
import { describe, expect, it } from "vitest";
import {
  estimateCallCostUsd,
  estimateTokens,
  maxOutputTokensWithin,
  priceFor,
} from "../../src/agent/pricing";

describe("モデル単価表", () => {
  it("単価はカタログ由来で、許可リストの全 id が引ける（OpenAI も）", () => {
    for (const id of [
      "anthropic/claude-haiku-5-5",
      "anthropic/claude-sonnet-5-5",
      "anthropic/claude-opus-5-5",
      "anthropic/claude-fable-5-1",
      "openai/gpt-6-luna",
      "openai/gpt-6-sol",
      "openai/gpt-6-astra",
    ]) {
      expect(priceFor(id, false), id).toBeDefined();
    }
    // tier がキャッシュの単価まで持つ（haiku の 100k 超）
    expect(priceFor("anthropic/claude-haiku-5-5", false)?.tiers[0]).toMatchObject({
      cacheReadPerMTok: 0.05,
      cacheWritePerMTok: 0.625,
    });
  });

  it("既知のモデルは単価を返し、未知のモデルは undefined", () => {
    expect(priceFor("anthropic/claude-sonnet-5-5", false)?.inputPerMTok).toBe(2);
    expect(priceFor("anthropic/claude-opus-5-5", false)?.outputPerMTok).toBe(20);
    expect(priceFor("anthropic/claude-haiku-5-5", false)?.outputPerMTok).toBe(0.5);
    expect(priceFor("anthropic/unknown-model", false)).toBeUndefined();
  });

  it("テスト用モデルは test 指定のときだけ使える", () => {
    expect(priceFor("scripted/script-1", false)).toBeUndefined();
    expect(priceFor("scripted/script-1", true)).toBeDefined();
  });

  it("許可リストに無いモデルは、カタログにあっても使えない", () => {
    expect(priceFor("anthropic/claude-opus-5", false)).toBeUndefined();
    expect(priceFor("toString", false)).toBeUndefined();
  });

  it("見積もりは 入力トークン×入力単価 + max_tokens×出力単価", () => {
    const sonnet = priceFor("anthropic/claude-sonnet-5-5", false);
    if (!sonnet) throw new Error("price missing");
    // 入力単価は input と cacheWrite の高い方（$2.5/M）: 100k × 2.5 + 16k × $10/M = 0.25 + 0.16
    expect(estimateCallCostUsd(sonnet, 100_000, 16_000)).toBeCloseTo(0.41, 6);
  });

  it("haiku は入力が 100k を超えると上位の単価で見積もる", () => {
    const haiku = priceFor("anthropic/claude-haiku-5-5", false);
    if (!haiku) throw new Error("price missing");
    // D10: 上位の tier も cacheWrite（$0.625/M）を持つので、入力の見積りは max(input, cacheWrite) の上位の値 0.625 になる
    // （以前は tier の cacheWrite が抜けていて 0.5 で見積もり、過少だった）: 200k × 0.625 + 10k × $2.5/M
    expect(estimateCallCostUsd(haiku, 200_000, 10_000)).toBeCloseTo(0.125 + 0.025, 6);
  });

  it("トークン数は UTF-8 のバイト数を上限として見積もる（1 トークンは 1 バイト以上）", () => {
    expect(estimateTokens("a".repeat(300))).toBe(300);
    // CJK は 1 文字 3 バイト。文字数/3 では実際のトークン数を下回りうる
    const cjk = "あ".repeat(30_000);
    expect(estimateTokens(cjk)).toBe(90_000);
    expect(estimateTokens("😀".repeat(10))).toBe(40);
  });

  it("CJK の長文でも見積もりは実費の上限（全バイトが 1 トークン）以上になる", () => {
    const sonnet = priceFor("anthropic/claude-sonnet-5-5", false);
    if (!sonnet) throw new Error("price missing");
    const text = "漢".repeat(50_000); // 150,000 バイト
    const worstCaseActual = (150_000 * 2.5 + 16_000 * 10) / 1e6; // 1 バイト 1 トークン、最も高い入力単価
    expect(estimateCallCostUsd(sonnet, estimateTokens(text), 16_000)).toBeGreaterThanOrEqual(
      worstCaseActual,
    );
  });

  it("価格帯は最大値で見積もる（入力が少なくても上位の単価）", () => {
    const haiku = priceFor("anthropic/claude-haiku-5-5", false);
    if (!haiku) throw new Error("price missing");
    // 1k 入力でも上位帯（cacheWrite の $0.625/M まで含めた最大値）: 1k × $0.625/M + 10k × $2.5/M
    expect(estimateCallCostUsd(haiku, 1_000, 10_000)).toBeCloseTo(0.000625 + 0.025, 6);
  });
});

describe("maxOutputTokensWithin（consult の出力の上限）", () => {
  const sonnet = priceFor("anthropic/claude-sonnet-5-5", false);
  const haiku = priceFor("anthropic/claude-haiku-5-5", false);
  if (!sonnet || !haiku) throw new Error("price missing");

  it("予算から入力の見積り（最悪の単価）を引いた残りを、出力の単価で割る。見積りは予算を超えない", () => {
    // 入力 100k × $2.5/M（input と cacheWrite の高い方）= $0.25。残り $0.25 ÷ $10/M = 25,000
    const cap = maxOutputTokensWithin(sonnet, 100_000, 0.5);
    expect(cap).toBe(25_000);
    expect(estimateCallCostUsd(sonnet, 100_000, cap)).toBeLessThanOrEqual(0.5);
    expect(estimateCallCostUsd(sonnet, 100_000, cap + 1)).toBeGreaterThan(0.5);
  });

  it("入力だけで予算を超えるなら 0", () => {
    expect(maxOutputTokensWithin(sonnet, 300_000, 0.5)).toBe(0);
    expect(maxOutputTokensWithin(sonnet, 200_000, 0.5)).toBe(0); // ちょうど使い切りも 0
  });

  it("価格帯がある（haiku）ときは上位の単価で見積もる（入力 $0.625/M、出力 $2.5/M）", () => {
    const cap = maxOutputTokensWithin(haiku, 100_000, 0.5);
    expect(estimateCallCostUsd(haiku, 100_000, cap)).toBeLessThanOrEqual(0.5);
    expect(estimateCallCostUsd(haiku, 100_000, cap + 1)).toBeGreaterThan(0.5);
  });

  it("壊れた予算（0・負・NaN）は 0", () => {
    for (const b of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(maxOutputTokensWithin(sonnet, 10, b)).toBe(0);
    }
  });
});

describe("思考レベル（effort）を含めた予算の上限", () => {
  // 思考のトークンは出力として課金され、max_tokens / max_output_tokens の中に収まる（adaptive thinking・Responses の reasoning）。
  // なので、出力の上限（cap）いっぱいまで思考で使い切っても、費用は予約額を超えない。レベルによらず同じ式で守れることを固定する。
  it("どのモデル・どの思考レベルでも、出力を cap トークンまで（思考で）使い切った実費は予約額以下", () => {
    for (const id of ALLOWED_MODEL_IDS) {
      const price = priceFor(id, false);
      if (!price) throw new Error(`price missing: ${id}`);
      for (const effort of supportedEfforts(id)) {
        for (const [context, budget] of [
          [1_100, 0.5],
          [50_000, 0.5],
          [150_000, 0.5],
          [1_100, 0.005],
        ] as const) {
          const cap = maxOutputTokensWithin(price, context, budget);
          // 入力だけで予算を超えるなら出力の余地は 0（consult は input_too_large で拒否する）
          if (cap === 0) {
            expect(
              estimateCallCostUsd(price, context, 0),
              `${id} ${effort}`,
            ).toBeGreaterThanOrEqual(budget);
            continue;
          }
          expect(estimateCallCostUsd(price, context, cap), `${id} ${effort}`).toBeLessThanOrEqual(
            budget,
          );
          // 実費の計算（入力 context + 出力 cap。出力に思考の分が含まれる）も予約額以下
          const actual = computeCostUsd(price, {
            input: context,
            output: cap,
            cacheRead: 0,
            cacheWrite: 0,
          });
          expect(actual, `${id} ${effort}`).toBeLessThanOrEqual(budget);
        }
      }
    }
  });
});
