import { z } from "zod";
import type { TaskIndexRow } from "../directory/types";

/**
 * task_list（呼んだ人のタスクの一覧。mod のペインやダッシュボードのように複数のワーカーを見渡す用途）の純関数。
 * 元は DirectoryDO の索引で、タスクごとの TaskDO は起こさない。ワーカーが書いた自由文・費用は載せない。
 */

/** scope: "recent" で、終端になってから残す時間 */
export const TASK_LIST_RECENT_MS = 24 * 60 * 60 * 1000;
export const TASK_LIST_DEFAULT_LIMIT = 20;
export const TASK_LIST_MAX_LIMIT = 50;
/** ワーカー（apps/agent の MAX_VERIFY_ATTEMPTS）が検証を試す回数の上限。最初の 1 回 + 修正 3 回 */
export const VERIFY_MAX_ATTEMPTS = 4;

export const taskListSchema = z.object({
  scope: z
    .enum(["active", "recent"])
    .optional()
    .describe(
      '"active"（終端でないもの。既定）か "recent"（終端でないもの + 直近 24 時間に終端になったもの）',
    ),
  limit: z.number().int().min(1).max(TASK_LIST_MAX_LIMIT).optional().describe("1〜50、既定 20"),
});

export type TaskStage = "setup" | "work" | "verify" | "pr" | "done";
export type ReviewStageName = "fetch" | "investigate" | "post" | "done";

export type StageInput = Pick<
  TaskIndexRow,
  "status" | "failure_phase" | "started_at" | "pr_number" | "pr_merged"
> &
  Partial<Pick<TaskIndexRow, "kind" | "review_stage" | "reached_verifying">>;

const FAILED_STATUSES: ReadonlySet<string> = new Set(["FAILED", "BUDGET_EXCEEDED", "CANCELLED"]);

/**
 * ペインの「駅」になる段階。ダッシュボードの帯（準備 → 実行 → 検証 → 完了。dashboard/detail-now.ts の phaseOf / stoppedPhaseOf）と同じ考え方:
 * 非終端は状態から、失敗・予算超過・キャンセルは止まった段（準備で失敗なら setup、検証に入った記録があれば verify、実行に入っていれば work、
 * どちらも無ければ setup）。
 * task: CREATING→setup、RUNNING / INPUT_REQUIRED / RECOVERING→work、VERIFYING→verify、COMPLETED→PR があり未マージなら pr（マージ待ち）・それ以外は done。
 * review: 準備と review_commands（fetch）→ モデルが調べる（investigate）→ コメントの投稿（post）→ done。
 */
export function stageOf(row: StageInput): TaskStage | ReviewStageName {
  if (row.kind === "review") {
    switch (row.review_stage) {
      case "reviewing":
        return "investigate";
      case "posting":
        return "post";
      case "done":
        return row.status === "COMPLETED" ? "done" : "fetch";
      default:
        return "fetch";
    }
  }
  if (FAILED_STATUSES.has(row.status)) {
    if (row.failure_phase === "setup") return "setup";
    if (row.reached_verifying === true) return "verify";
    return row.started_at === null ? "setup" : "work";
  }
  switch (row.status) {
    case "CREATING":
      return "setup";
    case "VERIFYING":
      return "verify";
    case "COMPLETED":
      return row.pr_number !== null && !row.pr_merged ? "pr" : "done";
    default:
      return "work";
  }
}

const iso = (ms: number): string => new Date(ms).toISOString();

export type TaskListItem = {
  task_id: string;
  kind: "task" | "review";
  title: string;
  repository: string;
  status: string;
  stage: TaskStage | ReviewStageName;
  verify_attempt?: number;
  verify_max?: number;
  waiting_for_answer: boolean;
  model: string;
  created_at: string;
  updated_at: string;
  ended_at?: string;
  pr?: { number: number; url: string };
  dashboard_url?: string;
};

/** 索引の 1 行 → 応答の 1 件。決まった項目だけを写す（費用・理由・所有者・トークン・ワーカーの自由文は写さない）。 */
export function toTaskListItem(
  row: TaskIndexRow,
  dashboardUrl: (taskId: string) => string | undefined,
): TaskListItem {
  const kind = row.kind ?? "task";
  const prNumber = kind === "review" ? row.target_pr_number : row.pr_number;
  const prUrl = kind === "review" ? row.target_pr_url : row.pr_url;
  const url = dashboardUrl(row.task_id);
  return {
    task_id: row.task_id,
    kind,
    title: row.title,
    repository: row.repository,
    status: row.status,
    stage: stageOf({ ...row, kind }),
    ...(row.verify_attempt != null
      ? { verify_attempt: row.verify_attempt, verify_max: VERIFY_MAX_ATTEMPTS }
      : {}),
    waiting_for_answer: row.status === "INPUT_REQUIRED",
    model: row.model,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
    ...(row.ended_at !== null ? { ended_at: iso(row.ended_at) } : {}),
    ...(prNumber != null && prUrl != null ? { pr: { number: prNumber, url: prUrl } } : {}),
    ...(url !== undefined ? { dashboard_url: url } : {}),
  };
}
