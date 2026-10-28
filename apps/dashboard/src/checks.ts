import type { ChecksDto } from "@rovo/dashboard-contract";

/**
 * PR の CI（check run と commit status）の表示の核（純粋な関数）。React に依存しない。
 * 並び・集計・所要・更新の間隔をここで決める。名前や URL は外部が書ける非信頼データなので、
 * 表示する側（ci-pane.tsx）はテキストとしてだけ描き、リンクは format.ts の isAllowedCheckUrl を通す。
 */

export type Check = ChecksDto["checks"][number];

/** 表示上の分類。並びもこの順（失敗 → 実行中 → 待ち → 成功 → skipped / neutral） */
export const CHECK_CLASSES = ["fail", "run", "queued", "ok", "skip"] as const;
export type CheckClass = (typeof CHECK_CLASSES)[number];

/** 更新の間隔（ms）。queued / in_progress / pending が 1 つでもあれば短く、全部終わっていれば後からの push を拾う程度に */
export const CHECKS_POLL_ACTIVE_MS = 10_000;
export const CHECKS_POLL_IDLE_MS = 60_000;

/** 成功とみなさない完了は失敗（gateway の集約と同じ規則。未知の conclusion も失敗側に倒す） */
export function checkClass(c: Check): CheckClass {
  if (c.status === "in_progress") return "run";
  if (c.status === "queued") return "queued";
  if (c.conclusion === "success") return "ok";
  if (c.kind === "check_run" && (c.conclusion === "skipped" || c.conclusion === "neutral")) {
    return "skip";
  }
  return "fail";
}

/** 失敗 → 実行中 → 待ち → 成功 → skipped / neutral。同じ分類の中は元の順（安定）。元の配列は変えない */
export function sortChecks(checks: readonly Check[]): Check[] {
  const rank = (c: Check) => CHECK_CLASSES.indexOf(checkClass(c));
  return checks
    .map((c, i) => ({ c, i, r: rank(c) }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.c);
}

/** 見出しのチップの数。ok は成功と skipped / neutral、pending は実行中と待ち */
export function summarizeChecks(checks: readonly Check[]): {
  ok: number;
  fail: number;
  pending: number;
} {
  const n = { ok: 0, fail: 0, pending: 0 };
  for (const c of checks) {
    const k = checkClass(c);
    if (k === "fail") n.fail++;
    else if (k === "run" || k === "queued") n.pending++;
    else n.ok++;
  }
  return n;
}

/** 所要（ms）。check run で開始と終了があるとき、または実行中で開始があるとき（経過）だけ。それ以外と負の差は null */
export function checkDurationMs(c: Check, nowMs: number): number | null {
  if (c.kind !== "check_run" || c.started_at === null) return null;
  const start = Date.parse(c.started_at);
  if (Number.isNaN(start)) return null;
  let end: number;
  if (c.status === "completed") {
    if (c.completed_at === null) return null;
    end = Date.parse(c.completed_at);
  } else if (c.status === "in_progress") {
    end = nowMs;
  } else {
    return null;
  }
  return Number.isNaN(end) || end < start ? null : end - start;
}

/** 次の更新までの間隔。実行中・待ちが 1 つでもあれば 10 秒、それ以外（全部終わった・無い・読めない・まだ取れていない）は 60 秒 */
export function checksPollMs(dto: ChecksDto | null): number {
  const active = dto?.checks.some((c) => c.status !== "completed") === true;
  return active ? CHECKS_POLL_ACTIVE_MS : CHECKS_POLL_IDLE_MS;
}

export function shortSha(sha: string | null): string {
  return sha === null ? "" : sha.slice(0, 7);
}
