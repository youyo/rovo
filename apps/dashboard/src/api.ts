import type { OverviewDto } from "@rovo/dashboard-contract";

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
