import { localeOf, type T } from "./i18n";

/** 表示用の純関数（テキスト整形・リンクの許可・金額と時刻の書式）。React に依存しない。書式は t.lang のロケールで Intl に渡す。 */

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

/** ワーカー由来の非信頼テキストを表示する前に、制御文字と双方向の制御文字を除く（D14）。 */
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
 * Cloudflare のダッシュボードを開くリンク。許すのはトップと、アカウントを書かない深いリンク
 * （`?to=/:account/<パス>`。Cloudflare の公式文書にある形）だけ。アカウント ID は含めない。
 * gateway の open_url は使わない（アカウント ID を含みうる）。
 */
export const CLOUDFLARE_DASH_URL = "https://dash.cloudflare.com/";
const DEEP_LINK_PREFIX = `${CLOUDFLARE_DASH_URL}?to=/:account/`;
const DEEP_LINK_PATH = /^[a-z0-9-]+(?:\/[a-z0-9-]+)*$/;
/** 行ごとの深いリンク（`/:account/` より後のパス）を組む。 */
export const cloudflareDashLink = (path: string) => `${DEEP_LINK_PREFIX}${path}`;
export function isAllowedCloudflareUrl(url: unknown): url is string {
  if (typeof url !== "string") return false;
  if (url === CLOUDFLARE_DASH_URL) return true;
  if (!url.startsWith(DEEP_LINK_PREFIX)) return false;
  const path = url.slice(DEEP_LINK_PREFIX.length);
  // アカウント ID らしい 32 桁の 16 進を含むものは許さない
  return DEEP_LINK_PATH.test(path) && !/[0-9a-f]{32}/i.test(path);
}

/** Intl に渡すロケール（t の言語。en は en-US、ja は ja-JP）。 */
const locale = (t: T) => localeOf(t.lang);

/** 金額（USD）。0 は $0、1 ドル以上は小数 2 桁、未満は 4 桁まで（末尾の 0 を落とし、2 桁は残す）。数字の書式はロケールの Intl。 */
export function formatUsd(v: number, t: T): string {
  if (!Number.isFinite(v) || v === 0) return "$0";
  if (v < 0.00005) return "<$0.0001";
  const digits =
    v >= 1
      ? { minimumFractionDigits: 2, maximumFractionDigits: 2 }
      : { minimumFractionDigits: 2, maximumFractionDigits: 4 };
  return new Intl.NumberFormat(locale(t), {
    style: "currency",
    currency: "USD",
    currencyDisplay: "narrowSymbol",
    ...digits,
  }).format(v);
}

/** ローカル時刻の時:分（ja は 24 時間の 14:05、en は 12 時間の 02:05 PM）。 */
export function formatClock(ms: number, t: T): string {
  return new Intl.DateTimeFormat(locale(t), { hour: "2-digit", minute: "2-digit" }).format(ms);
}

/** ローカル時刻の時:分:秒。 */
export function formatClockSeconds(ms: number, t: T): string {
  return new Intl.DateTimeFormat(locale(t), {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(ms);
}

/** 経過時間。1 秒未満 / N 秒 / M 分 S 秒 / H 時間 M 分。負と NaN は 0 として扱う。 */
export function formatDuration(ms: number, t: T): string {
  const total = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
  if (total < 1) return t("duration.lessThanSecond");
  if (total < 60) return t("duration.seconds", { s: total });
  if (total < 3600) return t("duration.minutes", { m: Math.floor(total / 60), s: total % 60 });
  return t("duration.hours", { h: Math.floor(total / 3600), m: Math.floor((total % 3600) / 60) });
}

/** 桁区切りの整数（ロケールの Intl）。 */
export function formatCount(n: number, t: T): string {
  return new Intl.NumberFormat(locale(t), { maximumFractionDigits: 0 }).format(Math.trunc(n));
}

/** ローカル日付の見出し（ja は 10月22日、en は October 22）。 */
export function formatDayHeading(ms: number, t: T): string {
  return new Intl.DateTimeFormat(locale(t), { month: "long", day: "numeric" }).format(ms);
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
