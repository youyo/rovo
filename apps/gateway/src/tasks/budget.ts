/**
 * タスク 1 件に予約する予算（USD）。env の TASK_BUDGET_USD（既定 10）。
 * UserDO の月額枠の予約と、AgentDO に渡す budgetUsd は、必ずこの関数の値を使う（同じ値でなければ
 * 予約より多く使えてしまう、または予約が余ってしまう）。
 * 未設定・数でない・0 以下（AgentDO は budgetUsd > 0 でないと invalid_spec にする）は既定に戻す。
 */
export const DEFAULT_TASK_BUDGET_USD = 10;

export function taskBudgetUsd(env: { TASK_BUDGET_USD?: string }): number {
  const raw = env.TASK_BUDGET_USD;
  const n = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TASK_BUDGET_USD;
}
