import type { OverviewDto, VisibleTaskDto } from "@rovo/dashboard-contract";
import { formatDayHeading } from "./format";
import type { T } from "./i18n";
import { isTerminal, markKindOf } from "./status";
import { taskTime } from "./timeline";

/** レール・ヘッダ・ステータスバーの純関数（React に依存しない）。状態の印の形は status.ts の MARKS と status-mark.tsx。 */

/**
 * 一覧のコンソールに出すタスク。実行中（終端でない）があれば開始が最新のもの、無ければ開始が最新のタスク。
 */
export function pickConsoleTask(tasks: readonly VisibleTaskDto[]): VisibleTaskDto | null {
  const latest = (list: readonly VisibleTaskDto[]) =>
    list.reduce<VisibleTaskDto | null>(
      (best, t) => (best === null || taskTime(t) > taskTime(best) ? t : best),
      null,
    );
  return latest(tasks.filter((t) => !isTerminal(t.status))) ?? latest(tasks);
}

export type DaySummary = { day: string; total: number; merged: number; running: number };

/** ヘッダの要約。「10月22日  12 件  マージ済み 0  実行中 0」（en は「October 22  12 tasks  Merged 0  Running 0」） */
export function daySummary(data: OverviewDto, t: T): DaySummary {
  return {
    day: formatDayHeading(Date.parse(data.range.from), t),
    total: data.tasks.length,
    merged: data.tasks.filter((t) => markKindOf(t) === "merged").length,
    running: data.tasks.filter((t) => !isTerminal(t.status)).length,
  };
}

/**
 * 自分の今月の上限（USD）。契約の monthly_budget_usd をそのまま使う。
 * 上限を足す前の gateway の応答（項目が無い）では、残りが「上限から実費と予約を引いた値」であることを使い、
 * 使った額 + 予約 + 残りで求める。残りが 0 のときは負にしない丸めで求められないので null。
 */
export function budgetLimit(budget: OverviewDto["budget"]): number | null {
  if (budget.monthly_budget_usd !== undefined) return budget.monthly_budget_usd;
  if (!(budget.remaining_usd > 0)) return null;
  return budget.spent_usd + budget.reserved_usd + budget.remaining_usd;
}
