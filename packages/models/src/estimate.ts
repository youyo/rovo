import type { ModelPrice } from "./index";

// 呼び出し 1 回の最大費用の見積り（過大に見積もる）。agent（consult・タスク・レビューの上限）と、
// gateway（道具つきの consult の往復で、次の歩と最後の歩が予約額に収まるかの確認。#135）が共有する。

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
 * 入力・出力・キャッシュ読み出しの最悪の単価（価格帯・キャッシュの書き込みまで含めた最大値。USD / 100 万トークン）。
 * input は input と cacheWrite の高い方: Anthropic では、キャッシュの境界より後ろの新しい入力は、境界の位置しだいで
 * 通常の入力（input）にも書き込み（cacheWrite。通常の 1.25 倍）にもなるので、どちらでも下回らないよう高い方で見る。
 * cacheRead は base と全 tier の最大値（tier は入力の合計がしきい値を超えると呼び出し全体に適用される）。
 */
function worstRates(price: ModelPrice): { input: number; output: number; cacheRead: number } {
  return {
    input: Math.max(
      price.inputPerMTok,
      price.cacheWritePerMTok,
      ...price.tiers.flatMap((t) => [t.inputPerMTok, t.cacheWritePerMTok]),
    ),
    output: Math.max(price.outputPerMTok, ...price.tiers.map((t) => t.outputPerMTok)),
    cacheRead: Math.max(price.cacheReadPerMTok, ...price.tiers.map((t) => t.cacheReadPerMTok)),
  };
}

/**
 * 入力側の見積額（USD）。contextTokens のうち cachedTokens（0〜contextTokens に丸める）はキャッシュ読み出しの
 * 最悪の単価、残りは最悪の入力単価。cachedTokens は「前回の実測でキャッシュから読まれた」と分かっている分だけを渡す。
 */
function inputCostUsd(price: ModelPrice, contextTokens: number, cachedTokens: number): number {
  const rates = worstRates(price);
  const cached = Math.min(Math.max(0, cachedTokens), contextTokens);
  return (cached * rates.cacheRead + (contextTokens - cached) * rates.input) / 1_000_000;
}

/**
 * 予算（USD）に収まる出力トークン数の上限。入力は contextTokens を最悪の単価で見積もり（cachedTokens の分だけ
 * cacheRead の最悪の単価）、残りを出力の最悪の単価で割る（切り捨て）。入力だけで予算を使い切るなら 0。
 * estimateCallCostUsd(price, contextTokens, 戻り値, cachedTokens) は budgetUsd を超えない。
 */
export function maxOutputTokensWithin(
  price: ModelPrice,
  contextTokens: number,
  budgetUsd: number,
  cachedTokens = 0,
): number {
  if (!Number.isFinite(budgetUsd) || budgetUsd <= 0) return 0;
  const rates = worstRates(price);
  const remaining = budgetUsd - inputCostUsd(price, contextTokens, cachedTokens);
  if (!(remaining > 0) || !(rates.output > 0)) return 0;
  let n = Math.floor((remaining * 1_000_000) / rates.output);
  // 浮動小数の誤差で上限を超えないよう、見積りが予算以下になるまで下げる
  while (n > 0 && estimateCallCostUsd(price, contextTokens, n, cachedTokens) > budgetUsd) n--;
  return n;
}

/**
 * 次の 1 回の呼び出しの最大費用（ハードキャップ用。過大に見積もる）:
 * 入力は input と cacheWrite の高い方、価格帯があればその最大値（cachedTokens の分だけ cacheRead の最大値）。
 * 出力は max_tokens × 出力単価の最大値。
 */
export function estimateCallCostUsd(
  price: ModelPrice,
  contextTokens: number,
  maxOutputTokens: number,
  cachedTokens = 0,
): number {
  const output = worstRates(price).output;
  return inputCostUsd(price, contextTokens, cachedTokens) + (maxOutputTokens * output) / 1_000_000;
}
