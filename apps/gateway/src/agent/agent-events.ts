import { SANDBOX_OPS } from "@rovo/audit";
import { sandboxInstanceName } from "../sandbox-instance";
import type { TaskStatus } from "../tasks/state";
import type { AgentEventDto, AgentPhase } from "./contract";

/** 公開イベントの値。DO の RPC で返せるようプリミティブに限る。 */
export type PublicPayload = Record<string, string | number | boolean | null>;

/** 公開する文字列の上限。AgentDO の data をそのままは流さず、既知の項目だけをここで切って渡す。 */
export const MAX_PUBLIC_TEXT = 500;
export const MAX_PUBLIC_SUMMARY = 2_000;
/** 子の質問の本文の上限（文字数）。options は 10 個まで・各 500 文字（ask_parent の上限と同じ）。 */
export const MAX_QUESTION_LENGTH = 4_000;
export const MAX_QUESTION_OPTIONS = 10;
export const MAX_QUESTION_OPTION_LENGTH = 500;

export type MappedAgentEvent =
  | { kind: "phase"; status: TaskStatus | null; reason?: string }
  | { kind: "usage"; costMicroUsd: number; payload: PublicPayload }
  /** 子の質問。TaskDO は questions テーブルにも保存する。options は JSON 配列の文字列 */
  | { kind: "question"; payload: PublicPayload }
  | { kind: "event"; type: string; payload: PublicPayload };

const PHASE_STATUS: Readonly<Record<AgentPhase, TaskStatus | null>> = {
  starting: null,
  running: "RUNNING",
  input_required: "INPUT_REQUIRED",
  verifying: "VERIFYING",
  completed: "COMPLETED",
  failed: "FAILED",
  budget_exceeded: "BUDGET_EXCEEDED",
  cancelled: "CANCELLED",
};

export function usdToMicro(usd: number): number {
  return Number.isFinite(usd) && usd > 0 ? Math.round(usd * 1_000_000) : 0;
}

function text(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  return v.length > max ? `${v.slice(0, max)}…` : v;
}

/** options を JSON 配列の文字列に正規化する（EventPayload はプリミティブしか持てない）。壊れていれば "[]"。 */
function questionOptions(v: unknown): string {
  let list: unknown = v;
  if (typeof v === "string") {
    try {
      list = JSON.parse(v);
    } catch {
      return "[]";
    }
  }
  if (!Array.isArray(list)) return "[]";
  const items = list
    .filter((x): x is string => typeof x === "string")
    .slice(0, MAX_QUESTION_OPTIONS)
    .map((x) => x.slice(0, MAX_QUESTION_OPTION_LENGTH));
  return JSON.stringify(items);
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** 回数（0 以上の整数）。壊れた値は 0 */
export function count(v: unknown): number {
  return typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : 0;
}

/** usage イベントの web: {search, fetch, browse} を、公開用の web_search / web_fetch / web_browse に写す */
function webCounts(web: unknown): { web_search: number; web_fetch: number; web_browse: number } {
  const w = typeof web === "object" && web !== null ? (web as Record<string, unknown>) : {};
  return { web_search: count(w.search), web_fetch: count(w.fetch), web_browse: count(w.browse) };
}

/**
 * usage の sandbox:{runtimeMs, restarts, bootRetries} を公開用の sandbox_* に写す（Phase 6 M3）。
 * sandbox が無い（agent が読めなかった）ときは何も付けない（0 回と区別する）。あるなら、欠けた・壊れた値は 0。
 * runtimeMs の小数は切り捨てる。回数（restarts / bootRetries）は整数以外を 0 にする。
 */
function sandboxCounts(sb: unknown): Record<string, string | number> {
  if (typeof sb !== "object" || sb === null || Array.isArray(sb)) return {};
  const s = sb as Record<string, unknown>;
  const n = (v: unknown) =>
    typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
  const cacheBuildMs = n(s.cacheBuildMs);
  const instance = sandboxInstanceName(s.instance);
  return {
    sandbox_runtime_ms: n(s.runtimeMs),
    sandbox_restarts: count(s.restarts),
    sandbox_boot_retries: count(s.bootRetries),
    ...depsCacheFields(s.depsCache, cacheBuildMs),
    // 実際に起動した大きさ。表にある名前だけ（任意の文字列を公開しない）。起動していなければ付けない
    ...(instance !== undefined ? { sandbox_instance: instance } : {}),
  };
}

/** 依存関係のキャッシュ（D14）の結果。固定の 4 値だけを通す（任意の文字列を公開しない）。作っていなければ cache_build_ms は付けない */
export const DEPS_CACHE_STATUSES = ["hit", "miss", "built", "disabled"] as const;
export type DepsCacheStatusDto = (typeof DEPS_CACHE_STATUSES)[number];

export function depsCacheStatus(v: unknown): DepsCacheStatusDto | undefined {
  return typeof v === "string" && (DEPS_CACHE_STATUSES as readonly string[]).includes(v)
    ? (v as DepsCacheStatusDto)
    : undefined;
}

function depsCacheFields(status: unknown, buildMs: number): Record<string, string | number> {
  const st = depsCacheStatus(status);
  return {
    ...(st !== undefined ? { deps_cache: st } : {}),
    ...(buildMs > 0 ? { cache_build_ms: buildMs } : {}),
  };
}

/** agent の audit イベントのうち、親にも見せてよい固定コード（Phase 6 M3。phase6.md「M3 で決めたこと」） */
const PUBLIC_AGENT_AUDIT_CODES: ReadonlySet<string> = new Set([
  "agent_cancelled",
  "sandbox_privileged_op",
]);

/** audit の payload を {code} / {code, op} の固定値に絞る。形が合わなければ undefined。 */
function auditPayload(d: Record<string, unknown>): PublicPayload | undefined {
  if (typeof d.code !== "string" || !PUBLIC_AGENT_AUDIT_CODES.has(d.code)) return undefined;
  if (d.code === "sandbox_privileged_op") {
    return typeof d.op === "string" && (SANDBOX_OPS as readonly string[]).includes(d.op)
      ? { code: d.code, op: d.op }
      : undefined;
  }
  return { code: d.code };
}

function parse(data: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(data);
    return v !== null && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * AgentDO のイベントを、公開用の形に写す（要約・整形）。
 * data の JSON は流さない。既知の type は項目を選んで文字列を切り詰め、未知の type は type 名だけを出す。
 */
export function mapAgentEvent(e: AgentEventDto): MappedAgentEvent {
  const d = parse(e.data);
  switch (e.type) {
    case "phase": {
      const phase = d.phase as AgentPhase | undefined;
      const status = phase !== undefined && phase in PHASE_STATUS ? PHASE_STATUS[phase] : null;
      const reason = text(d.reason, MAX_PUBLIC_TEXT);
      return { kind: "phase", status, ...(reason !== null ? { reason } : {}) };
    }
    case "usage": {
      const costMicroUsd = usdToMicro(num(d.costUsd));
      return {
        kind: "usage",
        costMicroUsd,
        payload: {
          cost_usd: costMicroUsd / 1_000_000,
          input_tokens: num(d.inputTokens),
          output_tokens: num(d.outputTokens),
          cache_read_tokens: num(d.cacheReadTokens),
          cache_write_tokens: num(d.cacheWriteTokens),
          ...webCounts(d.web),
          ...sandboxCounts(d.sandbox),
        },
      };
    }
    case "question":
      return {
        kind: "question",
        payload: {
          question_id: typeof d.question_id === "string" ? d.question_id.slice(0, 128) : "",
          message: typeof d.message === "string" ? d.message.slice(0, MAX_QUESTION_LENGTH) : "",
          options: questionOptions(d.options),
        },
      };
    case "answered":
      return {
        kind: "event",
        type: "answered",
        payload: { question_id: text(d.question_id, 128) },
      };
    case "steer_accepted":
      return {
        kind: "event",
        type: "steer_accepted",
        payload: { steer_id: text(d.steer_id, 160) },
      };
    case "tool_start":
      return {
        kind: "event",
        type: "tool_start",
        payload: {
          call_id: text(d.callId, 100),
          name: text(d.name, 100),
          summary: text(d.summary, MAX_PUBLIC_TEXT),
        },
      };
    case "tool_end":
      return {
        kind: "event",
        type: "tool_end",
        payload: {
          call_id: text(d.callId, 100),
          name: text(d.name, 100),
          is_error: d.isError === true,
          summary: text(d.summary, MAX_PUBLIC_TEXT),
        },
      };
    case "error":
      return {
        kind: "event",
        type: "agent_error",
        payload: { message: text(d.message, MAX_PUBLIC_TEXT) },
      };
    case "completion_report":
      return {
        kind: "event",
        type: "completion_report",
        payload: { summary: text(d.summary, MAX_PUBLIC_SUMMARY) },
      };
    case "verification":
      return {
        kind: "event",
        type: "verification",
        payload: {
          attempt: num(d.attempt),
          passed: d.passed === true,
          commit_sha: text(d.commitSha, 64),
        },
      };
    case "pushed":
      return {
        kind: "event",
        type: "pushed",
        payload: { sha: text(d.sha, 64), final: d.final === true },
      };
    case "push_failed":
      return {
        kind: "event",
        type: "push_failed",
        payload: {
          sha: text(d.sha, 64),
          message: text(d.message, MAX_PUBLIC_TEXT),
          final: d.final === true,
        },
      };
    case "audit": {
      const payload = auditPayload(d);
      if (payload !== undefined) return { kind: "event", type: "audit", payload };
      return { kind: "event", type: "agent_event", payload: { agent_type: "audit" } };
    }
    default:
      return { kind: "event", type: "agent_event", payload: { agent_type: text(e.type, 100) } };
  }
}
