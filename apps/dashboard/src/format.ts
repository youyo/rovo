/** 表示用の純関数（テキスト整形・リンクの許可・金額と時刻の書式）。React に依存しない。 */

/**
 * 表示してはいけない文字か。改行（\n \r）とタブ以外の C0、DEL、C1、双方向の制御文字（U+202A-202E・U+2066-2069）。
 * 加えて、向きだけを変える不可視のマーク（U+200E・U+200F・U+061C）も除く。
 * 正規表現ではなくコード単位の判定にして、制御文字をソースに直接書かない。
 */
function isUnsafe(c: number): boolean {
  return (
    c <= 0x08 ||
    c === 0x0b ||
    c === 0x0c ||
    (c >= 0x0e && c <= 0x1f) ||
    (c >= 0x7f && c <= 0x9f) ||
    c === 0x061c ||
    c === 0x200e ||
    c === 0x200f ||
    (c >= 0x202a && c <= 0x202e) ||
    (c >= 0x2066 && c <= 0x2069)
  );
}

/** 子エージェント由来の非信頼テキストを表示する前に、制御文字と双方向の制御文字を除く（D14）。 */
export function sanitizeText(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    if (!isUnsafe(s.charCodeAt(i))) out += s[i];
  }
  return out;
}

/** 1 行で出す文字列（表のセル・ラベル）。制御文字を除き、改行とタブを空白 1 つにする。 */
export function singleLine(s: string): string {
  return sanitizeText(s)
    .replace(/[\r\n\t]+/g, " ")
    .trim();
}

/** 外部リンクにしてよいのは、GitHub の PR の URL に厳密に一致するものだけ（D14）。 */
// owner は英数字とハイフン（先頭・末尾のハイフン不可）。repo は英数字と ._- で、「.」「..」だけは不可。
const PR_URL =
  /^https:\/\/github\.com\/[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/(?!\.{1,2}\/)[A-Za-z0-9._-]+\/pull\/[0-9]+$/;
export function isAllowedPrUrl(url: unknown): url is string {
  return typeof url === "string" && PR_URL.test(url);
}

/**
 * Cloudflare のダッシュボードを開くリンク。許すのはこのトップの URL だけ（アカウント ID を含めない）。
 * gateway の open_url は使わない（アカウント ID を含みうる）。
 */
export const CLOUDFLARE_DASH_URL = "https://dash.cloudflare.com/";
export function isAllowedCloudflareUrl(url: unknown): url is string {
  return url === CLOUDFLARE_DASH_URL;
}

/** 金額（USD）。0 は $0、1 ドル以上は小数 2 桁、未満は 4 桁まで（末尾の 0 を落とし、2 桁は残す）。 */
export function formatUsd(v: number): string {
  if (!Number.isFinite(v) || v === 0) return "$0";
  if (v >= 1) return `$${v.toFixed(2)}`;
  if (v < 0.00005) return "<$0.0001";
  const fixed = v.toFixed(4).replace(/0+$/, "");
  const [int = "0", frac = ""] = fixed.split(".");
  return `$${int}.${frac.padEnd(2, "0")}`;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** ローカル時刻の HH:MM。 */
export function formatClock(ms: number): string {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** ローカル時刻の HH:MM:SS。 */
export function formatClockSeconds(ms: number): string {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** 経過時間。1 秒未満 / N 秒 / M 分 S 秒 / H 時間 M 分。負と NaN は 0 として扱う。 */
export function formatDuration(ms: number): string {
  const total = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
  if (total < 1) return "1 秒未満";
  if (total < 60) return `${total} 秒`;
  if (total < 3600) return `${Math.floor(total / 60)} 分 ${total % 60} 秒`;
  return `${Math.floor(total / 3600)} 時間 ${Math.floor((total % 3600) / 60)} 分`;
}

/** 桁区切りの整数（ロケールに依存しない）。 */
export function formatCount(n: number): string {
  return String(Math.trunc(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** ローカル日付の「M月D日」。 */
export function formatDayHeading(ms: number): string {
  const d = new Date(ms);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

/** モデル名の表示用。最後の / より後ろ（プロバイダなどの接頭辞を省く）を名前にし、全体は title 用に残す。 */
export function shortModel(id: string): { name: string; full: string } {
  const full = singleLine(id);
  const name = full.slice(full.lastIndexOf("/") + 1);
  return { name: name === "" ? full : name, full };
}

/** 狭い場所（レール・ステータスバー）のモデル名。sonnet / haiku / opus はその系統名に縮め、ほかは shortModel の名前。 */
export function modelFamily(id: string): string {
  const name = shortModel(id).name;
  const m = /(sonnet|haiku|opus)/i.exec(name);
  return m?.[1] !== undefined ? m[1].toLowerCase() : name;
}
