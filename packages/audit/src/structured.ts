import { maskSecrets } from "./redact";
import {
  sanitizeText,
  truncateEnd,
  truncateMiddle,
  truncateStart,
  workspaceRelativePath,
} from "./sanitize";

/**
 * 構造化イベント（command / edit / commit / web。docs/specs/dashboard.md D14）の正規化。
 * agent は積む前に、gateway は取り込み時に、**同じこの関数**を通す。許可リストに無い項目は落とし、
 * 文字列は「ANSI・制御文字の除去 → 秘密のマスク → 上限での切り詰め」の順に整える（切り詰めで秘密が途中で切れて素通りしないように）。
 * 冪等（2 回通しても同じ結果）。差分の本文・URL のパス・クエリは持てない。
 */

/** 型ごとの上限（UTF-16 の長さ）。@rovo/dashboard-contract の LIMITS と同じ値（gateway のテストで一致を確かめる） */
export const STRUCTURED_LIMITS = {
  command: 1_000,
  outputTail: 2_000,
  path: 300,
  commitMessage: 200,
  host: 253,
} as const;

export const STRUCTURED_EVENT_TYPE_NAMES = ["command", "edit", "commit", "web"] as const;

export const EDIT_OPS = ["create", "modify", "delete"] as const;
export const WEB_KINDS = ["search", "fetch", "browse"] as const;

export type StructuredEvent =
  | {
      type: "command";
      command: string;
      cwd?: string;
      exitCode: number | null;
      durationMs?: number;
      outputTail?: string;
    }
  | {
      type: "edit";
      path: string;
      op: (typeof EDIT_OPS)[number];
      added: number;
      removed: number;
    }
  | { type: "commit"; message: string; sha: string; files: number }
  | { type: "web"; kind: (typeof WEB_KINDS)[number]; host?: string };

const SHA_RE = /^[0-9a-f]{40}$/;
const HOST_RE = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,62})\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,62})$/;

function record(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

/** 0 以上の整数。壊れた値は fallback */
function count(v: unknown, fallback: number): number;
function count(v: unknown, fallback: undefined): number | undefined;
function count(v: unknown, fallback: number | undefined): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= 0
    ? Math.min(Math.floor(v), Number.MAX_SAFE_INTEGER)
    : fallback;
}

/** 整形 → マスク（切り詰めはしない） */
function clean(text: string, opts: { singleLine?: boolean } = {}): string {
  return maskSecrets(sanitizeText(text, opts));
}

/** URL からホスト名だけを取り出す（パス・クエリ・資格・ポートは捨てる）。ホスト名として不正なら undefined */
export function hostOfUrl(url: unknown): string | undefined {
  if (typeof url !== "string") return undefined;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host.length <= STRUCTURED_LIMITS.host && HOST_RE.test(host) ? host : undefined;
  } catch {
    return undefined;
  }
}

/** 相対パス（ワークスペースの外・.. ・絶対パス・制御文字は undefined）。秘密らしい断片は伏せる */
export function relPath(v: unknown): string | undefined {
  if (typeof v !== "string" || v.startsWith("/")) return undefined;
  const p = workspaceRelativePath("/", v);
  if (p === undefined) return undefined;
  const masked = maskSecrets(p);
  return masked.length <= STRUCTURED_LIMITS.path ? masked : undefined;
}

function normalizeCommand(d: Record<string, unknown>): StructuredEvent | undefined {
  if (typeof d.command !== "string") return undefined;
  const command = clean(d.command).trim();
  if (command === "") return undefined;
  const cwd = relPath(d.cwd);
  const durationMs = count(d.durationMs, undefined);
  const outputTail =
    typeof d.outputTail === "string" && d.outputTail !== ""
      ? truncateStart(clean(d.outputTail), STRUCTURED_LIMITS.outputTail)
      : undefined;
  return {
    type: "command",
    command: truncateMiddle(command, STRUCTURED_LIMITS.command),
    ...(cwd !== undefined && cwd !== "." ? { cwd } : {}),
    exitCode: typeof d.exitCode === "number" && Number.isInteger(d.exitCode) ? d.exitCode : null,
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(outputTail !== undefined ? { outputTail } : {}),
  };
}

function normalizeEdit(d: Record<string, unknown>): StructuredEvent | undefined {
  const path = relPath(d.path);
  if (path === undefined || path === ".") return undefined;
  const op = (EDIT_OPS as readonly unknown[]).includes(d.op)
    ? (d.op as (typeof EDIT_OPS)[number])
    : undefined;
  if (op === undefined) return undefined;
  return { type: "edit", path, op, added: count(d.added, 0), removed: count(d.removed, 0) };
}

function normalizeCommit(d: Record<string, unknown>): StructuredEvent | undefined {
  if (typeof d.message !== "string" || typeof d.sha !== "string" || !SHA_RE.test(d.sha)) {
    return undefined;
  }
  // 1 行目（先頭の空行は飛ばす）だけ。本文は送らない
  const first = clean(d.message, { singleLine: false })
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l !== "");
  if (first === undefined) return undefined;
  return {
    type: "commit",
    message: truncateEnd(first, STRUCTURED_LIMITS.commitMessage),
    sha: d.sha,
    files: count(d.files, 0),
  };
}

function normalizeWeb(d: Record<string, unknown>): StructuredEvent | undefined {
  const kind = (WEB_KINDS as readonly unknown[]).includes(d.kind)
    ? (d.kind as (typeof WEB_KINDS)[number])
    : undefined;
  if (kind === undefined) return undefined;
  const host =
    typeof d.host === "string" && d.host.length <= STRUCTURED_LIMITS.host && HOST_RE.test(d.host)
      ? d.host.toLowerCase()
      : undefined;
  return { type: "web", kind, ...(host !== undefined ? { host } : {}) };
}

/** 型名と素のデータから、許可した項目だけの構造化イベントを作る。型が未知・必須の項目が不正なら undefined */
export function normalizeStructuredEvent(type: string, data: unknown): StructuredEvent | undefined {
  const d = record(data);
  if (d === undefined) return undefined;
  switch (type) {
    case "command":
      return normalizeCommand(d);
    case "edit":
      return normalizeEdit(d);
    case "commit":
      return normalizeCommit(d);
    case "web":
      return normalizeWeb(d);
    default:
      return undefined;
  }
}
