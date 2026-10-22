import { maskSecrets, normalizeStructuredEvent, sanitizeText, truncateEnd } from "@rovo/audit";
import {
  LIMITS,
  prUrlSchema,
  reasonCodeSchema,
  TASK_STATUSES,
  type TaskEventDto,
  TaskEventDtoSchema,
} from "@rovo/dashboard-contract";

/**
 * 保存された events の行を、ダッシュボードの契約（TaskEventDto）にする（docs/specs/dashboard.md D14・M7）。
 * API の応答の最後の層: 保存の時点で agent と gateway が一度ずつ整形・マスクしているが、ここでもう一度かける
 * （過去のバグや想定外の行があっても、応答に秘密を出さない）。契約に合わない行は null（応答全体を 503 にしない）。
 *
 * MCP の task_wait にはこの型を出さない（TaskDO.readEvents が除く）。ここは専用 RPC の読み取りだけが使う。
 */

/** API が返す型。保存された他の型（question・audit・warning など）は返さない */
export const DASHBOARD_EVENT_TYPES = [
  "status_changed",
  // 利用者の cancel は TaskDO.cancel が changeStatus を通さず cancelled を直接積むので、CANCELLED への変化として返す
  "cancelled",
  "draft_pr_created",
  "tool_start",
  "tool_end",
  "usage",
  "command",
  "edit",
  "commit",
  "web",
  "agent_event",
] as const;

/** web ツールの tool_start の要約の代わりに出す固定の文字列 */
const WEB_REQUEST_SUMMARY = "web request (omitted)";

export type StoredEventRow = {
  seq: number;
  type: string;
  payload: Record<string, unknown>;
  /** epoch ms */
  created_at: number;
};

/** 1 行の短い文字列（呼び出し ID・ツール名など）。壊れた値は空 */
function line(v: unknown, max: number): string {
  if (typeof v !== "string") return "";
  return truncateEnd(maskSecrets(sanitizeText(v, { singleLine: true })), max);
}

/** 自由文の要約。ANSI・制御文字を除き、マスクしてから切る */
function summary(v: unknown): string {
  if (typeof v !== "string") return "";
  return truncateEnd(maskSecrets(sanitizeText(v)), LIMITS.summary);
}

/** 0 以上の整数。壊れた値は 0 */
function count(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0
    ? Math.min(Math.floor(v), Number.MAX_SAFE_INTEGER)
    : 0;
}

function usd(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.min(v, 1_000_000_000) : 0;
}

function status(v: unknown): (typeof TASK_STATUSES)[number] | undefined {
  return typeof v === "string" && (TASK_STATUSES as readonly string[]).includes(v)
    ? (v as (typeof TASK_STATUSES)[number])
    : undefined;
}

/** 構造化イベントの保存形（snake_case）を、agent と同じ正規化の入力（camelCase）に戻す */
function structuredInput(type: string, p: Record<string, unknown>): Record<string, unknown> {
  switch (type) {
    case "command":
      return {
        command: p.command,
        cwd: p.cwd,
        exitCode: p.exit_code,
        durationMs: p.duration_ms,
        outputTail: p.output_tail,
      };
    default:
      return p;
  }
}

function build(row: StoredEventRow): Record<string, unknown> | null {
  const p = row.payload;
  switch (row.type) {
    case "status_changed": {
      const to = status(p.status);
      if (to === undefined) return null;
      const from = status(p.from);
      const reason = reasonCodeSchema.safeParse(p.reason);
      return {
        type: "status_changed",
        ...(from !== undefined ? { from } : {}),
        to,
        ...(reason.success ? { reason: reason.data } : {}),
      };
    }
    case "cancelled": {
      const from = status(p.from);
      return { type: "status_changed", ...(from !== undefined ? { from } : {}), to: "CANCELLED" };
    }
    case "draft_pr_created": {
      const url = prUrlSchema.safeParse(p.url);
      const n = count(p.number);
      if (!url.success || n < 1) return null;
      return { type: "draft_pr_created", pr_number: n, pr_url: url.data };
    }
    case "tool_start": {
      const name = line(p.name, LIMITS.toolName);
      return {
        type: "tool_start",
        call_id: line(p.call_id, LIMITS.callId),
        name,
        // web ツールの引数の要約は URL のパス・クエリを含みうる（D14: web は host だけ。host は web イベントが持つ）
        summary: name.startsWith("web_") ? WEB_REQUEST_SUMMARY : summary(p.summary),
      };
    }
    case "tool_end":
      return {
        type: "tool_end",
        call_id: line(p.call_id, LIMITS.callId),
        is_error: p.is_error === true,
        summary: summary(p.summary),
      };
    case "usage":
      return {
        type: "usage",
        cost_usd: usd(p.cost_usd),
        input_tokens: count(p.input_tokens),
        output_tokens: count(p.output_tokens),
        cache_read_tokens: count(p.cache_read_tokens),
        cache_write_tokens: count(p.cache_write_tokens),
      };
    case "agent_event":
      return { type: "agent_event", agent_type: line(p.agent_type, LIMITS.agentType) };
    case "command":
    case "edit":
    case "commit":
    case "web": {
      const s = normalizeStructuredEvent(row.type, structuredInput(row.type, p));
      if (s === undefined) return null;
      switch (s.type) {
        case "command":
          return {
            type: "command",
            command: s.command,
            ...(s.cwd !== undefined ? { cwd: s.cwd } : {}),
            exit_code: s.exitCode,
            ...(s.durationMs !== undefined ? { duration_ms: s.durationMs } : {}),
            ...(s.outputTail !== undefined ? { output_tail: s.outputTail } : {}),
          };
        case "edit":
          return {
            type: "edit",
            path: s.path,
            op: s.op,
            added: s.added,
            removed: s.removed,
          };
        case "commit":
          return { type: "commit", message: s.message, sha: s.sha, files: s.files };
        case "web":
          return { type: "web", kind: s.kind, ...(s.host !== undefined ? { host: s.host } : {}) };
      }
      return null;
    }
    default:
      return null;
  }
}

/** 保存された行を TaskEventDto にする。対象外の型・契約に合わない行は null */
export function toEventDto(row: StoredEventRow): TaskEventDto | null {
  const body = build(row);
  if (body === null) return null;
  const at = new Date(row.created_at);
  if (Number.isNaN(at.getTime())) return null;
  const parsed = TaskEventDtoSchema.safeParse({ seq: row.seq, at: at.toISOString(), ...body });
  return parsed.success ? parsed.data : null;
}
