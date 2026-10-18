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

/**
 * 入力トークン数の上限: UTF-8 のバイト数。byte-level BPE では 1 トークンは 1 バイト以上なので、
 * トークン数がバイト数を超えることはない（文字数からの見積もりは CJK で実際を下回る）。
 */
export function estimateTokens(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

/** リクエストの枠組み（ロール表記など）の分として、入力の見積もりに足す固定の余裕。 */
export const REQUEST_OVERHEAD_TOKENS = 1024;

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
    price.tier?.inputPerMTok ?? 0,
  );
  const output = Math.max(price.outputPerMTok, price.tier?.outputPerMTok ?? 0);
  return (contextTokens * input + maxOutputTokens * output) / 1_000_000;
}
