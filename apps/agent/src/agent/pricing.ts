/** モデルの単価（USD / 100万トークン）。コードに固定し、ここに無いモデルは使えない。 */
export interface ModelPrice {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok: number;
  cacheWritePerMTok: number;
  /** 入力トークンがしきい値を超える呼び出しに適用する上位の単価 */
  tier?: { inputTokensAbove: number; inputPerMTok: number; outputPerMTok: number };
}

/** 単価は pi-ai の cloudflare-ai-gateway カタログ（providers/data/cloudflare-ai-gateway.json）の値。 */
export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  "anthropic/claude-sonnet-5-5": {
    inputPerMTok: 2,
    outputPerMTok: 10,
    cacheReadPerMTok: 0.2,
    cacheWritePerMTok: 2.5,
  },
  "anthropic/claude-opus-5-5": {
    inputPerMTok: 4,
    outputPerMTok: 20,
    cacheReadPerMTok: 0.2,
    cacheWritePerMTok: 5,
  },
  "anthropic/claude-haiku-5-5": {
    inputPerMTok: 0.1,
    outputPerMTok: 0.5,
    cacheReadPerMTok: 0.01,
    cacheWritePerMTok: 0.125,
    tier: { inputTokensAbove: 100_000, inputPerMTok: 0.5, outputPerMTok: 2.5 },
  },
};

/** ENVIRONMENT=test のときだけ使える、台本付き fake モデルの単価（1 トークン = $1/100万）。 */
export const TEST_MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  "scripted/script-1": {
    inputPerMTok: 1,
    outputPerMTok: 1,
    cacheReadPerMTok: 0,
    cacheWritePerMTok: 0,
  },
};

export function priceFor(modelId: string, allowTest: boolean): ModelPrice | undefined {
  if (Object.hasOwn(MODEL_PRICES, modelId)) return MODEL_PRICES[modelId];
  if (allowTest && Object.hasOwn(TEST_MODEL_PRICES, modelId)) return TEST_MODEL_PRICES[modelId];
  return undefined;
}

/** 文字数から保守的に見積もったトークン数（3 文字 = 1 トークン）。 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

/** 次の 1 回の呼び出しの最大費用: 現在のコンテキスト × 入力単価 + 出力上限 × 出力単価。 */
export function estimateCallCostUsd(
  price: ModelPrice,
  contextTokens: number,
  maxOutputTokens: number,
): number {
  const upper = price.tier && contextTokens > price.tier.inputTokensAbove ? price.tier : undefined;
  const input = upper?.inputPerMTok ?? price.inputPerMTok;
  const output = upper?.outputPerMTok ?? price.outputPerMTok;
  return (contextTokens * input + maxOutputTokens * output) / 1_000_000;
}
