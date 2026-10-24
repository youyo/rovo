import { stripAnsi } from "./text";

/**
 * ワーカー由来の文字列を、ダッシュボードに出す前に整える共通の関数（docs/specs/dashboard.md D14）。
 * agent（出力時）と gateway（取り込み時）が同じ関数を使い、どちらかが壊れていても漏らさない二重の防御にする。
 * workerd でも Node でも動くよう、Node 固有の API は使わない。
 */

// 改行・タブ以外の C0、DEL、C1、双方向の制御（U+202A-202E, U+2066-2069）、U+200E/F（方向マーク）
// biome-ignore lint/suspicious/noControlCharactersInRegex: 制御文字の除去が目的
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F‎‏‪-‮⁦-⁩]/g;

/** ANSI・制御文字・双方向の制御を除く。singleLine なら改行とタブも空白 1 つにする。 */
export function sanitizeText(text: string, opts: { singleLine?: boolean } = {}): string {
  const clean = stripAnsi(text).replace(CONTROL_RE, "");
  return opts.singleLine === true ? clean.replace(/[\r\n\t]+/g, " ") : clean;
}

const MARK = "…";
const LONE_SURROGATE_HEAD = /^[\uDC00-\uDFFF]/;
const LONE_SURROGATE_TAIL = /[\uD800-\uDBFF]$/;

/** 書記素に分けて、UTF-16 の長さが budget に収まる先頭の並びを返す。 */
function takeHead(text: string, budget: number): string {
  if (budget <= 0) return "";
  // 書記素の分割は重いので、予算の周辺だけを対象にする
  const slice = text.slice(0, budget + 32);
  let out = "";
  for (const g of segments(slice)) {
    if (out.length + g.length > budget) break;
    out += g;
  }
  return out.replace(LONE_SURROGATE_TAIL, "");
}

function takeTail(text: string, budget: number): string {
  if (budget <= 0) return "";
  const slice = text.slice(Math.max(0, text.length - budget - 32));
  const parts = [...segments(slice)];
  let out = "";
  for (let i = parts.length - 1; i >= 0; i--) {
    const g = parts[i] as string;
    if (out.length + g.length > budget) break;
    out = g + out;
  }
  return out.replace(LONE_SURROGATE_HEAD, "");
}

function segments(text: string): string[] {
  if (typeof Intl !== "undefined" && "Segmenter" in Intl) {
    return Array.from(
      new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text),
      (s) => s.segment,
    );
  }
  return Array.from(text);
}

/** 先頭を残して、上限（UTF-16 の長さ。… を含む）に収める。 */
export function truncateEnd(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${takeHead(text, max - MARK.length)}${MARK}`;
}

/** 末尾を残して、上限（UTF-16 の長さ。… を含む）に収める。 */
export function truncateStart(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${MARK}${takeTail(text, max - MARK.length)}`;
}

/** 先頭と末尾を残して、上限（UTF-16 の長さ。… を含む）に収める。 */
export function truncateMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  const room = max - MARK.length;
  const head = Math.ceil(room * 0.6);
  return `${takeHead(text, head)}${MARK}${takeTail(text, room - head)}`;
}

/** パスの上限（契約の LIMITS.path と同じ） */
const MAX_PATH = 300;

/**
 * パスに入れさせない文字: 制御文字・バックスラッシュ・双方向の制御（U+061C, U+200E/F, U+202A-202E, U+2066-2069）・
 * ゼロ幅（U+200B-200D, U+FEFF）。整形で文字そのものに置き換わらないよう、文字列のエスケープから作る。
 */
const UNSAFE_PATH_CHARS =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 制御文字の拒否が目的
  /[\u0000-\u001F\u007F-\u009F\\\u061C\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/;

/**
 * ワークスペースからの相対パスにする。ワークスペースの外・`..`・NUL・制御文字・バックスラッシュ・空・長すぎるものは undefined。
 * 入力は root 配下の絶対パスか、相対パス。ワークスペース自身は "."。
 */
export function workspaceRelativePath(root: string, input: string): string | undefined {
  if (typeof input !== "string" || input === "" || input.length > MAX_PATH + root.length) {
    return undefined;
  }
  if (UNSAFE_PATH_CHARS.test(input) || /^[A-Za-z]:/.test(input)) return undefined;
  if (input.split("/").includes("..")) return undefined;
  const base = root.endsWith("/") ? root.slice(0, -1) : root;
  let rel: string;
  if (input.startsWith("/")) {
    if (input !== base && !input.startsWith(`${base}/`)) return undefined;
    rel = input.slice(base.length);
  } else {
    rel = input;
  }
  const parts = rel.split("/").filter((p) => p !== "" && p !== ".");
  const out = parts.length === 0 ? "." : parts.join("/");
  return out.length <= MAX_PATH ? out : undefined;
}
