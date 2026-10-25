import type { ThemeKey } from "claude-code";

import type { RovoLogLine, RovoTask } from "../types";

export const MAX_TASKS = 10;
/** task_list から入ったタスクの上限（task_list の limit の最大と同じ）。 */
export const MAX_LISTED = 50;
export const KEEP_AFTER_TERMINAL_MS = 60 * 60 * 1000;
export const TAIL_LINES = 30;
const MAX_LINE = 300;
const MAX_TITLE = 120;
const MAX_REPO = 100;
const MAX_MODEL = 60;

/** PR へのリンク。number は task_status の URL から取れなかったとき null（「PR」とだけ出す）。 */
export type PrLink = { number: number | null; url: string };

export type ParsedConsole = {
  status: string;
  phase: string | null;
  stoppedPhase: string | null;
  nowText: string | null;
  /** nowText のコマンドの場所（/workspace からの相対）。 */
  nowWhere?: string;
  command: string | null;
  /** command の場所（/workspace からの相対）。 */
  commandWhere?: string;
  tail: string | null;
  isRunning: boolean;
  dashboardUrl?: string;
  pr?: PrLink;
  /** 予算の延長の承認待ちのときだけ。 */
  awaiting?: Awaiting;
  /** `log` を返すサーバーのときだけ（task_console の log_after に対する応答）。 */
  log?: LogPage;
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
 * ワーカーが書いた文字列の表示用の整え方。囲み（UNTRUSTED_CHILD_QUESTION）を外し、
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
): { taskId: string; status?: string; dashboardUrl?: string; model?: string } | null => {
  const body = asObject(text);
  if (body === null || typeof body.task_id !== "string" || body.task_id === "") return null;
  const dashboardUrl = httpsOnly(body.dashboard_url);
  const status = plain(body.status) ?? undefined;
  const model = shortText(body.model, MAX_MODEL);
  return {
    taskId: stripFence(body.task_id),
    ...(model !== undefined ? { model } : {}),
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

const DIR_SEGMENT = /^[\p{L}\p{N}_.@+-]+$/u;
const CD_PREFIX = /^cd\s+(\S+)\s+&&\s+(\S.*)$/;
const WORKSPACE = "/workspace";

/** cd の行き先を /workspace からの相対にする。素直なパスでなければ undefined、/workspace 自身と . は ""。 */
const relativeDir = (path: string): string | undefined => {
  let rest: string;
  if (path === WORKSPACE || path.startsWith(`${WORKSPACE}/`))
    rest = path.slice(WORKSPACE.length + 1);
  else if (/^[/~$-]/.test(path)) return undefined;
  else if (path === ".") return "";
  else rest = path.startsWith("./") ? path.slice(2) : path;
  if (rest === "") return "";
  const parts = rest.split("/");
  if (parts.at(-1) === "") parts.pop();
  for (const p of parts) if (p === "." || p === ".." || !DIR_SEGMENT.test(p)) return undefined;
  return parts.join("/");
};

/**
 * 表示用に、コマンドの先頭の `cd <相対パス> && ` を外して場所に分ける（dashboard の splitCommand と同じ規則）。
 * `cd /workspace && ` と `cd . && ` は前置きだけ外す。.. を含む・/workspace の外・~ や $HOME や -・引用符つきは触らない。
 */
export const splitCommand = (text: string): { command: string; where?: string } => {
  const m = CD_PREFIX.exec(text);
  if (m === null) return { command: text };
  const dir = relativeDir(m[1] as string);
  if (dir === undefined) return { command: text };
  const command = m[2] as string;
  return dir === "" ? { command } : { command, where: dir };
};

/** now.text は `$ ` で始まる形があるので、その後ろに splitCommand を当てる。 */
const splitNow = (text: string | null): { text: string | null; where?: string } => {
  if (text === null || !text.startsWith("$ ")) return { text };
  const c = splitCommand(text.slice(2));
  return { text: `$ ${c.command}`, ...(c.where === undefined ? {} : { where: c.where }) };
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
  const log = parseLog(body.log);
  const now2 = splitNow(plain(now?.text));
  const cmdRaw = plain(output?.command);
  const cmd = cmdRaw === null ? null : splitCommand(cmdRaw);
  return {
    status: stripFence(body.status),
    phase: plain(body.phase),
    stoppedPhase: plain(body.stopped_phase),
    nowText: now2.text,
    ...(now2.where !== undefined ? { nowWhere: now2.where } : {}),
    command: cmd === null ? null : cmd.command,
    ...(cmd?.where !== undefined ? { commandWhere: cmd.where } : {}),
    tail: plain(output?.tail),
    isRunning: output?.running === true,
    ...(dashboardUrl !== undefined ? { dashboardUrl } : {}),
    ...(pr !== undefined ? { pr } : {}),
    ...(awaiting !== undefined ? { awaiting } : {}),
    ...(log !== null ? { log } : {}),
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

// --- 積み上がるログ（task_console の log） -------------------------------------

/** ワーカーごとに持つ行の上限。古い行から捨てる。 */
export const MAX_LOG_LINES = 500;
/** $.store に残す行数（再起動後に続きを見せるぶんだけ）。 */
export const STORED_LOG_LINES = 100;
/** 1 回の取得で追いかけるページ数の上限（1 ページは最大 100 件）。 */
export const MAX_LOG_PAGES = 10;
const MAX_ENTRIES_PER_PAGE = 200;
const MAX_CURSOR = 200;

export type LogLine = RovoLogLine;
export type LogKind = LogLine["kind"];

export type LogPage = { lines: LogLine[]; nextCursor: string; truncated: boolean };

const LOG_KINDS: ReadonlySet<string> = new Set([
  "cmd",
  "out",
  "edit",
  "commit",
  "web",
  "tool",
  "status",
  "pr",
  "error",
]);

/** 構造化イベントを別に出すツール（dashboard の STRUCTURED_OF と同じ）。tool_start は重複するので出さない。 */
const STRUCTURED_TOOLS: ReadonlySet<string> = new Set([
  "bash",
  "write_file",
  "edit_file",
  "git_commit",
  "web_search",
  "web_fetch",
  "web_browse",
]);

const oneLine = (value: unknown, max: number = MAX_LINE): string | undefined => {
  if (typeof value !== "string") return undefined;
  const text = stripFence(value).replace(/\s+/g, " ").trim();
  return text === "" ? undefined : cut(text.slice(0, max * 2));
};

const count = (value: unknown): number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;

const EDIT_LABEL: Record<string, string> = { create: "create", modify: "edit", delete: "delete" };

/**
 * task_console の log.entries の 1 件を、描く行にする（ダッシュボードの流れるコンソールと同じ型）。
 * ワーカーが書いた文字列は囲みを外して整える。知らない型・形が違うものは空。
 */
export const entryLines = (entry: unknown): LogLine[] => {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return [];
  const e = entry as Record<string, unknown>;
  switch (e.type) {
    case "command": {
      const raw = plain(e.command);
      if (raw === null || raw.trim() === "") return [];
      const c = splitCommand(raw.replace(/\s+/g, " ").trim());
      const out: LogLine[] = [
        {
          kind: "cmd",
          text: cut(`$ ${c.command}`),
          ...(c.where !== undefined ? { where: c.where } : {}),
        },
      ];
      const tail = plain(e.output_tail);
      if (tail !== null && tail.trim() !== "") {
        for (const line of tailLines(tail).split("\n")) out.push({ kind: "out", text: line });
      }
      if (typeof e.exit_code === "number" && e.exit_code !== 0) {
        out.push({ kind: "error", text: `✕ exit ${e.exit_code}` });
      }
      return out;
    }
    case "edit": {
      const path = oneLine(e.path);
      if (path === undefined) return [];
      const label = EDIT_LABEL[String(e.op)] ?? "edit";
      return [
        { kind: "edit", text: `✎ ${label} ${path} (+${count(e.added)} -${count(e.removed)})` },
      ];
    }
    case "commit": {
      const message = oneLine(e.message);
      return message === undefined ? [] : [{ kind: "commit", text: `⎇ commit ${message}` }];
    }
    case "web": {
      const kind = e.kind === "search" || e.kind === "fetch" || e.kind === "browse" ? e.kind : null;
      if (kind === null) return [];
      const host = oneLine(e.host, 253);
      const icon = kind === "search" ? "🔍" : "🌐";
      return [{ kind: "web", text: `${icon} ${kind}${host === undefined ? "" : ` ${host}`}` }];
    }
    case "status_changed": {
      const to = oneLine(e.to, 40);
      if (to === undefined) return [];
      const from = oneLine(e.from, 40);
      const text =
        from === undefined ? statusLabel(to) : `${statusLabel(from)} → ${statusLabel(to)}`;
      return [{ kind: "status", text: `· ${text}` }];
    }
    case "draft_pr_created": {
      const n = e.pr_number;
      return typeof n === "number" && Number.isInteger(n) && n >= 1
        ? [{ kind: "pr", text: `⎇ Draft PR #${n}` }]
        : [];
    }
    case "tool_start": {
      const name = oneLine(e.name, 100);
      if (name === undefined || STRUCTURED_TOOLS.has(name)) return [];
      const summary = oneLine(e.summary);
      return [{ kind: "tool", text: `· ${name}${summary === undefined ? "" : ` ${summary}`}` }];
    }
    case "tool_end": {
      if (e.is_error !== true) return [];
      const summary = oneLine(e.summary);
      return [{ kind: "error", text: `✕ ${summary ?? "失敗"}` }];
    }
    default:
      return [];
  }
};

/** task_console の `log`。entries と next_cursor（文字列）が無ければ null（log の無いサーバー）。 */
export const parseLog = (value: unknown): LogPage | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v.entries)) return null;
  if (
    typeof v.next_cursor !== "string" ||
    v.next_cursor === "" ||
    v.next_cursor.length > MAX_CURSOR
  )
    return null;
  const lines: LogLine[] = [];
  for (const entry of (v.entries as unknown[]).slice(0, MAX_ENTRIES_PER_PAGE)) {
    lines.push(...entryLines(entry));
  }
  return { lines, nextCursor: v.next_cursor, truncated: v.truncated === true };
};

/** 行を末尾に足し、上限を超えた古い行を捨てる。dropped は先頭から捨てた行数（窓の位置を直すのに使う）。 */
export const appendLines = (
  buffer: readonly LogLine[],
  add: readonly LogLine[],
  max: number = MAX_LOG_LINES,
): { lines: LogLine[]; dropped: number } => {
  const all = [...buffer, ...add];
  const dropped = Math.max(0, all.length - max);
  return { lines: dropped === 0 ? all : all.slice(dropped), dropped };
};

export type WorkerLog = { cursor: string; lines: LogLine[] };

const coerceLine = (raw: unknown): LogLine | null => {
  if (typeof raw !== "object" || raw === null) return null;
  const l = raw as Record<string, unknown>;
  if (typeof l.kind !== "string" || !LOG_KINDS.has(l.kind) || typeof l.text !== "string")
    return null;
  const text = cut(stripFence(l.text));
  const where = typeof l.where === "string" ? stripFence(l.where).slice(0, MAX_TITLE) : undefined;
  return {
    kind: l.kind as LogKind,
    text,
    ...(where !== undefined && where !== "" ? { where } : {}),
  };
};

/** $.store から読んだログを信用せず、形を確かめて作り直す。 */
export const coerceLogs = (value: unknown): Record<string, WorkerLog> => {
  const out: Record<string, WorkerLog> = {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) return out;
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const w = raw as Record<string, unknown> | null;
    if (typeof w !== "object" || w === null) continue;
    if (typeof w.cursor !== "string" || w.cursor === "" || w.cursor.length > MAX_CURSOR) continue;
    const lines: LogLine[] = [];
    if (Array.isArray(w.lines)) {
      for (const l of w.lines.slice(-STORED_LOG_LINES)) {
        const line = coerceLine(l);
        if (line !== null) lines.push(line);
      }
    }
    out[key] = { cursor: w.cursor, lines };
  }
  return out;
};

/** ログの行の色。undefined は本文の色、dim は薄く。 */
export const logStyle = (kind: LogKind): { color?: ThemeKey; dim?: boolean; bold?: boolean } => {
  switch (kind) {
    case "cmd":
      return { bold: true };
    case "edit":
    case "web":
    case "pr":
      return { color: "suggestion" };
    case "commit":
      return { color: "success" };
    case "error":
      return { color: "error" };
    case "status":
    case "tool":
      return { dim: true };
    default:
      return {};
  }
};

// --- 列の幅 ---------------------------------------------------------------------------

/** `anthropic/claude-sonnet-5-5` → `sonnet-5.5`。provider/ と claude- を落とし、末尾の -N-N を -N.N に。 */
export const shortModel = (model: string): string =>
  model
    .replace(/^.*\//, "")
    .replace(/^claude-/, "")
    .replace(/-(\d{1,2})-(\d{1,2})$/, "-$1.$2");

/** `owner/name` → `name`。 */
export const repoName = (repository: string | undefined): string =>
  (repository ?? "").split("/").pop() ?? "";

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

/** 質問への答え待ち。INPUT_REQUIRED か、終端でない間の waiting_for_answer。 */
export const isWaiting = (t: { status: string; waiting?: boolean }): boolean =>
  t.status === "INPUT_REQUIRED" || (t.waiting === true && !isTerminal(t.status));

export const taskKey = (t: Pick<RovoTask, "server" | "taskId">): string =>
  `${t.server}/${t.taskId}`;

export const cleanTitle = (title: unknown, fallback: string): string => {
  const text = typeof title === "string" ? stripFence(title).replace(/\s+/g, " ").trim() : "";
  return (text === "" ? fallback : text).slice(0, MAX_TITLE);
};

/** 終端から 1 時間たったものを消す。task_start で拾ったものは新しい方から 10 件、task_list から入ったものは 50 件に絞る。 */
export const pruneTasks = (list: RovoTask[], now: number): RovoTask[] => {
  const live = list.filter(
    (t) => t.terminalAt === undefined || now - t.terminalAt < KEEP_AFTER_TERMINAL_MS,
  );
  const keep = new Set<RovoTask>([
    ...live.filter((t) => t.listed !== true).slice(-MAX_TASKS),
    ...live.filter((t) => t.listed === true).slice(-MAX_LISTED),
  ]);
  return live.filter((t) => keep.has(t));
};

const asCount = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 99
    ? value
    : undefined;

/** PrLink（number は null もある）。url は https のみ。 */
const asPrLink = (value: unknown): PrLink | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const { number, url } = value as Record<string, unknown>;
  const safe = httpsOnly(url);
  if (safe === undefined) return undefined;
  if (number === null) return { number: null, url: safe };
  return typeof number === "number" && Number.isInteger(number) && number >= 1
    ? { number, url: safe }
    : undefined;
};

export const shortText = (value: unknown, max: number): string | undefined => {
  if (typeof value !== "string") return undefined;
  const text = stripFence(value).replace(/\s+/g, " ").trim().slice(0, max);
  return text === "" ? undefined : text;
};

export type TaskKind = "task" | "review";

/** task_list の stage。駅の並びと同じ順で、最後の done は全部済んだ印。 */
const STAGES: Record<TaskKind, readonly string[]> = {
  task: ["setup", "work", "verify", "pr", "done"],
  review: ["fetch", "investigate", "post", "done"],
};

const asStage = (kind: TaskKind, value: unknown): string | undefined =>
  typeof value === "string" && STAGES[kind].includes(value) ? value : undefined;

/** task_list 由来のフィールドを、形を確かめて取り出す（$.store の値も同じ規則で通す）。 */
const coerceListed = (t: Record<string, unknown>): Partial<RovoTask> => {
  const kind: TaskKind | undefined = t.kind === "task" || t.kind === "review" ? t.kind : undefined;
  const repository = shortText(t.repository, MAX_REPO);
  const model = shortText(t.model, MAX_MODEL);
  const stage = kind === undefined ? undefined : asStage(kind, t.stage);
  const verifyAttempt = asCount(t.verifyAttempt);
  const verifyMax = asCount(t.verifyMax);
  const pr = asPrLink(t.pr);
  return {
    ...(kind !== undefined ? { kind } : {}),
    ...(repository !== undefined ? { repository } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(stage !== undefined ? { stage } : {}),
    ...(verifyAttempt !== undefined ? { verifyAttempt } : {}),
    ...(verifyMax !== undefined ? { verifyMax } : {}),
    ...(t.waiting === true ? { waiting: true } : {}),
    ...(t.listed === true ? { listed: true } : {}),
    ...(pr !== undefined ? { pr } : {}),
  };
};

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
      ...coerceListed(t),
    });
  }
  return out;
};

// --- パイプラインの列（lanes） ------------------------------------------------

/** 駅の名前（列の下の行に出す）。 */
export const STATIONS: Record<TaskKind, readonly string[]> = {
  task: ["準備", "実行", "検証", "PR"],
  review: ["取出", "調査", "投稿"],
};

/** task_console の phase（task_list が無いサーバー）を task の stage に読み替える。 */
const PHASE_TO_STAGE: Record<string, string> = {
  prepare: "setup",
  run: "work",
  verify: "verify",
  done: "done",
};

/**
 * いまの駅の番号。済んだ印（done）は駅の数と同じ値。stage が無い・知らない・別の kind のものは null。
 * kind が task のときは console の phase（prepare|run|verify|done）も読む。
 */
export const stageIndex = (kind: TaskKind, stage: string | null | undefined): number | null => {
  if (typeof stage !== "string") return null;
  const names = STAGES[kind];
  const direct = names.indexOf(stage);
  if (direct >= 0) return direct;
  const mapped = kind === "task" ? PHASE_TO_STAGE[stage] : undefined;
  const at = mapped === undefined ? -1 : names.indexOf(mapped);
  return at >= 0 ? at : null;
};

const isWide = (cp: number): boolean =>
  (cp >= 0x1100 && cp <= 0x115f) ||
  (cp >= 0x2e80 && cp <= 0xa4cf) ||
  (cp >= 0xac00 && cp <= 0xd7a3) ||
  (cp >= 0xf900 && cp <= 0xfaff) ||
  (cp >= 0xfe30 && cp <= 0xfe6f) ||
  (cp >= 0xff00 && cp <= 0xff60) ||
  (cp >= 0xffe0 && cp <= 0xffe6) ||
  (cp >= 0x1f300 && cp <= 0x1faff) ||
  (cp >= 0x20000 && cp <= 0x3fffd);

/** 端末での表示幅。全角（日本語など）は 2 桁、それ以外は 1 桁。 */
export const displayWidth = (s: string): number => {
  let w = 0;
  for (const ch of s) w += isWide(ch.codePointAt(0) ?? 0) ? 2 : 1;
  return w;
};

export const padWidth = (s: string, width: number): string =>
  s + " ".repeat(Math.max(0, width - displayWidth(s)));

/** 表示幅が width 以下になるよう切り、切ったら末尾に … を付ける。 */
export const truncateWidth = (s: string, width: number): string => {
  if (displayWidth(s) <= width) return s;
  let out = "";
  let w = 0;
  for (const ch of s) {
    const cw = isWide(ch.codePointAt(0) ?? 0) ? 2 : 1;
    if (w + cw > width - 1) break;
    out += ch;
    w += cw;
  }
  return `${out}…`;
};

/** 線路 1 区間の長さ。1 駅ぶんの幅は駅 1 + 線路 SEG。名前の行もこの幅で並べる。 */
const SEG = 4;
const COLUMN = SEG + 1;

/** 列の下の行（駅の名前）。 */
export const labelRow = (kind: TaskKind): string =>
  STATIONS[kind].map((name) => padWidth(name, COLUMN)).join("");

export type Cell = { text: string; color?: ThemeKey; bold?: boolean };

export type LaneState = "active" | "waiting" | "done" | "failed";

const SPINNER = "◐◓◑◒";

/** 同じ色が続く文字をまとめて 1 つの Cell にする。 */
const runs = (parts: { text: string; color?: ThemeKey }[]): Cell[] => {
  const out: Cell[] = [];
  for (const p of parts) {
    const last = out[out.length - 1];
    if (last !== undefined && last.color === p.color) last.text += p.text;
    else out.push({ text: p.text, ...(p.color !== undefined ? { color: p.color } : {}) });
  }
  return out;
};

/**
 * 駅と線路 1 行ぶん。済んだ駅は ●━━、いまの駅はスピナー（着いた直後は白い ◉）、
 * その先の線路に ▶ の光が frame ごとに 1 つ進む。質問待ちは流れを止めて ? を点滅。
 * at は いまの駅の番号（駅の数と同じなら全部済み）。null は分からない（全部これから）。
 */
export const laneCells = (opts: {
  kind: TaskKind;
  at: number | null;
  state: LaneState;
  frame: number;
  arrived: boolean;
}): Cell[] => {
  const n = STATIONS[opts.kind].length;
  const { state, frame } = opts;
  const at = state === "done" ? n : opts.at === null ? -1 : Math.min(opts.at, n);
  const cells: Cell[] = [];
  for (let j = 0; j < n; j++) {
    if (j < at) cells.push({ text: "●", color: "success" });
    else if (j === at && state === "waiting") {
      cells.push(frame % 2 === 0 ? { text: "?", color: "warning" } : { text: " " });
    } else if (j === at && state === "failed") cells.push({ text: "✕", color: "error" });
    else if (j === at && opts.arrived) cells.push({ text: "◉", color: "text", bold: true });
    else if (j === at) {
      cells.push({ text: SPINNER[frame % SPINNER.length] ?? "◐", color: "suggestion" });
    } else cells.push({ text: "○", color: "subtle" });
    if (j === n - 1) break;
    if (j < at) cells.push({ text: "━".repeat(SEG), color: "success" });
    else if (j === at && state === "active") {
      const p = frame % (SEG + 2);
      const bar: { text: string; color?: ThemeKey }[] = [];
      for (let k = 0; k < SEG; k++) {
        if (k === p) bar.push({ text: "▶", color: "claude" });
        else if (k === p - 1) bar.push({ text: "━", color: "suggestion" });
        else bar.push({ text: "┈", color: "subtle" });
      }
      cells.push(...runs(bar));
    } else cells.push({ text: "┈".repeat(SEG), color: "subtle" });
  }
  return cells;
};

export type HeadingTone = "warning" | "suggestion" | "success";
export type HeadingPart = { label: string; n: number; tone: HeadingTone };

/**
 * ペインの見出しの部品。質問待ちが 1 件以上のときだけ先頭に出し、そのあと作業中（質問待ちでない実行中）・完了。
 * 0 の項目は残す（位置を動かさない）。費用は出さない。
 */
export const headingText = (tasks: readonly RovoTask[]): HeadingPart[] => {
  let run = 0;
  let wait = 0;
  let done = 0;
  for (const t of tasks) {
    if (t.status === "COMPLETED") done++;
    else if (isTerminal(t.status)) continue;
    else if (isWaiting(t)) wait++;
    else run++;
  }
  return [
    ...(wait > 0 ? [{ label: "質問待ち", n: wait, tone: "warning" as const }] : []),
    { label: "作業中", n: run, tone: "suggestion" as const },
    { label: "完了", n: done, tone: "success" as const },
  ];
};

const MAX_RIGHT = 40;

/** 列の右に出す文字。実行中はいまの道具と対象、終われば結果、質問待ちはその旨。 */
export const rightText = (
  t: RovoTask,
  nowText: string | null,
  pr?: PrLink,
): { text: string; color?: ThemeKey } => {
  if (isTerminal(t.status)) {
    const link = pr ?? t.pr;
    const text =
      t.status === "COMPLETED"
        ? link === undefined
          ? "✓ 完了"
          : link.number === null
            ? "✓ PR"
            : `✓ PR #${link.number}`
        : `${glyph(t.status)} ${statusLabel(t.status)}`;
    const color = statusColor(t.status);
    return { text: truncateWidth(text, MAX_RIGHT), ...(color !== undefined ? { color } : {}) };
  }
  if (isWaiting(t)) {
    const label = statusLabel(
      "INPUT_REQUIRED",
      t.status === "INPUT_REQUIRED" ? t.awaiting : undefined,
    );
    return { text: truncateWidth(label, MAX_RIGHT), color: "warning" };
  }
  const attempt =
    t.stage === "verify" && t.verifyAttempt !== undefined
      ? `[${t.verifyAttempt}${t.verifyMax !== undefined ? `/${t.verifyMax}` : ""}]`
      : "";
  const text = [attempt, nowText ?? ""].filter((x) => x !== "").join(" ");
  return { text: truncateWidth(text, MAX_RIGHT) };
};

// --- task_list ----------------------------------------------------------------

/** task_list の 1 件（整えたもの）。 */
export type ListedTask = {
  taskId: string;
  kind: TaskKind;
  title: string;
  repository?: string;
  status: string;
  stage?: string;
  verifyAttempt?: number;
  verifyMax?: number;
  waiting: boolean;
  model?: string;
  createdAt?: number;
  updatedAt?: number;
  endedAt?: number;
  pr?: PrLink;
  dashboardUrl?: string;
};

const asTime = (value: unknown): number | undefined => {
  if (typeof value !== "string") return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
};

/**
 * task_list の結果。形が違うもの（task_list が無いサーバーのエラーなど）は null。
 * 1 件ずつ形を確かめ、task_id か status が無い行は落とす。ワーカーが書いた文字列は整える。
 */
export const parseTaskList = (text: string): { tasks: ListedTask[]; truncated: boolean } | null => {
  const body = asObject(text);
  if (body === null || !Array.isArray(body.tasks)) return null;
  const tasks: ListedTask[] = [];
  for (const raw of body.tasks as unknown[]) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue;
    const r = raw as Record<string, unknown>;
    if (typeof r.task_id !== "string" || r.task_id === "" || typeof r.status !== "string") continue;
    const taskId = stripFence(r.task_id);
    const kind: TaskKind = r.kind === "review" ? "review" : "task";
    const repository = shortText(r.repository, MAX_REPO);
    const model = shortText(r.model, MAX_MODEL);
    const stage = asStage(kind, r.stage);
    const verifyAttempt = asCount(r.verify_attempt);
    const verifyMax = asCount(r.verify_max);
    const createdAt = asTime(r.created_at);
    const updatedAt = asTime(r.updated_at);
    const endedAt = asTime(r.ended_at);
    const pr = asPrLink(r.pr);
    const dashboardUrl = httpsOnly(r.dashboard_url);
    tasks.push({
      taskId,
      kind,
      title: cleanTitle(r.title, taskId),
      ...(repository !== undefined ? { repository } : {}),
      status: stripFence(r.status),
      ...(stage !== undefined ? { stage } : {}),
      ...(verifyAttempt !== undefined ? { verifyAttempt } : {}),
      ...(verifyMax !== undefined ? { verifyMax } : {}),
      waiting: r.waiting_for_answer === true,
      ...(model !== undefined ? { model } : {}),
      ...(createdAt !== undefined ? { createdAt } : {}),
      ...(updatedAt !== undefined ? { updatedAt } : {}),
      ...(endedAt !== undefined ? { endedAt } : {}),
      ...(pr !== undefined ? { pr } : {}),
      ...(dashboardUrl !== undefined ? { dashboardUrl } : {}),
    });
  }
  return { tasks, truncated: body.truncated === true };
};

/**
 * task_list の結果を追跡リストに混ぜる。新しいものは足し、知っているものは状態を更新する
 * （startedAt と task_start で付けた印は保つ）。すでに終わっていたものは通知済みにして、トーストを出さない。
 * 終端に変わったことを知らせる（トースト・notified）のは呼ぶ側。開始時刻の古い順に並べる。
 */
export const mergeListed = (
  existing: RovoTask[],
  listed: readonly ListedTask[],
  endpoint: { server: string; prefix: string },
  now: number,
): RovoTask[] => {
  const out = [...existing];
  for (const l of listed) {
    const key = taskKey({ server: endpoint.server, taskId: l.taskId });
    const at = out.findIndex((x) => taskKey(x) === key);
    const prev = at >= 0 ? out[at] : undefined;
    const terminal = isTerminal(l.status);
    const fields: Partial<RovoTask> = {
      kind: l.kind,
      ...(l.repository !== undefined ? { repository: l.repository } : {}),
      ...(l.model !== undefined ? { model: l.model } : {}),
      ...(l.stage !== undefined ? { stage: l.stage } : {}),
      ...(l.verifyAttempt !== undefined ? { verifyAttempt: l.verifyAttempt } : {}),
      ...(l.verifyMax !== undefined ? { verifyMax: l.verifyMax } : {}),
      ...(l.waiting ? { waiting: true as const } : {}),
      ...(l.pr !== undefined ? { pr: l.pr } : {}),
    };
    const dashboardUrl = l.dashboardUrl ?? prev?.dashboardUrl;
    if (prev === undefined) {
      out.push({
        taskId: l.taskId,
        title: l.title,
        server: endpoint.server,
        prefix: endpoint.prefix,
        startedAt: l.createdAt ?? now,
        status: l.status,
        ...(dashboardUrl !== undefined ? { dashboardUrl } : {}),
        ...fields,
        listed: true,
        ...(terminal
          ? { terminalAt: l.endedAt ?? l.updatedAt ?? now, notified: true as const }
          : {}),
      });
      continue;
    }
    // list が毎回言い直すフィールドは、前の値を捨ててから入れ直す。
    const {
      stage: _stage,
      verifyAttempt: _attempt,
      verifyMax: _max,
      waiting: _waiting,
      pr: _pr,
      awaiting: _awaiting,
      ...rest
    } = prev;
    const becameTerminal = !isTerminal(prev.status) && terminal;
    out[at] = {
      ...rest,
      title: l.title,
      status: l.status,
      ...(l.status === "INPUT_REQUIRED" && prev.awaiting !== undefined
        ? { awaiting: prev.awaiting }
        : {}),
      ...(dashboardUrl !== undefined ? { dashboardUrl } : {}),
      ...fields,
      listed: true,
      ...(becameTerminal ? { terminalAt: l.endedAt ?? now } : {}),
    };
  }
  return out
    .map((t, i) => ({ t, i }))
    .sort((a, b) => a.t.startedAt - b.t.startedAt || a.i - b.i)
    .map(({ t }) => t);
};

/** `mcp__<server>__<prefix>task_*` のどれか。task_list を呼ぶ先（server と prefix）を知るのに使う。 */
export const matchRovoTool = (tool: string): { server: string; prefix: string } | null => {
  if (!tool.startsWith("mcp__")) return null;
  const parts = tool.split("__");
  if (parts.length < 3) return null;
  const name = parts[parts.length - 1] ?? "";
  const hit =
    /^((?:[A-Za-z0-9-]+_)*)task_(?:start|status|console|result|review|list|wait|answer|steer|cancel)$/.exec(
      name,
    );
  const server = parts.slice(1, -1).join("__");
  if (hit === null || server === "") return null;
  return { server, prefix: hit[1] ?? "" };
};

// --- ペインの情報設計（0.6.0） -------------------------------------------------------

/** 線路の列の幅（線路 16 桁 + あき 3。列見出しの駅名とモデルの間を 2 桁以上あける）。 */
export const TRACK_COL = 19;
const MODEL_COL = 10;
const ELAPSED_COL = 9;
const MARK_COL = 2;

export type PaneCols = { title: number; model: number; elapsed: number };

/**
 * 1 行目の列の幅。選択の帯 2 + タイトル + あき 1 + 線路 18 + モデル + あき 1 + 経過。
 * タイトルは残りを使う。狭くてタイトルが 12 桁を割るときは、モデルの列をやめる。
 */
export const paneColumns = (total: number): PaneCols => {
  const rest = (model: number): number =>
    total - MARK_COL - 1 - TRACK_COL - model - (model > 0 ? 1 : 0) - ELAPSED_COL;
  let model = MODEL_COL;
  if (rest(model) < 12) model = 0;
  return { title: Math.max(1, rest(model)), model, elapsed: ELAPSED_COL };
};

const stationNames = (kind: TaskKind): string =>
  STATIONS[kind]
    .map((name, i, all) => (i === all.length - 1 ? name : padWidth(name, COLUMN)))
    .join("");

/** 列見出しの 1 行（駅の名前はここに 1 回だけ）。 */
export const columnHeader = (cols: PaneCols, kind: TaskKind): string => {
  const title = " ".repeat(MARK_COL + cols.title);
  const track = padWidth(stationNames(kind), TRACK_COL);
  const model = cols.model > 0 ? padWidth("モデル", cols.model) + " " : "";
  const elapsed = " ".repeat(Math.max(0, cols.elapsed - displayWidth("経過"))) + "経過";
  return `${title} ${track}${model}${elapsed}`;
};

/** review のワーカーをまとめた直前の見出し（そのグループ専用の駅の名前）。 */
export const reviewHeader = (cols: PaneCols): string =>
  `${" ".repeat(MARK_COL + cols.title)} ${stationNames("review")}`;

/** 終了からの時間。1 分未満は「たった今」。 */
export const agoText = (ms: number): string => {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return "たった今";
  return minutes < 60 ? `${minutes}分前` : `${Math.floor(minutes / 60)}時間前`;
};

const isDone = (t: RovoTask): boolean => isTerminal(t.status);

/** 並び: 質問待ち → 作業中（開始が新しい順）→ 終端（終了が新しい順）。同じなら元の順。 */
export const orderTasks = (tasks: readonly RovoTask[]): RovoTask[] => {
  const rank = (t: RovoTask): number => (isDone(t) ? 2 : isWaiting(t) ? 0 : 1);
  return tasks
    .map((t, i) => ({ t, i }))
    .sort((a, b) => {
      const ra = rank(a.t);
      const rb = rank(b.t);
      if (ra !== rb) return ra - rb;
      const ka = ra === 2 ? (a.t.terminalAt ?? a.t.startedAt) : a.t.startedAt;
      const kb = rb === 2 ? (b.t.terminalAt ?? b.t.startedAt) : b.t.startedAt;
      return kb - ka || a.i - b.i;
    })
    .map(({ t }) => t);
};

/** 自動で出すワーカー: 質問待ち > 最新の実行中 > 最新（開始が新しいもの。同じなら後に入ったもの）。 */
export const bestWorker = (tasks: readonly RovoTask[]): RovoTask | undefined => {
  const newest = (list: RovoTask[]): RovoTask | undefined =>
    list.reduce<RovoTask | undefined>(
      (a, t) => (a === undefined || t.startedAt >= a.startedAt ? t : a),
      undefined,
    );
  return (
    newest(tasks.filter((t) => !isDone(t) && isWaiting(t))) ??
    newest(tasks.filter((t) => !isDone(t))) ??
    newest([...tasks])
  );
};

/**
 * イベント（新しい作業中のタスクを拾った・質問待ちに入った）のときに出すワーカー。
 * いま出しているワーカーが作業中・質問待ちなら動かさない。終端か、一覧に無いか、何も出していないときだけ best に移る。
 */
export const moveTarget = (tasks: readonly RovoTask[], current: string | null): string | null => {
  const cur = current === null ? undefined : tasks.find((t) => taskKey(t) === current);
  if (cur !== undefined && !isDone(cur)) return current;
  const best = bestWorker(tasks);
  return best === undefined ? null : taskKey(best);
};

/** 終端の行の右（モデルの列）に出す文字。完了は PR、それ以外は結果。 */
export const terminalCell = (t: RovoTask, pr?: PrLink): { text: string; color?: ThemeKey } => {
  const color = statusColor(t.status);
  const out = (text: string): { text: string; color?: ThemeKey } => ({
    text,
    ...(color !== undefined ? { color } : {}),
  });
  if (t.status === "COMPLETED") {
    const link = pr ?? t.pr;
    return out(link === undefined ? "完了" : link.number === null ? "PR" : `PR #${link.number}`);
  }
  return out(statusLabel(t.status));
};

const QUESTION_NOTE = "? 質問に答えてください（会話で task_answer）";
const BUDGET_NOTE = "? 予算の承認待ち（利用者に確認してから task_answer）";

/** 2 行目に出すいまの動き。質問待ちは warning、検証中は [n/m] を前に。 */
export const detailText = (
  t: RovoTask,
  nowText: string | null,
): { text: string; color?: ThemeKey } => {
  if (isWaiting(t)) {
    return {
      text:
        t.status === "INPUT_REQUIRED" && t.awaiting === "budget_extension"
          ? BUDGET_NOTE
          : QUESTION_NOTE,
      color: "warning",
    };
  }
  const attempt =
    t.stage === "verify" && t.verifyAttempt !== undefined
      ? `[${t.verifyAttempt}${t.verifyMax !== undefined ? `/${t.verifyMax}` : ""}]`
      : "";
  return { text: [attempt, nowText ?? ""].filter((x) => x !== "").join(" ") };
};

export const MIN_WINDOW = 6;
const MAX_WORKING = 4;
const MAX_ENDED = 5;
/** 一覧以外の行: 見出し 1 + 列見出し 1 + 枠 2 + 余り 1（タイトルは枠の上辺に載る）。 */
const LIST_OVERHEAD = 5;

/** 見出しの下・一覧と枠の間に入れる空行。窓が MIN_WINDOW を超えて余った行からだけ取る（最大 2）。 */
export const spacerRows = (leftover: number): number =>
  Math.min(2, Math.max(0, leftover - MIN_WINDOW));

/**
 * 枠の上辺 `╭─ タイトル ─── リンク ─╮` の部品。幅は width ちょうど:
 * 3（`╭─ `）+ タイトル + 1 + dashes + （リンクあり: 1 + linksWidth + 3 / なし: 1 `╮`）。
 * タイトルは入る幅で切る。リンクの分の余地（ダッシュ 3 本以上 + タイトル 1 桁）がなければリンクは出さない。
 */
export const frameTop = (
  width: number,
  title: string,
  linksWidth: number,
): { title: string; dashes: number; showLinks: boolean } => {
  const withLinks = width - (3 + 1 + 3 + 1 + linksWidth + 3);
  const showLinks = linksWidth > 0 && withLinks >= 1;
  const cap = showLinks ? withLinks : width - 6;
  const cut = cap < 1 ? "" : truncateWidth(title, cap);
  const tail = showLinks ? 1 + linksWidth + 3 : 1;
  return { title: cut, dashes: Math.max(1, width - (3 + displayWidth(cut) + 1 + tail)), showLinks };
};

export type WorkerPlan = {
  shown: RovoTask[];
  hidden: number;
  hiddenAllTerminal: boolean;
  rows: number;
};

/**
 * 出すワーカーと行の予算。作業中は 2 行、終端は 1 行、review 見出し（あれば）と「他 n 件」が各 1 行。
 * 作業中は 4、終端は 5 まで（出しているワーカーは必ず入れる）。残りが MIN_WINDOW を割るときは、終端の行 → 作業中の行の順に減らす。
 * ordered は orderTasks の並び。
 */
export const planWorkers = (
  ordered: readonly RovoTask[],
  shownKey: string | null,
  bodyRows: number,
): WorkerPlan => {
  const budget = bodyRows - LIST_OVERHEAD - MIN_WINDOW;
  const sel = ordered.find((t) => taskKey(t) === shownKey);
  const pick = (list: RovoTask[], n: number): Set<RovoTask> => {
    const first = list.slice(0, n);
    if (sel !== undefined && list.includes(sel) && !first.includes(sel))
      first.splice(n - 1, 1, sel);
    return new Set(first);
  };
  const working = pick(
    ordered.filter((t) => !isDone(t)),
    MAX_WORKING,
  );
  const ended = pick(ordered.filter(isDone), MAX_ENDED);
  const rowsOf = (): number => {
    const kept = ordered.filter((t) => working.has(t) || ended.has(t));
    const hidden = ordered.length - kept.length;
    return (
      working.size * 2 +
      ended.size +
      (kept.some((t) => t.kind === "review") ? 1 : 0) +
      (hidden > 0 ? 1 : 0)
    );
  };
  const dropLast = (set: Set<RovoTask>): boolean => {
    const victim = [...ordered].reverse().find((t) => set.has(t) && t !== sel);
    if (victim === undefined) return false;
    set.delete(victim);
    return true;
  };
  while (rowsOf() > budget && (dropLast(ended) || dropLast(working))) {
    // 予算に収まるか、出しているワーカーだけになるまで減らす。
  }
  const shown = ordered.filter((t) => working.has(t) || ended.has(t));
  const hiddenList = ordered.filter((t) => !working.has(t) && !ended.has(t));
  return {
    shown,
    hidden: hiddenList.length,
    hiddenAllTerminal: hiddenList.length > 0 && hiddenList.every(isDone),
    rows: rowsOf(),
  };
};
