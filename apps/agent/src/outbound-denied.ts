// 拒否した外向き通信の、タスクごとの集計（task_result の usage.outbound_denied / outbound_denied_total）。
// 鍵は {host, reason}。host は厳密に検証したホスト名だけ、reason は既存の固定の違反コードだけ。

import { RECEIVE_PACK_REJECT_CODES } from "./git-pkt";
import { GATEWAY_DENY_CODES } from "./outbound-gateway";
import { POLICY_DENY_CODES } from "./outbound-policy";
import { isValidHostname } from "./repo-diag";

/** 異なる {host, reason} の組を残す上限。超えた分は total にだけ数える */
export const OUTBOUND_DENIED_MAX_ENTRIES = 20;

/** 集計してよい違反コード（policy・gateway・receive-pack の解析の全部） */
export const OUTBOUND_DENY_REASONS: ReadonlySet<string> = new Set<string>([
  ...POLICY_DENY_CODES,
  ...GATEWAY_DENY_CODES,
  ...RECEIVE_PACK_REJECT_CODES,
]);

export interface OutboundDeniedEntry {
  host: string;
  reason: string;
  count: number;
}
export interface OutboundDeniedState {
  entries: OutboundDeniedEntry[];
  /** 拒否の合計（ホスト名を検証できなかったもの・上限を超えた組を含む） */
  total: number;
}

/**
 * 拒否 1 件を足した新しい集計を返す（prev は変えない）。reason が表に無ければ数えない。
 * host が検証できなければ total にだけ数える。
 */
export function addOutboundDenied(
  prev: OutboundDeniedState | undefined,
  host: unknown,
  reason: unknown,
): OutboundDeniedState {
  const state: OutboundDeniedState = {
    entries: (prev?.entries ?? []).map((e) => ({ ...e })),
    total: prev?.total ?? 0,
  };
  if (typeof reason !== "string" || !OUTBOUND_DENY_REASONS.has(reason)) return state;
  state.total += 1;
  const h = typeof host === "string" ? host.toLowerCase() : undefined;
  if (!isValidHostname(h)) return state;
  const hit = state.entries.find((e) => e.host === h && e.reason === reason);
  if (hit) hit.count += 1;
  else if (state.entries.length < OUTBOUND_DENIED_MAX_ENTRIES) {
    state.entries.push({ host: h, reason, count: 1 });
  }
  return state;
}

/** 受け取った値を、正しい形の要素（検証したホスト名・表にある違反コード・正の整数）だけに絞る（最大 20 件） */
export function sanitizeOutboundDenied(v: unknown): OutboundDeniedEntry[] {
  if (!Array.isArray(v)) return [];
  const out: OutboundDeniedEntry[] = [];
  for (const e of v) {
    if (out.length >= OUTBOUND_DENIED_MAX_ENTRIES) break;
    if (typeof e !== "object" || e === null) continue;
    const r = e as Record<string, unknown>;
    if (!isValidHostname(r.host)) continue;
    if (typeof r.reason !== "string" || !OUTBOUND_DENY_REASONS.has(r.reason)) continue;
    if (typeof r.count !== "number" || !Number.isSafeInteger(r.count) || r.count < 1) continue;
    out.push({ host: r.host, reason: r.reason, count: r.count });
  }
  return out;
}
