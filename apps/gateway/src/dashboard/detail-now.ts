import { maskSecrets, sanitizeText, truncateEnd, truncateStart } from "@rovo/audit";
import { LIMITS, type TaskDetailDto, type TaskEventDto } from "@rovo/dashboard-contract";
import { type StoredEventRow, toEventDto } from "./events";

/**
 * 詳細の「いまの手順」（now）と「出力の末尾」（output）を、保存された最新のイベントから作る
 * （docs/specs/dashboard.md M8・D14・D15）。
 *
 * どの行も toEventDto を通す（保存時の整形・マスクのうえに、API の最後の層でもう一度かける）。
 * さらに、画面に出す 1 行の文字列は、ここでも 1 行化・マスク・長さの制限をかける。
 * 全件は読まない。TaskDO.dashboardLatest が返す直近の数十件と、最新の command 1 件だけを受ける。
 */

type NowDto = NonNullable<TaskDetailDto["now"]>;
type OutputDto = TaskDetailDto["output"];

const WAITING: NowDto = { kind: "waiting", text: "waiting for input" };

/** 画面に出す 1 行の文字列。改行・制御文字を空白にし、マスクしてから切る */
function oneLine(v: string): string {
  return truncateEnd(maskSecrets(sanitizeText(v, { singleLine: true })), LIMITS.nowText);
}

function isoOf(ms: number): string | undefined {
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

function nowOfStructured(e: TaskEventDto, at: string): NowDto | null {
  switch (e.type) {
    case "command":
      return { kind: "command", text: oneLine(e.command), at };
    case "edit":
      return { kind: "edit", text: oneLine(`${e.op} ${e.path}`), at };
    case "commit":
      return { kind: "commit", text: oneLine(`commit ${e.message}`), at };
    case "web":
      return {
        kind: "web",
        text: oneLine(`web ${e.kind}${e.host !== undefined ? ` ${e.host}` : ""}`),
        at,
      };
    default:
      return null;
  }
}

/**
 * 「いま何をしているか」。
 * - 終端（phase が done）は null。INPUT_REQUIRED は「入力待ち」。
 * - 候補は、終わっていない tool_start（実行中）と、command / edit / commit / web（記録は完了時）。
 *   このうち seq が最新のものを出す。tool_end 済みの tool_start は候補にしない。
 * - 構造化イベントが 1 件も無い古い agent は、最新の tool_start（終わっていても）に縮退する。
 * rows は seq の昇順。
 */
export function buildNow(
  rows: StoredEventRow[],
  status: string,
  phase: TaskDetailDto["phase"],
): NowDto | null {
  if (phase === "done") return null;
  if (status === "INPUT_REQUIRED") return WAITING;

  const ended = new Set<string>();
  for (const r of rows) {
    if (r.type !== "tool_end") continue;
    const e = toEventDto(r);
    if (e?.type === "tool_end") ended.add(e.call_id);
  }

  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (r === undefined) continue;
    const e = toEventDto(r);
    if (e === null) continue;
    const at = isoOf(r.created_at);
    if (at === undefined) continue;
    if (e.type === "tool_start") {
      if (!ended.has(e.call_id)) return toolNow(e, at);
      continue;
    }
    const s = nowOfStructured(e, at);
    if (s !== null) return s;
  }

  // 古い agent: 構造化イベントが無い。最新の tool_start（終わっていてもよい）
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (r === undefined) continue;
    const e = toEventDto(r);
    const at = isoOf(r.created_at);
    if (e?.type === "tool_start" && at !== undefined) return toolNow(e, at);
  }
  return null;
}

function toolNow(e: Extract<TaskEventDto, { type: "tool_start" }>, at: string): NowDto {
  return {
    kind: "tool",
    text: oneLine(e.summary === "" ? e.name : `${e.name}: ${e.summary}`),
    at,
  };
}

/** 実行中のコマンドの最新の進捗（TaskDO が 1 件だけ上書きで持つもの。時刻は epoch ms） */
export interface OutputProgress {
  command: string;
  started_at: number;
  output_tail?: string;
  updated_at: number;
}

/**
 * 出力の末尾。実行中のコマンドの進捗があればそれ（running: true と開始時刻つき）、無ければ最新の command の output_tail
 * （toEventDto で再マスク済み）。進捗も保存済みの値をもう一度マスクして切る。伏せている旨は常に true
 */
export function buildOutput(
  latestCommand: StoredEventRow | null,
  progress: OutputProgress | null = null,
): OutputDto {
  if (progress !== null) {
    const at = isoOf(progress.updated_at);
    const startedAt = isoOf(progress.started_at);
    return {
      tail: progress.output_tail
        ? truncateStart(maskSecrets(sanitizeText(progress.output_tail)), LIMITS.outputTail)
        : null,
      command: oneLine(progress.command),
      ...(at !== undefined ? { at } : {}),
      running: true,
      ...(startedAt !== undefined ? { started_at: startedAt } : {}),
      redacted: true,
    };
  }
  const e = latestCommand === null ? null : toEventDto(latestCommand);
  if (latestCommand === null || e?.type !== "command" || !e.output_tail) {
    return { tail: null, redacted: true };
  }
  const at = isoOf(latestCommand.created_at);
  return {
    tail: truncateStart(maskSecrets(e.output_tail), LIMITS.outputTail),
    command: oneLine(e.command),
    ...(at !== undefined ? { at } : {}),
    redacted: true,
  };
}
