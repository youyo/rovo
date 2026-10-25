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
  // task_list 用（古い TaskDO の snapshot には無い。無い行は stage などを省いて返す）
  kind: z.enum(["task", "review"]).optional(),
  /** review の段（waiting / commands / reviewing / posting / done）。review 以外は null */
  review_stage: z
    .enum(["waiting", "commands", "reviewing", "posting", "done"])
    .nullable()
    .optional(),
  reached_verifying: z.boolean().optional(),
  /** 検証の試行回数（検証の結果が出たもののうち最大の attempt）。無ければ null */
  verify_attempt: z.number().int().min(1).max(1_000).nullable().optional(),
  /** review の対象の PR */
  target_pr_number: z.number().int().nullable().optional(),
  target_pr_url: z.string().max(500).nullable().optional(),
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

export type ListOwnTasksQuery = {
  ownerId: number;
  /** active: 終端でないもの。recent: 終端でないもの + endedSince 以降に終端になったもの（epoch ms） */
  scope: "active" | "recent";
  endedSince: number;
  limit: number;
};

/** 新しい順の rows（最大 limit 件）と、まだ続きがあるか */
export type ListOwnTasksResult =
  | { ok: true; rows: TaskIndexRow[]; truncated: boolean }
  | { ok: false; code: "invalid_input" };

export type ListWaitingQuery = {
  /** 閲覧者に見える repository id の集合。絞った後でページを切る */
  repoIds: number[];
  /** 指定したら、その所有者のタスクだけ（「自分」への絞り込み） */
  ownerId?: number;
  limit: number;
  offset: number;
};

/**
 * 「待ち」のタスク（日付に関係なく）。total / rows は見えるタスク、hidden は権限の無い待ちの件数だけ（個別の値は返さない）。
 * 待ち = 状態が INPUT_REQUIRED、または COMPLETED で PR があり Draft でなく rovo の記録で未マージ。
 * 人が GitHub 上でマージ・クローズした PR は索引に反映されないので、呼び出し側が GitHub の状態で外す。
 */
export type ListWaitingResult =
  | { ok: true; total: number; hidden: number; rows: TaskIndexRow[] }
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

/**
 * consult の索引（DirectoryDO の consult_index。D9 / M3b）に入れる 1 件の写し。
 * 「誰が・いつ・どのモデルで・いくら」だけを持つ。質問・system・応答の本文は入れない（strict なので余計な項目は弾かれる）。
 * 対象のリポジトリが無いので、権限の判定には使わない。時刻は epoch ms、費用は micro USD（整数）。
 */
export const ConsultIndexSnapshotSchema = z.strictObject({
  consult_id: z.string().regex(/^consult-[0-9A-HJKMNP-TV-Z]{26}$/),
  owner_id: z.number().int(),
  owner_login: z.string().max(200),
  at: z.number().int(),
  model: z.string().min(1).max(200),
  cost_micro: z.number().int().min(0),
  /** 実費が分からず予約額（や見積もり）で閉じた consult */
  estimated: z.boolean(),
});
export type ConsultIndexSnapshot = z.infer<typeof ConsultIndexSnapshotSchema>;

export type ConsultIndexRow = ConsultIndexSnapshot & { revision: number };

export type UpsertConsultResult = UpsertTaskResult;

/** consult の一覧の件数の上限 */
export const MAX_CONSULT_LIMIT = 2_000;

export type ListConsultsQuery = {
  /** [from, to)（epoch ms） */
  from: number;
  to: number;
  /** 指定したら、その所有者の consult だけ（「自分」への絞り込み） */
  ownerId?: number;
  limit: number;
};

export type ListConsultsResult =
  | { ok: true; rows: ConsultIndexRow[] }
  | { ok: false; code: "invalid_input" };

export type SummarizeConsultsResult =
  | {
      ok: true;
      count: number;
      /** 全員分の合計。estimated_micro は、そのうち見積もりで閉じた分（内数） */
      cost_micro: number;
      estimated_micro: number;
      models: { model: string; cost_micro: number }[];
    }
  | { ok: false; code: "invalid_input" };

export type SummarizeByOwnerResult =
  | {
      ok: true;
      /** repoIds に repository_id があるタスクだけの、owner_login ごとの集計（login 順） */
      visible: { owner_login: string; task_cost_micro: number; task_count: number }[];
      /** 権限の無い（NULL を含む）タスク。件数と合計だけで、持ち主は返さない */
      hidden: { count: number; cost_micro: number };
    }
  | { ok: false; code: "invalid_input" | "too_many_repo_ids" };

export type SummarizeConsultsByOwnerResult =
  | { ok: true; owners: { owner_login: string; cost_micro: number }[] }
  | { ok: false; code: "invalid_input" };

export type VisibleModelsResult =
  | { ok: true; models: string[] }
  | { ok: false; code: "invalid_input" | "too_many_repo_ids" };

/** listOwnerIds が返す利用者 ID の上限（超えたら truncated: true。呼び出し側は台帳の合計を諦める） */
export const MAX_OWNER_IDS = 50;

export type ListOwnerIdsResult =
  | { ok: true; ids: number[]; truncated: boolean }
  | { ok: false; code: "invalid_input" };
