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

/**
 * 入力トークン数の上限: UTF-8 のバイト数。byte-level BPE では 1 トークンは 1 バイト以上なので、
 * トークン数がバイト数を超えることはない（文字数からの見積もりは CJK で実際を下回る）。
 */
export function estimateTokens(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

/** リクエストの枠組み（ロール表記など）の分として、入力の見積もりに足す固定の余裕。 */
export const REQUEST_OVERHEAD_TOKENS = 1024;

/** 入力と出力の最悪の単価（価格帯・キャッシュの書き込みまで含めた最大値。USD / 100 万トークン）。 */
function worstRates(price: ModelPrice): { input: number; output: number } {
  return {
    input: Math.max(
      price.inputPerMTok,
      price.cacheWritePerMTok,
      ...price.tiers.flatMap((t) => [t.inputPerMTok, t.cacheWritePerMTok]),
    ),
    output: Math.max(price.outputPerMTok, ...price.tiers.map((t) => t.outputPerMTok)),
  };
}

/**
 * 予算（USD）に収まる出力トークン数の上限（consult 用）。入力は contextTokens を最悪の単価で見積もり、
 * 残りを出力の最悪の単価で割る（切り捨て）。入力だけで予算を使い切るなら 0。
 * estimateCallCostUsd(price, contextTokens, 戻り値) は budgetUsd を超えない。
 */
export function maxOutputTokensWithin(
  price: ModelPrice,
  contextTokens: number,
  budgetUsd: number,
): number {
  if (!Number.isFinite(budgetUsd) || budgetUsd <= 0) return 0;
  const rates = worstRates(price);
  const remaining = budgetUsd - (contextTokens * rates.input) / 1_000_000;
  if (!(remaining > 0) || !(rates.output > 0)) return 0;
  let n = Math.floor((remaining * 1_000_000) / rates.output);
  // 浮動小数の誤差で上限を超えないよう、見積りが予算以下になるまで下げる
  while (n > 0 && estimateCallCostUsd(price, contextTokens, n) > budgetUsd) n--;
  return n;
}

/**
 * 次の 1 回の呼び出しの最大費用（ハードキャップ用。過大に見積もる）:
 * 入力は input と cacheWrite の高い方、価格帯があればその最大値。出力は max_tokens × 出力単価の最大値。
 */
export function estimateCallCostUsd(
  price: ModelPrice,
  contextTokens: number,
  maxOutputTokens: number,
): number {
  const input = Math.max(
    price.inputPerMTok,
    price.cacheWritePerMTok,
    ...price.tiers.flatMap((t) => [t.inputPerMTok, t.cacheWritePerMTok]),
  );
  const output = Math.max(price.outputPerMTok, ...price.tiers.map((t) => t.outputPerMTok));
  return (contextTokens * input + maxOutputTokens * output) / 1_000_000;
}
