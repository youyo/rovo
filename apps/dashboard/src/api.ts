import type {
  BudgetMeDto,
  CloudflareSummaryDto,
  OverviewDto,
  WaitingDto,
} from "@rovo/dashboard-contract";

/** 読み取り API の呼び出し（同一オリジン・Cookie のセッション）。契約は型だけ取り込む（zod を画面に入れない）。 */

export type Scope = "all" | "me";

export type OverviewResult =
  | { kind: "ok"; data: OverviewDto }
  | { kind: "unauthorized" }
  | { kind: "not_found" }
  | { kind: "error" };

const OVERVIEW = "/dashboard/api/overview";

/** 「今日」: ブラウザのローカル日の 0 時〜いま（D18）。 */
export function localDayRange(nowMs: number): { from: number; to: number } {
  const d = new Date(nowMs);
  d.setHours(0, 0, 0, 0);
  return { from: d.getTime(), to: nowMs };
}

export function overviewUrl(range: { from: number; to: number }, scope: Scope): string {
  return `${OVERVIEW}?from=${range.from}&to=${range.to}&scope=${scope}`;
}

/** 応答の形の最低限の確認（契約の検証は gateway が出力時に行う）。壊れた応答で画面を落とさない。 */
function looksLikeOverview(b: unknown): b is OverviewDto {
  if (typeof b !== "object" || b === null) return false;
  const o = b as Record<string, unknown>;
  const obj = (v: unknown) => typeof v === "object" && v !== null;
  const month = o.month as Record<string, unknown> | undefined;
  return (
    typeof o.generated_at === "string" &&
    obj(o.range) &&
    (o.scope === "all" || o.scope === "me") &&
    obj(o.viewer) &&
    Array.isArray(o.tasks) &&
    Array.isArray(o.consults) &&
    Array.isArray(o.models) &&
    obj(o.budget) &&
    obj(month) &&
    obj(month?.budget_actual) &&
    obj(month?.hidden_tasks)
  );
}

export type CloudflareResult =
  | { kind: "ok"; data: CloudflareSummaryDto }
  | { kind: "unauthorized" }
  | { kind: "not_found" }
  | { kind: "error" };

/** 期間は今月（UTC の月初から今まで）で固定（切り替えは作らない）。 */
export const CLOUDFLARE_URL = "/dashboard/api/cloudflare?range=month";

function looksLikeCloudflare(b: unknown): b is CloudflareSummaryDto {
  if (typeof b !== "object" || b === null) return false;
  const o = b as Record<string, unknown>;
  const obj = (v: unknown) => typeof v === "object" && v !== null;
  return (
    typeof o.generated_at === "string" &&
    obj(o.containers) &&
    obj(o.ai_gateway) &&
    obj(o.credit_balance)
  );
}

export async function fetchCloudflare(fetchImpl: typeof fetch = fetch): Promise<CloudflareResult> {
  try {
    const res = await fetchImpl(CLOUDFLARE_URL, {
      credentials: "same-origin",
      headers: { accept: "application/json" },
    });
    if (res.status === 401) return { kind: "unauthorized" };
    if (res.status === 404) return { kind: "not_found" };
    if (res.status !== 200) return { kind: "error" };
    const body: unknown = await res.json();
    return looksLikeCloudflare(body) ? { kind: "ok", data: body } : { kind: "error" };
  } catch {
    return { kind: "error" };
  }
}

export async function fetchOverview(
  range: { from: number; to: number },
  scope: Scope,
  fetchImpl: typeof fetch = fetch,
): Promise<OverviewResult> {
  try {
    const res = await fetchImpl(overviewUrl(range, scope), {
      credentials: "same-origin",
      headers: { accept: "application/json" },
    });
    if (res.status === 401) return { kind: "unauthorized" };
    if (res.status === 404) return { kind: "not_found" };
    if (res.status !== 200) return { kind: "error" };
    const body: unknown = await res.json();
    return looksLikeOverview(body) ? { kind: "ok", data: body } : { kind: "error" };
  } catch {
    return { kind: "error" };
  }
}

const BUDGET = "/dashboard/api/budget";

export type BudgetResult =
  | { kind: "ok"; data: BudgetMeDto }
  | { kind: "unauthorized" }
  | { kind: "error" };

/** 自分の予算だけ（軽い）。一覧より先にステータスバーの予算を出すのに使う。 */
export async function fetchBudget(fetchImpl: typeof fetch = fetch): Promise<BudgetResult> {
  try {
    const res = await fetchImpl(BUDGET, {
      credentials: "same-origin",
      headers: { accept: "application/json" },
    });
    if (res.status === 401) return { kind: "unauthorized" };
    if (res.status !== 200) return { kind: "error" };
    const b: unknown = await res.json();
    const o = b as Record<string, unknown> | null;
    return o !== null &&
      typeof o === "object" &&
      typeof o.spent_usd === "number" &&
      typeof o.remaining_usd === "number" &&
      typeof o.startable === "number"
      ? { kind: "ok", data: b as BudgetMeDto }
      : { kind: "error" };
  } catch {
    return { kind: "error" };
  }
}

export type WaitingResult =
  | { kind: "ok"; data: WaitingDto }
  | { kind: "unauthorized" }
  | { kind: "not_found" }
  | { kind: "error" };

const WAITING = "/dashboard/api/waiting";

/** 日付に関係なく「待ち」だけ。期間は渡さない（scope だけ）。 */
export function waitingUrl(scope: Scope): string {
  return `${WAITING}?scope=${scope}`;
}

function looksLikeWaiting(b: unknown): b is WaitingDto {
  if (typeof b !== "object" || b === null) return false;
  const o = b as Record<string, unknown>;
  return (
    typeof o.generated_at === "string" &&
    (o.scope === "all" || o.scope === "me") &&
    Array.isArray(o.tasks) &&
    typeof o.truncated === "boolean" &&
    typeof o.hidden_count === "number"
  );
}

export async function fetchWaiting(
  scope: Scope,
  fetchImpl: typeof fetch = fetch,
): Promise<WaitingResult> {
  try {
    const res = await fetchImpl(waitingUrl(scope), {
      credentials: "same-origin",
      headers: { accept: "application/json" },
    });
    if (res.status === 401) return { kind: "unauthorized" };
    if (res.status === 404) return { kind: "not_found" };
    if (res.status !== 200) return { kind: "error" };
    const body: unknown = await res.json();
    return looksLikeWaiting(body) ? { kind: "ok", data: body } : { kind: "error" };
  } catch {
    return { kind: "error" };
  }
}
