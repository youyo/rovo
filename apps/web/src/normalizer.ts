/**
 * Normalizer: 取得した本文を、返す形（Markdown のテキスト）に整える。
 * - 隠し文字（ゼロ幅・双方向制御・Tag 文字・制御文字）を取り除く
 * - 上限（50,000 文字）で切り詰める
 * 切り詰めた後の全体が、Safety Evaluator が評価する対象になる。
 * 非信頼データの目印で囲むのは呼び出し元（gateway の MCP ツール・agent の Pi ツール）の責務で、web は生の Markdown を返す。
 */

export const MAX_CONTENT_CHARS = 50_000;

// ゼロ幅（U+200B-200F）、行・段落区切り〜双方向上書き（U+2028-202E）、Word Joiner〜不可視演算ワーカー（U+2060-2064）、
// 双方向 isolate（U+2066-2069）、BOM（U+FEFF）、Tag 文字（U+E0000-E007F）、
// C0 制御（\n \t を除く）、DEL、C1 制御
const HIDDEN =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 制御文字を取り除くのが目的
  /[\u200B-\u200F\u2028-\u202E\u2060-\u2064\u2066-\u2069\uFEFF\u{E0000}-\u{E007F}\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu;

export type Normalized = {
  text: string;
  truncated: boolean;
  originalChars: number;
  strippedHidden: number;
};

export function normalizeContent(raw: string, options: { maxChars?: number } = {}): Normalized {
  const max = options.maxChars ?? MAX_CONTENT_CHARS;
  const originalChars = raw.length;
  let strippedHidden = 0;
  let text = raw.replace(/\r\n?/g, "\n").replace(HIDDEN, () => {
    strippedHidden++;
    return "";
  });
  text = text.replace(/\n{3,}/g, "\n\n");
  let truncated = false;
  if (text.length > max) {
    truncated = true;
    let end = max;
    // サロゲートペアの途中で切らない
    const last = text.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff) end -= 1;
    text = text.slice(0, end);
  }
  return { text, truncated, originalChars, strippedHidden };
}

/**
 * normalizeContent が返す本文（切り詰め後）を覆う、raw の先頭部分。
 * 決定論ルールを「返す範囲」にだけかけるために使う（返さない末尾の語句や隠し文字で止めない）。
 * 切り詰めがなければ raw 全体。正規化は文字の削除と改行の圧縮だけなので、正規化後の長さは raw の先頭からの長さに対して単調。
 */
export function coveringRawPrefix(raw: string, options: { maxChars?: number } = {}): string {
  const n = normalizeContent(raw, options);
  if (!n.truncated) return raw;
  const target = n.text.length;
  const unbounded = { maxChars: Number.POSITIVE_INFINITY };
  let lo = 0;
  let hi = raw.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (normalizeContent(raw.slice(0, mid), unbounded).text.length >= target) hi = mid;
    else lo = mid + 1;
  }
  return raw.slice(0, lo);
}
