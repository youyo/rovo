import { describe, expect, it } from "vitest";
import {
  ALLOWED_MODEL_IDS,
  computeCostUsd,
  DEFAULT_MAX_SANDBOX_INSTANCE,
  DEFAULT_MODEL,
  DEFAULT_MODEL_ORDER,
  DEFAULT_SANDBOX_INSTANCE,
  EFFORTS,
  effortFor,
  isSandboxPromotionReason,
  isSandboxPromotionTrigger,
  isSelectableSandboxInstance,
  listSandboxInstances,
  MODEL_CATALOG_IDS,
  modelInfo,
  parseAgentModels,
  pickDefaultModel,
  piModelId,
  providerOf,
  resolveEfforts,
  resolveMaxSandboxInstance,
  resolveSandboxInstance,
  SANDBOX_INSTANCES,
  SANDBOX_PROMOTION_REASONS,
  SANDBOX_PROMOTION_TRIGGERS,
  SELECTABLE_SANDBOX_INSTANCES,
  sandboxInstanceSpec,
  sandboxUsdPerHour,
  selectableSandboxInstancesUpTo,
  supportedEfforts,
  thinkingOffFor,
} from "../src";

describe("許可リストとカタログ", () => {
  it("許可リストは仕様どおりの 13 件（Anthropic 4 + OpenAI 3 + Workers AI の無料プラン 6）で、rovo の id → カタログの id の対応が 1 か所にある", () => {
    expect(Object.keys(MODEL_CATALOG_IDS).sort()).toEqual(
      [
        "anthropic/claude-fable-5-1",
        "anthropic/claude-haiku-5-5",
        "anthropic/claude-opus-5-5",
        "anthropic/claude-sonnet-5-5",
        "openai/gpt-6-astra",
        "openai/gpt-6-luna",
        "openai/gpt-6-sol",
        "workers-ai/@cf/google/gemma-4-26b-a4b-it",
        "workers-ai/@cf/nvidia/nemotron-3-120b-a12b",
        "workers-ai/@cf/openai/gpt-oss-120b",
        "workers-ai/@cf/openai/gpt-oss-20b",
        "workers-ai/@cf/qwen/qwen3.8-27b",
        "workers-ai/@cf/zai-org/glm-4.7-flash",
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
      // Workers AI: 6 つとも low から。gemma は low を受け付けない（off / high だけ）ので、受け付ける最小の思考レベル high
      "workers-ai/@cf/openai/gpt-oss-120b": "low",
      "workers-ai/@cf/openai/gpt-oss-20b": "low",
      "workers-ai/@cf/qwen/qwen3.8-27b": "low",
      "workers-ai/@cf/nvidia/nemotron-3-120b-a12b": "low",
      "workers-ai/@cf/zai-org/glm-4.7-flash": "low",
      "workers-ai/@cf/google/gemma-4-26b-a4b-it": "high",
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

describe("Workers AI のモデル（D10b。無料プランで使えるものだけ）", () => {
  const WAI = [
    "workers-ai/@cf/openai/gpt-oss-120b",
    "workers-ai/@cf/openai/gpt-oss-20b",
    "workers-ai/@cf/qwen/qwen3.8-27b",
    "workers-ai/@cf/nvidia/nemotron-3-120b-a12b",
    "workers-ai/@cf/zai-org/glm-4.7-flash",
    "workers-ai/@cf/google/gemma-4-26b-a4b-it",
  ];

  it("provider は workers-ai、単価はカタログ（gpt-oss-120b は 0.35 / 0.75）", () => {
    for (const id of WAI) {
      expect(modelInfo(id), id).toMatchObject({ provider: "workers-ai", id });
    }
    expect(modelInfo("workers-ai/@cf/openai/gpt-oss-120b")?.price).toMatchObject({
      inputPerMTok: 0.35,
      outputPerMTok: 0.75,
    });
  });

  it("有料プラン専用のモデルは許可リストに入れない（kimi-k2.7-code / glm-5.x / deepseek-v4）", () => {
    for (const id of [
      "workers-ai/@cf/moonshotai/kimi-k2.7-code",
      "workers-ai/@cf/zai-org/glm-5.2",
      "workers-ai/@cf/zai-org/glm-5.3",
      "workers-ai/@cf/zai-org/glm-5.3-flash",
      "workers-ai/@cf/deepseek-ai/deepseek-v4-flash-0731",
      "workers-ai/@cf/deepseek-ai/deepseek-v4-pro-0813",
    ]) {
      expect(modelInfo(id), id).toBeUndefined();
      expect(ALLOWED_MODEL_IDS).not.toContain(id);
    }
  });

  it("思考レベルは Workers AI のレジストリの thinkingLevelMap に従う（gemma は off / high だけ、gpt-oss は low / medium / high）", () => {
    expect(supportedEfforts("workers-ai/@cf/google/gemma-4-26b-a4b-it")).toEqual(["off", "high"]);
    expect(supportedEfforts("workers-ai/@cf/openai/gpt-oss-120b")).toEqual([
      "low",
      "medium",
      "high",
    ]);
    // gemma に low を指定しても無視して初期値（high）のまま
    expect(
      effortFor(
        "workers-ai/@cf/google/gemma-4-26b-a4b-it",
        "workers-ai/@cf/google/gemma-4-26b-a4b-it=low",
      ),
    ).toBe("high");
  });

  it("providerOf: id の接頭辞（許可リストに無ければ undefined）", () => {
    expect(providerOf("anthropic/claude-sonnet-5-5")).toBe("anthropic");
    expect(providerOf("openai/gpt-6-sol")).toBe("openai");
    expect(providerOf("workers-ai/@cf/openai/gpt-oss-120b")).toBe("workers-ai");
    expect(providerOf("nope/x")).toBeUndefined();
    expect(providerOf("toString")).toBeUndefined();
  });

  it("piModelId: Pi（createAI）に渡す id。Workers AI は workers-ai/ を外した @cf/ の id、他はそのまま", () => {
    expect(piModelId("workers-ai/@cf/openai/gpt-oss-120b")).toBe("@cf/openai/gpt-oss-120b");
    expect(piModelId("anthropic/claude-sonnet-5-5")).toBe("anthropic/claude-sonnet-5-5");
    expect(piModelId("openai/gpt-6-sol")).toBe("openai/gpt-6-sol");
  });
});

describe("既定のモデルの順序（D10b）", () => {
  it("順序は固定: Anthropic → gpt-oss-120b → 残りの Workers AI → OpenAI。許可リストの全モデルを 1 回ずつ含む", () => {
    expect([...DEFAULT_MODEL_ORDER]).toEqual([
      "anthropic/claude-sonnet-5-5",
      "anthropic/claude-haiku-5-5",
      "anthropic/claude-opus-5-5",
      "anthropic/claude-fable-5-1",
      "workers-ai/@cf/openai/gpt-oss-120b",
      "workers-ai/@cf/openai/gpt-oss-20b",
      "workers-ai/@cf/qwen/qwen3.8-27b",
      "workers-ai/@cf/nvidia/nemotron-3-120b-a12b",
      "workers-ai/@cf/zai-org/glm-4.7-flash",
      "workers-ai/@cf/google/gemma-4-26b-a4b-it",
      "openai/gpt-6-sol",
      "openai/gpt-6-luna",
      "openai/gpt-6-astra",
    ]);
    expect([...DEFAULT_MODEL_ORDER].sort()).toEqual([...ALLOWED_MODEL_IDS].sort());
  });

  it("pickDefaultModel: 希望のモデルが使えればそれ。なければ順序の最初の使えるモデル。1 つも無ければ undefined", () => {
    const all = [...DEFAULT_MODEL_ORDER];
    expect(pickDefaultModel("openai/gpt-6-sol", all)).toBe("openai/gpt-6-sol");
    // Anthropic のキーが無い: gpt-oss-120b
    const noAnthropic = all.filter((m) => !m.startsWith("anthropic/"));
    expect(pickDefaultModel("anthropic/claude-sonnet-5-5", noAnthropic)).toBe(
      "workers-ai/@cf/openai/gpt-oss-120b",
    );
    // 渡された順序に依らず固定の順序で選ぶ
    expect(pickDefaultModel(undefined, [...noAnthropic].reverse())).toBe(
      "workers-ai/@cf/openai/gpt-oss-120b",
    );
    // gpt-oss-120b が AGENT_MODELS に無ければ次
    expect(
      pickDefaultModel(undefined, ["workers-ai/@cf/openai/gpt-oss-20b", "openai/gpt-6-sol"]),
    ).toBe("workers-ai/@cf/openai/gpt-oss-20b");
    expect(pickDefaultModel("anthropic/claude-sonnet-5-5", [])).toBeUndefined();
  });
});

describe("Sandbox のインスタンス（D13）", () => {
  it("名前付きの 5 種類だけ。既定は standard-2", () => {
    expect(Object.keys(SANDBOX_INSTANCES)).toEqual([
      "lite",
      "standard-1",
      "standard-2",
      "standard-3",
      "standard-4",
    ]);
    expect(DEFAULT_SANDBOX_INSTANCE).toBe("standard-2");
    expect(sandboxInstanceSpec("standard-2")).toEqual({ vcpu: 1, memoryGiB: 6, diskGB: 12 });
    expect(sandboxInstanceSpec("lite")).toEqual({ vcpu: 1 / 16, memoryGiB: 0.25, diskGB: 2 });
  });

  it("selectableSandboxInstancesUpTo: 選べる名前を、上限（含む）までだけ小さい順に返す。上限より大きい名前を含めない", () => {
    expect(selectableSandboxInstancesUpTo("standard-1")).toEqual(["standard-1"]);
    expect(selectableSandboxInstancesUpTo("standard-3")).toEqual([
      "standard-1",
      "standard-2",
      "standard-3",
    ]);
    expect(selectableSandboxInstancesUpTo("standard-4")).toEqual([...SELECTABLE_SANDBOX_INSTANCES]);
  });

  it("resolveSandboxInstance: 未設定・空は既定。不正な値は既定に戻して ignored に返す", () => {
    expect(resolveSandboxInstance(undefined)).toEqual({ instance: "standard-2" });
    expect(resolveSandboxInstance("  ")).toEqual({ instance: "standard-2" });
    expect(resolveSandboxInstance(" standard-4 ")).toEqual({ instance: "standard-4" });
    expect(resolveSandboxInstance("lite")).toEqual({ instance: "lite" });
    expect(resolveSandboxInstance("basic")).toEqual({ instance: "standard-2", ignored: "basic" });
    expect(resolveSandboxInstance("toString")).toEqual({
      instance: "standard-2",
      ignored: "toString",
    });
  });

  it("sandboxUsdPerHour: CPU 100% の上限側。小数 4 桁に切り上げる（少なく数えない）", () => {
    // lite: 0.0625*3600*0.00002 + 0.25*3600*0.0000025 + 2*3600*0.00000007 = 0.007254
    expect(sandboxUsdPerHour("lite")).toBe(0.0073);
    // standard-2: 1*3600*0.00002 + 6*3600*0.0000025 + 12*3600*0.00000007 = 0.129024
    expect(sandboxUsdPerHour("standard-2")).toBe(0.1291);
    expect(sandboxUsdPerHour("standard-1")).toBe(0.0741);
    expect(sandboxUsdPerHour("standard-3")).toBe(0.2201);
    expect(sandboxUsdPerHour("standard-4")).toBe(0.4011);
    for (const id of Object.keys(SANDBOX_INSTANCES)) {
      const s = sandboxInstanceSpec(id as "lite");
      const exact =
        s.vcpu * 3600 * 0.00002 + s.memoryGiB * 3600 * 0.0000025 + s.diskGB * 3600 * 0.00000007;
      expect(sandboxUsdPerHour(id as "lite")).toBeGreaterThanOrEqual(exact - 1e-12);
    }
  });

  it("タスクが選べるのは lite を除く 4 種類（lite はメモリ不足で落ちた実績がある）", () => {
    expect([...SELECTABLE_SANDBOX_INSTANCES]).toEqual([
      "standard-1",
      "standard-2",
      "standard-3",
      "standard-4",
    ]);
    for (const id of SELECTABLE_SANDBOX_INSTANCES)
      expect(isSelectableSandboxInstance(id)).toBe(true);
    for (const v of ["lite", "basic", "toString", "", undefined, 2, null]) {
      expect(isSelectableSandboxInstance(v), String(v)).toBe(false);
    }
  });

  it("listSandboxInstances: 表と単価の関数から作る（数値を二重に持たない）。既定と選べるかの印が付く", () => {
    const list = listSandboxInstances();
    expect(list.map((i) => i.name)).toEqual(Object.keys(SANDBOX_INSTANCES));
    for (const i of list) {
      const spec = sandboxInstanceSpec(i.name as "lite");
      expect(i).toEqual({
        name: i.name,
        vcpu: spec.vcpu,
        memory_gib: spec.memoryGiB,
        disk_gb: spec.diskGB,
        usd_per_hour: sandboxUsdPerHour(i.name as "lite"),
        default: i.name === DEFAULT_SANDBOX_INSTANCE,
        selectable: i.name !== "lite",
        auto_scale_max: i.name === DEFAULT_MAX_SANDBOX_INSTANCE,
      });
    }
    expect(list.filter((i) => i.default).map((i) => i.name)).toEqual(["standard-2"]);
  });

  it("listSandboxInstances: 既定を引数で変えられる（デプロイの設定）。lite を既定にしても selectable は false のまま", () => {
    expect(
      listSandboxInstances("standard-4")
        .filter((i) => i.default)
        .map((i) => i.name),
    ).toEqual(["standard-4"]);
    const lite = listSandboxInstances("lite").find((i) => i.name === "lite");
    expect(lite).toMatchObject({ default: true, selectable: false });
  });

  it("listSandboxInstances: Clef が自動で上げる上限に auto_scale_max が付く（引数で変えられる。null なら付かない）", () => {
    const names = (max?: Parameters<typeof listSandboxInstances>[1]) =>
      listSandboxInstances("standard-2", max)
        .filter((i) => i.auto_scale_max)
        .map((i) => i.name);
    expect(names()).toEqual(["standard-4"]);
    expect(names("standard-3")).toEqual(["standard-3"]);
    expect(names(null)).toEqual([]);
  });

  it("昇格の見送り・失敗の理由は固定コード（公開してよい値の一覧）", () => {
    expect([...SANDBOX_PROMOTION_REASONS]).toEqual([
      "fixed_instance",
      "already_large",
      "state_unreadable",
      "snapshot_unsupported",
      "snapshot_failed",
      "start_failed",
      "cert_missing",
      "workspace_mismatch",
      "fallback_failed",
    ]);
    expect(isSandboxPromotionReason("snapshot_unsupported")).toBe(true);
    for (const v of ["", "toString", "SNAPSHOT_FAILED", undefined, 3]) {
      expect(isSandboxPromotionReason(v), String(v)).toBe(false);
    }
  });
});

describe("Clef による Sandbox の昇格の上限（SANDBOX_MAX_INSTANCE）", () => {
  it("上限の既定は standard-4", () => {
    expect(DEFAULT_MAX_SANDBOX_INSTANCE).toBe("standard-4");
  });

  it("resolveMaxSandboxInstance: 未設定・空・off / none は無効（null。Clef による昇格をしない）。選べる 4 種類だけ有効。不正な値は無効にして ignored に返す", () => {
    expect(resolveMaxSandboxInstance(undefined)).toEqual({ instance: null });
    expect(resolveMaxSandboxInstance("")).toEqual({ instance: null });
    expect(resolveMaxSandboxInstance(" Off ")).toEqual({ instance: null });
    expect(resolveMaxSandboxInstance("none")).toEqual({ instance: null });
    expect(resolveMaxSandboxInstance(" standard-4 ")).toEqual({ instance: "standard-4" });
    expect(resolveMaxSandboxInstance("standard-3")).toEqual({ instance: "standard-3" });
    expect(resolveMaxSandboxInstance("lite")).toEqual({ instance: null, ignored: "lite" });
    expect(resolveMaxSandboxInstance("toString")).toEqual({ instance: null, ignored: "toString" });
  });
});

describe("Sandbox の昇格の引き金", () => {
  it("昇格の引き金は固定の値（clef は Clef による判断。agent / rule / verification は古いタスクの記録を読むために残す）", () => {
    expect([...SANDBOX_PROMOTION_TRIGGERS]).toEqual(["agent", "rule", "verification", "clef"]);
    expect(isSandboxPromotionTrigger("clef")).toBe(true);
    expect(isSandboxPromotionTrigger("agent")).toBe(true);
    expect(isSandboxPromotionTrigger("rule")).toBe(true);
    expect(isSandboxPromotionTrigger("verification")).toBe(true);
    expect(isSandboxPromotionTrigger("npm test")).toBe(false);
    expect(isSandboxPromotionTrigger(undefined)).toBe(false);
  });
});
