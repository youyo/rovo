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
    // 100k 入力 × $2/M + 16k 出力 × $10/M = 0.2 + 0.16
    expect(estimateCallCostUsd(sonnet, 100_000, 16_000)).toBeCloseTo(0.36, 6);
  });

  it("haiku は入力が 100k を超えると上位の単価で見積もる", () => {
    const haiku = priceFor("anthropic/claude-haiku-5-5", false);
    if (!haiku) throw new Error("price missing");
    expect(estimateCallCostUsd(haiku, 200_000, 10_000)).toBeCloseTo(0.1 + 0.025, 6);
  });

  it("トークン数は文字数から保守的に見積もる", () => {
    expect(estimateTokens("a".repeat(300))).toBe(100);
  });
});
