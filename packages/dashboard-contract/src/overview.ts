import { z } from "zod";
import {
  consultIdSchema,
  countSchema,
  effortSchema,
  isoTimeSchema,
  LIMITS,
  loginSchema,
  modelIdSchema,
  periodSchema,
  prUrlSchema,
  reasonCodeSchema,
  repositorySchema,
  taskStatusSchema,
  ulidSchema,
  untrustedText,
  usdSchema,
} from "./primitives";

/**
 * タスク 1 件の費用（TaskDO の usage。D8 の `TaskCostDto`）。
 * consult を含む「予算の実績」（`BudgetActualDto`）とは別の DTO で、画面で足し合わせない。
 */
export const TaskCostDtoSchema = z.strictObject({
  cost_usd: usdSchema,
  input_tokens: countSchema,
  output_tokens: countSchema,
  cache_read_tokens: countSchema,
  cache_write_tokens: countSchema,
});
export type TaskCostDto = z.infer<typeof TaskCostDtoSchema>;

/** PR の状態の値（GitHub から閲覧時に取る。取れなければ "unknown"）。 */
export const PR_STATES = ["open", "merged", "closed", "unknown"] as const;

/** Draft PR。`url` は GitHub の PR の URL の形だけ。 */
export const PrDtoSchema = z.strictObject({
  number: z.int().min(1),
  url: prUrlSchema,
  /** Draft か。不明なら null */
  draft: z.boolean().nullable(),
  /** rovo の task_pr_merge でマージ済みか（人が GitHub 上でマージした場合は付かない） */
  merged: z.boolean(),
  /**
   * GitHub での今の状態。閲覧時に gateway が閲覧者のトークンで取る（短いキャッシュあり）。
   * 取れない（権限・レート制限・障害・タイムアウト）ときや、照会しない状態のタスクは "unknown"。
   * `merged` が true なら常に "merged"（rovo の task_pr_merge の記録を優先する）。
   */
  state: z.enum(PR_STATES),
});
export type PrDto = z.infer<typeof PrDtoSchema>;

/**
 * **閲覧者に見えるタスク 1 件**。task_id・owner_login・repository・pr_url・model・title を持つのはこの型だけで、
 * 閲覧権限の無いタスクにはこの型を使わない（個別の行を作らず、`HiddenTasksDto` の件数と合計だけにする。D7）。
 * 個別の行は全項目が必須で、「一部を伏せた行」は表現できない。
 */
export const VisibleTaskDtoSchema = z.strictObject({
  task_id: ulidSchema,
  owner_login: loginSchema,
  repository: repositorySchema,
  title: untrustedText(LIMITS.title),
  status: taskStatusSchema,
  model: modelIdSchema,
  effort: effortSchema,
  created_at: isoTimeSchema,
  started_at: isoTimeSchema.nullable(),
  ended_at: isoTimeSchema.nullable(),
  updated_at: isoTimeSchema,
  cost: TaskCostDtoSchema,
  pr: PrDtoSchema.nullable(),
  reason: reasonCodeSchema.optional(),
  /** "setup" は準備（ブランチ・Draft PR の作成など）で失敗したこと */
  failure_phase: z.literal("setup").optional(),
});
export type VisibleTaskDto = z.infer<typeof VisibleTaskDtoSchema>;

/**
 * タイムラインの灰の点（consult。D9）。内容は持たない。対象のリポジトリが無いので権限の判定は要らず、
 * 「誰が・いつ・どのモデルで・いくら」だけ。
 */
export const ConsultPointDtoSchema = z.strictObject({
  consult_id: consultIdSchema,
  owner_login: loginSchema,
  at: isoTimeSchema,
  model: modelIdSchema,
  cost_usd: usdSchema,
  /** 実費が分からず予約額で閉じた consult か */
  estimated: z.boolean(),
});
export type ConsultPointDto = z.infer<typeof ConsultPointDtoSchema>;

/**
 * 閲覧権限の無いタスクの扱い（D7）。**件数と全員分の合計の費用だけ**。
 * 個別の識別子・題名・人・リポジトリ・PR・モデル・時刻を持つ項目をこの型に足してはならない
 * （strict なので、足した応答は弾かれる）。
 */
export const HiddenTasksDtoSchema = z.strictObject({
  count: countSchema,
  cost_usd: usdSchema,
});
export type HiddenTasksDto = z.infer<typeof HiddenTasksDtoSchema>;

/**
 * 閲覧者本人の予算（D8。「あなたの残り」）。他人の枠は出さない。月は UTC。
 * `startable` = min(max_concurrent_tasks, concurrency_limit - running_slots)（0 未満は 0）。
 */
export const BudgetMeDtoSchema = z.strictObject({
  /**
   * 月の上限（USD。MCP の budget_status の monthly_budget_usd と同じ値）。gateway は常に返す。
   * 上限を足す前の gateway の応答でも画面が壊れないよう optional（無いときは画面が逆算に戻る）。
   */
  monthly_budget_usd: usdSchema.optional(),
  remaining_usd: usdSchema,
  spent_usd: usdSchema,
  estimated_usd: usdSchema,
  reserved_usd: usdSchema,
  max_concurrent_tasks: countSchema,
  concurrency_limit: countSchema,
  running_slots: countSchema,
  startable: countSchema,
});
export type BudgetMeDto = z.infer<typeof BudgetMeDtoSchema>;

/** consult を含む月の予算の実績（全員分。D8 の `BudgetActualDto`）。実費と推定を分ける。 */
export const BudgetActualDtoSchema = z.strictObject({
  spent_usd: usdSchema,
  estimated_usd: usdSchema,
});
export type BudgetActualDto = z.infer<typeof BudgetActualDtoSchema>;

/** モデル別の費用（月・全員分の集計）。タスクと consult を分ける。 */
export const ModelCostDtoSchema = z.strictObject({
  model: modelIdSchema,
  task_cost_usd: usdSchema,
  consult_cost_usd: usdSchema,
});
export type ModelCostDto = z.infer<typeof ModelCostDtoSchema>;

export const SCOPES = ["all", "me"] as const;

/** `GET /dashboard/api/overview` の応答。 */
export const OverviewDtoSchema = z.strictObject({
  generated_at: isoTimeSchema,
  /** タイムラインの範囲（クライアントが渡した from / to。幅は最大 36 時間） */
  range: z.strictObject({ from: isoTimeSchema, to: isoTimeSchema }),
  scope: z.enum(SCOPES),
  viewer: z.strictObject({ login: loginSchema }),
  /** タイムラインと表に出す、閲覧者に見えるタスクだけ */
  tasks: z.array(VisibleTaskDtoSchema).max(LIMITS.overviewTasks),
  consults: z.array(ConsultPointDtoSchema).max(LIMITS.overviewConsults),
  budget: BudgetMeDtoSchema,
  /** 月（UTC）の集計。全員分で、見えないタスクを含む */
  month: z.strictObject({
    period: periodSchema,
    /** タスクの費用の合計（全員分・見えないタスクを含む） */
    task_cost_usd: usdSchema,
    budget_actual: BudgetActualDtoSchema,
    /** 上の合計に含まれる、権限の無いタスクの件数と合計（個別の情報は無い） */
    hidden_tasks: HiddenTasksDtoSchema,
  }),
  models: z.array(ModelCostDtoSchema).max(LIMITS.models),
});
export type OverviewDto = z.infer<typeof OverviewDtoSchema>;
