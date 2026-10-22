/**
 * ANSI のエスケープコード（色・カーソル操作・OSC のハイパーリンクやタイトル）。
 * 端末向けの装飾で、親にもモデルにも意味がなく、トークンを食うだけなので取り除く。
 */
const ANSI_RE =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ESC / BEL を扱うのが目的
  /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;

export function stripAnsi(text: string): string {
  return text.includes("\u001b") ? text.replace(ANSI_RE, "") : text;
}

/** 書記素（絵文字・結合文字の並びを 1 つと数える）に分ける。Segmenter が無ければコードポイント単位。 */
function graphemes(text: string): string[] {
  if (typeof Intl !== "undefined" && "Segmenter" in Intl) {
    return Array.from(
      new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text),
      (s) => s.segment,
    );
  }
  return Array.from(text);
}

/** 末尾 n 文字を残す（切ったら先頭に "..."）。サロゲートペアや結合文字の途中では切らない。 */
export function tailChars(text: string, n: number): string {
  if (text.length <= n) return text;
  const g = graphemes(text);
  return g.length > n ? `...${g.slice(g.length - n).join("")}` : text;
}

/** 先頭 n 文字を残す（切ったら末尾に "..."）。サロゲートペアや結合文字の途中では切らない。 */
export function headChars(text: string, n: number): string {
  if (text.length <= n) return text;
  const g = graphemes(text);
  return g.length > n ? `${g.slice(0, n).join("")}...` : text;
}
