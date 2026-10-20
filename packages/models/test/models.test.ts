import { describe, expect, it } from "vitest";
import {
  ALLOWED_MODEL_IDS,
  computeCostUsd,
  DEFAULT_MODEL,
  MODEL_CATALOG_IDS,
  modelInfo,
  parseAgentModels,
  thinkingOffFor,
} from "../src";

describe("許可リストとカタログ", () => {
  it("初期の許可リストは仕様どおりの 7 件で、rovo の id → カタログの id の対応が 1 か所にある", () => {
    expect(Object.keys(MODEL_CATALOG_IDS).sort()).toEqual(
      [
        "anthropic/claude-fable-5-1",
        "anthropic/claude-haiku-5-5",
        "anthropic/claude-opus-5-5",
        "anthropic/claude-sonnet-5-5",
        "openai/gpt-6-astra",
        "openai/gpt-6-luna",
        "openai/gpt-6-sol",
      ].sort(),
    );
    expect(MODEL_CATALOG_IDS["openai/gpt-6-sol"]).toBe("gpt-6-sol");
    expect(DEFAULT_MODEL).toBe("anthropic/claude-sonnet-5-5");
  });

  it("許可リストの全 id がカタログに cost 付きで存在する", () => {
    for (const id of ALLOWED_MODEL_IDS) {
      const info = modelInfo(id);
      expect(info, id).toBeDefined();
      expect(info?.price.inputPerMTok, id).toBeGreaterThan(0);
      expect(info?.price.outputPerMTok, id).toBeGreaterThan(0);
      expect(Number.isFinite(info?.price.cacheReadPerMTok), id).toBe(true);
      expect(Number.isFinite(info?.price.cacheWritePerMTok), id).toBe(true);
      expect(info?.contextWindow, id).toBeGreaterThan(0);
    }
  });

  it("api と provider はカタログの宣言（claude は anthropic-messages、gpt-6 は openai-responses）", () => {
    expect(modelInfo("anthropic/claude-sonnet-5-5")).toMatchObject({
      provider: "anthropic",
      api: "anthropic-messages",
    });
    expect(modelInfo("openai/gpt-6-sol")).toMatchObject({
      provider: "openai",
      api: "openai-responses",
    });
  });

  it("許可リストに無い id は undefined（カタログにあっても使えない）", () => {
    expect(modelInfo("anthropic/claude-opus-5")).toBeUndefined();
    expect(modelInfo("anthropic/unknown")).toBeUndefined();
    expect(modelInfo("toString")).toBeUndefined();
    expect(modelInfo("__proto__")).toBeUndefined();
  });

  it("単価はカタログの値（sonnet 2/10/0.2/2.5）", () => {
    expect(modelInfo("anthropic/claude-sonnet-5-5")?.price).toMatchObject({
      inputPerMTok: 2,
      outputPerMTok: 10,
      cacheReadPerMTok: 0.2,
      cacheWritePerMTok: 2.5,
      tiers: [],
    });
  });

  it("tier はキャッシュの単価まで持つ（haiku の 100k 超: cacheRead 0.05 / cacheWrite 0.625）", () => {
    expect(modelInfo("anthropic/claude-haiku-5-5")?.price.tiers).toEqual([
      {
        inputTokensAbove: 100_000,
        inputPerMTok: 0.5,
        outputPerMTok: 2.5,
        cacheReadPerMTok: 0.05,
        cacheWritePerMTok: 0.625,
      },
    ]);
  });
});

describe("computeCostUsd", () => {
  const sonnet = modelInfo("anthropic/claude-sonnet-5-5")?.price;
  const haiku = modelInfo("anthropic/claude-haiku-5-5")?.price;
  if (!sonnet || !haiku) throw new Error("price missing");

  it("input / output / cacheRead / cacheWrite をそれぞれの単価で足す", () => {
    // 1M×2 + 1M×10 + 1M×0.2 + 1M×2.5
    expect(
      computeCostUsd(sonnet, {
        input: 1_000_000,
        output: 1_000_000,
        cacheRead: 1_000_000,
        cacheWrite: 1_000_000,
      }),
    ).toBeCloseTo(14.7, 9);
  });

  it("tier の境目は「入力側の合計（input + cacheRead + cacheWrite）が inputTokensAbove を超えたら」", () => {
    const at = { input: 100_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0 };
    // ちょうど 100k は基本の単価
    expect(computeCostUsd(haiku, at)).toBeCloseTo(0.1 * 0.1 + 0.5, 9);
    // 100k を 1 超えると上位の単価（output も上位）
    expect(computeCostUsd(haiku, { ...at, input: 100_001 })).toBeCloseTo(0.100001 * 0.5 + 2.5, 9);
    // キャッシュのトークンも合計に入り、キャッシュの単価も上位になる
    expect(
      computeCostUsd(haiku, {
        input: 0,
        output: 0,
        cacheRead: 1_000_000,
        cacheWrite: 1_000_000,
      }),
    ).toBeCloseTo(0.05 + 0.625, 9);
  });

  it("壊れた値（負・NaN）は 0 として扱わず、有限の非負だけを数える", () => {
    expect(
      computeCostUsd(sonnet, { input: -5, output: Number.NaN, cacheRead: 0, cacheWrite: 0 }),
    ).toBe(0);
  });
});

describe("parseAgentModels（AGENT_MODELS の解釈）", () => {
  const D = "anthropic/claude-sonnet-5-5";

  it("未設定・空なら既定のモデルだけ（fail-closed）", () => {
    expect(parseAgentModels(undefined, D).models).toEqual([D]);
    expect(parseAgentModels("", D).models).toEqual([D]);
    expect(parseAgentModels("  , ,", D).models).toEqual([D]);
  });

  it("カンマ区切り。空白を取り、重複を除き、順序を保つ。既定のモデルは常に含む", () => {
    expect(
      parseAgentModels(
        " anthropic/claude-haiku-5-5 , openai/gpt-6-sol,anthropic/claude-haiku-5-5",
        D,
      ).models,
    ).toEqual(["anthropic/claude-haiku-5-5", "openai/gpt-6-sol", D]);
  });

  it("許可リストに無い id は無視し、ignored に返す（起動はエラーにしない）", () => {
    const r = parseAgentModels("anthropic/claude-haiku-5-5,evil/model,anthropic/claude-opus-5", D);
    expect(r.models).toEqual(["anthropic/claude-haiku-5-5", D]);
    expect(r.ignored).toEqual(["evil/model", "anthropic/claude-opus-5"]);
  });

  it("既定のモデル自体が許可リストに無ければ含めない（単価の分からないモデルは使えない）", () => {
    expect(parseAgentModels("anthropic/claude-haiku-5-5", "anthropic/bogus").models).toEqual([
      "anthropic/claude-haiku-5-5",
    ]);
    expect(parseAgentModels(undefined, "anthropic/bogus").models).toEqual([]);
  });
});

describe("thinkingOffFor（思考をオフにするときの値）", () => {
  it("sonnet は between_tools、haiku は disabled、opus は暫定で between_tools", () => {
    expect(thinkingOffFor("anthropic/claude-sonnet-5-5")).toBe("between_tools");
    expect(thinkingOffFor("anthropic/claude-haiku-5-5")).toBe("disabled");
    expect(thinkingOffFor("anthropic/claude-opus-5-5")).toBe("between_tools");
  });
  it("カタログの id（プロバイダー接頭辞なし）でも引ける", () => {
    expect(thinkingOffFor("claude-sonnet-5-5")).toBe("between_tools");
    expect(thinkingOffFor("claude-haiku-5-5")).toBe("disabled");
  });
  it("fable・OpenAI・表に無いモデルは undefined（置き換えない）", () => {
    expect(thinkingOffFor("anthropic/claude-fable-5-1")).toBeUndefined();
    expect(thinkingOffFor("openai/gpt-6-sol")).toBeUndefined();
    expect(thinkingOffFor("claude-unknown-9")).toBeUndefined();
    expect(thinkingOffFor("toString")).toBeUndefined();
  });
});
