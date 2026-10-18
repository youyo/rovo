import type { TaskStatus } from "../tasks/state";
import type { AgentEventDto, AgentPhase } from "./contract";

/** 公開イベントの値。DO の RPC で返せるようプリミティブに限る。 */
export type PublicPayload = Record<string, string | number | boolean | null>;

/** 公開する文字列の上限。AgentDO の data をそのままは流さず、既知の項目だけをここで切って渡す。 */
export const MAX_PUBLIC_TEXT = 500;
export const MAX_PUBLIC_SUMMARY = 2_000;

export type MappedAgentEvent =
  | { kind: "phase"; status: TaskStatus | null; reason?: string }
  | { kind: "usage"; costMicroUsd: number; payload: PublicPayload }
  | { kind: "event"; type: string; payload: PublicPayload };

const PHASE_STATUS: Readonly<Record<AgentPhase, TaskStatus | null>> = {
  starting: null,
  running: "RUNNING",
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

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
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
        },
      };
    }
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
    default:
      return { kind: "event", type: "agent_event", payload: { agent_type: text(e.type, 100) } };
  }
}
