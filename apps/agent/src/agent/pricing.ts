import { type ModelPrice, modelInfo } from "@rovo/models";

export type { ModelPrice, PriceTier } from "@rovo/models";

// 本番のモデルの単価は手書きしない。pi-ai のカタログから、許可リストに載った id だけを取り出す（packages/models）。
// ここに無い・カタログに cost が無いモデルは単価が分からないので使えない。

/**
 * ENVIRONMENT=test のときだけ使える、台本付き fake モデルの単価（入出力は 1 トークン = $1/100万）。
 * キャッシュは cacheRead $0.1 / cacheWrite $1.25（consult のキャッシュ込みの費用計算を確かめるため。台本の usage に
 * キャッシュのトークンが無ければ費用に影響しない）。
 */
export const TEST_MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  "scripted/script-1": {
    inputPerMTok: 1,
    outputPerMTok: 1,
    cacheReadPerMTok: 0.1,
    cacheWritePerMTok: 1.25,
    tiers: [],
  },
};

export function priceFor(modelId: string, allowTest: boolean): ModelPrice | undefined {
  const info = modelInfo(modelId);
  if (info) return info.price;
  if (allowTest && Object.hasOwn(TEST_MODEL_PRICES, modelId)) return TEST_MODEL_PRICES[modelId];
  return undefined;
}

// 見積りの関数は gateway（道具つきの consult の往復）と共有するため packages/models にある
export {
  estimateCallCostUsd,
  estimateTokens,
  maxOutputTokensWithin,
  REQUEST_OVERHEAD_TOKENS,
} from "@rovo/models";
