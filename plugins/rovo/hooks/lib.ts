import type { ThemeKey } from "claude-code";

import type { RovoTask } from "../types";

export const MAX_TASKS = 10;
export const KEEP_AFTER_TERMINAL_MS = 60 * 60 * 1000;
export const TAIL_LINES = 30;
const MAX_LINE = 300;
const MAX_TITLE = 120;

/** PR へのリンク。number は task_status の URL から取れなかったとき null（「PR」とだけ出す）。 */
export type PrLink = { number: number | null; url: string };

export type ParsedConsole = {
  status: string;
  phase: string | null;
  stoppedPhase: string | null;
  nowText: string | null;
  command: string | null;
  tail: string | null;
  isRunning: boolean;
  dashboardUrl?: string;
  pr?: PrLink;
  /** 予算の延長の承認待ちのときだけ。 */
  awaiting?: Awaiting;
};

export type Awaiting = "budget_extension";

/** 未知の値は信用せず、"budget_extension" の完全一致だけを通す。INPUT_REQUIRED のときだけ意味がある。 */
const parseAwaiting = (status: string, value: unknown): Awaiting | undefined =>
  status === "INPUT_REQUIRED" && value === "budget_extension" ? "budget_extension" : undefined;

export const CONSOLE_RETRY_MS = 60_000;

const TERMINAL = new Set(["COMPLETED", "FAILED", "BUDGET_EXCEEDED", "CANCELLED"]);

export const isTerminal = (status: string): boolean => TERMINAL.has(status);

/** `https://` で始まるものだけを通す。リンクにしてよい唯一の文字列。 */
export const httpsOnly = (url: unknown): string | undefined =>
  typeof url === "string" && url.startsWith("https://") && !/[\s\u0000-\u001f\u007f]/.test(url)
    ? url
    : undefined;

/**
 * 子が書いた文字列の表示用の整え方。囲み（UNTRUSTED_CHILD_QUESTION）を外し、
 * 端末を動かす制御列（ANSI・OSC）と、向きを偽装する文字を落とす。Markdown には触らない
 * （描くときにプレーンな Text に入れるので、そのまま文字として出る）。
 */
export const stripFence = (s: string): string =>
  s
    .replace(/<<<UNTRUSTED_CHILD_QUESTION[^\n]*(?:\n|$)/g, "")
    .replace(/\n?<<<END_UNTRUSTED_CHILD_QUESTION>>>/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, "");

const asObject = (text: string): Record<string, unknown> | null => {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

const plain = (value: unknown): string | null =>
  typeof value === "string" ? stripFence(value) : null;

/** `mcp__<server>__<prefix>task_start` を見分ける。prefix は空か `my-rovo_` のようなもの。 */
export const matchTaskStart = (tool: string): { server: string; prefix: string } | null => {
  if (!tool.startsWith("mcp__")) return null;
  const parts = tool.split("__");
  if (parts.length < 3) return null;
  const name = parts[parts.length - 1] ?? "";
  const hit = /^((?:[A-Za-z0-9-]+_)*)task_start$/.exec(name);
  const server = parts.slice(1, -1).join("__");
  if (hit === null || server === "") return null;
  return { server, prefix: hit[1] ?? "" };
};

export const parseStartResult = (
  text: string,
): { taskId: string; status?: string; dashboardUrl?: string } | null => {
  const body = asObject(text);
  if (body === null || typeof body.task_id !== "string" || body.task_id === "") return null;
  const dashboardUrl = httpsOnly(body.dashboard_url);
  const status = plain(body.status) ?? undefined;
  return {
    taskId: stripFence(body.task_id),
    ...(status !== undefined && status !== "" ? { status } : {}),
    ...(dashboardUrl !== undefined ? { dashboardUrl } : {}),
  };
};

/** task_console の `pr`。{ number: 数値, url: https } だけを通す。 */
const parsePr = (value: unknown): PrLink | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const { number, url } = value as Record<string, unknown>;
  const safe = httpsOnly(url);
  if (safe === undefined || typeof number !== "number" || !Number.isInteger(number) || number < 1)
    return undefined;
  return { number, url: safe };
};

/** task_status の draft_pr_url から。番号は URL 末尾の /pull/<n>、取れなければ null。 */
const prFromUrl = (value: unknown): PrLink | undefined => {
  const url = httpsOnly(value);
  if (url === undefined) return undefined;
  const hit = /\/pull\/(\d+)\/?(?:[?#].*)?$/.exec(url);
  const n = hit === null ? NaN : Number(hit[1]);
  return { number: Number.isSafeInteger(n) && n > 0 ? n : null, url };
};

export const parseConsole = (text: string): ParsedConsole | null => {
  const body = asObject(text);
  if (body === null || typeof body.status !== "string") return null;
  const now = body.now as { text?: unknown } | null | undefined;
  const output = body.output as
    | { command?: unknown; tail?: unknown; running?: unknown }
    | null
    | undefined;
  const dashboardUrl = httpsOnly(body.dashboard_url);
  const pr = parsePr(body.pr);
  const awaiting = parseAwaiting(body.status, body.awaiting);
  return {
    status: stripFence(body.status),
    phase: plain(body.phase),
    stoppedPhase: plain(body.stopped_phase),
    nowText: plain(now?.text),
    command: plain(output?.command),
    tail: plain(output?.tail),
    isRunning: output?.running === true,
    ...(dashboardUrl !== undefined ? { dashboardUrl } : {}),
    ...(pr !== undefined ? { pr } : {}),
    ...(awaiting !== undefined ? { awaiting } : {}),
  };
};

export const parseStatus = (
  text: string,
): { status: string; dashboardUrl?: string; pr?: PrLink; awaiting?: Awaiting } | null => {
  const body = asObject(text);
  if (body === null || typeof body.status !== "string") return null;
  const dashboardUrl = httpsOnly(body.dashboard_url);
  const pr = prFromUrl(body.draft_pr_url);
  const question = body.pending_question as { kind?: unknown } | null | undefined;
  const awaiting = parseAwaiting(body.status, question?.kind);
  return {
    status: stripFence(body.status),
    ...(awaiting !== undefined ? { awaiting } : {}),
    ...(dashboardUrl !== undefined ? { dashboardUrl } : {}),
    ...(pr !== undefined ? { pr } : {}),
  };
};

const cut = (line: string): string =>
  line.length > MAX_LINE ? `${line.slice(0, MAX_LINE)}…` : line;

/** 末尾の n 行。長い行は切る。 */
export const tailLines = (s: string, n: number = TAIL_LINES): string =>
  s.replace(/\n+$/, "").split("\n").slice(-n).map(cut).join("\n");

/** 出力の末尾が前の取得から何行分前へずれたか（古い行が落ちた数）。重なりが無ければ 0。 */
export const slideShift = (before: readonly string[], after: readonly string[]): number => {
  for (let k = 0; k < before.length; k++) {
    const rest = before.slice(k);
    if (rest.length <= after.length && rest.every((line, i) => line === after[i])) return k;
  }
  return 0;
};

export const formatElapsed = (ms: number): string => {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}秒`;
  const minutes = Math.floor(total / 60);
  if (total < 3600) return `${minutes}分${total % 60}秒`;
  return `${Math.floor(minutes / 60)}時間${minutes % 60}分`;
};

/** 状態の色（利用者のテーマのキー）。実行中 suggestion・完了 success・失敗 error・入力待ち warning・止まった inactive。 */
export const statusColor = (status: string): ThemeKey | undefined => {
  switch (status) {
    case "RUNNING":
    case "CREATING":
    case "VERIFYING":
      return "suggestion";
    case "COMPLETED":
      return "success";
    case "FAILED":
      return "error";
    case "INPUT_REQUIRED":
      return "warning";
    case "CANCELLED":
    case "BUDGET_EXCEEDED":
      return "inactive";
    default:
      return undefined;
  }
};

export const glyph = (status: string): string => {
  switch (status) {
    case "COMPLETED":
      return "✓";
    case "FAILED":
    case "BUDGET_EXCEEDED":
      return "✕";
    case "CANCELLED":
      return "–";
    case "INPUT_REQUIRED":
      return "?";
    default:
      return "●";
  }
};

export const statusLabel = (status: string, awaiting?: string): string => {
  if (status === "INPUT_REQUIRED" && awaiting === "budget_extension") return "予算の承認待ち";
  switch (status) {
    case "COMPLETED":
      return "完了";
    case "FAILED":
      return "失敗";
    case "BUDGET_EXCEEDED":
      return "予算超過";
    case "CANCELLED":
      return "取り消し";
    case "INPUT_REQUIRED":
      return "入力待ち";
    case "CREATING":
      return "準備中";
    case "VERIFYING":
      return "検証中";
    case "RUNNING":
      return "実行中";
    default:
      return status;
  }
};

/** トーストの文。 */
export const toastText = (title: string, status: string): string => {
  const what =
    status === "COMPLETED"
      ? "完了"
      : status === "FAILED"
        ? "失敗"
        : status === "BUDGET_EXCEEDED"
          ? "予算超過で停止"
          : status === "CANCELLED"
            ? "取り消し"
            : status;
  return `${title} が${what}`;
};

/** 予算の承認待ちに入ったときのトースト。 */
export const budgetToastText = (title: string): string =>
  `${title} が予算の承認待ち（利用者に確認してから task_answer で答える）`;

export const taskKey = (t: Pick<RovoTask, "server" | "taskId">): string =>
  `${t.server}/${t.taskId}`;

export const cleanTitle = (title: unknown, fallback: string): string => {
  const text = typeof title === "string" ? stripFence(title).replace(/\s+/g, " ").trim() : "";
  return (text === "" ? fallback : text).slice(0, MAX_TITLE);
};

/** 終端から 1 時間たったものを消し、新しい方から 10 件に絞る。 */
export const pruneTasks = (list: RovoTask[], now: number): RovoTask[] =>
  list
    .filter((t) => t.terminalAt === undefined || now - t.terminalAt < KEEP_AFTER_TERMINAL_MS)
    .slice(-MAX_TASKS);

/** $.store から読んだ値を信用せず、形を確かめて作り直す。 */
export const coerceTasks = (value: unknown): RovoTask[] => {
  if (!Array.isArray(value)) return [];
  const out: RovoTask[] = [];
  for (const raw of value) {
    const t = raw as Record<string, unknown> | null;
    if (
      typeof t !== "object" ||
      t === null ||
      typeof t.taskId !== "string" ||
      typeof t.server !== "string" ||
      typeof t.status !== "string" ||
      typeof t.startedAt !== "number"
    ) {
      continue;
    }
    const dashboardUrl = httpsOnly(t.dashboardUrl);
    out.push({
      taskId: t.taskId,
      title: cleanTitle(t.title, t.taskId),
      server: t.server,
      prefix: typeof t.prefix === "string" ? t.prefix : "",
      startedAt: t.startedAt,
      status: stripFence(t.status),
      ...(dashboardUrl !== undefined ? { dashboardUrl } : {}),
      ...(typeof t.terminalAt === "number" ? { terminalAt: t.terminalAt } : {}),
      ...(t.notified === true ? { notified: true } : {}),
      ...(t.noConsole === true ? { noConsole: true } : {}),
      ...(t.awaiting === "budget_extension" ? { awaiting: "budget_extension" as const } : {}),
      ...(typeof t.consoleRetryAt === "number" ? { consoleRetryAt: t.consoleRetryAt } : {}),
    });
  }
  return out;
};
