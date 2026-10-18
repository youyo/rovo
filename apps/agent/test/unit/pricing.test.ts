import { describe, expect, it } from "vitest";
import { estimateCallCostUsd, estimateTokens, priceFor } from "../../src/agent/pricing";

describe("モデル単価表", () => {
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

  it("見積もりは 入力トークン×入力単価 + max_tokens×出力単価", () => {
    const sonnet = priceFor("anthropic/claude-sonnet-5-5", false);
    if (!sonnet) throw new Error("price missing");
    // 入力単価は input と cacheWrite の高い方（$2.5/M）: 100k × 2.5 + 16k × $10/M = 0.25 + 0.16
    expect(estimateCallCostUsd(sonnet, 100_000, 16_000)).toBeCloseTo(0.41, 6);
  });

  it("haiku は入力が 100k を超えると上位の単価で見積もる", () => {
    const haiku = priceFor("anthropic/claude-haiku-5-5", false);
    if (!haiku) throw new Error("price missing");
    expect(estimateCallCostUsd(haiku, 200_000, 10_000)).toBeCloseTo(0.1 + 0.025, 6);
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
    // 1k 入力でも上位帯: 1k × $0.5/M + 10k × $2.5/M
    expect(estimateCallCostUsd(haiku, 1_000, 10_000)).toBeCloseTo(0.0005 + 0.025, 6);
  });
});
