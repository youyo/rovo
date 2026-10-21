import { SANDBOX_OPS } from "@rovo/audit";
import { isSandboxPromotionReason } from "@rovo/models";
import {
  sandboxInstanceName,
  sanitizePromotionFailures,
  sanitizePromotions,
  sanitizeScaleStats,
} from "../sandbox-instance";
import type { TaskStatus } from "../tasks/state";
import type { AgentEventDto, AgentPhase, SandboxUsageDto } from "./contract";

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
  const promotedTo = sandboxInstanceName(s.promotedTo);
  const reason = isSandboxPromotionReason(s.promotionReason) ? s.promotionReason : undefined;
  // 昇格の履歴（trigger・規則名つき）。payload はプリミティブだけなので JSON 文字列にする（question の options と同じ）。固定の値だけを通す
  const promotions = sanitizePromotions(s.promotions, "camel");
  const failures = sanitizePromotionFailures(s.promotionFailures);
  const scale = sanitizeScaleStats(s.scaleStats);
  return {
    sandbox_runtime_ms: n(s.runtimeMs),
    sandbox_restarts: count(s.restarts),
    sandbox_boot_retries: count(s.bootRetries),
    ...depsCacheFields(s.depsCache, cacheBuildMs, s.depsMissReason),
    // 実際に起動した大きさ。表にある名前だけ（任意の文字列を公開しない）。起動していなければ付けない
    ...(instance !== undefined ? { sandbox_instance: instance } : {}),
    // 昇格（重いコマンドの初回に大きい Sandbox へ）。昇格先は表にある名前だけ、理由は固定コードだけ。昇格前の時間は昇格したときだけ付ける
    ...(promotedTo !== undefined
      ? {
          sandbox_promoted_to: promotedTo,
          ...(n(s.promotedAt) > 0 ? { sandbox_promoted_at: n(s.promotedAt) } : {}),
          sandbox_runtime_ms_before_promotion: n(s.runtimeMsBeforePromotion),
        }
      : {}),
    ...(reason !== undefined ? { sandbox_promotion_reason: reason } : {}),
    ...(promotions.length > 0 ? { sandbox_promotions: JSON.stringify(promotions) } : {}),
    // 古い agent の記録（子が上げたあとに規則で重いと判定されたコマンドの本数。今の agent は報告しない）
    ...(typeof s.heavyCommandsAfterAgentScaleUp === "number"
      ? { sandbox_heavy_commands_after_agent_scale_up: n(s.heavyCommandsAfterAgentScaleUp) }
      : {}),
    // そのうち、子が規則の昇格先以上に上げていたために規則が昇格しなくて済んだ本数（子の見立ての的中）
    ...(typeof s.heavyCommandsCoveredByAgent === "number"
      ? { sandbox_heavy_commands_covered_by_agent: n(s.heavyCommandsCoveredByAgent) }
      : {}),
    // 昇格の見送り・失敗の内訳（固定の trigger と理由コードだけ。JSON 文字列）
    ...(failures.length > 0 ? { sandbox_promotion_failures: JSON.stringify(failures) } : {}),
    // Clef の判断の集計（数値だけ。agent は終端の確定のときだけ報告する）。判断ごとの記録は usage イベントには載せず、task_result の usage にだけ出す
    ...(scale !== undefined
      ? {
          sandbox_scale_decisions: scale.decisions,
          sandbox_scale_raised: scale.raised,
          sandbox_scale_clef_failures: scale.clef_failures,
          sandbox_scale_slow_not_raised: scale.slow_not_raised,
        }
      : {}),
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

/**
 * 依存関係のキャッシュを使えなかった理由（agent の DEPS_MISS_REASONS と同じ固定コード。ログの deps_cache_miss: <reason>）。
 * 入力や例外の文面を含まない値だけを通す（表に無いものは公開しない）。
 */
export const DEPS_MISS_REASONS = [
  "ensure_failed",
  "ensure_timeout",
  "build_failed",
  "build_timeout",
  "cooldown",
  "snapshot_unsupported",
  "snapshot_failed",
  "restore_failed",
  "cert_missing",
  "move_failed",
  "invalid_deps",
] as const satisfies readonly NonNullable<SandboxUsageDto["depsMissReason"]>[];
export type DepsMissReasonDto = (typeof DEPS_MISS_REASONS)[number];

/** miss のときだけ意味がある。miss 以外・表に無い値は undefined */
export function depsMissReason(status: unknown, v: unknown): DepsMissReasonDto | undefined {
  if (depsCacheStatus(status) !== "miss") return undefined;
  return typeof v === "string" && (DEPS_MISS_REASONS as readonly string[]).includes(v)
    ? (v as DepsMissReasonDto)
    : undefined;
}

function depsCacheFields(
  status: unknown,
  buildMs: number,
  missReason?: unknown,
): Record<string, string | number> {
  const st = depsCacheStatus(status);
  const reason = depsMissReason(status, missReason);
  return {
    ...(st !== undefined ? { deps_cache: st } : {}),
    ...(reason !== undefined ? { deps_cache_miss_reason: reason } : {}),
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
