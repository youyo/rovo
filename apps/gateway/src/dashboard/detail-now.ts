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
      return { kind: "command", text: oneLine(commandLine(e.command, "")), at };
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

const MARK = "…";

/** 先頭が `{"<キー>":"` で始まる（文字列の値の手前まで）。キーは JSON のエスケープを含まないものだけ */
const STRING_HEAD = /^\s*\{\s*"([^"\\]*)"\s*:\s*"/;
const HEX4 = /^[0-9a-fA-F]{4}$/;
const HEX_PART = /^[0-9a-fA-F]*$/;
const SIMPLE_ESCAPE: Record<string, string> = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};

/**
 * JSON の文字列の中身（開き " の次から）を読み、エスケープを戻す。閉じる " が無ければ、途中で切れている（cut）。
 * 切れているときは、切り詰めの印（agent の "..."・gateway の "…"）を外し、末尾の中途半端なエスケープ
 * （\ や \u12）と、対の片方だけのサロゲートは捨てる。エスケープが壊れていれば undefined。
 * dashboard の steps.ts と同じ振る舞い（別のパッケージなので、それぞれに実装している）。
 */
function readJsonString(body: string): { value: string; cut: boolean } | undefined {
  let end = -1;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === "\\") i++;
    else if (c === '"') {
      end = i;
      break;
    }
  }
  const cut = end < 0;
  const raw = cut ? body.replace(/(?:\.\.\.|…)$/, "") : body.slice(0, end);
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i] as string;
    if (c !== "\\") {
      out += c;
      continue;
    }
    const n = raw[i + 1];
    if (n === undefined) break; // 切れた位置が \ の直後
    if (n === "u") {
      const hex = raw.slice(i + 2, i + 6);
      if (hex.length < 4) {
        if (cut && HEX_PART.test(hex)) break; // 切れた位置が \uXX の途中
        return undefined;
      }
      if (!HEX4.test(hex)) return undefined;
      out += String.fromCharCode(Number.parseInt(hex, 16));
      i += 5;
      continue;
    }
    const e = SIMPLE_ESCAPE[n];
    if (e === undefined) return undefined;
    out += e;
    i++;
  }
  return { value: cut ? out.replace(/[\uD800-\uDBFF]$/, "") : out, cut };
}

/**
 * 引数の JSON から文字列の項目を取り出す（マスク前）。要約は 200 字で切られていて JSON として壊れていることがあるので、
 * 読めないときは、先頭が `{"<key>":"` のときだけ、その文字列を取り出す（切れていれば末尾に …）。取り出せなければ undefined。
 */
function argString(summary: string, key: string): string | undefined {
  try {
    const v: unknown = JSON.parse(summary);
    if (typeof v === "object" && v !== null && !Array.isArray(v)) {
      const f = (v as Record<string, unknown>)[key];
      return typeof f === "string" ? f : undefined;
    }
    return undefined;
  } catch {
    // 切れた JSON かもしれない
  }
  const head = STRING_HEAD.exec(summary);
  if (head === null || head[1] !== key) return undefined;
  const read = readJsonString(summary.slice(head[0].length));
  if (read === undefined || read.value === "") return undefined;
  return `${read.value}${read.cut ? MARK : ""}`;
}

/** 引数が JSON のオブジェクト・配列に見える（生のまま画面に出さない） */
function looksLikeJson(v: string): boolean {
  return /^\s*[{[]/.test(v);
}

/** 場所の 1 区切りに許す文字（素直なディレクトリ名だけ。空白・引用符・変数・シェルの記号は許さない） */
const DIR_SEGMENT = /^[\p{L}\p{N}_.@+-]+$/u;
const CD_PREFIX = /^cd\s+(\/workspace(?:\/\S*)?)\s+&&\s+(\S.*)$/;

/** /workspace からの相対パス。/workspace 自身は ""。素直なパスでない（.. や // を含む・変な文字がある）ものは undefined */
function relativeDir(abs: string): string | undefined {
  const rest = abs.slice("/workspace".length);
  if (rest === "") return "";
  const parts = rest.slice(1).split("/");
  if (parts.at(-1) === "") parts.pop();
  for (const p of parts) {
    if (p === "." || p === ".." || !DIR_SEGMENT.test(p)) return undefined;
  }
  return parts.join("/");
}

/**
 * コマンドの 1 行（マスク前）。先頭の `cd /workspace/<相対パス> && ` を外し、場所を「<相対パス> で 」と先頭に添える
 * （prompt はその次、コマンドの直前）。`cd /workspace && ` は前置きだけ外す（場所なし）。ほかの形（.. を含む・
 * /workspace の外・引用符つきなど）は触らない。dashboard の steps.ts と同じ見せ方。
 */
function commandLine(raw: string, prompt: string): string {
  const text = sanitizeText(raw, { singleLine: true }).trim();
  const m = CD_PREFIX.exec(text);
  const dir = m === null ? undefined : relativeDir(m[1] as string);
  if (m === null || dir === undefined) return `${prompt}${text}`;
  return `${dir === "" ? "" : `${dir} で `}${prompt}${m[2]}`;
}

/** ツールの種類ごとの、人が読める 1 行（マスク前）。bash は「$ コマンド」、ファイル系はパス、search はパターン */
function toolText(name: string, summary: string): string {
  const arg = (key: string) => argString(summary, key);
  switch (name) {
    case "bash": {
      const c = arg("command") ?? (looksLikeJson(summary) ? "" : summary);
      return c === "" ? name : commandLine(c, "$ ");
    }
    case "read_file":
    case "write_file":
    case "edit_file":
    case "list_files": {
      const p = arg("path");
      return p === undefined || p === "" ? name : `${name}: ${p}`;
    }
    case "search": {
      const p = arg("pattern");
      return p === undefined || p === "" ? name : `${name}: ${p}`;
    }
    default:
      return summary === "" || looksLikeJson(summary) ? name : `${name}: ${summary}`;
  }
}

function toolNow(e: Extract<TaskEventDto, { type: "tool_start" }>, at: string): NowDto {
  return { kind: "tool", text: oneLine(toolText(e.name, e.summary)), at };
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

const PHASE_OF: Record<string, TaskDetailDto["phase"]> = {
  CREATING: "prepare",
  RUNNING: "run",
  INPUT_REQUIRED: "run",
  RECOVERING: "run",
  VERIFYING: "verify",
};

/**
 * 終端（失敗・予算超過・キャンセル）で止まった段階。準備で失敗（failure_phase が setup）→ prepare、
 * 検証に入った記録がある → verify、実行に入った記録がある → run、どちらも無い → prepare。完了・非終端は null。
 */
export function stoppedPhaseOf(
  status: string,
  failurePhase: string | null,
  reached: { running: boolean; verifying: boolean },
): "prepare" | "run" | "verify" | null {
  if (status !== "FAILED" && status !== "BUDGET_EXCEEDED" && status !== "CANCELLED") return null;
  if (failurePhase === "setup") return "prepare";
  if (reached.verifying) return "verify";
  if (reached.running) return "run";
  return "prepare";
}

/** 状態から段階を求める（詳細 API と task_console が同じ関数を使う）。終端（と未知の状態）は done */
export function phaseOf(status: string): TaskDetailDto["phase"] {
  return PHASE_OF[status] ?? "done";
}
