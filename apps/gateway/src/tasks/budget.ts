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

/**
 * consult 1 回に予約する予算（USD）。env の CONSULT_BUDGET_USD（既定 0.5）。
 * UserDO の月額枠の予約と、AgentDO に渡す上限（max_output_tokens の上限と入力サイズの判定）は、必ずこの値を使う。
 * 未設定・数でない・0 以下は既定に戻す。
 */
export const DEFAULT_CONSULT_BUDGET_USD = 0.5;

export function consultBudgetUsd(env: { CONSULT_BUDGET_USD?: string }): number {
  const raw = env.CONSULT_BUDGET_USD;
  const n = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_CONSULT_BUDGET_USD;
}

/**
 * 道具（web_search / web_fetch。#135）を使う consult 1 回に予約する予算（USD）。env の CONSULT_TOOLS_BUDGET_USD（既定 1）。
 * 道具なしの consult は CONSULT_BUDGET_USD のまま。道具の往復は 1 回の consult でモデルを複数回呼び、web の費用もかかるので別の額にする。
 * UserDO の予約と、往復の各歩で AgentDO に渡す上限（予約額 − それまでの費用）は、必ずこの値から作る。
 * 未設定・数でない・0 以下は既定に戻す。
 */
export const DEFAULT_CONSULT_TOOLS_BUDGET_USD = 1;

export function consultToolsBudgetUsd(env: { CONSULT_TOOLS_BUDGET_USD?: string }): number {
  const raw = env.CONSULT_TOOLS_BUDGET_USD;
  const n = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_CONSULT_TOOLS_BUDGET_USD;
}

/**
 * 利用者ごとに同時に実行できるタスクの上限。env の MAX_CONCURRENT_TASKS（既定 2）。
 * UserDO の reserve が、動いている予約の件数がこの値に達していたら concurrency_limit で断る。
 * 予算（task_budget）の予約とは別の仕組みで、両方を満たすときだけタスクを始められる。
 * 未設定・1 以上の整数でない値（0・負・小数・数でない）は既定に戻す。
 */
export const DEFAULT_MAX_CONCURRENT_TASKS = 2;

export function maxConcurrentTasks(env: { MAX_CONCURRENT_TASKS?: string }): number {
  const raw = env.MAX_CONCURRENT_TASKS;
  if (typeof raw !== "string" || !/^\d+$/.test(raw.trim())) return DEFAULT_MAX_CONCURRENT_TASKS;
  const n = Number(raw.trim());
  return Number.isSafeInteger(n) && n >= 1 ? n : DEFAULT_MAX_CONCURRENT_TASKS;
}
