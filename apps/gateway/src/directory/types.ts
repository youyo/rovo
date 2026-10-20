import { z } from "zod";

/**
 * ダッシュボードの索引（DirectoryDO の task_index）に入れる 1 タスクの写し（docs/specs/dashboard.md D10）。
 * 一覧・集計・タイムラインに要る値だけを持つ。instructions・base_sha・acceptance_criteria などの入力や、
 * トークン・PR の本文は入れない（索引は本体のコピーなので、持つ値が増えるほど漏洩の面が広がる）。
 * **索引は権限の根拠にしない**: repository_id は絞り込みに使うだけで、詳細は TaskDO の今の値で認可し直す。
 * 時刻は epoch ms。費用は micro USD（整数）。
 */
export const TaskIndexSnapshotSchema = z.strictObject({
  task_id: z.string().min(1).max(64),
  owner_id: z.number().int(),
  owner_login: z.string().max(200),
  repository: z.string().max(300),
  /** NULL を許す（呼び出し側が渡さなかったタスク）。NULL の行はどの repoIds にも一致しない（fail closed） */
  repository_id: z.number().int().nullable(),
  title: z.string().max(2_000),
  status: z.string().min(1).max(40),
  model: z.string().max(200),
  effort: z.string().max(40),
  created_at: z.number().int(),
  updated_at: z.number().int(),
  started_at: z.number().int().nullable(),
  ended_at: z.number().int().nullable(),
  cost_micro: z.number().int().min(0),
  input_tokens: z.number().int().min(0),
  output_tokens: z.number().int().min(0),
  cache_read_tokens: z.number().int().min(0),
  cache_write_tokens: z.number().int().min(0),
  pr_number: z.number().int().nullable(),
  pr_url: z.string().max(500).nullable(),
  pr_draft: z.boolean().nullable(),
  pr_merged: z.boolean(),
  reason: z.string().max(200).nullable(),
  /** "setup" は準備（ブランチ・Draft PR の作成など）で失敗したこと */
  failure_phase: z.literal("setup").nullable(),
  deps_cache: z.string().max(40).nullable(),
  sandbox_runtime_ms: z.number().int().min(0).nullable(),
});
export type TaskIndexSnapshot = z.infer<typeof TaskIndexSnapshotSchema>;

/** 索引のシングルトンの DO の名前 */
export const DIRECTORY_NAME = "directory";

export type TaskIndexRow = TaskIndexSnapshot & { revision: number };

export type UpsertTaskResult =
  | { ok: true; applied: boolean; revision: number }
  | { ok: false; code: "invalid_input" };

/** repoIds の上限（D5。超えたら fail closed） */
export const MAX_REPO_IDS = 10_000;
/** 1 回の list で返す件数の上限 */
export const MAX_LIST_LIMIT = 500;

export type ListTasksQuery = {
  /** 閲覧者に見える repository id の集合。絞った後でページを切る */
  repoIds: number[];
  /** タイムラインの範囲（epoch ms）。この範囲と重なるタスク（終了していなければ重なる扱い） */
  from: number;
  to: number;
  /** 指定したら、その所有者のタスクだけ（「自分」への絞り込み） */
  ownerId?: number;
  limit: number;
  offset: number;
};

export type ListTasksResult =
  | { ok: true; total: number; rows: TaskIndexRow[] }
  | { ok: false; code: "invalid_input" | "too_many_repo_ids" };

export type SummarizeQuery = {
  repoIds: number[];
  /** created_at が [from, to) のタスクを数える（月の集計用） */
  from: number;
  to: number;
};

export type SummarizeResult =
  | {
      ok: true;
      visible: { count: number; cost_micro: number };
      /** 権限の無い（repoIds に無い・repository_id が NULL の）タスク。件数と合計だけで、個別の値は返さない */
      hidden: { count: number; cost_micro: number };
      /** 全員分（見えないタスクを含む）のモデル別の費用 */
      models: { model: string; cost_micro: number }[];
    }
  | { ok: false; code: "invalid_input" | "too_many_repo_ids" };
