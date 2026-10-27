import { estimateTokens, modelInfo, REQUEST_OVERHEAD_TOKENS } from "@rovo/models";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConsultRequest, ConsultResult } from "../../src/agent/contract";
import {
  CONSULT_MAX_TRANSCRIPT,
  type ConsultToolsDeps,
  consultToolsBudgetNeed,
  runConsultTools,
} from "../../src/consult-tools";
import type { WebPort, WebSearchResponse } from "../../src/web/contract";
import { okResult } from "../support/consult-agent";

// #135 のレビューで残った課題（キャッシュの割引の起点・途中の会話の件数）。runConsultTools を直接呼ぶ。

const MIN = 60_000;
const MODEL = "anthropic/claude-sonnet-5-5";
/** 1 歩目の費用 */
const STEP_USD = 0.2;

afterEach(() => vi.restoreAllMocks());

const searchResponse: WebSearchResponse = {
  results: [],
  metadata: { requestId: "r", latencyMs: 1, provider: "p", dropped_urls: 0 },
};

function toolStep(n: number, over: Partial<Extract<ConsultResult, { ok: true }>> = {}) {
  const ids = Array.from({ length: n }, (_, i) => `call_${i}`);
  return okResult({
    text: "",
    costUsd: 0.01,
    usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 },
    toolCalls: ids.map((id, i) => ({
      id,
      name: "web_search",
      argumentsJson: JSON.stringify({ query: `q${i}` }),
    })),
    assistantJson: JSON.stringify([
      { type: "thinking", thinking: "plan", thinkingSignature: "SIG" },
      ...ids.map((id, i) => ({
        type: "toolCall",
        id,
        name: "web_search",
        arguments: { query: `q${i}` },
      })),
    ]),
    ...over,
  });
}

function deps(
  step: ConsultToolsDeps["step"],
  over: Partial<ConsultToolsDeps> = {},
): ConsultToolsDeps {
  const web: WebPort = {
    async search() {
      return searchResponse;
    },
    async fetchUrl() {
      throw new Error("not used");
    },
    async browse() {
      throw new Error("not used");
    },
  };
  return {
    step,
    consumeQuota: () => ({ ok: true }) as never,
    web,
    webPrices: { searchUsdPer1k: 0, fetchUsdPer1k: 0 },
    stepTimeoutMs: 600_000,
    stopped: () => false,
    ...over,
  };
}

describe("キャッシュの割引の起点（リクエストを送った時刻から数える）", () => {
  // 大きな会話 + 前の歩の cacheRead。割り引けるときだけ予約額に収まる額にする
  const bigText = "x".repeat(400_000);
  function setup() {
    const price = modelInfo(MODEL)?.price;
    if (!price) throw new Error("no price");
    const baseTokens =
      estimateTokens(
        JSON.stringify({ system: "s", messages: [{ role: "user", content: bigText }] }),
      ) +
      REQUEST_OVERHEAD_TOKENS +
      6_000;
    const common = {
      price,
      baseTokens,
      toolBytes: 0,
      callsUsed: 0,
      webPrices: { searchUsdPer1k: 0, fetchUsdPer1k: 0 },
    };
    // 1 歩目は割引なしで収まる予約額。1 歩目で STEP_USD 使ったあとは、割り引けるときだけ次の歩 + 最後の歩が収まる
    const uncachedNeed = consultToolsBudgetNeed(common);
    const cachedNeed = consultToolsBudgetNeed({
      ...common,
      callsUsed: 1,
      cachedTokens: baseTokens,
    });
    const reserved = uncachedNeed * 1.05;
    expect(cachedNeed).toBeLessThan(reserved - STEP_USD);
    expect(uncachedNeed).toBeGreaterThan(reserved - STEP_USD + 0.01);
    const request: ConsultRequest = {
      consultId: "consult-01HXXXXXXXXXXXXXXXXXXXXXXX",
      userId: "1",
      model: MODEL,
      system: "s",
      messages: [{ role: "user", content: bigText }],
      budgetUsd: reserved,
    };
    return { request, baseTokens };
  }

  async function run(responseMs: number, afterMs: number) {
    const { request, baseTokens } = setup();
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const seen: ConsultRequest[] = [];
    const steps = [
      toolStep(1, {
        costUsd: STEP_USD,
        usage: { input: 100, output: 10, cacheRead: baseTokens, cacheWrite: 0 },
      }),
      okResult({ text: "done" }),
    ];
    const d = deps(async (req) => {
      seen.push(structuredClone(req));
      // モデルの応答に responseMs かかる（リクエストを送ってから応答が返るまで）
      now += responseMs;
      return steps.shift() ?? okResult({ text: "exhausted" });
    });
    d.web = {
      ...(d.web as WebPort),
      async search() {
        // 応答を受けてから、次の歩を送るまでに afterMs かかる
        now += afterMs;
        return searchResponse;
      },
    };
    const out = await runConsultTools(request, ["web_search"], d);
    return { out, seen };
  }

  it("応答から 2 分後の次の歩でも、応答が 3 分かかっていれば（送ってから 5 分）割り引かない: 道具を閉じる", async () => {
    const { out, seen } = await run(3 * MIN, 2 * MIN);
    expect(out.toolsClosed).toBe("budget");
    expect(seen[1]?.tools).toBeUndefined();
  });

  it("送ってから 4 分以内（応答 1 分 + 1 分後）なら割り引く: 道具を開いたまま", async () => {
    const { out, seen } = await run(1 * MIN, 1 * MIN);
    expect(out.toolsClosed).toBeUndefined();
    expect(seen[1]?.tools).toBeDefined();
  });
});

describe("途中の会話の件数（CONSULT_MAX_TRANSCRIPT）", () => {
  it("次の歩の transcript が上限を超えるなら、道具を閉じて会話をたたむ（開いたまま送らない）", async () => {
    const seen: ConsultRequest[] = [];
    const steps = [toolStep(2), okResult({ text: "done" })];
    const request: ConsultRequest = {
      consultId: "consult-01HXXXXXXXXXXXXXXXXXXXXXXX",
      userId: "1",
      model: MODEL,
      system: "s",
      messages: [{ role: "user", content: "q" }],
      budgetUsd: 1,
    };
    // assistant 1 + toolResult 2 = 3 件。上限を 2 にすると超える
    const out = await runConsultTools(
      request,
      ["web_search"],
      deps(
        async (req) => {
          seen.push(structuredClone(req));
          return steps.shift() ?? okResult({ text: "exhausted" });
        },
        { maxTranscript: 2 },
      ),
    );
    expect(out.toolsClosed).toBe("limit");
    expect(seen[1]?.tools).toBeUndefined();
    expect(seen[1]?.transcript?.every((m) => m.role !== "toolResult" && !("toolCalls" in m))).toBe(
      true,
    );
    expect(seen[1]?.transcript?.length ?? 0).toBeLessThanOrEqual(2);
  });

  it("既定の上限は agent の受け入れ上限と同じ 64", () => {
    expect(CONSULT_MAX_TRANSCRIPT).toBe(64);
  });
});
