import { describe, expect, it } from "vitest";
import {
  ALLOWED_MODEL_IDS,
  computeCostUsd,
  DEFAULT_MODEL,
  EFFORTS,
  effortFor,
  MODEL_CATALOG_IDS,
  modelInfo,
  parseAgentModels,
  resolveEfforts,
  supportedEfforts,
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
  it("sonnet は between_tools、haiku と opus は disabled（本番で確認済み 2026-10-20）", () => {
    expect(thinkingOffFor("anthropic/claude-sonnet-5-5")).toBe("between_tools");
    expect(thinkingOffFor("anthropic/claude-haiku-5-5")).toBe("disabled");
    expect(thinkingOffFor("anthropic/claude-opus-5-5")).toBe("disabled");
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

describe("EFFORTS（モデルごとに固定した思考レベル）", () => {
  it("初期値は決定どおり（haiku=low / sonnet=high / opus=medium / fable=low / luna=low / sol=medium / astra=low）", () => {
    expect(EFFORTS).toEqual({
      "anthropic/claude-haiku-5-5": "low",
      "anthropic/claude-sonnet-5-5": "high",
      "anthropic/claude-opus-5-5": "medium",
      "anthropic/claude-fable-5-1": "low",
      "openai/gpt-6-luna": "low",
      "openai/gpt-6-sol": "medium",
      "openai/gpt-6-astra": "low",
    });
  });

  it("許可リストの全モデルに初期値があり、そのモデルが受け付ける値である", () => {
    for (const id of ALLOWED_MODEL_IDS) {
      expect(EFFORTS[id], id).toBeDefined();
      expect(supportedEfforts(id), id).toContain(EFFORTS[id]);
    }
  });

  it("supportedEfforts: カタログの thinkingLevelMap に従う（fable と astra は off 不可、luna / sol は minimal 不可）", () => {
    const claude = supportedEfforts("anthropic/claude-sonnet-5-5");
    expect(claude).toEqual(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
    expect(supportedEfforts("anthropic/claude-fable-5-1")).not.toContain("off");
    expect(supportedEfforts("anthropic/claude-fable-5-1")).toContain("max");
    expect(supportedEfforts("openai/gpt-6-astra")).not.toContain("off");
    expect(supportedEfforts("openai/gpt-6-astra")).not.toContain("minimal");
    expect(supportedEfforts("openai/gpt-6-sol")).toContain("off");
    expect(supportedEfforts("openai/gpt-6-sol")).not.toContain("minimal");
    expect(supportedEfforts("unknown/model")).toEqual([]);
    expect(supportedEfforts("toString")).toEqual([]);
  });

  it("予算の前提: 許可リストの Anthropic は adaptive thinking（forceAdaptiveThinking）で、max_tokens に思考が含まれる", () => {
    // 外れると Pi が maxTokens に思考の budget を足して、予約した上限を超える（pi-ai の adjustMaxTokensForThinking）
    for (const id of ALLOWED_MODEL_IDS) {
      const info = modelInfo(id);
      if (info?.api === "anthropic-messages") {
        expect(info.forceAdaptiveThinking, id).toBe(true);
      }
    }
  });
});

describe("resolveEfforts / effortFor（MODEL_EFFORTS の上書き）", () => {
  it("未設定・空は初期値のまま、ignored なし", () => {
    expect(resolveEfforts(undefined)).toEqual({ efforts: EFFORTS, ignored: [] });
    expect(resolveEfforts("")).toEqual({ efforts: EFFORTS, ignored: [] });
    expect(resolveEfforts("  , ,").ignored).toEqual([]);
  });

  it("モデルごとに上書きできる（空白を許す）。ほかのモデルは初期値のまま", () => {
    const r = resolveEfforts(
      " anthropic/claude-sonnet-5-5 = medium , anthropic/claude-haiku-5-5=off",
    );
    expect(r.ignored).toEqual([]);
    expect(r.efforts["anthropic/claude-sonnet-5-5"]).toBe("medium");
    expect(r.efforts["anthropic/claude-haiku-5-5"]).toBe("off");
    expect(r.efforts["anthropic/claude-opus-5-5"]).toBe("medium");
    expect(r.efforts["openai/gpt-6-sol"]).toBe("medium");
  });

  it("xhigh / max も、モデルが受け付けるなら使える", () => {
    expect(effortFor("anthropic/claude-opus-5-5", "anthropic/claude-opus-5-5=xhigh")).toBe("xhigh");
    expect(effortFor("openai/gpt-6-sol", "openai/gpt-6-sol=max")).toBe("max");
  });

  it("同じモデルを複数回書いたら後のものが勝つ", () => {
    expect(
      effortFor(
        "anthropic/claude-sonnet-5-5",
        "anthropic/claude-sonnet-5-5=low,anthropic/claude-sonnet-5-5=max",
      ),
    ).toBe("max");
  });

  it("モデルが受け付けない値は無視して初期値のまま（fable / astra の off、luna の minimal）", () => {
    const r = resolveEfforts(
      "anthropic/claude-fable-5-1=off,openai/gpt-6-astra=off,openai/gpt-6-luna=minimal",
    );
    expect(r.efforts["anthropic/claude-fable-5-1"]).toBe("low");
    expect(r.efforts["openai/gpt-6-astra"]).toBe("low");
    expect(r.efforts["openai/gpt-6-luna"]).toBe("low");
    expect(r.ignored).toHaveLength(3);
  });

  it("不正な書式・未知の値・許可リストに無いモデル・プロトタイプ名は無視する（ほかの項目は有効）", () => {
    const r = resolveEfforts(
      [
        "no-equals",
        "=high",
        "anthropic/claude-sonnet-5-5=",
        "anthropic/claude-sonnet-5-5=HIGH",
        "anthropic/claude-sonnet-5-5=turbo",
        "anthropic/claude-sonnet-5-5=a=b",
        "anthropic/unknown=high",
        "__proto__=high",
        "toString=low",
        "anthropic/claude-haiku-5-5=medium",
      ].join(","),
    );
    expect(r.efforts["anthropic/claude-haiku-5-5"]).toBe("medium");
    expect(r.efforts["anthropic/claude-sonnet-5-5"]).toBe("high");
    expect(r.ignored).toHaveLength(9);
    expect(Object.keys(r.efforts).sort()).toEqual([...ALLOWED_MODEL_IDS].sort());
  });

  it("effortFor: 許可リストに無いモデルは undefined", () => {
    expect(effortFor("anthropic/claude-sonnet-5-5", undefined)).toBe("high");
    expect(effortFor("scripted/script-1", undefined)).toBeUndefined();
    expect(effortFor("toString", undefined)).toBeUndefined();
  });
});
