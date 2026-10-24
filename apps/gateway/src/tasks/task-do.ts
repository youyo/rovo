import { DurableObject } from "cloudflare:workers";
import {
  type AuditEventName,
  type AuditFields,
  type AuditRecord,
  audit,
  type CommandProgressEvent,
} from "@rovo/audit";
import { LIMITS, STRUCTURED_EVENT_TYPES } from "@rovo/dashboard-contract";
import { type Effort, isSandboxPromotionReason } from "@rovo/models";
import type { z } from "zod";
import { count, depsCacheStatus, depsMissReason, mapAgentEvent } from "../agent/agent-events";
import type {
  AgentRpc,
  EventsPage,
  ResultDto,
  ReviewResultDto,
  StartResult,
  TaskSpec,
  UsageDto,
} from "../agent/contract";
import { DASHBOARD_EVENT_TYPES } from "../dashboard/events";
import { indexBackoffMs } from "../directory/backoff";
import { DIRECTORY_NAME, type TaskIndexSnapshot, type UpsertTaskResult } from "../directory/types";
import {
  applyManagedBlock,
  type BotAuthor,
  decryptString,
  detectDeps,
  encryptString,
  FALLBACK_COMMIT_IDENTITY,
  GitHubApiError,
  GitHubAppClient,
  GitHubRepoApi,
  importEncryptionKey,
  type PullInfo,
  READY_FALLBACK_NOTE,
  renderInitialBlock,
  renderReportBlock,
  resolveGitHubBaseUrls,
} from "../github";
import { type ModelSelection, modelSelectionSchema } from "../model-selection";
import { agentModelsOf, defaultModelOf, effortOf, effortRejection } from "../models";
import {
  type PublicPromotion,
  type PublicPromotionFailure,
  type PublicScaleDecision,
  sandboxInstanceName,
  sanitizePromotionFailures,
  sanitizePromotions,
  sanitizeScaleDecisions,
  sanitizeScaleStats,
} from "../sandbox-instance";
import { testDraftFallback, withTestScripts } from "../test-routes";
import { taskBudgetUsd } from "./budget";
import { BUDGET_EXTENSION_KIND, MAX_BUDGET_EXTENSIONS } from "./budget-question";
import { addColumnIfMissing } from "./sql-schema";
import { canTransition, isTaskStatus, isTerminal, type TaskStatus } from "./state";
import {
  buildTaskSummary,
  mergeUsagePublic,
  parsePrices,
  parseUsagePublic,
  summaryMetrics,
  type TaskSummary,
} from "./summary";
import { isTaskId, ulid } from "./ulid";
import type { ReviewPull, UserDO } from "./user-do";
import {
  type BudgetPolicy,
  computeFingerprint,
  computeReviewFingerprint,
  DEFAULT_BUDGET_POLICY,
  DEFAULT_REVIEW_POLICY,
  isValidIdempotencyKey,
  MAX_ANSWER_LENGTH,
  MAX_CONCURRENT_WAITERS,
  MAX_EVENTS_PER_WAIT,
  MAX_STEER_LENGTH,
  parseCursor,
  parseTimeoutSeconds,
  type ReviewPolicy,
  reviewInputSchema,
  taskInputSchema,
  WAIT_RETRY_AFTER_SECONDS,
} from "./validation";

/** ワーカーに許す実行時間（開始から）。AgentDO も同じ上限で丸める。 */
export const AGENT_DEADLINE_MS = 2 * 60 * 60 * 1000;
/** alarm の間隔。start / cancel の再送、取り込み、精算の再試行に使う。 */
export const ALARM_INTERVAL_MS = 10_000;
/** INPUT_REQUIRED の間で、配送すべきものが無いときの alarm の間隔（AgentDO の期限の監視と、トークンの更新の確認だけ）。 */
export const INPUT_REQUIRED_ALARM_INTERVAL_MS = 60_000;
/** 回答待ちの上限（AgentDO が数える。7.3）と、TaskDO がバックストップとして待つ猶予。 */
export const INPUT_TIMEOUT_MS = 24 * 60 * 60 * 1000;
export const INPUT_TIMEOUT_GRACE_MS = 10 * 60 * 1000;
const INPUT_REQUIRED_SINCE_KEY = "input_required_at";
/** 実行中のコマンドの最新の進捗（meta の 1 行。履歴の events には入れない） */
const PROGRESS_KEY = "command_progress";
/** task_wait が待機中に AgentDO から取り込み直す間隔。 */
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const EVENT_PAGE_LIMIT = 100;
/** task_wait が入口の取り込みを最低限待つ時間。timeout 0 や終端のタスクでも、速い応答は拾う。 */
const SYNC_GRACE_MS = 500;
/** task_result が AgentDO の getResult を待つ上限。超えたら upstream_unavailable（MCP の呼び出しを固めない）。 */
const RESULT_TIMEOUT_MS = 10_000;
/** CREATING（初期コミット・ブランチ・Draft PR・start の受理）に許す時間。超えたら FAILED（setup_timeout）。 */
export const SETUP_TIMEOUT_MS = 10 * 60 * 1000;
/** Installation Token の期限のこれだけ前になったら、新しいトークンを発行して渡す。 */
export const TOKEN_REFRESH_BEFORE_MS = 15 * 60 * 1000;
/** GitHub 呼び出しの再試行間隔: 5s, 10s, 20s, 40s, 60s（上限）。Retry-After があればそれを尊重する。 */
const BACKOFF_BASE_MS = 5_000;
const BACKOFF_MAX_MS = 60_000;
const RETRY_AFTER_MAX_MS = 10 * 60 * 1000;
/** 終端の PR 更新を諦めるまでの試行回数（諦めてもトークンの失効は行う）。 */
const FINALIZE_MAX_ATTEMPTS = 6;
/**
 * task_result は、PR があるタスクの終了処理（PR 本文の更新・トークンの失効 = finalize_done）が済むまで not_ready を返す。
 * 終了処理が恒久的に失敗しても待ち続けないよう、終端から数えてこの時間を過ぎたら従来どおり返す。
 */
const RESULT_FINALIZE_WAIT_MS = 30_000;
/** R2 アーカイブを諦めるまでの試行回数（諦めたら archive_failed を監査ログに出して打ち切る）。FINALIZE_MAX_ATTEMPTS と同じ。 */
export const ARCHIVE_MAX_ATTEMPTS = 6;
/** R2 への 1 回の put を待つ上限。超えたら失敗として再試行に回す（advance を固めない）。 */
const ARCHIVE_PUT_TIMEOUT_MS = 15_000;
/** トークンの暗号文の AAD。task id を含め、他のタスクの暗号文を差し込まれても復号できないようにする。 */
const tokenAad = (taskId: string) => `installation_token:${taskId}`;
/** 終端のトークン失効を諦めるまでの試行回数（諦めたら記録を閉じて token_revoke_failed を出す）。 */
const REVOKE_MAX_ATTEMPTS = 6;
/** Git の SHA-1（40 桁）/ SHA-256（64 桁）。コンテナ由来の値は、この形でなければ捨てる。 */
const SHA_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const safeSha = (v: string | undefined): string | undefined =>
  v !== undefined && SHA_RE.test(v) ? v : undefined;
/** GitHub が Draft PR を作れないときの 422 の文言（"Draft pull requests are not supported in this repository." など）。 */
const DRAFT_UNSUPPORTED_RE =
  /draft pull requests? (are|is) (not (supported|available|allowed)|unavailable)/i;
/** 作者（App の bot）を永続化するキー（DO の storage）。一度決めたら変えない（再送の spec と初期コミットを揃える） */
const BOT_IDENTITY_KEY = "bot_identity";
/** 1 回の取り込みで読むページ数の上限（残りは次の alarm / wait で取り込む）。 */
const MAX_PAGES_PER_SYNC = 20;
/** Directory への 1 回の配送を待つ上限。超えたら失敗として再試行に回す（alarm を固めない） */
const INDEX_TIMEOUT_MS = 5_000;
/** 索引の snapshot の文字列の上限（packages/dashboard-contract の LIMITS と同じ。超えた値は送る前に切り詰める） */
const INDEX_LIMITS = { title: 300, repository: 140, login: 39, model: 100, reason: 100, url: 300 };

/** 文字列を n 文字（コードポイント単位）までに切り詰める。 */
function clip(text: string, n: number): string {
  return text.length <= n ? text : Array.from(text).slice(0, n).join("");
}

/** TaskDO.ensureCreated の入力。task_start の入力に、タスク ID と所有者・GitHub 側の ID を足したもの。 */
export type EnsureCreatedInput = z.input<typeof taskInputSchema> & {
  task_id: string;
  owner_id: number;
  owner_login: string;
  /** M3 以降で渡される。GitHub の repository ID / Installation ID。 */
  repository_id?: number | null;
  installation_id?: number | null;
  /**
   * モデルの選び方の記録（gateway が task_start で model を決めたときの mode / reason など）。新しい RPC は作らず、作成時の入力に足す。
   * 省略可（古い呼び出し・直接の作成）。chosen は model と一致していなければならない。
   */
  model_selection?: ModelSelection;
};

/** task_review の対象の PR（rovo が開いた PR ではない。task_result の pr の代わり） */
export type TargetPr = { repository: string; number: number; head_sha: string; url: string };

/**
 * レビューの段の段階（docs/specs/worker-review.md「状態の遷移」）。task_review で使うのは
 * waiting（AgentDO がまだ段に入っていない）/ commands（review_commands を流している）/ reviewing（モデルを待っている・投稿の前）/
 * done（レビューが得られた）/ skipped（予算・失敗・取消しで飛ばした）。
 */
export type ReviewStage = "waiting" | "commands" | "reviewing" | "done" | "skipped";

/** task_result の review（公開用。snake_case）。commands の output と body は、service が非信頼の囲みで包む */
export type ReviewResultView = {
  stage: "done" | "skipped";
  model: string;
  /** 投稿したレビューの URL。投稿できなかった・投稿しなかったときは null */
  comment_url: string | null;
  must_fix_count: number;
  suggestion_count: number;
  /** 修正の回は未実装（task_review は修正しない）ので常に false */
  fix_applied: false;
  commands: {
    argv: string[];
    exit_code: number;
    timed_out: boolean;
    output: string;
    duration_ms?: number;
    skipped?: true;
  }[];
  commands_unavailable: boolean;
  /** 飛ばした理由の固定コード（model_error / model_rejected / timeout / budget / invalid_response / tool_rounds_exceeded） */
  failure?: string;
  /** 修正のあとの再実行の結果（修正の回は未実装・task_review は修正しないので常に null） */
  final: null;
  /** レビューに使った費用（作業の費用と分けて見せる） */
  usage: {
    cost_usd: number;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_write_tokens: number;
    estimated: boolean;
  };
  /** 投稿できなかったときだけ: 投稿するはずだった本文（クライアントが読める） */
  body?: string;
};

export type TaskView = {
  task_id: string;
  owner_id: number;
  status: TaskStatus;
  /** task_review のタスクだけ "review"（通常のタスクには付かない） */
  kind?: "review";
  /**
   * レビューの段の段階とモデル。task_review のタスクと、worker_review のタスク（fix_rounds・rounds_used も付く。
   * 修正の回は未実装なので rounds_used は 0）に付く。client_review のタスクには付かない
   */
  review?: { stage: ReviewStage; model: string; fix_rounds?: number; rounds_used?: number };
  /** task_review のタスクだけ: 対象の PR */
  target_pr?: TargetPr;
  repository: string;
  title: string;
  draft_pr_url: string | null;
  /** 全体のテストとレビューをどこで行うか（task_start で指定。既定 client_review） */
  review_policy: ReviewPolicy;
  /** 予算に近づいたときの扱い（task_start で指定。既定 ask = 止めずにクライアントへ延長を聞く / stop = 止める）。この変更より前のタスクは stop */
  budget_policy: BudgetPolicy;
  /** ワーカーのモデル（task_start の model。省略時は既定のモデル。D10） */
  model: string;
  /** ワーカーのモデルの思考レベル（task_start の effort で上書きした値、無ければモデルごとの既定。タスクの開始時の値。考える量が多いほど出力トークン＝費用が増える） */
  effort: Effort;
  /** モデルの選び方（task_start の mode: explicit | auto と、理由の固定コード）。記録の無いタスク（古いタスク）には付かない */
  model_selection?: ModelSelection;
  /** task_start で明示した Sandbox の大きさ。省略したタスクは null（agent の既定。実際に使った大きさは task_result の usage.sandbox_instance） */
  sandbox_instance: string | null;
  created_at: string;
  updated_at: string;
  /** 最後のイベントの seq（不透明な cursor 文字列）。 */
  latest_cursor: string;
  /** ワーカーの未回答の質問（終端でないとき）。message はワーカーが作った非信頼データ */
  pending_question: {
    question_id: string;
    message: string;
    options: string[];
    /** budget_extension: 予算の延長の質問（rovo が数値だけで書く固定文。ワーカーの質問ではない）。ワーカーの質問（ask_parent）には付かない */
    kind?: "budget_extension";
  } | null;
};

/** イベントの中身。RPC で返せるよう、値はプリミティブに限る。 */
export type EventPayload = Record<string, string | number | boolean | null>;

export type TaskEvent = {
  seq: number;
  type: string;
  payload: EventPayload;
  created_at: string;
};

export type EnsureCreatedResult =
  | { ok: true; created: boolean; task: TaskView }
  | { ok: false; code: "conflict" | "expired" }
  /** message は、入力を直すための説明（effort がそのモデルに対応していないときの、使えるレベルの一覧など）。無いこともある */
  | { ok: false; code: "invalid_input"; message?: string };

/** UserDO が予約を照合するための最小の問い合わせ結果。 */
export type TaskInspection =
  | { kind: "uncreated" }
  | { kind: "abandoned" }
  | { kind: "created"; status: TaskStatus; stopped: boolean }
  /**
   * Phase 1 で作られたタスク（agent_link が無い）。ワーカーは存在せず、精算するものも無い。
   * UserDO は abandoned と同じ扱いで予約を回収してよい。
   */
  | { kind: "legacy" };

export type AbandonResult =
  | { result: "abandoned" }
  | { result: "created"; status: TaskStatus; stopped: boolean };

/** task_result の中身（公開用。snake_case）。 */
export type ResultView = {
  status: TaskStatus;
  /** task_review のタスクだけ "review" */
  kind?: "review";
  /** task_review と worker_review のタスクだけ: レビューの結果 */
  review?: ReviewResultView;
  /** task_review のタスクだけ: 対象の PR（pr の代わり） */
  target_pr?: TargetPr;
  reason?: string;
  /**
   * 失敗した段階。"setup" は準備（ブランチ・Draft PR の作成など。runSetup）で FAILED になったこと。
   * その場合 reason は準備の失敗のコード（base_sha_not_found など）。エージェントが動く前なので結果は合成される。
   */
  failure_phase?: "setup";
  summary: string;
  verification: {
    commands: { argv: string[]; cwd?: string; timeout_seconds?: number }[];
    results: {
      argv: string[];
      exit_code: number;
      timed_out: boolean;
      output: string;
      /** コマンド 1 本の所要時間（ms。タイムアウトを含む）。古い agent の結果には無い */
      duration_ms?: number;
    }[];
    verified: boolean;
    attempts: number;
    commit_sha?: string;
  };
  warnings: string[];
  /** タスクの review_policy（task_start で指定。client_review のとき、完了で rovo が PR を Ready にする） */
  review_policy: ReviewPolicy;
  /** 予算に近づいたときの扱い（task_start の budget_policy。ask | stop） */
  budget_policy: BudgetPolicy;
  /** ワーカーのモデル（task_start の model。省略時は既定のモデル。D10） */
  model: string;
  /** ワーカーのモデルの思考レベル（task_start の effort で上書きした値、無ければモデルごとの既定。タスクの開始時の値） */
  effort: Effort;
  /** モデルの選び方（task_start と同じ記録。無いタスクには付かない） */
  model_selection?: ModelSelection;
  /** Draft PR の情報。PR が無い（作成前に失敗した、Phase 2 のタスク）なら null */
  pr: {
    number: number;
    url: string;
    /** Draft か。task_pr_ready の成功で false になる（GitHub 上で人が Ready にした場合は、task_pr_ready を呼ぶと反映される） */
    draft: boolean | null;
    /** task_pr_merge でマージ済みか */
    merged: boolean;
    /** 変更なしで終わったので rovo が Draft PR を閉じた（閉じたときだけ true が付く） */
    closed_empty?: true;
    /** GitHub から読んだ PR の head。まだ読めていなければ null */
    head_sha: string | null;
    /** head が検証済みの SHA と一致するか。比較できない（未読・検証済みの SHA なし）なら null */
    head_matches_verified: boolean | null;
  } | null;
  patch?: string;
  diffstat?: string;
  patch_too_large: boolean;
  usage: {
    cost_usd: number;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_write_tokens: number;
    /** ワーカーが使った web の回数 */
    web: { search: number; fetch: number; browse: number };
    /** 依存関係のキャッシュ（D14）の結果。agent がカウンタを読めたときだけ付く */
    deps_cache?: "hit" | "miss" | "built" | "disabled";
    /** deps_cache が "miss" のときだけ付く: キャッシュを使えなかった理由の固定コード（ensure_failed / ensure_timeout / build_failed / build_timeout / cooldown / snapshot_unsupported / snapshot_failed / restore_failed / cert_missing / move_failed / invalid_deps） */
    deps_cache_miss_reason?: string;
    /** deps_cache が付くときは常に付く: キャッシュを作るのにかかった時間（ms。作っていなければ 0。Sandbox の時間の推定にも含まれる） */
    cache_build_ms?: number;
    /** Sandbox を動かした累計の時間（ms。task_summary の sandbox_runtime_ms と同じもの）。agent がカウンタを読めたときだけ付く */
    sandbox_runtime_ms?: number;
    /** 最初にコンテナを起動した大きさ（standard-2 など）。Sandbox を一度も起動しなかったタスク・agent が報告しなかったタスクには付かない。昇格しても変わらない */
    sandbox_instance?: string;
    /** 重いコマンド（テスト・ビルドなど）の初回に昇格した先の大きさ（standard-3 など）。昇格していなければ付かない。昇格前の時間は sandbox_instance、残りは sandbox_promoted_to の単価で推定費用に按分される */
    sandbox_promoted_to?: string;
    /** 昇格した時刻（epoch ms） */
    sandbox_promoted_at?: number;
    /** 昇格した時点までの Sandbox の時間（ms。sandbox_runtime_ms のうち昇格前の分） */
    sandbox_runtime_ms_before_promotion?: number;
    /** 昇格を見送った・失敗した理由の固定コード（fixed_instance / already_large / state_unreadable / snapshot_unsupported / snapshot_failed / start_failed / cert_missing / workspace_mismatch / fallback_failed）。最後に残したもの（あとで昇格が成功しても消さない）。設定で無効のときは付かない */
    sandbox_promotion_reason?: string;
    /** 成功した昇格の履歴（古い順）。trigger は agent（ワーカーが sandbox_scale_up で頼んだ）/ rule（重いコマンドの規則＝保険）/ verification（検証コマンド）、rule_match は規則で上がったときだけ（固定の表の名前。コマンドの文字列は入らない）、runtime_ms_before はその昇格までの Sandbox の累計時間（ms）。昇格していなければ付かない。ワーカーの自由文（reason）は残らない */
    sandbox_promotions?: {
      to: string;
      at: number;
      trigger: string;
      runtime_ms_before: number;
      rule_match?: string;
    }[];
    /** ワーカーが sandbox_scale_up で上げたあと、規則で重いと判定されたコマンドを実行した本数。0 なら、規則（保険）が要らなかった = 不要だったかもしれない昇格。ワーカーが上げていなければ付かない */
    sandbox_heavy_commands_after_agent_scale_up?: number;
    /** そのうち、ワーカーが規則の昇格先以上に上げていたために規則が昇格しなくて済んだ本数（ワーカーの見立ての的中）。ワーカーが上げていなければ付かない */
    sandbox_heavy_commands_covered_by_agent?: number;
    /** 昇格の試みが見送り・失敗になった記録（古い順、最大 8 件）。trigger は clef（古いタスクは agent / rule / verification）、reason は sandbox_promotion_reason と同じ固定コード。Clef の失敗（判断できなかった）は入らない（sandbox_scale_clef_failures）。無ければ付かない */
    sandbox_promotion_failures?: { trigger: string; reason: string }[];
    /** Clef が Sandbox の大きさを判断した回数（コマンドの前に「今の大きさで足りるか」を聞いた回数）。Clef を呼ばなかったタスクには付かない */
    sandbox_scale_decisions?: number;
    /** そのうち、上げた（昇格に成功した）回数 */
    sandbox_scale_raised?: number;
    /** Clef が失敗した（再試行しても判断できず、今の大きさのまま実行した）回数 */
    sandbox_scale_clef_failures?: number;
    /** 上げなかったのに長くかかった（60 秒超）コマンドの数。Clef の見落としの候補 */
    sandbox_scale_slow_not_raised?: number;
    sandbox_scale_skipped_light?: number;
    /** Clef の判断ごとの記録（古い順、直近 50 件まで）。from は判断したときの大きさ、to は上げた先（上げなかった・昇格に失敗した・Clef が失敗したときは null）、heavy / fast4 / choice は確率、model は答えを使ったモデル（flash / clef）、clef_ms は Clef の所要、cmd_ms / exit_code はそのコマンドの実行時間と終了コード、cmd は argv[0] の basename だけ（argv の全体は残らない）。Clef の精度の振り返り用 */
    sandbox_scale_log?: PublicScaleDecision[];
  };
};

/** 結果の組み立て途中の形（review_policy は GitHub 側の情報と一緒に足す）。 */
type ResultCore = Omit<
  ResultView,
  "review_policy" | "budget_policy" | "model" | "effort" | "model_selection" | "kind" | "target_pr"
>;

/** TaskDO.ensureReviewCreated の入力（task_review）。PR は UserDO が利用者本人のトークンで読んだ値 */
export type EnsureReviewInput = {
  task_id: string;
  owner_id: number;
  owner_login: string;
  repository_id: number | null;
  installation_id: number | null;
  repository: string;
  pull_number: number;
  review_model: string;
  review_commands: { argv: string[]; cwd?: string; timeout_seconds?: number }[];
  budget_policy: BudgetPolicy;
  sandbox_instance?: string;
  pull: ReviewPull;
};

/** worker_review の状態（1 行）。レビューの指定と投稿の進み具合 */
type WorkerReviewRow = {
  review_model: string;
  /** JSON（task_start の review_commands。snake_case） */
  review_commands: string;
  review_fix_rounds: number;
  comment_url: string | null;
  /** 0: 未投稿 / 1: 投稿した / 2: 投稿できなかった（本文は結果で読める） / 3: 投稿するものが無い */
  posted: number;
  post_attempts: number;
  post_retry_at: number;
};

/** レビューの投稿の進み具合の持ち主（task_review の review_link か worker_review の行） */
type ReviewPostTarget = {
  table: "review_link" | "worker_review";
  posted: number;
  post_attempts: number;
  post_retry_at: number;
  model: string;
  /** 投稿先の PR の番号。worker_review でタスクの PR が無ければ null */
  pull_number: number | null;
  /** 投稿に付ける commit。task_review は固定した head、worker_review は AgentDO の結果の headSha を使う（ここには無い） */
  head_sha?: string;
};

/** task_review の状態（1 行）。PR・差分・投稿の進み具合 */
type ReviewRow = {
  pull_number: number;
  pull_url: string;
  head_sha: string;
  head_ref: string;
  base_sha: string;
  pr_title: string;
  pr_body: string;
  review_model: string;
  /** JSON（task_review の review_commands。snake_case） */
  review_commands: string;
  /** 準備で取得した差分。NULL は未取得 */
  diff: string | null;
  diff_truncated: number;
  comment_url: string | null;
  /** 0 = まだ / 1 = 投稿した / 2 = 投稿を諦めた / 3 = 投稿しない（レビューが無い） */
  posted: number;
  post_attempts: number;
  post_retry_at: number;
};

/** gateway が取得する差分の上限（UTF-8 のバイト数）。レビューのモデルに渡す前に agent がさらに 200 KB に収める */
const REVIEW_DIFF_FETCH_MAX_BYTES = 1024 * 1024;
const FULL_SHA_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
/** PR の本文の保存の上限（agent がモデルに渡すのは先頭 4000 文字。行の大きさを抑える） */
const MAX_REVIEW_PR_BODY = 8_000;

/** task_pr_ready / task_pr_merge の入口で TaskDO が返す、対象と判定の結果。 */
export type PrContextResult =
  | {
      ok: true;
      repository: string;
      number: number;
      pr_url: string;
      branch: string;
      review_policy: ReviewPolicy;
      /** 検証済みの head の sha（終端で GitHub から読んだ値）。まだ読めていなければ null */
      head_sha: string | null;
    }
  | {
      ok: false;
      code: "not_found" | "not_ready" | "conflict" | "forbidden";
      message: string;
    };

/** UserDO での GitHub 操作の結果を TaskDO に記録する（状態の更新と監査）。 */
export type PrAction =
  /** changed: false は、すでにその状態だった（冪等な再実行）。状態は合わせるが、pr_ready / pr_merged は監査しない */
  | { kind: "ready" | "merge"; outcome: "done"; changed?: boolean }
  | { kind: "ready" | "merge"; outcome: "denied"; reason: string };

export type ResultOutcome =
  | { ok: true; result: ResultView }
  | { ok: false; code: "not_found" | "not_ready" | "upstream_unavailable" };

type StartState = "pending" | "accepted" | "rejected" | "skipped";
type CancelState = "none" | "pending" | "stopped";

type LinkRow = {
  spec: string;
  operation_id: string;
  start_state: StartState;
  cancel_state: CancelState;
  ingest_cursor: number;
  usage_seq: number;
  usage_micro: number;
  settled_seq: number;
  finished: number;
  /** AgentDO の cancel が stopped:true と共に返した最後のイベントの seq。無ければ NULL。 */
  final_seq: number | null;
  /** usage イベントから覚えた累計の数値（summary.ts の UsagePublic の JSON） */
  usage_public: string;
  /** task_summary を出したか（1 回だけ出す） */
  summary_logged: number;
  /** R2 アーカイブが済んだ（または打ち切った・スキップした）か。summary_logged とは別の印 */
  archive_done: number;
  archive_attempts: number;
  /** この時刻（epoch ms）までは再試行しない */
  archive_retry_at: number;
  /** ダッシュボードの索引の outbox（D10）。行を変えるたびに index_revision を上げ、alarm で配送して index_sent_revision を追いつかせる */
  index_revision: number;
  index_sent_revision: number;
  /** 配送の連続失敗の回数と、この時刻（epoch ms）までは再試行しない */
  index_attempts: number;
  index_retry_at: number;
};

export type GetStatusResult = { ok: true; task: TaskView } | { ok: false; code: "not_found" };

export type CancelResult =
  | { ok: true; status: TaskStatus; changed: boolean }
  | { ok: false; code: "not_found" };

/**
 * 予算の延長の質問への回答の結果: extended = 月の枠から延長分を予約して続ける / declined = クライアントが止めることを選んだ /
 * monthly_limit = 続けたいが月の枠が足りず予約できなかったので止まる / limit_reached = 延長の上限（2 回）に達していたので止まる。
 */
export type BudgetExtensionOutcome = "extended" | "declined" | "monthly_limit" | "limit_reached";

export type AnswerResult =
  | { ok: true; status: TaskStatus; budget_extension?: BudgetExtensionOutcome }
  | { ok: false; code: "not_found" | "conflict" | "invalid_input" | "unavailable" };

export type SteerResult =
  | { ok: true; status: TaskStatus; steer_id: string }
  | { ok: false; code: "not_found" | "conflict" | "invalid_input" };

/** steer を受け付ける状態（4.6）。 */
/** 索引の review_stage / verify_attempt を変えるイベント（取り込んだら索引の revision を上げる） */
const INDEX_STAGE_EVENTS: ReadonlySet<string> = new Set([
  "verification",
  "review_started",
  "review_commands_finished",
]);

const STEERABLE: ReadonlySet<TaskStatus> = new Set(["RUNNING", "VERIFYING", "INPUT_REQUIRED"]);

export type WaitResult =
  | {
      ok: true;
      status: TaskStatus;
      cursor: string;
      events: TaskEvent[];
      /** 同時待機数の上限に達したときだけ付く。クライアントはこの秒数だけ待ってから再試行する。 */
      retry_after_seconds?: number;
    }
  | { ok: false; code: "not_found" | "invalid_cursor" | "invalid_input" };

/** dashboardRead の結果。view は索引の snapshot と同じ形（入力・トークン・PR の本文を含まない）。 */
export type DashboardReadResult =
  | { ok: true; view: TaskIndexSnapshot }
  | { ok: false; code: "not_found" };

/** dashboardDetail の結果。view に加え、詳細の画面に要る設定（入力・トークンは含まない）。 */
export type DashboardDetailResult =
  | {
      ok: true;
      view: TaskIndexSnapshot;
      review_policy: ReviewPolicy;
      sandbox_instance: string | null;
      /** 予算の延長の承認待ち（INPUT_REQUIRED で、未回答の質問が budget_extension）か */
      awaiting_budget: boolean;
      /** モデルの選び方の記録。無いタスクには付かない */
      model_selection?: ModelSelection;
      /** 状態の遷移の記録に RUNNING / VERIFYING があるか（止まった段階の判定用。1 回の SQL で読む） */
      reached: { running: boolean; verifying: boolean };
    }
  | { ok: false; code: "not_found" };

/** dashboardEvents の結果。events は seq の昇順、created_at は epoch ms */
export type DashboardEventsResult =
  | {
      ok: true;
      events: { seq: number; type: string; payload: EventPayload; created_at: number }[];
      has_older: boolean;
    }
  | { ok: false; code: "not_found" };

/** 実行中のコマンドの最新の進捗（時刻は epoch ms）。履歴には積まず 1 件だけ上書きで持つ */
export interface DashboardProgress {
  command: string;
  cwd?: string;
  started_at: number;
  output_tail?: string;
  updated_at: number;
}

/** dashboardLatest の結果。recent は seq の昇順（直近 DASHBOARD_LATEST_RECENT 件）、latest_command は最新の command 1 件、progress は実行中の進捗 */
export type DashboardLatestResult =
  | {
      ok: true;
      recent: { seq: number; type: string; payload: EventPayload; created_at: number }[];
      latest_command: {
        seq: number;
        type: string;
        payload: EventPayload;
        created_at: number;
      } | null;
      progress: DashboardProgress | null;
    }
  | { ok: false; code: "not_found" };

type TaskRow = {
  id: string;
  owner_id: number;
  owner_login: string;
  repository: string;
  repository_id: number | null;
  installation_id: number | null;
  base_ref: string;
  base_sha: string;
  title: string;
  instructions: string;
  acceptance_criteria: string;
  constraints: string;
  verification_commands: string;
  fingerprint: string;
  status: string;
  draft_pr_url: string | null;
  review_policy: string;
  /** 予算に近づいたときの扱い。この変更より前のタスクは NULL（stop として扱う） */
  budget_policy: string | null;
  /** D10 より前のタスクは NULL（既定のモデルとして扱う） */
  model: string | null;
  /** D10 の思考レベル。開始時の値。それより前のタスクは NULL（現在の設定から求める） */
  effort: string | null;
  /** モデルの選び方の記録（JSON）。それより前のタスクは NULL */
  model_selection: string | null;
  /** 明示した Sandbox の大きさ。NULL は省略（agent の既定） */
  sandbox_instance: string | null;
  /** タスクの種類。NULL は通常のタスク、"review" は task_review */
  kind: string | null;
  created_at: number;
  updated_at: number;
};

/** ensureCreated が保存する、トークンを含まない taskSpec（branch・initialSha・gitCredential は start の直前に足す）。 */
type BaseSpec = Omit<TaskSpec, "branch" | "initialSha" | "gitCredential">;

type GithubRow = {
  branch: string;
  initial_sha: string | null;
  branch_ready: number;
  pr_number: number | null;
  pr_url: string | null;
  pr_draft: number | null;
  setup_done: number;
  setup_attempts: number;
  setup_retry_at: number;
  auth_warned: number;
  /** JSON の文字列配列（draft_pr_unavailable など。task_result と PR 本文に出す） */
  warnings: string;
  /** AgentDO が受け取りを確認した最新のトークン（git_token.id） */
  cred_delivered_id: number;
  head_sha: string | null;
  head_matches: number | null;
  body_done: number;
  finalize_attempts: number;
  finalize_retry_at: number;
  finalize_done: number;
  revoke_attempts: number;
  /** task_pr_merge でマージ済み */
  pr_merged: number;
  /** 変更なしで終わったので、空の Draft PR を rovo が閉じた */
  closed_empty: number;
  /** D14: TaskSpec.deps の JSON。"null" は lockfile なし（または読めなかった）。NULL は未取得（spec に載せない） */
  deps: string | null;
};

type TokenRow = { id: number; enc: string; expires_at: number; revoked: number; kind: string };

/** 再試行しても直らない失敗。TaskDO を FAILED にする。reason は公開される（秘密を入れない）。 */
class SetupFailure extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.name = "SetupFailure";
    this.reason = reason;
  }
}

/** 行の review_policy（未知の値は既定の client_review に倒す） */
function policyOf(row: Pick<TaskRow, "review_policy">): ReviewPolicy {
  return row.review_policy === "worker_review" ? "worker_review" : DEFAULT_REVIEW_POLICY;
}

/** 行の budget_policy（NULL = この変更より前のタスクは、止まる動きだったので stop） */
function budgetPolicyOf(row: Pick<TaskRow, "budget_policy">): BudgetPolicy {
  return row.budget_policy === "ask" ? "ask" : "stop";
}

/** 上限による終了の reason（監査の固定コード）。上限でなければ undefined。 */
function limitReason(to: TaskStatus, reason: unknown): string | undefined {
  // 予算の延長の質問への無応答は、予算の枠による停止（budget_exceeded）と監査で区別する（status_changed の reason と同じコード）
  if (to === "BUDGET_EXCEEDED") {
    return reason === "budget_extension_timeout" ? "budget_extension_timeout" : "budget_exceeded";
  }
  if (to === "FAILED" && (reason === "deadline" || reason === "input_timeout")) return reason;
  return undefined;
}

/** トークンの発行の失敗を、監査の固定コードにする（メッセージは使わない）。 */
function issueFailureCode(e: unknown): string {
  if (e instanceof GitHubApiError) return `github_error_${e.status}`;
  if (e instanceof SetupFailure) return e.reason;
  return "internal_error";
}

type EventRow = { seq: number; type: string; payload: string; created_at: number };

/** SQL の IN (...) に埋め込む、構造化イベントの型名（固定の定数だけ。入力は入らない） */
const STRUCTURED_TYPES_SQL = STRUCTURED_EVENT_TYPES.map((t) => `'${t}'`).join(",");
/** ダッシュボードの events API が返す型（固定の定数だけ） */
const DASHBOARD_TYPES_SQL = DASHBOARD_EVENT_TYPES.map((t) => `'${t}'`).join(",");
/** dashboardEvents の 1 回の上限（契約の LIMITS.eventsPerPage と同じ） */
const DASHBOARD_EVENTS_MAX = LIMITS.eventsPerPage;
/** dashboardLatest が読む直近の件数（「いまの手順」を作るのに足りる数。全件は読まない） */
const DASHBOARD_LATEST_RECENT = 30;
/** 「いまの手順」の候補にする型（固定の定数だけ） */
const DASHBOARD_NOW_TYPES_SQL = ["command", "edit", "commit", "web", "tool_start", "tool_end"]
  .map((t) => `'${t}'`)
  .join(",");

type Waiter = { wake: () => void; timer?: ReturnType<typeof setTimeout> };

const ABANDONED_KEY = "abandoned_at";

/**
 * タスク1件の状態とイベントログを持つ（SQLite バックエンド）。
 * 状態変更・seq 採番・イベント挿入は同じ transactionSync の中で行う。
 *
 * DO 間の呼び出し: TaskDO → UserDO は settleUsage / finishTask、UserDO → TaskDO は inspect /
 * abandonIfUncreated だけ。UserDO は TaskDO の取り込み（sync）を待たない（待つと相互に待って循環するため）。
 */
export class TaskDO extends DurableObject<Env> {
  /** wait 中の呼び出し。イベント追加時に全員を起こし、各自が自分の cursor で再読する。 */
  private waiters = new Set<Waiter>();
  /** wait の待機中に AgentDO から取り込み直す間隔（ms）。テストで差し替える。 */
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS;
  /** 進行中の取り込み。wait と alarm が同時に来ても、AgentDO への問い合わせは 1 本に束ねる。 */
  private syncing: Promise<void> | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.migrate();
    // 配送の意図が残っているのに alarm が無い（作成と setAlarm の間で止まった等）なら設定し直す。
    ctx.blockConcurrencyWhile(() => this.ensureAlarm());
  }

  /** テストで短くする。 */
  protected resultTimeoutMs = RESULT_TIMEOUT_MS;

  /** GitHub API への fetch。テストで偽の GitHub に差し替える。 */
  protected githubFetch: typeof fetch | undefined = undefined;

  /** ワーカーの RPC。テストで差し替える。 */
  protected agentStub(): AgentRpc {
    const taskId = this.getRow()?.id;
    if (!taskId) throw new Error("task row missing");
    // ENVIRONMENT=test のときだけ、E2E の台本を start の前に渡す（それ以外は素通し）
    return withTestScripts(this.env, this.env.AGENT_DO.getByName(taskId) as unknown as AgentRpc);
  }

  /** 所有者の UserDO。テストで差し替える。 */
  protected userStub(ownerId: number): DurableObjectStub<UserDO> {
    return this.env.USER_DO.getByName(String(ownerId));
  }

  private migrate(): void {
    const sql = this.ctx.storage.sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS task (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      id TEXT NOT NULL,
      owner_id INTEGER NOT NULL,
      owner_login TEXT NOT NULL,
      repository TEXT NOT NULL,
      repository_id INTEGER,
      installation_id INTEGER,
      base_ref TEXT NOT NULL,
      base_sha TEXT NOT NULL,
      title TEXT NOT NULL,
      instructions TEXT NOT NULL,
      acceptance_criteria TEXT NOT NULL,
      constraints TEXT NOT NULL,
      verification_commands TEXT NOT NULL DEFAULT '[]',
      fingerprint TEXT NOT NULL,
      status TEXT NOT NULL,
      draft_pr_url TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
    sql.exec(`CREATE TABLE IF NOT EXISTS events (
      seq INTEGER PRIMARY KEY,
      type TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`);
    sql.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    // Phase 1 で作られた DO に、Phase 2 の列を足す。
    addColumnIfMissing(
      this.ctx.storage.sql,
      "task",
      "verification_commands",
      "TEXT NOT NULL DEFAULT '[]'",
    );
    addColumnIfMissing(this.ctx.storage.sql, "events", "operation_id", "TEXT");
    addColumnIfMissing(this.ctx.storage.sql, "events", "agent_seq", "INTEGER");
    // AgentDO のイベントは (operation_id, agent_seq) で一意。取り込みの重複を DB でも防ぐ。
    sql.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS events_agent_seq ON events (operation_id, agent_seq) WHERE agent_seq IS NOT NULL",
    );
    // ワーカーとの配送状態（1 行）。start / cancel の意図、取り込みカーソル、精算の進み具合。
    sql.exec(`CREATE TABLE IF NOT EXISTS agent_link (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      spec TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      start_state TEXT NOT NULL,
      cancel_state TEXT NOT NULL,
      ingest_cursor INTEGER NOT NULL DEFAULT 0,
      usage_seq INTEGER NOT NULL DEFAULT 0,
      usage_micro INTEGER NOT NULL DEFAULT 0,
      settled_seq INTEGER NOT NULL DEFAULT 0,
      finished INTEGER NOT NULL DEFAULT 0
    )`);
    addColumnIfMissing(this.ctx.storage.sql, "agent_link", "final_seq", "INTEGER");
    // Phase 6 M3: 要約（task_summary）のための累計と、出力済みの印
    addColumnIfMissing(
      this.ctx.storage.sql,
      "agent_link",
      "usage_public",
      "TEXT NOT NULL DEFAULT '{}'",
    );
    addColumnIfMissing(
      this.ctx.storage.sql,
      "agent_link",
      "summary_logged",
      "INTEGER NOT NULL DEFAULT 0",
    );
    // Phase 6 M4: R2 アーカイブの状態（summary_logged と同じ agent_link に足す。finished / finalize_done とは独立）
    addColumnIfMissing(
      this.ctx.storage.sql,
      "agent_link",
      "archive_done",
      "INTEGER NOT NULL DEFAULT 0",
    );
    addColumnIfMissing(
      this.ctx.storage.sql,
      "agent_link",
      "archive_attempts",
      "INTEGER NOT NULL DEFAULT 0",
    );
    addColumnIfMissing(
      this.ctx.storage.sql,
      "agent_link",
      "archive_retry_at",
      "INTEGER NOT NULL DEFAULT 0",
    );
    // ダッシュボードの索引の outbox（M3a）。既存のタスクは 0/0（= 配送するものが無い）で始まり、次に更新が来た時点で 1 になる。過去分の遡及はしない
    for (const column of [
      "index_revision",
      "index_sent_revision",
      "index_attempts",
      "index_retry_at",
    ]) {
      addColumnIfMissing(this.ctx.storage.sql, "agent_link", column, "INTEGER NOT NULL DEFAULT 0");
    }
    // Phase 3: Draft PR・Installation Token・終端処理の進み具合（1 行）。Phase 2 で作られたタスクには無い。
    sql.exec(`CREATE TABLE IF NOT EXISTS github_link (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      branch TEXT NOT NULL,
      initial_sha TEXT,
      branch_ready INTEGER NOT NULL DEFAULT 0,
      pr_number INTEGER,
      pr_url TEXT,
      pr_draft INTEGER,
      setup_done INTEGER NOT NULL DEFAULT 0,
      setup_attempts INTEGER NOT NULL DEFAULT 0,
      setup_retry_at INTEGER NOT NULL DEFAULT 0,
      auth_warned INTEGER NOT NULL DEFAULT 0,
      warnings TEXT NOT NULL DEFAULT '[]',
      cred_delivered_id INTEGER NOT NULL DEFAULT 0,
      head_sha TEXT,
      head_matches INTEGER,
      body_done INTEGER NOT NULL DEFAULT 0,
      finalize_attempts INTEGER NOT NULL DEFAULT 0,
      finalize_retry_at INTEGER NOT NULL DEFAULT 0,
      finalize_done INTEGER NOT NULL DEFAULT 0
    )`);
    addColumnIfMissing(
      this.ctx.storage.sql,
      "github_link",
      "revoke_attempts",
      "INTEGER NOT NULL DEFAULT 0",
    );
    // 全体のテストとレビューの方針（task_start の review_policy。旧 merge_policy の列は使わず残す）と、task_pr_merge でマージ済みか
    addColumnIfMissing(
      this.ctx.storage.sql,
      "task",
      "review_policy",
      "TEXT NOT NULL DEFAULT 'client_review'",
    );
    addColumnIfMissing(
      this.ctx.storage.sql,
      "github_link",
      "pr_merged",
      "INTEGER NOT NULL DEFAULT 0",
    );
    addColumnIfMissing(
      this.ctx.storage.sql,
      "github_link",
      "closed_empty",
      "INTEGER NOT NULL DEFAULT 0",
    );
    // D14: 依存関係のキャッシュの指定（TaskSpec.deps の JSON。"null" は lockfile なし・読めなかった。NULL は未取得で、spec に載せない）
    addColumnIfMissing(this.ctx.storage.sql, "github_link", "deps", "TEXT");
    // 予算に近づいたときの扱い（task_start の budget_policy。NULL = この変更より前のタスク = stop）
    addColumnIfMissing(this.ctx.storage.sql, "task", "budget_policy", "TEXT");
    // D10: ワーカーのモデル（task_start の model。NULL は既定のモデル）
    addColumnIfMissing(this.ctx.storage.sql, "task", "model", "TEXT");
    // D10: ワーカーのモデルの思考レベル（開始時の値。NULL は現在の設定から求める）
    addColumnIfMissing(this.ctx.storage.sql, "task", "effort", "TEXT");
    // モデルの選び方の記録（task_start の mode / reason / scores。JSON。NULL は記録なし = 古いタスク）
    addColumnIfMissing(this.ctx.storage.sql, "task", "model_selection", "TEXT");
    // task_start の sandbox_instance（明示した Sandbox の大きさ。NULL は省略 = agent の既定）
    addColumnIfMissing(this.ctx.storage.sql, "task", "sandbox_instance", "TEXT");
    // task_review: タスクの種類（NULL = 通常のタスク）と、対象の PR・差分・投稿の進み具合（1 行。review のタスクだけ）
    addColumnIfMissing(this.ctx.storage.sql, "task", "kind", "TEXT");
    sql.exec(`CREATE TABLE IF NOT EXISTS review_link (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      pull_number INTEGER NOT NULL,
      pull_url TEXT NOT NULL,
      head_sha TEXT NOT NULL,
      head_ref TEXT NOT NULL,
      base_sha TEXT NOT NULL,
      pr_title TEXT NOT NULL,
      pr_body TEXT NOT NULL,
      review_model TEXT NOT NULL,
      review_commands TEXT NOT NULL,
      diff TEXT,
      diff_truncated INTEGER NOT NULL DEFAULT 0,
      comment_url TEXT,
      posted INTEGER NOT NULL DEFAULT 0,
      post_attempts INTEGER NOT NULL DEFAULT 0,
      post_retry_at INTEGER NOT NULL DEFAULT 0
    )`);
    // worker_review: レビューの指定（task_start の review_model・review_commands・review_fix_rounds）と、投稿の進み具合（1 行。worker_review のタスクだけ）
    sql.exec(`CREATE TABLE IF NOT EXISTS worker_review (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      review_model TEXT NOT NULL,
      review_commands TEXT NOT NULL,
      review_fix_rounds INTEGER NOT NULL DEFAULT 0,
      comment_url TEXT,
      posted INTEGER NOT NULL DEFAULT 0,
      post_attempts INTEGER NOT NULL DEFAULT 0,
      post_retry_at INTEGER NOT NULL DEFAULT 0
    )`);
    // Phase 4: ワーカーの質問と回答、クライアントからの追加の指示。配送の意図（delivery_state）を永続化し、alarm で再送する。
    sql.exec(`CREATE TABLE IF NOT EXISTS questions (
      question_id TEXT PRIMARY KEY,
      message TEXT NOT NULL,
      options TEXT NOT NULL,
      answer TEXT,
      delivery_state TEXT NOT NULL DEFAULT 'none',
      asked_at INTEGER NOT NULL
    )`);
    // 予算の延長の質問（kind = 'budget_extension'）と、その回答の決定（extend | stop。クライアントの答えと月の枠の予約結果から gateway が決める）
    addColumnIfMissing(sql, "questions", "kind", "TEXT");
    addColumnIfMissing(sql, "questions", "decision", "TEXT");
    sql.exec(`CREATE TABLE IF NOT EXISTS steers (
      n INTEGER PRIMARY KEY AUTOINCREMENT,
      steer_id TEXT NOT NULL UNIQUE,
      message TEXT NOT NULL,
      delivery_state TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL
    )`);
    // Installation Token は AES-GCM で暗号化して保存する（TOKEN_ENC_KEY）。kind は start（taskSpec に入れたもの）/ refresh / final。
    sql.exec(`CREATE TABLE IF NOT EXISTS git_token (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      enc TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      revoked INTEGER NOT NULL DEFAULT 0,
      kind TEXT NOT NULL
    )`);
    // Phase 7 M2: 終端済み（finalize_done = 1）で暗号文が残っている既存の行を空にする（冪等）
    this.scrubTokenCiphertext();
  }

  /**
   * finalize_done = 1（失効の記録を閉じた後）に、git_token の暗号文（enc）だけを空文字にする。
   * 行と id は残す（cred_delivered_id の参照と、credential_* の件数の突き合わせを保つため）。
   * finalize_done の後にトークンを復号する経路は無い（finalizeGithub は finalize_done = 1 で先に return する）。
   * enc は NOT NULL なので、NULL ではなく空文字にする。冪等。
   * github_link は 1 行だけ（singleton）である前提で、EXISTS で絞っている。
   */
  private scrubTokenCiphertext(): void {
    this.ctx.storage.sql.exec(
      "UPDATE git_token SET enc = '' WHERE enc != '' AND EXISTS (SELECT 1 FROM github_link WHERE finalize_done = 1)",
    );
  }

  /** テスト専用: git_token の状態（暗号文そのものは返さない）。ENVIRONMENT=test のときだけ。 */
  testTokenState(): { finalizeDone: boolean; rows: number; encEmpty: number; encPresent: number } {
    if (this.env.ENVIRONMENT !== "test") throw new Error("test only");
    const sql = this.ctx.storage.sql;
    const t = sql
      .exec<{ n: number; empty: number | null }>(
        "SELECT COUNT(*) AS n, SUM(enc = '') AS empty FROM git_token",
      )
      .one();
    const empty = t.empty ?? 0;
    return {
      finalizeDone: this.getGithub()?.finalize_done === 1,
      rows: t.n,
      encEmpty: empty,
      encPresent: t.n - empty,
    };
  }

  // --- 読み取りヘルパー ---

  private now(): number {
    return Date.now();
  }

  private getRow(): TaskRow | undefined {
    return this.ctx.storage.sql
      .exec<TaskRow>("SELECT * FROM task WHERE singleton = 1")
      .toArray()[0];
  }

  private isAbandoned(): boolean {
    return (
      this.ctx.storage.sql.exec("SELECT 1 AS x FROM meta WHERE key = ?", ABANDONED_KEY).toArray()
        .length > 0
    );
  }

  private latestSeq(): number {
    const row = this.ctx.storage.sql
      .exec<{ m: number }>("SELECT COALESCE(MAX(seq), 0) AS m FROM events")
      .one();
    return row.m;
  }

  private readEvents(afterSeq: number): TaskEvent[] {
    return this.ctx.storage.sql
      .exec<EventRow>(
        // 構造化イベント（D14）は MCP の task_wait に出さない（保存はしてあり、ダッシュボードの専用 RPC だけが読む）
        `SELECT seq, type, payload, created_at FROM events WHERE seq > ? AND type NOT IN (${STRUCTURED_TYPES_SQL}) ORDER BY seq LIMIT ?`,
        afterSeq,
        MAX_EVENTS_PER_WAIT,
      )
      .toArray()
      .map((e) => ({
        seq: e.seq,
        type: e.type,
        payload: JSON.parse(e.payload) as EventPayload,
        created_at: new Date(e.created_at).toISOString(),
      }));
  }

  private statusOf(row: TaskRow): TaskStatus {
    if (!isTaskStatus(row.status)) throw new Error(`corrupt task status: ${row.status}`);
    return row.status;
  }

  private isReview(row: Pick<TaskRow, "kind"> | undefined): boolean {
    return row?.kind === "review";
  }

  private getReview(): ReviewRow | undefined {
    return this.ctx.storage.sql.exec<ReviewRow>("SELECT * FROM review_link").toArray()[0];
  }

  /** worker_review のタスクの、レビューの指定と投稿の進み具合（client_review のタスクと task_review には無い） */
  private getWorkerReview(): WorkerReviewRow | undefined {
    return this.ctx.storage.sql.exec<WorkerReviewRow>("SELECT * FROM worker_review").toArray()[0];
  }

  private targetPr(row: TaskRow, rl: ReviewRow): TargetPr {
    return {
      repository: row.repository,
      number: rl.pull_number,
      head_sha: rl.head_sha,
      url: rl.pull_url,
    };
  }

  /**
   * レビューの段の段階。終端では、レビューが得られた（AgentDO の結果を待たずに分かる: COMPLETED）なら done、それ以外は skipped。
   * 実行中は、取り込んだイベント（review_started / review_commands_finished）から決める。
   */
  private reviewStage(row: TaskRow, rl: ReviewRow): ReviewStage {
    const status = this.statusOf(row);
    if (isTerminal(status)) return status === "COMPLETED" ? "done" : "skipped";
    const seen = new Set(
      this.ctx.storage.sql
        .exec<{ type: string }>(
          "SELECT DISTINCT type FROM events WHERE type IN ('review_started', 'review_commands_finished')",
        )
        .toArray()
        .map((r) => r.type),
    );
    if (seen.has("review_commands_finished")) return "reviewing";
    if (seen.has("review_started")) {
      const commands = JSON.parse(rl.review_commands) as unknown[];
      return commands.length > 0 ? "commands" : "reviewing";
    }
    return "waiting";
  }

  /**
   * worker_review のレビューの段の段階。実行中は取り込んだイベント（review_started / review_commands_finished）から決める
   * （verification が通るまでは waiting）。終端では、TaskDO が投稿の終わりに積む review_finished の stage（done / skipped）。
   * まだ投稿が済んでいない COMPLETED は reviewing（投稿の前）、レビューの段に入らず終わったものは skipped。
   */
  private workerReviewStage(row: TaskRow, wr: WorkerReviewRow): ReviewStage {
    const sql = this.ctx.storage.sql;
    const seen = new Set(
      sql
        .exec<{ type: string }>(
          "SELECT DISTINCT type FROM events WHERE type IN ('review_started', 'review_commands_finished')",
        )
        .toArray()
        .map((r) => r.type),
    );
    if (isTerminal(this.statusOf(row))) {
      const fin = sql
        .exec<{
          payload: string;
        }>("SELECT payload FROM events WHERE type = 'review_finished' ORDER BY seq DESC LIMIT 1")
        .toArray()[0];
      if (fin) {
        const stage = (JSON.parse(fin.payload) as { stage?: unknown }).stage;
        return stage === "done" ? "done" : "skipped";
      }
      return this.statusOf(row) === "COMPLETED" && seen.has("review_started")
        ? "reviewing"
        : "skipped";
    }
    if (seen.has("review_commands_finished")) return "reviewing";
    if (seen.has("review_started")) {
      const commands = JSON.parse(wr.review_commands) as unknown[];
      return commands.length > 0 ? "commands" : "reviewing";
    }
    return "waiting";
  }

  private reviewViewPart(row: TaskRow): Pick<TaskView, "kind" | "review" | "target_pr"> {
    if (!this.isReview(row)) {
      const wr = this.getWorkerReview();
      if (!wr) return {};
      return {
        review: {
          stage: this.workerReviewStage(row, wr),
          model: wr.review_model,
          fix_rounds: wr.review_fix_rounds,
          rounds_used: 0,
        },
      };
    }
    const rl = this.getReview();
    if (!rl) return { kind: "review" };
    return {
      kind: "review",
      review: { stage: this.reviewStage(row, rl), model: rl.review_model },
      target_pr: this.targetPr(row, rl),
    };
  }

  private view(row: TaskRow): TaskView {
    return {
      task_id: row.id,
      owner_id: row.owner_id,
      status: this.statusOf(row),
      ...this.reviewViewPart(row),
      repository: row.repository,
      title: row.title,
      draft_pr_url: row.draft_pr_url,
      review_policy: policyOf(row),
      budget_policy: budgetPolicyOf(row),
      model: this.modelOf(row),
      effort: this.effortOfRow(row),
      ...this.selectionOf(row),
      sandbox_instance: row.sandbox_instance ?? null,
      created_at: new Date(row.created_at).toISOString(),
      updated_at: new Date(row.updated_at).toISOString(),
      latest_cursor: String(this.latestSeq()),
      pending_question: this.pendingQuestion(this.statusOf(row)),
    };
  }

  /** 行のモデル（D10 より前のタスクは NULL。既定のモデルとして扱う）。 */
  private modelOf(row: Pick<TaskRow, "model">): string {
    return row.model ?? defaultModelOf(this.env);
  }

  /** 行のモデルの選び方の記録。無い・壊れているときは何も足さない（キー自体を付けない） */
  private selectionOf(row: Pick<TaskRow, "model_selection">): { model_selection?: ModelSelection } {
    if (row.model_selection === null) return {};
    try {
      const parsed = modelSelectionSchema.safeParse(JSON.parse(row.model_selection));
      return parsed.success ? { model_selection: parsed.data } : {};
    } catch {
      return {};
    }
  }

  /** 行の思考レベル（開始時に保存した値。無ければ現在の設定から求める）。 */
  private effortOfRow(row: Pick<TaskRow, "model" | "effort">): Effort {
    return (row.effort as Effort | null) ?? effortOf(this.env, this.modelOf(row));
  }

  /** 未回答の質問。終端のタスクには無い。 */
  private pendingQuestion(status: TaskStatus): TaskView["pending_question"] {
    if (isTerminal(status)) return null;
    const q = this.ctx.storage.sql
      .exec<{ question_id: string; message: string; options: string; kind: string | null }>(
        "SELECT question_id, message, options, kind FROM questions WHERE answer IS NULL ORDER BY asked_at DESC, rowid DESC LIMIT 1",
      )
      .toArray()[0];
    if (!q) return null;
    let options: string[] = [];
    try {
      const parsed: unknown = JSON.parse(q.options);
      if (Array.isArray(parsed)) options = parsed.filter((x): x is string => typeof x === "string");
    } catch {
      // 壊れていれば空（保存時に正規化済みなので通常は起きない）
    }
    return {
      question_id: q.question_id,
      message: q.message,
      options,
      ...(q.kind === BUDGET_EXTENSION_KIND ? { kind: BUDGET_EXTENSION_KIND } : {}),
    };
  }

  // --- 書き込み（必ず transactionSync の中から呼ぶ） ---

  /** seq を採番してイベントを挿入する。AgentDO 由来なら (operation_id, agent_seq) も記録する。 */
  private appendEvent(
    type: string,
    payload: EventPayload,
    at: number,
    agent?: { operationId: string; seq: number },
  ): number {
    const seq = this.latestSeq() + 1;
    this.ctx.storage.sql.exec(
      "INSERT INTO events (seq, type, payload, created_at, operation_id, agent_seq) VALUES (?, ?, ?, ?, ?, ?)",
      seq,
      type,
      JSON.stringify(payload),
      at,
      agent?.operationId ?? null,
      agent?.seq ?? null,
    );
    return seq;
  }

  // --- 監査（phase6.md「監査ログ」/ audit.ts） ---

  /**
   * 監査ログに 1 行出す（taskId と caller の既定値つき）。ENVIRONMENT=test のときだけ、DO の SQLite（test_audit）にも記録する。
   * 記録の失敗で本来の処理を壊さない。
   */
  private emitAudit(event: AuditEventName, fields: AuditFields): void {
    const record = audit(
      event,
      { taskId: this.getRow()?.id, caller: "system", ...fields },
      { now: this.now() },
    );
    if (record === null || this.env.ENVIRONMENT !== "test") return;
    try {
      const sql = this.ctx.storage.sql;
      sql.exec(
        "CREATE TABLE IF NOT EXISTS test_audit (n INTEGER PRIMARY KEY AUTOINCREMENT, record TEXT NOT NULL)",
      );
      sql.exec("INSERT INTO test_audit (record) VALUES (?)", JSON.stringify(record));
    } catch (e) {
      console.error("audit_sink_error", e instanceof Error ? e.name : typeof e);
    }
  }

  /**
   * 欠落してはならない事象の二重化: 監査ログに出し、events にも type "audit" の固定コード（{code, kind?}）で積む。
   * transactionSync の中から呼ぶ。呼び出し側が、tx の後に notifyWaiters() する。
   */
  private auditBoth(event: AuditEventName, fields: AuditFields): void {
    const payload: EventPayload = { code: event };
    if (fields.kind !== undefined) payload.kind = fields.kind;
    this.appendEvent("audit", payload, this.now());
    this.emitAudit(event, fields);
  }

  /** テスト専用: このタスクが発行した監査イベント（発行順）。ENVIRONMENT=test のときだけ。 */
  testAudit(): AuditRecord[] {
    if (this.env.ENVIRONMENT !== "test") throw new Error("test only");
    const sql = this.ctx.storage.sql;
    sql.exec(
      "CREATE TABLE IF NOT EXISTS test_audit (n INTEGER PRIMARY KEY AUTOINCREMENT, record TEXT NOT NULL)",
    );
    return sql
      .exec<{ record: string }>("SELECT record FROM test_audit ORDER BY n")
      .toArray()
      .map((r) => JSON.parse(r.record) as AuditRecord);
  }

  /** owner でない呼び出しか。行があるのに owner が違うときだけ authz_denied を出す（応答は not_found のまま）。 */
  private notOwner(row: TaskRow, ownerId: number): boolean {
    if (row.owner_id === ownerId) return false;
    this.emitAudit("authz_denied", { userId: ownerId, caller: "parent", reason: "not_owner" });
    return true;
  }

  private getLink(): LinkRow | undefined {
    return this.ctx.storage.sql.exec<LinkRow>("SELECT * FROM agent_link").toArray()[0];
  }

  private getGithub(): GithubRow | undefined {
    return this.ctx.storage.sql.exec<GithubRow>("SELECT * FROM github_link").toArray()[0];
  }

  private tokenRows(where = "1 = 1"): TokenRow[] {
    return this.ctx.storage.sql
      .exec<TokenRow>(`SELECT * FROM git_token WHERE ${where} ORDER BY id`)
      .toArray();
  }

  /**
   * 状態を遷移させてイベントを積む（transactionSync の中で呼ぶ）。許されない遷移は何もしない。
   * 終端に入ったら、AgentDO の停止確認（cancel）の意図を記録する。
   */
  private changeStatus(to: TaskStatus, extra: EventPayload = {}): boolean {
    const from = this.currentStatus();
    if (from === to || !canTransition(from, to)) return false;
    const at = this.now();
    this.ctx.storage.sql.exec(
      "UPDATE task SET status = ?, updated_at = ? WHERE singleton = 1",
      to,
      at,
    );
    this.bumpIndexRevision();
    this.appendEvent("status_changed", { status: to, from, ...extra }, at);
    // 回答待ちの起点（24 時間のバックストップの基準）。INPUT_REQUIRED に入ったときに記録し、出たら消す。
    if (to === "INPUT_REQUIRED") {
      this.ctx.storage.sql.exec(
        "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)",
        INPUT_REQUIRED_SINCE_KEY,
        String(at),
      );
    } else {
      this.ctx.storage.sql.exec("DELETE FROM meta WHERE key = ?", INPUT_REQUIRED_SINCE_KEY);
    }
    if (isTerminal(to)) {
      this.clearProgress();
      this.ctx.storage.sql.exec(
        "UPDATE agent_link SET cancel_state = 'pending' WHERE cancel_state = 'none'",
      );
      this.skipPendingDeliveries();
      // 上限による終了。events には既存の status_changed の reason があるので、監査ログだけに出す
      const limit = limitReason(to, extra.reason);
      if (limit !== undefined) this.emitAudit("task_ended_by_limit", { reason: limit });
    }
    return true;
  }

  /** 回答と steer の未配送の意図を取りやめる（終端に入ったトランザクションの中で呼ぶ）。 */
  private skipPendingDeliveries(): void {
    const sql = this.ctx.storage.sql;
    const pending = (table: "questions" | "steers") =>
      sql.exec(`SELECT 1 AS x FROM ${table} WHERE delivery_state = 'pending' LIMIT 1`).toArray()
        .length > 0;
    const answers = pending("questions");
    const steers = pending("steers");
    sql.exec("UPDATE questions SET delivery_state = 'skipped' WHERE delivery_state = 'pending'");
    sql.exec("UPDATE steers SET delivery_state = 'skipped' WHERE delivery_state = 'pending'");
    // 配送の打ち切り: 終端で未配送の意図を取りやめた（再送の回数の上限による打ち切りは無い）
    if (answers) this.giveUpDelivery("answer");
    if (steers) this.giveUpDelivery("steer");
  }

  /** 配送の打ち切りを events（audit）と監査ログに出す（transactionSync の中から呼ぶ。待機中の呼び出しは呼び出し側が起こす）。 */
  private giveUpDelivery(kind: "start" | "answer" | "steer"): void {
    this.auditBoth("delivery_given_up", { kind, reason: "skipped_on_terminal" });
  }

  private notifyWaiters(): void {
    for (const w of [...this.waiters]) w.wake();
  }

  // --- 公開 API（RPC） ---

  /** 冪等な作成。未作成なら作り、同じ入力なら既存を返し、違う入力は conflict、tombstone 済みは expired。 */
  async ensureCreated(input: EnsureCreatedInput): Promise<EnsureCreatedResult> {
    const parsed = taskInputSchema.safeParse(input);
    if (
      !parsed.success ||
      !isTaskId(input.task_id) ||
      !Number.isSafeInteger(input.owner_id) ||
      typeof input.owner_login !== "string" ||
      !isNullableId(input.repository_id) ||
      !isNullableId(input.installation_id)
    ) {
      return { ok: false, code: "invalid_input" };
    }
    const data = parsed.data;
    // D10: モデルはこのデプロイの AGENT_MODELS の中だけ（service でも見るが、TaskDO への直接の呼び出しにも効かせる）
    if (data.model !== undefined && !agentModelsOf(this.env).includes(data.model)) {
      return { ok: false, code: "invalid_input" };
    }
    // worker_review のレビューのモデルも、このデプロイの AGENT_MODELS の中だけ（作業の model とは独立）
    if (
      data.review_policy === "worker_review" &&
      (data.review_model === undefined || !agentModelsOf(this.env).includes(data.review_model))
    ) {
      return { ok: false, code: "invalid_input" };
    }
    const model = data.model ?? defaultModelOf(this.env);
    // モデルの選び方の記録（任意）。形が違う・選んだモデルと食い違うものは受け付けない
    let modelSelection: ModelSelection | undefined;
    if (input.model_selection !== undefined) {
      const sel = modelSelectionSchema.safeParse(input.model_selection);
      if (!sel.success || sel.data.chosen !== model) return { ok: false, code: "invalid_input" };
      modelSelection = sel.data;
    }
    // 思考レベル: task_start で指定されたらそれ（最終のモデルが受け付けるレベルだけ。service が予約の前に見ているが、
    // TaskDO への直接の呼び出しにも効かせる）。省略はモデルごとの既定（MODEL_EFFORTS）。開始時の値を保存する
    // （あとで MODEL_EFFORTS を変えても、このタスクの表示は変わらない）。
    // 同じ idempotency_key の再試行（既存のタスクがある）では、この検査より先に既存のタスクを返す（下の transactionSync）
    const effortError = data.effort !== undefined ? effortRejection(model, data.effort) : undefined;
    const effort = data.effort ?? effortOf(this.env, model);
    // await のあいだに他の呼び出しが進みうるので、状態の判定は await の後の同期区間で行う。
    // fingerprint は「利用者が入力したもの」で決める。rovo が選んだモデル（mode: auto）は入力ではないので含めない
    // （同じ idempotency_key の再試行で Clef の答えが変わっても、同じタスクとして扱うため）。明示した model は従来どおり含める。
    const { model: _chosen, ...withoutModel } = data;
    const fingerprint = await computeFingerprint(
      modelSelection?.mode === "auto" ? (withoutModel as typeof data) : data,
    );
    // この変更より前に model を省略して作られたタスク（fingerprint に既定のモデルが含まれている）の再試行も、同じタスクとして扱う
    const before = this.getRow();
    const legacyFingerprint =
      before !== undefined && before.model_selection === null
        ? await computeFingerprint({ ...data, model: before.model ?? model })
        : undefined;

    const result = this.ctx.storage.transactionSync((): EnsureCreatedResult => {
      const existing = this.getRow();
      if (existing) {
        const same =
          existing.id === input.task_id &&
          existing.owner_id === input.owner_id &&
          (existing.fingerprint === fingerprint ||
            (legacyFingerprint !== undefined && existing.fingerprint === legacyFingerprint));
        return same
          ? { ok: true, created: false, task: this.view(existing) }
          : { ok: false, code: "conflict" };
      }
      if (this.isAbandoned()) return { ok: false, code: "expired" };
      if (effortError !== undefined) {
        return { ok: false, code: "invalid_input", message: effortError };
      }

      const at = this.now();
      this.ctx.storage.sql.exec(
        `INSERT INTO task (singleton, id, owner_id, owner_login, repository, repository_id,
           installation_id, base_ref, base_sha, title, instructions, acceptance_criteria,
           constraints, verification_commands, fingerprint, review_policy, budget_policy, model, effort, model_selection, sandbox_instance, status, draft_pr_url, created_at, updated_at)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'CREATING', NULL, ?, ?)`,
        input.task_id,
        input.owner_id,
        input.owner_login,
        data.repository,
        input.repository_id ?? null,
        input.installation_id ?? null,
        data.base_ref,
        data.base_sha,
        data.title,
        data.instructions,
        JSON.stringify(data.acceptance_criteria),
        JSON.stringify(data.constraints),
        JSON.stringify(data.verification_commands),
        fingerprint,
        data.review_policy,
        data.budget_policy,
        model,
        effort,
        modelSelection === undefined ? null : JSON.stringify(modelSelection),
        data.sandbox_instance ?? null,
        at,
        at,
      );
      // start を配送する意図と taskSpec を、作成と同じトランザクションで記録する。
      const spec: BaseSpec = {
        taskId: input.task_id,
        userId: String(input.owner_id),
        repository: data.repository,
        baseSha: data.base_sha,
        instructions: data.instructions,
        acceptanceCriteria: data.acceptance_criteria,
        ...(data.verification_commands.length > 0
          ? {
              verificationCommands: data.verification_commands.map((c) => ({
                argv: c.argv,
                ...(c.cwd !== undefined ? { cwd: c.cwd } : {}),
                ...(c.timeout_seconds !== undefined ? { timeoutSeconds: c.timeout_seconds } : {}),
              })),
            }
          : {}),
        constraints: data.constraints,
        model,
        // 常に載せる（task 行に保存したのと同じ値。省略時はモデルごとの既定。off も値として載せる）。
        // gateway と agent の片方だけのデプロイでも、task_status の effort と実際の思考レベルがずれない。
        // fingerprint は data.effort だけで作る（既定の値は入れない）
        effort,
        // 明示したときだけ載せる（省略は agent の既定。後段の自動の昇格も、明示したタスクでは行わない）
        ...(data.sandbox_instance !== undefined ? { sandboxInstance: data.sandbox_instance } : {}),
        budgetUsd: taskBudgetUsd(this.env),
        budgetPolicy: data.budget_policy,
        deadlineAt: at + AGENT_DEADLINE_MS,
        // worker_review のときだけ載せる（client_review の spec は変えない）
        ...(data.review_policy === "worker_review" && data.review_model !== undefined
          ? {
              workerReview: {
                model: data.review_model,
                commands: (data.review_commands ?? []).map((c) => ({
                  argv: c.argv,
                  ...(c.cwd !== undefined ? { cwd: c.cwd } : {}),
                  ...(c.timeout_seconds !== undefined ? { timeoutSeconds: c.timeout_seconds } : {}),
                })),
                fixRounds: 0 as const,
              },
            }
          : {}),
      };
      if (data.review_policy === "worker_review" && data.review_model !== undefined) {
        this.ctx.storage.sql.exec(
          "INSERT INTO worker_review (singleton, review_model, review_commands, review_fix_rounds) VALUES (1, ?, ?, 0)",
          data.review_model,
          JSON.stringify(data.review_commands ?? []),
        );
      }
      this.ctx.storage.sql.exec(
        `INSERT INTO agent_link (singleton, spec, operation_id, start_state, cancel_state)
         VALUES (1, ?, ?, 'pending', 'none')`,
        JSON.stringify(spec),
        `run:${input.task_id}`,
      );
      this.ctx.storage.sql.exec(
        "INSERT INTO github_link (singleton, branch) VALUES (1, ?)",
        `agent/task-${input.task_id}`,
      );
      this.appendEvent("created", { status: "CREATING" }, at);
      this.bumpIndexRevision();
      const row = this.getRow();
      if (!row) throw new Error("task row missing after insert");
      return { ok: true, created: true, task: this.view(row) };
    });
    if (result.ok && result.created) this.notifyWaiters();
    if (result.ok) await this.ensureAlarm();
    return result;
  }

  /**
   * task_review のタスクの冪等な作成（ensureCreated と同じ規則: 同じ入力なら既存を返し、違う入力は conflict、tombstone 済みは expired）。
   * 作業ブランチ・初期コミット・Draft PR は作らない。github_link は Installation Token の発行と失効のために持つ（branch は空、PR は無い）。
   * 指紋は task_review の指紋（その時点の head の SHA を含む）。対象の PR は review_link に残す。
   */
  async ensureReviewCreated(input: EnsureReviewInput): Promise<EnsureCreatedResult> {
    const parsed = reviewInputSchema.safeParse({
      repository: input.repository,
      pull_number: input.pull_number,
      review_model: input.review_model,
      review_commands: input.review_commands,
      budget_policy: input.budget_policy,
      ...(input.sandbox_instance !== undefined ? { sandbox_instance: input.sandbox_instance } : {}),
    });
    const pull = input.pull;
    if (
      !parsed.success ||
      !isTaskId(input.task_id) ||
      !Number.isSafeInteger(input.owner_id) ||
      typeof input.owner_login !== "string" ||
      !isNullableId(input.repository_id) ||
      !isNullableId(input.installation_id) ||
      typeof pull !== "object" ||
      pull === null ||
      pull.number !== input.pull_number ||
      typeof pull.headSha !== "string" ||
      !FULL_SHA_RE.test(pull.headSha) ||
      typeof pull.baseSha !== "string" ||
      !FULL_SHA_RE.test(pull.baseSha) ||
      typeof pull.url !== "string" ||
      typeof pull.title !== "string" ||
      typeof pull.body !== "string" ||
      typeof pull.baseRef !== "string" ||
      pull.baseRef === "" ||
      typeof pull.headRef !== "string"
    ) {
      return { ok: false, code: "invalid_input" };
    }
    const data = parsed.data;
    // レビューのモデルは、このデプロイの AGENT_MODELS の中だけ（service でも見るが、TaskDO への直接の呼び出しにも効かせる）
    if (!agentModelsOf(this.env).includes(data.review_model)) {
      return { ok: false, code: "invalid_input" };
    }
    const fingerprint = await computeReviewFingerprint(data, pull.headSha);
    const model = data.review_model;
    const effort = effortOf(this.env, model);
    const header = `Review pull request ${data.repository}#${data.pull_number} at ${pull.headSha}.`;
    const result = this.ctx.storage.transactionSync((): EnsureCreatedResult => {
      const existing = this.getRow();
      if (existing) {
        const same =
          existing.id === input.task_id &&
          existing.owner_id === input.owner_id &&
          existing.fingerprint === fingerprint;
        return same
          ? { ok: true, created: false, task: this.view(existing) }
          : { ok: false, code: "conflict" };
      }
      if (this.isAbandoned()) return { ok: false, code: "expired" };
      const at = this.now();
      const selection: ModelSelection = { mode: "explicit", chosen: model, reason: "explicit" };
      this.ctx.storage.sql.exec(
        `INSERT INTO task (singleton, id, owner_id, owner_login, repository, repository_id,
           installation_id, base_ref, base_sha, title, instructions, acceptance_criteria,
           constraints, verification_commands, fingerprint, review_policy, budget_policy, model, effort, model_selection, sandbox_instance, kind, status, draft_pr_url, created_at, updated_at)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', '[]', '[]', ?, ?, ?, ?, ?, ?, ?, 'review', 'CREATING', NULL, ?, ?)`,
        input.task_id,
        input.owner_id,
        input.owner_login,
        data.repository,
        input.repository_id ?? null,
        input.installation_id ?? null,
        pull.baseRef,
        pull.baseSha,
        clip(`Review #${data.pull_number}: ${pull.title}`, 200),
        header,
        fingerprint,
        DEFAULT_REVIEW_POLICY,
        data.budget_policy,
        model,
        effort,
        JSON.stringify(selection),
        data.sandbox_instance ?? null,
        at,
        at,
      );
      // start の spec（トークン・差分・review は start の直前に足す）。Pi は動かないので instructions は rovo が書いた見出し
      const spec: BaseSpec = {
        taskId: input.task_id,
        userId: String(input.owner_id),
        repository: data.repository,
        baseSha: pull.baseSha,
        instructions: header,
        acceptanceCriteria: [],
        constraints: [],
        model,
        effort,
        ...(data.sandbox_instance !== undefined ? { sandboxInstance: data.sandbox_instance } : {}),
        budgetUsd: taskBudgetUsd(this.env),
        budgetPolicy: data.budget_policy,
        deadlineAt: at + AGENT_DEADLINE_MS,
        kind: "review",
      };
      this.ctx.storage.sql.exec(
        `INSERT INTO agent_link (singleton, spec, operation_id, start_state, cancel_state)
         VALUES (1, ?, ?, 'pending', 'none')`,
        JSON.stringify(spec),
        `run:${input.task_id}`,
      );
      // 作業ブランチは持たない（branch は空）。Installation Token の発行・配送・失効は github_link の仕組みを使う
      this.ctx.storage.sql.exec("INSERT INTO github_link (singleton, branch) VALUES (1, '')");
      this.ctx.storage.sql.exec(
        `INSERT INTO review_link (singleton, pull_number, pull_url, head_sha, head_ref, base_sha, pr_title, pr_body, review_model, review_commands)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        data.pull_number,
        pull.url,
        pull.headSha,
        pull.headRef,
        pull.baseSha,
        clip(pull.title, 300),
        clip(pull.body, MAX_REVIEW_PR_BODY),
        model,
        JSON.stringify(data.review_commands),
      );
      this.appendEvent("created", { status: "CREATING", kind: "review" }, at);
      this.bumpIndexRevision();
      const row = this.getRow();
      if (!row) throw new Error("task row missing after insert");
      return { ok: true, created: true, task: this.view(row) };
    });
    if (result.ok && result.created) this.notifyWaiters();
    if (result.ok) await this.ensureAlarm();
    return result;
  }

  /** 未作成なら取り消せない tombstone を記録する。作成済みなら何もしない。 */
  async abandonIfUncreated(): Promise<AbandonResult> {
    return this.ctx.storage.transactionSync((): AbandonResult => {
      const row = this.getRow();
      if (row) return { result: "created", status: this.statusOf(row), stopped: this.isStopped() };
      this.ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)",
        ABANDONED_KEY,
        String(this.now()),
      );
      return { result: "abandoned" };
    });
  }

  /** UserDO が予約を照合するための問い合わせ（owner を問わない。UserDO → TaskDO の照合専用）。 */
  async inspect(): Promise<TaskInspection> {
    const row = this.getRow();
    if (row) {
      // Phase 1 のタスク（agent_link なし）は移行しない。照合では abandoned と同じく回収できる扱いにする。
      // task_status などの表示は変えない（そのまま CREATING などと表示する）。
      if (!this.getLink()) return { kind: "legacy" };
      return { kind: "created", status: this.statusOf(row), stopped: this.isStopped() };
    }
    return this.isAbandoned() ? { kind: "abandoned" } : { kind: "uncreated" };
  }

  async getStatus(ownerId: number): Promise<GetStatusResult> {
    const row = this.getRow();
    if (!row || this.notOwner(row, ownerId)) return { ok: false, code: "not_found" };
    return { ok: true, task: this.view(row) };
  }

  /**
   * ダッシュボード用の読み取り専用の view（docs/specs/dashboard.md D5）。所有者を問わない（権限の判定は呼び出し側 =
   * gateway が、閲覧者の見える repository id の集合で行う。判定に通るまで応答に出さない）。
   * **TaskDO の今の repository_id** を含めて 1 回で返す（索引を権限の根拠にしない）。repository_id は INSERT 後に変わらない。
   * 入力の指示文・受け入れ条件・トークン・PR の本文は含めない。repository_id が NULL・タスクが無いときは、区別なく not_found。
   * 何も書かない（索引の revision も alarm も動かさない）。
   */
  async dashboardRead(): Promise<DashboardReadResult> {
    const row = this.getRow();
    const link = this.getLink();
    if (!row || !link || row.repository_id === null) return { ok: false, code: "not_found" };
    return { ok: true, view: this.buildIndexSnapshot(row, link) };
  }

  /**
   * 詳細の画面用（docs/specs/dashboard.md M5b）。dashboardRead の view に、設定（review_policy・sandbox_instance）を足す。
   * 所有者を問わず返すので、**gateway が閲覧者の集合で照合するまで応答に出してはならない**（dashboard/api.ts の readAuthorizedTask だけが呼ぶ）。
   * repository_id が NULL・タスクが無いときは区別なく not_found。何も書かない。
   */
  async dashboardDetail(): Promise<DashboardDetailResult> {
    const row = this.getRow();
    const link = this.getLink();
    if (!row || !link || row.repository_id === null) return { ok: false, code: "not_found" };
    return {
      ok: true,
      view: this.buildIndexSnapshot(row, link),
      review_policy: policyOf(row),
      sandbox_instance: row.sandbox_instance ?? null,
      awaiting_budget: this.pendingQuestion(this.statusOf(row))?.kind === BUDGET_EXTENSION_KIND,
      ...this.selectionOf(row),
      reached: this.reachedStatuses(),
    };
  }

  /** status_changed の記録に RUNNING / VERIFYING があるか（1 回の SQL。何も書かない） */
  private reachedStatuses(): { running: boolean; verifying: boolean } {
    const found = new Set(
      this.ctx.storage.sql
        .exec<{ s: string | null }>(
          "SELECT DISTINCT json_extract(payload, '$.status') AS s FROM events WHERE type = 'status_changed'",
        )
        .toArray()
        .map((r) => r.s),
    );
    return { running: found.has("RUNNING"), verifying: found.has("VERIFYING") };
  }

  /**
   * 詳細の画面の進み具合（docs/specs/dashboard.md D14・D15・M7）。events から、ダッシュボードが返す型だけを読む。
   * 既定は末尾（新しい側）から limit 件、`before` はそれより古い側を末尾から、`cursor` はそれより新しいものを古い順に limit 件。
   * 返す行は seq の昇順。has_older は、返した先頭より古い対象イベントがあるか。
   *
   * 所有者を問わず返すので、**gateway が閲覧者の集合で照合したあとに呼ぶ**（dashboard/api.ts の readAuthorizedTask だけ）。
   * expectedRepositoryId は照合に使った repository_id。TaskDO の今の値と違えば not_found（照合と読み取りの間の食い違いを許さない）。
   * 何も書かない。payload は保存時に agent と gateway が整形・マスク済みで、API の応答の前にもう一度かける。
   */
  async dashboardEvents(
    expectedRepositoryId: number,
    opts: { cursor?: number; before?: number; limit: number },
  ): Promise<DashboardEventsResult> {
    const row = this.getRow();
    if (
      !row ||
      row.repository_id === null ||
      row.repository_id !== expectedRepositoryId ||
      !this.getLink()
    ) {
      return { ok: false, code: "not_found" };
    }
    const limit = Math.min(Math.max(Math.trunc(opts.limit) || 1, 1), DASHBOARD_EVENTS_MAX);
    const sql = this.ctx.storage.sql;
    const cols = "seq, type, payload, created_at";
    const types = `type IN (${DASHBOARD_TYPES_SQL})`;
    let found: EventRow[];
    let hasMoreOlder: boolean | undefined;
    if (opts.cursor !== undefined) {
      found = sql
        .exec<EventRow>(
          `SELECT ${cols} FROM events WHERE ${types} AND seq > ? ORDER BY seq ASC LIMIT ?`,
          opts.cursor,
          limit,
        )
        .toArray();
    } else {
      const upper = opts.before ?? Number.MAX_SAFE_INTEGER;
      const desc = sql
        .exec<EventRow>(
          `SELECT ${cols} FROM events WHERE ${types} AND seq < ? ORDER BY seq DESC LIMIT ?`,
          upper,
          limit + 1,
        )
        .toArray();
      hasMoreOlder = desc.length > limit;
      found = desc.slice(0, limit).reverse();
    }
    const first = found[0];
    const hasOlder =
      hasMoreOlder ??
      (first !== undefined &&
        sql
          .exec<{ x: number }>(
            `SELECT 1 AS x FROM events WHERE ${types} AND seq < ? LIMIT 1`,
            first.seq,
          )
          .toArray().length > 0);
    return {
      ok: true,
      events: found.map((e) => ({
        seq: e.seq,
        type: e.type,
        payload: JSON.parse(e.payload) as EventPayload,
        created_at: e.created_at,
      })),
      has_older: hasOlder,
    };
  }

  /**
   * 詳細の「いまの手順」と「出力の末尾」の材料（docs/specs/dashboard.md M8）。
   * 直近 DASHBOARD_LATEST_RECENT 件の command / edit / commit / web / tool_start / tool_end と、最新の command 1 件だけを読む。
   * 権限の流儀は dashboardEvents と同じ（gateway が閲覧者の集合で照合したあとに呼び、expectedRepositoryId が今の値と違えば not_found）。
   * 何も書かない。payload は保存時に整形・マスク済みで、API の応答の前にもう一度かける。
   */
  async dashboardLatest(expectedRepositoryId: number): Promise<DashboardLatestResult> {
    const row = this.getRow();
    if (
      !row ||
      row.repository_id === null ||
      row.repository_id !== expectedRepositoryId ||
      !this.getLink()
    ) {
      return { ok: false, code: "not_found" };
    }
    const sql = this.ctx.storage.sql;
    const cols = "seq, type, payload, created_at";
    const toRow = (e: EventRow) => ({
      seq: e.seq,
      type: e.type,
      payload: JSON.parse(e.payload) as EventPayload,
      created_at: e.created_at,
    });
    const recent = sql
      .exec<EventRow>(
        `SELECT ${cols} FROM events WHERE type IN (${DASHBOARD_NOW_TYPES_SQL}) ORDER BY seq DESC LIMIT ?`,
        DASHBOARD_LATEST_RECENT,
      )
      .toArray()
      .reverse();
    const cmd = sql
      .exec<EventRow>(`SELECT ${cols} FROM events WHERE type = 'command' ORDER BY seq DESC LIMIT 1`)
      .toArray()[0];
    // 実行中の進捗。終端では出さない（後始末の取りこぼしがあっても、終わったタスクを実行中に見せない）
    const progress = isTerminal(this.statusOf(row)) ? null : this.readProgress();
    return {
      ok: true,
      recent: recent.map(toRow),
      latest_command: cmd ? toRow(cmd) : null,
      progress,
    };
  }

  /** CANCELLED に確定する。終端状態なら何もせず成功（イベントは追加しない）。 */
  async cancel(ownerId: number): Promise<CancelResult> {
    const result = this.ctx.storage.transactionSync((): CancelResult => {
      const row = this.getRow();
      if (!row || this.notOwner(row, ownerId)) return { ok: false, code: "not_found" };
      const from = this.statusOf(row);
      if (isTerminal(from)) return { ok: true, status: from, changed: false };
      if (!canTransition(from, "CANCELLED")) {
        throw new Error(`invalid transition ${from} -> CANCELLED`);
      }
      const at = this.now();
      this.ctx.storage.sql.exec(
        "UPDATE task SET status = 'CANCELLED', updated_at = ? WHERE singleton = 1",
        at,
      );
      this.bumpIndexRevision();
      this.appendEvent("cancelled", { status: "CANCELLED", from }, at);
      // CANCELLED の確定と同じトランザクションで、AgentDO へ cancel を配送する意図を記録する。
      this.ctx.storage.sql.exec(
        "UPDATE agent_link SET cancel_state = 'pending' WHERE cancel_state = 'none'",
      );
      this.ctx.storage.sql.exec("DELETE FROM meta WHERE key = ?", INPUT_REQUIRED_SINCE_KEY);
      this.clearProgress();
      // 未配送の回答と steer は送らない（cancel と同じトランザクションで取りやめる）
      this.skipPendingDeliveries();
      return { ok: true, status: "CANCELLED", changed: true };
    });
    if (result.ok && result.changed) {
      this.emitAudit("task_cancelled", {
        userId: ownerId,
        caller: "parent",
        reason: "parent_requested",
      });
      this.notifyWaiters();
      await this.ensureAlarm();
    }
    return result;
  }

  /**
   * ワーカーの質問への回答を受け付ける（task_answer）。
   * 保存済みの回答と一致すれば、状態に関係なく成功（再送。RUNNING に戻った後でも conflict にしない）。この判定を最初に行う。
   * それ以外は INPUT_REQUIRED の未回答の質問にだけ答えられる。配送は alarm で成功するまで再送する。
   */
  async answer(ownerId: number, questionId: string, answer: string): Promise<AnswerResult> {
    if (
      typeof questionId !== "string" ||
      questionId === "" ||
      typeof answer !== "string" ||
      answer === "" ||
      answer.length > MAX_ANSWER_LENGTH
    ) {
      return { ok: false, code: "invalid_input" };
    }
    // 予算の延長の質問（kind: budget_extension）は、答えが「続ける」なら、受け付ける前に月の枠から延長分を予約する
    // （予約できたときだけ extend。月の枠はハードリミットなので、足りなければ stop = BUDGET_EXCEEDED になる）。
    // await をまたぐので、先に読んで判断し、記録は下の同期区間でやり直して確かめる
    let decision: "extend" | "stop" | undefined;
    let budgetExtension: BudgetExtensionOutcome | undefined;
    const pre = this.readQuestionForAnswer(ownerId, questionId);
    if (
      pre?.kind === BUDGET_EXTENSION_KIND &&
      pre.answer === null &&
      pre.status === "INPUT_REQUIRED"
    ) {
      const [cont, stop] = pre.options;
      if (answer !== cont && answer !== stop) return { ok: false, code: "invalid_input" };
      if (answer === stop) {
        decision = "stop";
        budgetExtension = "declined";
      } else {
        const n = this.grantedBudgetExtensions() + 1;
        if (n > MAX_BUDGET_EXTENSIONS) {
          decision = "stop";
          budgetExtension = "limit_reached";
        } else {
          let r: Awaited<ReturnType<UserDO["extendTaskBudget"]>>;
          try {
            r = await this.userStub(pre.owner_id).extendTaskBudget(pre.task_id, n);
          } catch {
            // 予約できたか分からない。答えを記録せず、呼び出し側に再試行させる（extendTaskBudget は冪等）
            return { ok: false, code: "unavailable" };
          }
          decision = r.ok ? "extend" : "stop";
          budgetExtension = r.ok
            ? "extended"
            : r.code === "budget_exceeded"
              ? "monthly_limit"
              : "declined";
        }
      }
    }
    const result = this.ctx.storage.transactionSync((): AnswerResult & { changed?: boolean } => {
      const row = this.getRow();
      if (!row || this.notOwner(row, ownerId)) return { ok: false, code: "not_found" };
      const status = this.statusOf(row);
      const q = this.ctx.storage.sql
        .exec<{ answer: string | null }>(
          "SELECT answer FROM questions WHERE question_id = ?",
          questionId,
        )
        .toArray()[0];
      if (!q) return { ok: false, code: "not_found" };
      if (q.answer !== null) {
        return q.answer === answer ? { ok: true, status } : { ok: false, code: "conflict" };
      }
      if (status !== "INPUT_REQUIRED") return { ok: false, code: "conflict" };
      this.ctx.storage.sql.exec(
        "UPDATE questions SET answer = ?, delivery_state = 'pending', decision = ? WHERE question_id = ? AND answer IS NULL",
        answer,
        decision ?? null,
        questionId,
      );
      return {
        ok: true,
        status,
        changed: true,
        ...(budgetExtension !== undefined ? { budget_extension: budgetExtension } : {}),
      };
    });
    if (result.ok && result.changed) await this.pullAlarmIn(ALARM_INTERVAL_MS);
    return result.ok
      ? {
          ok: true,
          status: result.status,
          ...(result.budget_extension !== undefined
            ? { budget_extension: result.budget_extension }
            : {}),
        }
      : result;
  }

  /** answer の前読み（所有者の確認つき）。予算の延長の質問の判断に使う。見つからなければ undefined */
  private readQuestionForAnswer(
    ownerId: number,
    questionId: string,
  ):
    | {
        kind: string | null;
        answer: string | null;
        options: string[];
        status: TaskStatus;
        owner_id: number;
        task_id: string;
      }
    | undefined {
    const row = this.getRow();
    // 監査を出す notOwner は使わない（下の同期区間が同じ確認をして、他人の呼び出しは 1 回だけ記録する）
    if (!row || row.owner_id !== ownerId) return undefined;
    const q = this.ctx.storage.sql
      .exec<{ kind: string | null; answer: string | null; options: string }>(
        "SELECT kind, answer, options FROM questions WHERE question_id = ?",
        questionId,
      )
      .toArray()[0];
    if (!q) return undefined;
    let options: string[] = [];
    try {
      const parsed: unknown = JSON.parse(q.options);
      if (Array.isArray(parsed)) options = parsed.filter((x): x is string => typeof x === "string");
    } catch {
      // 壊れていれば空
    }
    return {
      kind: q.kind,
      answer: q.answer,
      options,
      status: this.statusOf(row),
      owner_id: row.owner_id,
      task_id: row.id,
    };
  }

  /** 承認済み（decision = extend）の予算の延長の回数 */
  private grantedBudgetExtensions(): number {
    return this.ctx.storage.sql
      .exec<{ n: number }>(
        "SELECT COUNT(*) AS n FROM questions WHERE kind = ? AND decision = 'extend'",
        BUDGET_EXTENSION_KIND,
      )
      .one().n;
  }

  /**
   * 実行中のタスクへ追加の指示を渡す（task_steer）。RUNNING / VERIFYING / INPUT_REQUIRED だけ受け付ける。
   * steer_id は idempotency_key から導く（無ければ発行）。同じ steer_id・同じ message の再送は、状態に関係なく成功。
   */
  async steer(ownerId: number, message: string, idempotencyKey?: string): Promise<SteerResult> {
    if (
      typeof message !== "string" ||
      message === "" ||
      message.length > MAX_STEER_LENGTH ||
      (idempotencyKey !== undefined && !isValidIdempotencyKey(idempotencyKey))
    ) {
      return { ok: false, code: "invalid_input" };
    }
    const steerId = idempotencyKey !== undefined ? `steer-${idempotencyKey}` : `steer-${ulid()}`;
    const result = this.ctx.storage.transactionSync((): SteerResult & { changed?: boolean } => {
      const row = this.getRow();
      if (!row || this.notOwner(row, ownerId)) return { ok: false, code: "not_found" };
      const status = this.statusOf(row);
      const existing = this.ctx.storage.sql
        .exec<{ message: string }>("SELECT message FROM steers WHERE steer_id = ?", steerId)
        .toArray()[0];
      if (existing) {
        return existing.message === message
          ? { ok: true, status, steer_id: steerId }
          : { ok: false, code: "conflict" };
      }
      // task_review にはワーカーの LLM が無い（追加の指示の届け先が無い）
      if (this.isReview(row)) return { ok: false, code: "conflict" };
      if (!STEERABLE.has(status)) return { ok: false, code: "conflict" };
      const at = this.now();
      this.ctx.storage.sql.exec(
        "INSERT INTO steers (steer_id, message, delivery_state, created_at) VALUES (?, ?, 'pending', ?)",
        steerId,
        message,
        at,
      );
      this.appendEvent("steer_received", { steer_id: steerId }, at);
      return { ok: true, status, steer_id: steerId, changed: true };
    });
    if (result.ok && result.changed) {
      this.notifyWaiters();
      await this.pullAlarmIn(ALARM_INTERVAL_MS);
    }
    return result.ok ? { ok: true, status: result.status, steer_id: result.steer_id } : result;
  }

  /**
   * bounded long polling。seq > cursor のイベントを最大 100 件返す。
   * blockConcurrencyWhile では包まない（待機中も cancel などを受け付けるため）。
   *
   * 呼び出し側（Gateway / クライアント）の切断は検知しない。DO の RPC では、呼び出し側が
   * 切断・中断しても被呼び出し側にはそれが伝わらない（AbortSignal 等を渡せない）ため。
   * その代わり、待機者は必ず最大 timeout_seconds（上限 60 秒）のタイマーで解放する。
   * 切断済みの待機が残るのは最長でもその間だけで、waiters 上限（MAX_CONCURRENT_WAITERS）で
   * 同時数も抑えている。切断で取りこぼしたイベントは、同じ cursor での再試行で受け取れる。
   */
  async wait(
    ownerId: number,
    cursor: string | undefined,
    timeoutSeconds: number | undefined,
  ): Promise<WaitResult> {
    const first = this.getRow();
    if (!first || this.notOwner(first, ownerId)) return { ok: false, code: "not_found" };

    const c = parseCursor(cursor);
    if (!c.ok) return { ok: false, code: "invalid_cursor" };
    const t = parseTimeoutSeconds(timeoutSeconds);
    if (!t.ok) return { ok: false, code: "invalid_input" };

    // 期限は入口で決める。AgentDO / UserDO への RPC が応答しなくても、期限を超えて待たない。
    const deadline = Date.now() + t.value * 1000;
    // 返す前に AgentDO から取り込む（失敗・遅延しても、保存済みのイベントで返せる）。
    // timeout 0 や終端のタスクでも、速い取り込みは拾えるよう、短い猶予（SYNC_GRACE_MS）だけは待つ。
    const entryDeadline = isTerminal(this.currentStatus())
      ? Date.now() + SYNC_GRACE_MS
      : Math.max(deadline, Date.now() + SYNC_GRACE_MS);
    await this.trySync(entryDeadline);
    if (c.value > this.latestSeq()) return { ok: false, code: "invalid_cursor" };

    let events = this.readEvents(c.value);
    const done = () => events.length > 0 || isTerminal(this.currentStatus());
    if (done() || t.value === 0) return this.waitResult(c.value, events);

    if (this.waiters.size >= MAX_CONCURRENT_WAITERS) {
      return this.waitResult(c.value, [], WAIT_RETRY_AFTER_SECONDS);
    }

    // 待機者を登録してから再読する（登録前に追加されたイベントを取りこぼさない）。
    // ワーカーが動いている間は、pollIntervalMs ごとに取り込み直す（alarm の 10 秒を待たせない）。
    const waiter: Waiter = { wake: () => {} };
    this.waiters.add(waiter);
    try {
      for (;;) {
        events = this.readEvents(c.value);
        if (done()) break;
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        const polling = this.isIngesting();
        const slice = polling ? Math.min(remaining, this.pollIntervalMs) : remaining;
        await new Promise<void>((resolve) => {
          waiter.wake = resolve;
          waiter.timer = setTimeout(resolve, slice);
        });
        clearTimeout(waiter.timer);
        if (this.isIngesting()) await this.trySync(deadline);
      }
    } finally {
      clearTimeout(waiter.timer);
      this.waiters.delete(waiter);
    }
    return this.waitResult(c.value, events);
  }

  // ---- ワーカー（AgentDO）との配送・取り込み・精算 ----

  /**
   * 配送と取り込みを 1 回進める（task_start / task_cancel が呼び、alarm からも呼ばれる）。
   * start / cancel の再送、イベントの取り込み、usage の精算、終了時の返却を、冪等に行う。
   * 失敗は握りつぶして次の alarm に任せる。
   */
  async advance(): Promise<{ status: TaskStatus } | null> {
    try {
      await this.pump();
    } finally {
      this.logSummaryIfReady();
      await this.archiveIfReady();
      await this.syncAlarm();
    }
    const row = this.getRow();
    return row ? { status: this.statusOf(row) } : null;
  }

  /** alarm は at-least-once で発火する。処理は冪等で、次の alarm は advance が明示的に設定し直す。 */
  override async alarm(): Promise<void> {
    await this.advance();
    // 索引の配送は alarm の経路だけで行う（advance は task_start / task_wait / task_cancel からも呼ばれ、Directory を待たせない）。
    // 配送が済むと dirty が消えるので、alarm を設定し直す（終端のタスクの alarm を消す）。
    await this.deliverIndex();
    await this.syncAlarm();
  }

  private withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const limit = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("timeout")), ms);
    });
    return Promise.race([p, limit]).finally(() => {
      if (timer !== undefined) clearTimeout(timer);
    });
  }

  /**
   * PR があるのに終了処理（finalize_done）が未了で、待つ上限（終端から RESULT_FINALIZE_WAIT_MS）の内か。
   * 終端の updated_at は status を変えたときにしか動かない。
   */
  private finalizePending(row: TaskRow): boolean {
    const gl = this.getGithub();
    if (!gl || gl.finalize_done === 1) return false;
    // task_review は PR を持たないが、レビューの投稿が終了処理の中にある
    if (gl.pr_number === null && !this.isReview(row)) return false;
    return this.now() - row.updated_at < RESULT_FINALIZE_WAIT_MS;
  }

  /** 利用者に結果を返せる状態か（終端 + AgentDO の停止確認済み）を確かめて、結果を整形して返す。 */
  async result(ownerId: number): Promise<ResultOutcome> {
    const row = this.getRow();
    if (!row || this.notOwner(row, ownerId)) return { ok: false, code: "not_found" };
    const status = this.statusOf(row);
    if (!isTerminal(status) || !this.isStopped()) return { ok: false, code: "not_ready" };
    if (this.finalizePending(row)) return { ok: false, code: "not_ready" };
    try {
      return { ok: true, result: await this.composeResult(row, status) };
    } catch (e) {
      console.error("task_do_result_error", e instanceof Error ? e.name : typeof e);
      return { ok: false, code: "upstream_unavailable" };
    }
  }

  /**
   * task_pr_ready / task_pr_merge の入口。所有者・状態・検証済みの head を確かめ、
   * 操作の対象（リポジトリ・PR 番号・ブランチ）を返す。対象はこの DO の記録だけから作る（呼び出し元の入力は使わない）。
   * 拒否は pr_denied として監査する（所有者でない場合は authz_denied のまま not_found）。
   */
  async prContext(ownerId: number, op: "ready" | "merge"): Promise<PrContextResult> {
    const row = this.getRow();
    if (!row || this.notOwner(row, ownerId)) {
      return { ok: false, code: "not_found", message: "task not found" };
    }
    const policy = policyOf(row);
    const deny = (
      code: "not_ready" | "conflict" | "forbidden",
      reason: string,
      message: string,
    ): PrContextResult => {
      this.emitAudit("pr_denied", {
        userId: ownerId,
        caller: "parent",
        kind: op,
        reason,
        review_policy: policy,
      });
      return { ok: false, code, message };
    };
    const status = this.statusOf(row);
    // task_review の対象はクライアントの PR（rovo の PR ではない）。rovo は Ready にもマージにもしない
    if (this.isReview(row)) {
      return deny(
        "conflict",
        "review_task",
        "this is a task_review task; it reviews the client's pull request and has no pull request of its own (rovo never marks it ready or merges it)",
      );
    }
    if (!isTerminal(status) || !this.isStopped()) {
      return deny("not_ready", "task_not_finished", "the task has not finished yet");
    }
    if (status !== "COMPLETED") {
      return deny(
        "conflict",
        "not_completed",
        `only a COMPLETED task can be used (status: ${status}); read task_result and start a new task if needed`,
      );
    }
    const gl = this.getGithub();
    if (!gl || gl.pr_number === null || gl.pr_url === null) {
      return deny("conflict", "no_pr", "this task has no pull request");
    }
    if (gl.closed_empty === 1) {
      return deny(
        "conflict",
        "pr_closed_empty",
        "the task finished without changes and rovo closed its empty draft pull request; read the summary in task_result",
      );
    }
    if (op === "merge") {
      if (gl.head_matches === null) {
        return deny(
          "not_ready",
          "head_not_read",
          "the pull request head has not been verified yet; retry shortly",
        );
      }
      if (gl.head_matches !== 1 || gl.head_sha === null) {
        return deny(
          "conflict",
          "head_not_verified",
          "the pull request head does not match the verified commit (head_matches_verified is false); review the changes and merge by hand",
        );
      }
      // task_result の warnings（テストの設定の変更など）が 1 件でもあれば自動マージしない。人がレビューしてマージする
      let warnings: string[];
      try {
        warnings = (await this.composeResult(row, status)).warnings;
      } catch (e) {
        console.error("task_do_pr_context_error", e instanceof Error ? e.name : typeof e);
        return deny(
          "not_ready",
          "result_unavailable",
          "the task result could not be read to check warnings; retry shortly",
        );
      }
      if (warnings.length > 0) {
        return deny(
          "conflict",
          "warnings_present",
          "the task result has warnings, so the pull request is not merged automatically; review the warnings and the changes, then merge by hand",
        );
      }
    }
    return {
      ok: true,
      repository: row.repository,
      number: gl.pr_number,
      pr_url: gl.pr_url,
      branch: gl.branch,
      review_policy: policy,
      head_sha: gl.head_sha,
    };
  }

  /** UserDO での操作の結果を記録する: 成功なら PR の状態を更新して pr_ready / pr_merged、拒否なら pr_denied を監査する。 */
  async recordPrAction(ownerId: number, action: PrAction): Promise<void> {
    const row = this.getRow();
    if (!row || this.notOwner(row, ownerId)) return;
    const fields = { userId: ownerId, caller: "parent" as const, kind: action.kind };
    const review_policy = policyOf(row);
    if (action.outcome === "denied") {
      this.emitAudit("pr_denied", { ...fields, reason: action.reason, review_policy });
      return;
    }
    // PR の状態の更新と revision の上昇は同じトランザクション
    this.ctx.storage.transactionSync(() => {
      if (action.kind === "ready") {
        this.ctx.storage.sql.exec("UPDATE github_link SET pr_draft = 0");
      } else {
        this.ctx.storage.sql.exec("UPDATE github_link SET pr_draft = 0, pr_merged = 1");
      }
      this.bumpIndexRevision();
    });
    if (action.changed !== false) {
      this.emitAudit(action.kind === "ready" ? "pr_ready" : "pr_merged", {
        ...fields,
        review_policy,
      });
    }
    // 終端の後は alarm が消えている。未配送の索引を配送するために、alarm を戻す
    await this.ensureAlarm();
  }

  /** task_result と R2 の result.json が共有する結果の組み立て。AgentDO の getResult が失敗・タイムアウトしたら throw する。 */
  private async composeResult(row: TaskRow, status: TaskStatus): Promise<ResultView> {
    const dto = await this.withTimeout(this.agentStub().getResult(), this.resultTimeoutMs);
    const view =
      dto.status === "not_ready" ? this.synthesizeResult(row, status) : shapeResult(status, dto);
    const withGh = this.withGithub(view);
    if (this.isReview(row)) {
      return this.withReview(row, withGh, dto.status === "not_ready" ? undefined : dto.review);
    }
    const wr = this.getWorkerReview();
    return wr
      ? {
          ...withGh,
          review: this.reviewResultView(
            wr.review_model,
            wr.posted === 1 ? wr.comment_url : null,
            wr.posted === 2,
            dto.status === "not_ready" ? undefined : dto.review,
          ),
        }
      : withGh;
  }

  /** task_review の結果: review と target_pr を足す（pr は無い）。投稿できなかったときだけ本文を載せる */
  private withReview(row: TaskRow, view: ResultView, dto: ReviewResultDto | undefined): ResultView {
    const rl = this.getReview();
    if (!rl) return { ...view, kind: "review" };
    const review = this.reviewResultView(
      rl.review_model,
      rl.posted === 1 ? rl.comment_url : null,
      rl.posted === 2,
      dto,
    );
    return { ...view, kind: "review", review, target_pr: this.targetPr(row, rl) };
  }

  /** task_result の review（task_review と worker_review で共通。AgentDO の結果の review を公開用の形にする） */
  private reviewResultView(
    model: string,
    commentUrl: string | null,
    includeBody: boolean,
    dto: ReviewResultDto | undefined,
  ): ReviewResultView {
    const usage = dto?.usage;
    return {
      stage: dto?.stage === "done" ? "done" : "skipped",
      model,
      comment_url: commentUrl,
      must_fix_count: count(dto?.mustFixCount),
      suggestion_count: count(dto?.suggestionCount),
      fix_applied: false,
      commands: (dto?.commands ?? []).map((c) => ({
        argv: c.argv,
        exit_code: c.exitCode,
        timed_out: c.timedOut,
        output: tailUtf8(c.output, MAX_RESULT_OUTPUT),
        ...(typeof c.durationMs === "number" && Number.isFinite(c.durationMs) && c.durationMs >= 0
          ? { duration_ms: c.durationMs }
          : {}),
        ...(c.skipped === true ? { skipped: true as const } : {}),
      })),
      commands_unavailable: dto?.commandsUnavailable === true,
      ...(typeof dto?.failure === "string" ? { failure: dto.failure.slice(0, 100) } : {}),
      final: null,
      usage: {
        cost_usd:
          typeof usage?.costUsd === "number" && Number.isFinite(usage.costUsd) && usage.costUsd >= 0
            ? usage.costUsd
            : 0,
        input_tokens: count(usage?.inputTokens),
        output_tokens: count(usage?.outputTokens),
        cache_read_tokens: count(usage?.cacheReadTokens),
        cache_write_tokens: count(usage?.cacheWriteTokens),
        estimated: usage?.estimated === true,
      },
      ...(includeBody && typeof dto?.body === "string" ? { body: dto.body } : {}),
    };
  }

  /** GitHub 側の情報（Draft PR・終端で読んだ head・警告）を結果に足す。 */
  private withGithub(view: ResultCore): ResultView {
    const gl = this.getGithub();
    const row = this.getRow();
    const review_policy = row ? policyOf(row) : DEFAULT_REVIEW_POLICY;
    const budget_policy = row ? budgetPolicyOf(row) : DEFAULT_BUDGET_POLICY;
    const model = row ? this.modelOf(row) : defaultModelOf(this.env);
    const effort = row ? this.effortOfRow(row) : effortOf(this.env, model);
    const selection = row ? this.selectionOf(row) : {};
    if (!gl)
      return { ...view, review_policy, budget_policy, model, effort, ...selection, pr: null };
    const extra = (JSON.parse(gl.warnings) as string[]).filter((w) => !view.warnings.includes(w));
    return {
      ...view,
      review_policy,
      budget_policy,
      model,
      effort,
      ...selection,
      warnings: [...view.warnings, ...extra],
      pr:
        gl.pr_number !== null && gl.pr_url !== null
          ? {
              number: gl.pr_number,
              url: gl.pr_url,
              draft: gl.pr_draft === null ? null : gl.pr_draft === 1,
              merged: gl.pr_merged === 1,
              ...(gl.closed_empty === 1 ? { closed_empty: true as const } : {}),
              head_sha: gl.head_sha,
              head_matches_verified: gl.head_matches === null ? null : gl.head_matches === 1,
            }
          : null,
    };
  }

  /** AgentDO に結果が無い（start より先に cancel した、start が rejected など）終端タスクの結果。 */
  private synthesizeResult(row: TaskRow, status: TaskStatus): ResultCore {
    const link = this.getLink();
    const spec = link ? (JSON.parse(link.spec) as BaseSpec) : undefined;
    // 準備の段階の失敗: 準備が終わらないまま FAILED になった（理由は status_changed の reason に残っている）
    const gl = this.getGithub();
    const setupReason =
      status === "FAILED" && gl !== undefined && gl.setup_done === 0
        ? this.failedReason()
        : undefined;
    return {
      status,
      ...(setupReason !== undefined
        ? { reason: setupReason, failure_phase: "setup" as const }
        : {}),
      summary: "",
      verification: {
        commands: (spec?.verificationCommands ?? []).map(shapeCommand),
        results: [],
        verified: false,
        attempts: 0,
      },
      warnings: [`${row.id}: the agent produced no result`],
      pr: null,
      patch_too_large: false,
      usage: shapeUsage({
        costUsd: (link?.usage_micro ?? 0) / 1_000_000,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        web: { search: 0, fetch: 0, browse: 0 },
      }),
    };
  }

  private isStopped(): boolean {
    const link = this.getLink();
    return link ? link.cancel_state === "stopped" : true;
  }

  /** 実行中の GitHub 手順（setup / credentials / finalize）。同じ手順を並行して走らせない（冪等だが無駄な呼び出しを避ける）。 */
  private running = new Set<string>();

  private async guard(step: string, fn: () => Promise<void>): Promise<void> {
    const single =
      step === "setup" ||
      step === "credentials" ||
      step === "finalize" ||
      step === "answer" ||
      step === "steer";
    if (single) {
      if (this.running.has(step)) return;
      this.running.add(step);
    }
    try {
      await fn();
    } catch (e) {
      // メッセージにタスクの内容が入りうるので、エラー名だけを記録する。次の alarm で再試行される。
      console.error("task_do_step_error", step, e instanceof Error ? e.name : typeof e);
    } finally {
      this.running.delete(step);
    }
  }

  private async pump(): Promise<void> {
    const first = this.getLink();
    if (!first) return;
    this.failIfSetupTimedOut();
    await this.guard("setup", () => this.deliverSetup());
    await this.guard("start", () => this.deliverStart());
    await this.guard("cancel", () => this.deliverCancel());
    await this.guard("answer", () => this.deliverAnswers());
    await this.guard("steer", () => this.deliverSteers());
    await this.guard("sync", () => this.syncFromAgent());
    // AgentDO が自分で input_timeout にしなかったときのバックストップ（取り込みの後に判定する）
    this.failIfInputTimedOut();
    // エージェント側の終端をこの回で取り込んだときは、その場で停止確認（cancel）まで進める。
    // （cancel を送ったのに未停止だったものは、次の alarm で再送する。1 回の advance で繰り返さない）
    if (first.cancel_state === "none" && this.getLink()?.cancel_state === "pending") {
      await this.guard("cancel", () => this.deliverCancel());
      await this.guard("sync", () => this.syncFromAgent());
    }
    await this.guard("credentials", () => this.deliverCredentials());
    await this.guard("finalize", () => this.finalizeGithub());
  }

  private async deliverStart(): Promise<void> {
    const link = this.getLink();
    if (link?.start_state !== "pending") return;
    const gl = this.getGithub();
    // Draft PR とブランチ（と最初のトークン）が整うまで start は送らない
    if (gl && gl.setup_done === 0 && !isTerminal(this.currentStatus())) return;
    // Phase 2 で作られた TaskDO（github_link なし）は移行しない。AgentDO は gitCredential を必須にして
    // rejected にするので、start を送らずに FAILED（legacy_task）で閉じる（本番データはまだ無い）。
    if (!gl && !isTerminal(this.currentStatus())) {
      this.failTask("legacy_task");
    }
    if (isTerminal(this.currentStatus())) {
      // 終端のタスクの start は送らない（cancel の tombstone が遅れて届く start を拒否する）。
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec(
          "UPDATE agent_link SET start_state = 'skipped' WHERE start_state = 'pending'",
        );
        this.giveUpDelivery("start");
      });
      this.notifyWaiters();
      return;
    }
    const base = JSON.parse(link.spec) as BaseSpec;
    // 再送のたびに同じ spec（同じトークン）を送る。AgentDO は spec の同一性で冪等を判定する。
    const spec: TaskSpec = gl
      ? {
          ...base,
          ...(this.isReview(this.getRow())
            ? await this.reviewSpecPart(gl)
            : await this.githubSpecPart(gl)),
        }
      : (base as TaskSpec);
    const result = await this.agentStub().start(spec);
    this.applyStartResult(result);
  }

  private applyStartResult(result: StartResult): void {
    const changed = this.ctx.storage.transactionSync(() => {
      const link = this.getLink();
      if (link?.start_state !== "pending") return false;
      const sql = this.ctx.storage.sql;
      switch (result.status) {
        case "accepted":
          sql.exec("UPDATE agent_link SET start_state = 'accepted' WHERE singleton = 1");
          // start に載せたトークンは AgentDO に渡った
          sql.exec(
            "UPDATE github_link SET cred_delivered_id = COALESCE((SELECT MIN(id) FROM git_token WHERE kind = 'start'), 0)",
          );
          if (this.currentStatus() === "CREATING") this.changeStatus("RUNNING");
          if (this.isReview(this.getRow())) {
            const rl = this.getReview();
            this.emitAudit("review_started", {
              userId: this.getRow()?.owner_id,
              ...(rl ? { model: rl.review_model } : {}),
            });
          }
          break;
        case "rejected":
          // 受理されなかったので何も動いていない。停止確認も済んだものとして扱う。
          sql.exec("UPDATE agent_link SET start_state = 'rejected' WHERE singleton = 1");
          this.changeStatus("FAILED", { reason: result.reason.slice(0, 200) });
          sql.exec("UPDATE agent_link SET cancel_state = 'stopped' WHERE singleton = 1");
          break;
        case "conflict":
          // 同じ spec を再送しているので起きないはずの結果。何が動いているか分からないので停止を確認する。
          sql.exec("UPDATE agent_link SET start_state = 'rejected' WHERE singleton = 1");
          this.changeStatus("FAILED", { reason: "agent_conflict" });
          break;
        case "cancelled":
          sql.exec("UPDATE agent_link SET start_state = 'skipped' WHERE singleton = 1");
          this.changeStatus("FAILED", { reason: "agent_cancelled" });
          break;
      }
      return true;
    });
    if (changed) this.notifyWaiters();
  }

  /** 回答を AgentDO に届ける。ok:true（ignored を含む）で完了。ok:false・例外は次の alarm で再送する。 */
  private async deliverAnswers(): Promise<void> {
    const link = this.getLink();
    if (link?.start_state !== "accepted" || isTerminal(this.currentStatus())) return;
    const pending = this.ctx.storage.sql
      .exec<{ question_id: string; answer: string; kind: string | null; decision: string | null }>(
        "SELECT question_id, answer, kind, decision FROM questions WHERE delivery_state = 'pending' AND answer IS NOT NULL ORDER BY asked_at, rowid",
      )
      .toArray();
    for (const q of pending) {
      // 予算の延長の質問には、クライアントの答えの文ではなく、gateway が決めた固定の語（extend | stop）を渡す
      const delivered =
        q.kind === BUDGET_EXTENSION_KIND ? (q.decision === "extend" ? "extend" : "stop") : q.answer;
      const r = await this.agentStub().answer(q.question_id, delivered);
      if (!r.ok) return;
      // await の間に cancel が skipped にしていれば、上書きしない
      this.ctx.storage.sql.exec(
        "UPDATE questions SET delivery_state = 'delivered' WHERE question_id = ? AND delivery_state = 'pending'",
        q.question_id,
      );
    }
  }

  /** steer を受け付けた順に AgentDO に届ける。失敗したらそこで止めて、次の alarm で同じ順に再送する。 */
  private async deliverSteers(): Promise<void> {
    const link = this.getLink();
    if (link?.start_state !== "accepted" || isTerminal(this.currentStatus())) return;
    const pending = this.ctx.storage.sql
      .exec<{ steer_id: string; message: string }>(
        "SELECT steer_id, message FROM steers WHERE delivery_state = 'pending' ORDER BY n",
      )
      .toArray();
    for (const s of pending) {
      const r = await this.agentStub().steer(s.steer_id, s.message);
      if (!r.ok) return;
      this.ctx.storage.sql.exec(
        "UPDATE steers SET delivery_state = 'delivered' WHERE steer_id = ? AND delivery_state = 'pending'",
        s.steer_id,
      );
    }
  }

  /** テスト専用: 回答と steer の配送状態（通しの E2E が、cancel で未配送が skipped になることを確かめる）。 */
  testDeliveryStates(): {
    questions: { question_id: string; delivery_state: string }[];
    steers: { steer_id: string; delivery_state: string }[];
  } {
    if (this.env.ENVIRONMENT !== "test") throw new Error("test only");
    const sql = this.ctx.storage.sql;
    return {
      questions: sql
        .exec<{ question_id: string; delivery_state: string }>(
          "SELECT question_id, delivery_state FROM questions ORDER BY asked_at, rowid",
        )
        .toArray(),
      steers: sql
        .exec<{ steer_id: string; delivery_state: string }>(
          "SELECT steer_id, delivery_state FROM steers ORDER BY n",
        )
        .toArray(),
    };
  }

  private hasPendingDelivery(): boolean {
    const sql = this.ctx.storage.sql;
    return (
      sql.exec("SELECT 1 AS x FROM questions WHERE delivery_state = 'pending' LIMIT 1").toArray()
        .length > 0 ||
      sql.exec("SELECT 1 AS x FROM steers WHERE delivery_state = 'pending' LIMIT 1").toArray()
        .length > 0
    );
  }

  /**
   * 回答待ちが上限（24 時間）+ 猶予を過ぎたら FAILED(input_timeout) にする。
   * 24 時間を数えるのは AgentDO（主）。これは AgentDO が応答しない場合のバックストップで、
   * FAILED になれば cancel の配送（停止確認）に進む。
   */
  private failIfInputTimedOut(): void {
    const row = this.getRow();
    if (!row || this.statusOf(row) !== "INPUT_REQUIRED") return;
    const since = this.ctx.storage.sql
      .exec<{ value: string }>("SELECT value FROM meta WHERE key = ?", INPUT_REQUIRED_SINCE_KEY)
      .toArray()[0];
    const at = since ? Number(since.value) : Number.NaN;
    if (!Number.isFinite(at)) return;
    if (this.now() - at > INPUT_TIMEOUT_MS + INPUT_TIMEOUT_GRACE_MS) {
      // 予算の延長の質問への無応答は、AgentDO と同じく BUDGET_EXCEEDED（reason: budget_extension_timeout）
      const latest = this.ctx.storage.sql
        .exec<{ kind: string | null }>(
          "SELECT kind FROM questions ORDER BY asked_at DESC, rowid DESC LIMIT 1",
        )
        .toArray()[0];
      if (latest?.kind === BUDGET_EXTENSION_KIND) {
        this.ctx.storage.transactionSync(() => {
          this.changeStatus("BUDGET_EXCEEDED", { reason: "budget_extension_timeout" });
        });
        this.notifyWaiters();
      } else this.failTask("input_timeout");
    }
  }

  private async deliverCancel(): Promise<void> {
    const link = this.getLink();
    if (link?.cancel_state !== "pending") return;
    const r = await this.agentStub().cancel();
    if (!r.stopped) return;
    // 契約: stopped:true なら以後イベントは増えない。finalSeq は最後のイベントの seq。
    const finalSeq =
      typeof r.finalSeq === "number" && Number.isSafeInteger(r.finalSeq) && r.finalSeq >= 0
        ? r.finalSeq
        : null;
    this.ctx.storage.sql.exec(
      "UPDATE agent_link SET cancel_state = 'stopped', final_seq = ? WHERE cancel_state = 'pending'",
      finalSeq,
    );
  }

  /** 取り込む必要があるか。start が受理済み、または cancel の意図がある間（最後の usage を拾うため）。 */
  private shouldIngest(link: LinkRow): boolean {
    if (link.finished === 1 || link.start_state === "rejected") return false;
    return link.start_state === "accepted" || link.cancel_state !== "none";
  }

  private isIngesting(): boolean {
    const link = this.getLink();
    return link !== undefined && this.shouldIngest(link);
  }

  /**
   * 取り込みを試し、deadline（epoch ms）までは待つ。超えたら待つのをやめる。
   * 進行中の取り込みは止めない（syncFromAgent の単一化は保たれ、続きは alarm が担う）。
   */
  private async trySync(deadline: number): Promise<void> {
    const sync = this.guard("sync", () => this.syncFromAgent());
    const ms = deadline - Date.now();
    if (ms <= 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        sync,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, ms);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** イベントの取り込みと精算。同時に呼ばれても AgentDO への問い合わせは 1 本に束ねる。 */
  private syncFromAgent(): Promise<void> {
    this.syncing ??= this.doSync().finally(() => {
      this.syncing = undefined;
    });
    return this.syncing;
  }

  private async doSync(): Promise<void> {
    const link = this.getLink();
    if (!link) return;
    const stoppedBefore = link.cancel_state === "stopped";
    let complete = true;
    if (this.shouldIngest(link)) complete = await this.ingest();
    await this.settle(this.readyToFinish(stoppedBefore && complete));
  }

  /**
   * 終了処理（finishTask）に進んでよいか。停止確認済みで、最終 usage まで取り込み済みのとき。
   * finalSeq が分かっていれば、取り込みカーソルがそこに達していること。
   * 分からない場合（finalSeq を返さない AgentDO）は、停止確認の後に取り込みが最後まで済んだこと。
   */
  private readyToFinish(drainedAfterStop: boolean): boolean {
    const link = this.getLink();
    if (link?.cancel_state !== "stopped") return false;
    if (link.final_seq !== null) return link.ingest_cursor >= link.final_seq;
    return drainedAfterStop;
  }

  /** hasMore が false になるまで取り込む。最後まで読めたら true。 */
  private async ingest(): Promise<boolean> {
    for (let page = 0; page < MAX_PAGES_PER_SYNC; page++) {
      const link = this.getLink();
      if (!link) return true;
      const res = await this.agentStub().getEvents(link.ingest_cursor, EVENT_PAGE_LIMIT);
      const progressed = this.applyPage(res);
      if (!res.hasMore) return true;
      if (!progressed) return false;
    }
    return false;
  }

  /**
   * 1 ページ分を、状態・自分の seq・イベント・取り込みカーソルとまとめて 1 トランザクションで反映する。
   * カーソル以下の seq は取り込み済みとして読み飛ばすので、同じ範囲が重なって届いても重複しない。
   */
  private applyPage(page: EventsPage): boolean {
    const before = this.latestSeq();
    const progressed = this.ctx.storage.transactionSync(() => {
      const link = this.getLink();
      if (!link) return false;
      let cursor = link.ingest_cursor;
      let usageSeq = link.usage_seq;
      let usageMicro = link.usage_micro;
      let usagePublic = parseUsagePublic(link.usage_public);
      for (const e of page.events) {
        if (e.seq <= cursor) continue;
        const m = mapAgentEvent(e);
        // 終端に確定した後は公開イベントを増やさない（利用者の cancel 後など）。usage だけは数え続ける。
        const open = !isTerminal(this.currentStatus());
        if (m.kind === "phase") {
          if (open && m.status !== null) this.applyPhase(m.status, m.reason);
        } else if (m.kind === "usage") {
          usagePublic = mergeUsagePublic(usagePublic, m.payload);
          if (e.seq > usageSeq) {
            usageSeq = e.seq;
            usageMicro = m.costMicroUsd;
          }
          if (open) this.appendAgentEvent("usage", m.payload, e.ts, link.operation_id, e.seq);
        } else if (m.kind === "question") {
          if (open) this.applyQuestion(m.payload, e.ts, link.operation_id, e.seq);
        } else if (m.kind === "progress") {
          // 履歴（events）には積まない。最新の 1 件だけを上書きする（終端の後は取り込まない）
          if (open && m.progress !== undefined) this.applyProgress(m.progress, e.ts);
        } else if (open) {
          this.appendAgentEvent(m.type, m.payload, e.ts, link.operation_id, e.seq);
          // 索引の stage / verify_attempt に効くイベント（一覧の段階を古いままにしない）
          if (INDEX_STAGE_EVENTS.has(m.type)) this.bumpIndexRevision();
          // 終わったコマンドの記録が来たら、そのコマンドの途中経過は要らない
          if (m.type === "command") this.clearProgress();
        }
        cursor = e.seq;
      }
      const usagePublicJson = JSON.stringify(usagePublic);
      this.ctx.storage.sql.exec(
        "UPDATE agent_link SET ingest_cursor = ?, usage_seq = ?, usage_micro = ?, usage_public = ? WHERE singleton = 1",
        cursor,
        usageSeq,
        usageMicro,
        usagePublicJson,
      );
      // 索引に出る usage の値が変わったときだけ上げる（何も変わらない取り込みで dirty にしない）
      if (usageMicro !== link.usage_micro || usagePublicJson !== link.usage_public) {
        this.bumpIndexRevision();
      }
      return cursor > link.ingest_cursor;
    });
    if (this.latestSeq() !== before) this.notifyWaiters();
    return progressed;
  }

  /** 実行中の進捗（command_progress）の保存場所。meta の 1 行で、履歴の events には入れない。 */
  private applyProgress(p: CommandProgressEvent, ts: number): void {
    if (p.ended === true) {
      this.clearProgress();
      return;
    }
    const value = {
      command: p.command,
      ...(p.cwd !== undefined ? { cwd: p.cwd } : {}),
      started_at: p.startedAt,
      ...(p.outputTail !== undefined ? { output_tail: p.outputTail } : {}),
      updated_at: Number.isFinite(ts) ? ts : this.now(),
    };
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)",
      PROGRESS_KEY,
      JSON.stringify(value),
    );
  }

  /** 進捗を消す（最後の command・終端・cancel・ended で呼ぶ） */
  private clearProgress(): void {
    this.ctx.storage.sql.exec("DELETE FROM meta WHERE key = ?", PROGRESS_KEY);
  }

  /** 保存してある最新の進捗。無ければ null */
  private readProgress(): DashboardProgress | null {
    const row = this.ctx.storage.sql
      .exec<{ value: string }>("SELECT value FROM meta WHERE key = ?", PROGRESS_KEY)
      .toArray()[0];
    if (!row) return null;
    try {
      return JSON.parse(row.value) as DashboardProgress;
    } catch {
      return null;
    }
  }

  /** question の取り込み。questions への保存とイベントの追加は、取り込みと同じトランザクションの中で行う。 */
  private applyQuestion(
    payload: EventPayload,
    ts: number,
    operationId: string,
    agentSeq: number,
  ): void {
    const questionId = String(payload.question_id ?? "");
    if (questionId === "") return;
    const sql = this.ctx.storage.sql;
    const known = sql
      .exec("SELECT 1 AS x FROM questions WHERE question_id = ?", questionId)
      .toArray();
    if (known.length > 0) return;
    const at = Number.isFinite(ts) ? ts : this.now();
    sql.exec(
      "INSERT INTO questions (question_id, message, options, kind, delivery_state, asked_at) VALUES (?, ?, ?, ?, 'none', ?)",
      questionId,
      String(payload.message ?? ""),
      String(payload.options ?? "[]"),
      payload.kind === BUDGET_EXTENSION_KIND ? BUDGET_EXTENSION_KIND : null,
      at,
    );
    this.appendAgentEvent("question", payload, ts, operationId, agentSeq);
  }

  private appendAgentEvent(
    type: string,
    payload: EventPayload,
    ts: number,
    operationId: string,
    agentSeq: number,
  ): void {
    this.appendEvent(type, payload, Number.isFinite(ts) ? ts : this.now(), {
      operationId,
      seq: agentSeq,
    });
  }

  /**
   * AgentDO の phase を状態に写す。イベントを 1 件ずつ順に適用するので、
   * start の応答が失われて CREATING のまま先へ進んでいた場合は、RUNNING を経由して追いつく。
   */
  private applyPhase(target: TaskStatus, reason: string | undefined): void {
    const from = this.currentStatus();
    if (from === target || isTerminal(from)) return;
    if (!canTransition(from, target) && from === "CREATING") this.changeStatus("RUNNING");
    this.changeStatus(target, reason !== undefined ? { reason } : {});
  }

  /** usage の精算と、終了時の返却。UserDO への呼び出しは冪等で、失敗すれば次の alarm で再試行する。 */
  private async settle(canFinish: boolean): Promise<void> {
    const row = this.getRow();
    let link = this.getLink();
    if (!row || !link) return;
    if (link.usage_seq > link.settled_seq) {
      const seq = link.usage_seq;
      await this.userStub(row.owner_id).settleUsage(row.id, seq, link.usage_micro);
      this.ctx.storage.sql.exec(
        "UPDATE agent_link SET settled_seq = MAX(settled_seq, ?) WHERE singleton = 1",
        seq,
      );
      link = this.getLink();
      if (!link) return;
    }
    if (
      canFinish &&
      link.finished === 0 &&
      link.cancel_state === "stopped" &&
      isTerminal(this.currentStatus())
    ) {
      await this.userStub(row.owner_id).finishTask(row.id, link.usage_seq, link.usage_micro);
      this.ctx.storage.sql.exec("UPDATE agent_link SET finished = 1 WHERE singleton = 1");
    }
  }

  // ---- GitHub: 初期コミット・ブランチ・Draft PR・Installation Token ----

  private apiBase(): string {
    return resolveGitHubBaseUrls(this.env).apiBase;
  }

  private async encKey(): Promise<CryptoKey> {
    return importEncryptionKey(this.env.TOKEN_ENC_KEY);
  }

  private appClient(): GitHubAppClient {
    const appId = this.env.GITHUB_APP_ID;
    const privateKey = this.env.GITHUB_APP_PRIVATE_KEY;
    if (!appId || !privateKey) throw new SetupFailure("github_app_not_configured");
    return new GitHubAppClient({
      appId,
      privateKey,
      apiBase: this.apiBase(),
      now: () => this.now(),
      ...(this.githubFetch ? { fetch: this.githubFetch } : {}),
    });
  }

  private repoApi(row: TaskRow, token: string): GitHubRepoApi {
    return new GitHubRepoApi({
      token,
      repository: row.repository,
      apiBase: this.apiBase(),
      ...(this.githubFetch ? { fetch: this.githubFetch } : {}),
    });
  }

  /** Installation Token を発行して暗号化保存する。トークンの値はログにもイベントにも出さない。 */
  private async issueToken(
    row: TaskRow,
    kind: "start" | "refresh" | "final",
  ): Promise<{ id: number; token: string; expiresAt: number }> {
    try {
      return await this.issueTokenInner(row, kind);
    } catch (e) {
      // 失敗は監査ログだけに出す（再試行のたびに events を増やさない。FAILED になれば status_changed の reason が残る）
      this.emitAudit("credential_issue_failed", { kind, reason: issueFailureCode(e) });
      throw e;
    }
  }

  private async issueTokenInner(
    row: TaskRow,
    kind: "start" | "refresh" | "final",
  ): Promise<{ id: number; token: string; expiresAt: number }> {
    if (row.repository_id === null || row.installation_id === null) {
      throw new SetupFailure("github_app_not_configured");
    }
    const client = this.appClient();
    let issued: { token: string; expiresAt: number };
    try {
      issued = await client.createInstallationToken(row.installation_id, row.repository_id);
    } catch (e) {
      if (e instanceof GitHubApiError) throw e;
      // 鍵の形式不正など（メッセージに鍵の内容は含まれない）
      throw new SetupFailure("github_app_not_configured");
    }
    const enc = await encryptString(await this.encKey(), issued.token, tokenAad(row.id));
    // 保存と、発行の記録（events の audit と監査ログ。トークンの値は入れない）は同じトランザクション
    const id = this.ctx.storage.transactionSync(() => {
      const inserted = this.ctx.storage.sql
        .exec<{ id: number }>(
          "INSERT INTO git_token (enc, expires_at, kind) VALUES (?, ?, ?) RETURNING id",
          enc,
          issued.expiresAt,
          kind,
        )
        .one().id;
      this.auditBoth("credential_issued", { kind });
      return inserted;
    });
    this.notifyWaiters();
    return { id, token: issued.token, expiresAt: issued.expiresAt };
  }

  private async decryptToken(r: TokenRow): Promise<string> {
    const id = this.getRow()?.id ?? "";
    try {
      return await decryptString(await this.encKey(), r.enc, tokenAad(id));
    } catch {
      // 壊れた・別のタスクの暗号文。再試行しても直らない（中身は出さない）。
      throw new SetupFailure("token_decrypt_failed");
    }
  }

  /** 保存済みの作者（無ければ undefined。形が壊れていても undefined） */
  private async storedBotIdentity(): Promise<BotAuthor | undefined> {
    const v = await this.ctx.storage.get<BotAuthor>(BOT_IDENTITY_KEY);
    return v && typeof v.name === "string" && typeof v.email === "string" ? v : undefined;
  }

  /**
   * commit の作者: この App の bot（`<slug>[bot]` / `<id>+<slug>[bot]@users.noreply.github.com`）。
   * 初回に GitHub から引いて保存し、以後は同じ値を返す。引けなかった（障害・権限・App 未設定）ときは
   * GitHub のアカウントに結び付かない代わりの作者（rovo@noreply.invalid）にして、それも保存する（タスクを止めない）。
   */
  private async botIdentity(installationToken?: string): Promise<BotAuthor> {
    const stored = await this.storedBotIdentity();
    if (stored) return stored;
    let who = FALLBACK_COMMIT_IDENTITY;
    try {
      who = await this.appClient().getBotIdentity(installationToken);
    } catch (e) {
      // 代わりの作者のまま続ける（コミットの作者のために、タスクを失敗させない）。理由だけ残す（トークンや本文は出さない）
      const what =
        e instanceof GitHubApiError
          ? `${e.message} status=${e.status} detail=${e.detail.slice(0, 200)}`
          : e instanceof SetupFailure
            ? `setup_failure`
            : "unexpected error";
      console.warn(`[bot-identity] fallback: ${what}`);
    }
    await this.ctx.storage.put(BOT_IDENTITY_KEY, who);
    return who;
  }

  /** start の taskSpec に入れる部分（branch・initialSha・最初のトークン）。再送でも同じ値になる。 */
  private async githubSpecPart(
    gl: GithubRow,
  ): Promise<Pick<TaskSpec, "branch" | "initialSha" | "gitCredential" | "deps" | "commitAuthor">> {
    const start = this.tokenRows("kind = 'start'")[0];
    if (!start || gl.initial_sha === null) throw new Error("github setup is incomplete");
    return {
      branch: gl.branch,
      initialSha: gl.initial_sha,
      gitCredential: { token: await this.decryptToken(start), expiresAt: start.expires_at },
      // 取得済みの値をそのまま送る（再送で変わらない）。未取得（この機能より前に始まったタスク）は載せない: 受理済みの spec と食い違わせない
      ...(gl.deps !== null ? { deps: JSON.parse(gl.deps) as TaskSpec["deps"] } : {}),
      // 初期コミットで決めた作者（保存済みのときだけ。この機能より前に始まったタスクは載せない: 受理済みの spec と食い違わせない）
      ...(await this.storedBotIdentity().then((who) => (who ? { commitAuthor: who } : {}))),
    };
  }

  /** 10 分を超えて CREATING のままなら FAILED（setup_timeout）。GitHub の障害で枠と予算を握り続けない。 */
  private failIfSetupTimedOut(): void {
    const row = this.getRow();
    if (!row || this.statusOf(row) !== "CREATING") return;
    if (this.now() - row.created_at > SETUP_TIMEOUT_MS) this.failTask("setup_timeout");
  }

  private failTask(reason: string): void {
    this.ctx.storage.transactionSync(() => {
      this.changeStatus("FAILED", { reason });
    });
    this.notifyWaiters();
  }

  private async deliverSetup(): Promise<void> {
    const row = this.getRow();
    const gl = this.getGithub();
    if (!row || !gl || gl.setup_done === 1 || isTerminal(this.statusOf(row))) return;
    if (this.now() < gl.setup_retry_at) return;
    try {
      if (this.isReview(row)) await this.runReviewSetup(row, gl);
      else await this.runSetup(row, gl);
    } catch (e) {
      this.onGithubError(e, "setup");
    }
  }

  /** 各ステップは冪等で、進んだところは永続化する。途中で落ちても次の alarm で続きから再開する。 */
  private async runSetup(row: TaskRow, start: GithubRow): Promise<void> {
    const sql = this.ctx.storage.sql;
    let gl = start;
    const existing = this.tokenRows("kind = 'start'")[0];
    const plain = existing
      ? await this.decryptToken(existing)
      : (await this.issueToken(row, "start")).token;
    const api = this.repoApi(row, plain);

    // 0. 依存関係のキャッシュの指定（D14）。base_sha 時点のルート直下の lockfile。読めなくても null で続ける（失敗しない）。
    //    一度保存したら、start の再送でも同じ値を送る（AgentDO は spec の同一性で冪等を判定する）。
    if (gl.deps === null) {
      const deps = await detectDeps(api, row.repository_id ?? 0, row.base_sha);
      sql.exec("UPDATE github_link SET deps = ?", JSON.stringify(deps));
      gl = this.getGithub() as GithubRow;
    }

    // 1. 決定的な初期コミット（author / committer の日時を created_at に固定）。SHA は ref を作る前に永続化する。
    if (gl.initial_sha === null) {
      let base: { sha: string; treeSha: string };
      try {
        base = await api.getCommit(row.base_sha);
      } catch (e) {
        if (e instanceof GitHubApiError && e.status === 404) {
          throw new SetupFailure("base_sha_not_found");
        }
        throw e;
      }
      const date = new Date(row.created_at).toISOString().replace(/\.\d{3}Z$/, "Z");
      const who = await this.botIdentity(plain);
      const sha = await api.createCommit({
        message: `rovo: start task ${row.id}`,
        treeSha: base.treeSha,
        parents: [base.sha],
        identity: { ...who, date },
      });
      sql.exec("UPDATE github_link SET initial_sha = ?", sha);
      gl = this.getGithub() as GithubRow;
    }
    const initial = gl.initial_sha as string;

    // 2. 作業ブランチ。既にあれば compare で確かめる（削除も force もしない）。
    if (gl.branch_ready === 0) {
      if ((await api.createBranch(gl.branch, initial)) === "exists") {
        const head = await api.getBranchSha(gl.branch);
        if (head === null) throw new GitHubApiError({ status: 0, what: "branch vanished" });
        const cmp = await api.compare(initial, head);
        if (cmp.status !== "identical" && cmp.status !== "ahead") {
          throw new SetupFailure("branch_conflict");
        }
      }
      sql.exec("UPDATE github_link SET branch_ready = 1");
    }

    // 3. Draft PR と、4. 保存・イベント
    if (gl.pr_number === null) {
      this.existingNotDraft = false;
      const pr = await this.ensurePull(api, row, gl.branch);
      const reused = this.existingNotDraft;
      this.ctx.storage.transactionSync(() => {
        sql.exec(
          "UPDATE github_link SET pr_number = ?, pr_url = ?, pr_draft = ?",
          pr.number,
          pr.url,
          pr.draft ? 1 : 0,
        );
        sql.exec("UPDATE task SET draft_pr_url = ? WHERE singleton = 1", pr.url);
        this.bumpIndexRevision();
        const at = this.now();
        this.appendEvent(
          "draft_pr_created",
          {
            number: pr.number,
            url: pr.url,
            draft: pr.draft,
            branch: gl.branch,
            initial_sha: initial,
          },
          at,
        );
        if (!pr.draft && reused) {
          const warning =
            "existing_pr_not_draft: the existing pull request for this branch is not a draft; rovo is working on it anyway (DRAFT_PR_FALLBACK=ready)";
          sql.exec(
            "UPDATE github_link SET warnings = ?",
            JSON.stringify([...(JSON.parse(gl.warnings) as string[]), warning]),
          );
          this.appendEvent("warning", { code: "existing_pr_not_draft" }, at);
        } else if (!pr.draft) {
          const warning =
            "draft_pr_unavailable: this repository cannot create draft pull requests; a regular [WIP] pull request was created instead";
          sql.exec(
            "UPDATE github_link SET warnings = ?",
            JSON.stringify([...(JSON.parse(gl.warnings) as string[]), warning]),
          );
          this.appendEvent("warning", { code: "draft_pr_unavailable" }, at);
        }
      });
      this.notifyWaiters();
    }

    // 5. 最初のトークンは発行済み（上）。start を送ってよい。
    sql.exec("UPDATE github_link SET setup_done = 1, setup_attempts = 0, setup_retry_at = 0");
  }

  /**
   * task_review の準備: 最初の Installation Token、依存関係のキャッシュの指定（head の lockfile。読めなくても null で続ける）、
   * base...head の差分（上限 1 MiB。超えたらファイルの区切りで切る）。ブランチ・初期コミット・PR は作らない（クライアントの PR に書き込まない）。
   * 各ステップは冪等で、進んだところは永続化する。
   */
  private async runReviewSetup(row: TaskRow, start: GithubRow): Promise<void> {
    const sql = this.ctx.storage.sql;
    const rl = this.getReview();
    if (!rl) throw new SetupFailure("review_missing");
    const existing = this.tokenRows("kind = 'start'")[0];
    const plain = existing
      ? await this.decryptToken(existing)
      : (await this.issueToken(row, "start")).token;
    const api = this.repoApi(row, plain);
    if (start.deps === null) {
      const deps = await detectDeps(api, row.repository_id ?? 0, rl.head_sha);
      sql.exec("UPDATE github_link SET deps = ?", JSON.stringify(deps));
    }
    if (rl.diff === null) {
      const d = await api.getCompareDiff(rl.base_sha, rl.head_sha, REVIEW_DIFF_FETCH_MAX_BYTES);
      sql.exec("UPDATE review_link SET diff = ?, diff_truncated = ?", d.diff, d.truncated ? 1 : 0);
    }
    sql.exec("UPDATE github_link SET setup_done = 1, setup_attempts = 0, setup_retry_at = 0");
  }

  /** task_review の start の spec に足す部分（トークン・差分・レビューの指定）。再送でも同じ値になる */
  private async reviewSpecPart(
    gl: GithubRow,
  ): Promise<Pick<TaskSpec, "branch" | "initialSha" | "gitCredential" | "deps" | "review">> {
    const start = this.tokenRows("kind = 'start'")[0];
    const rl = this.getReview();
    if (!start || !rl || rl.diff === null) throw new Error("review setup is incomplete");
    const commands = JSON.parse(rl.review_commands) as {
      argv: string[];
      cwd?: string;
      timeout_seconds?: number;
    }[];
    return {
      branch: "",
      initialSha: rl.head_sha,
      gitCredential: { token: await this.decryptToken(start), expiresAt: start.expires_at },
      ...(gl.deps !== null ? { deps: JSON.parse(gl.deps) as TaskSpec["deps"] } : {}),
      review: {
        pullNumber: rl.pull_number,
        headSha: rl.head_sha,
        baseSha: rl.base_sha,
        model: rl.review_model,
        commands: commands.map((c) => ({
          argv: c.argv,
          ...(c.cwd !== undefined ? { cwd: c.cwd } : {}),
          ...(c.timeout_seconds !== undefined ? { timeoutSeconds: c.timeout_seconds } : {}),
        })),
        title: rl.pr_title,
        body: rl.pr_body,
        diff: rl.diff,
        diffTruncated: rl.diff_truncated === 1,
      },
    };
  }

  private checkBase(pr: PullInfo, row: TaskRow): PullInfo {
    if (pr.baseRef !== row.base_ref) throw new SetupFailure("pr_base_mismatch");
    return pr;
  }

  /**
   * 既存の open PR を使う。base が違えば失敗。Draft でなければ、DRAFT_PR_FALLBACK=ready のときだけ
   * 警告付きで使う（既定の fail では existing_pr_not_draft で FAILED。レビュー可能な PR に勝手に書き込まない）。
   */
  private async useExisting(pr: PullInfo, row: TaskRow): Promise<PullInfo> {
    this.checkBase(pr, row);
    if (!pr.draft) {
      if (!(await this.draftFallbackIsReady())) throw new SetupFailure("existing_pr_not_draft");
      this.existingNotDraft = true;
    }
    return pr;
  }

  /** ensurePull が、Draft でない既存の PR を使ったか（runSetup が警告を残す）。 */
  private existingNotDraft = false;

  private async draftFallbackIsReady(): Promise<boolean> {
    // 通しの E2E だけ、wrangler の再起動なしで切り替えられる（ENVIRONMENT=test のときだけ有効。test-routes.ts）
    const override = await testDraftFallback(this.env);
    const value = override ?? this.env.DRAFT_PR_FALLBACK ?? "";
    // fail-closed: "ready" 以外（未設定・不正な値）はすべて fail
    return value.trim().toLowerCase() === "ready";
  }

  private async ensurePull(api: GitHubRepoApi, row: TaskRow, branch: string): Promise<PullInfo> {
    const found = await api.findOpenPull(branch);
    if (found) return this.useExisting(found, row);
    const create = (draft: boolean) =>
      api.createPull({
        title: draft ? row.title : `[WIP] ${row.title}`,
        head: branch,
        base: row.base_ref,
        body: draft
          ? renderInitialBlock(row.id)
          : `${READY_FALLBACK_NOTE}\n\n${renderInitialBlock(row.id)}`,
        draft,
      });
    // already exists の 422: もう一度探して使う
    const refind = async (): Promise<PullInfo> => {
      const again = await api.findOpenPull(branch);
      if (again) return this.useExisting(again, row);
      throw new GitHubApiError({ status: 0, what: "pull request exists but is not listed" });
    };
    try {
      return await create(true);
    } catch (e) {
      if (!(e instanceof GitHubApiError) || e.status !== 422) throw e;
      if (/already exists/i.test(e.detail)) return refind();
      // Draft に関する 422 のときだけ、DRAFT_PR_FALLBACK に従う。それ以外の 422 で通常の PR に切り替えない。
      if (!DRAFT_UNSUPPORTED_RE.test(e.detail)) throw new SetupFailure("github_unprocessable");
      if (!(await this.draftFallbackIsReady())) throw new SetupFailure("draft_pr_unsupported");
      try {
        return await create(false);
      } catch (e2) {
        if (e2 instanceof GitHubApiError && e2.status === 422) {
          if (/already exists/i.test(e2.detail)) return refind();
          throw new SetupFailure("github_unprocessable");
        }
        throw e2;
      }
    }
  }

  /**
   * GitHub 呼び出しの失敗を分類する。
   * 401: 警告して再試行 / 403・404: FAILED / 422: FAILED / 429・secondary rate limit・5xx・ネットワーク: 再試行。
   */
  private onGithubError(e: unknown, phase: "setup" | "finalize"): void {
    if (e instanceof SetupFailure) {
      if (phase === "setup") this.failTask(e.reason);
      else this.giveUpFinalize();
      return;
    }
    if (!(e instanceof GitHubApiError)) {
      console.error("task_do_github_error", phase, e instanceof Error ? e.name : typeof e);
      this.scheduleRetry(phase);
      return;
    }
    console.error("task_do_github_error", phase, e.status);
    if (e.rateLimited) {
      this.scheduleRetry(phase, e.retryAfterMs);
    } else if (e.status === 401) {
      const gl = this.getGithub();
      if (gl && gl.auth_warned === 0) {
        this.ctx.storage.transactionSync(() => {
          this.ctx.storage.sql.exec("UPDATE github_link SET auth_warned = 1");
          this.appendEvent("warning", { code: "github_auth_failed" }, this.now());
        });
        this.notifyWaiters();
      }
      this.scheduleRetry(phase);
    } else if (e.status === 0 || e.status >= 500) {
      this.scheduleRetry(phase, e.retryAfterMs);
    } else if (phase === "finalize") {
      // 403（権限不足）・404（見えない）・422・その他の 4xx: 再試行しても直らない
      this.giveUpFinalize();
    } else {
      const reason =
        e.status === 403
          ? "github_forbidden"
          : e.status === 404
            ? "github_not_found"
            : e.status === 422
              ? "github_unprocessable"
              : `github_error_${e.status}`;
      this.failTask(reason);
    }
  }

  private scheduleRetry(phase: "setup" | "finalize", retryAfterMs?: number): void {
    const gl = this.getGithub();
    if (!gl) return;
    const attempts = (phase === "setup" ? gl.setup_attempts : gl.finalize_attempts) + 1;
    const backoff = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (attempts - 1));
    const delay =
      retryAfterMs !== undefined
        ? Math.min(Math.max(retryAfterMs, 0), RETRY_AFTER_MAX_MS)
        : backoff;
    const at = this.now() + delay;
    if (phase === "setup") {
      this.ctx.storage.sql.exec(
        "UPDATE github_link SET setup_attempts = ?, setup_retry_at = ?",
        attempts,
        at,
      );
    } else {
      this.ctx.storage.sql.exec(
        "UPDATE github_link SET finalize_attempts = ?, finalize_retry_at = ?",
        attempts,
        at,
      );
      // 有限回で PR 本文の更新を諦める（トークンの失効は続ける）
      if (attempts >= FINALIZE_MAX_ATTEMPTS) this.giveUpFinalize();
    }
  }

  /** PR 本文の更新を諦める。トークンの失効には進む。 */
  private giveUpFinalize(): void {
    const gl = this.getGithub();
    if (!gl || gl.body_done === 1 || gl.pr_number === null) return;
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        "UPDATE github_link SET body_done = 1, finalize_attempts = 0, finalize_retry_at = 0",
      );
      this.appendEvent("warning", { code: "pr_update_failed" }, this.now());
    });
    this.notifyWaiters();
  }

  // ---- RUNNING 中のトークンの更新と配送 ----

  private async deliverCredentials(): Promise<void> {
    const row = this.getRow();
    const link = this.getLink();
    const gl = this.getGithub();
    if (!row || !link || !gl) return;
    if (link.start_state !== "accepted" || isTerminal(this.statusOf(row))) return;
    let latest = this.tokenRows("revoked = 0").at(-1);
    if (!latest) return;
    // 期限の 15 分前になったら新しいトークンを発行する（まだ渡せていない新しいトークンがあれば、それを再送する）
    // 未配送のトークン自身が期限に近づいた場合も再発行して差し替える（配送失敗が続いても期限切れを送り続けない）
    if (latest.expires_at - this.now() <= TOKEN_REFRESH_BEFORE_MS) {
      const issued = await this.issueToken(row, "refresh");
      latest = this.tokenRows(`id = ${issued.id}`)[0] as TokenRow;
    }
    if (latest.id <= gl.cred_delivered_id) return;
    const r = await this.agentStub().setGitCredential({
      token: await this.decryptToken(latest),
      expiresAt: latest.expires_at,
    });
    if (!r.ok) return;
    this.ctx.storage.sql.exec(
      "UPDATE github_link SET cred_delivered_id = MAX(cred_delivered_id, ?)",
      latest.id,
    );
    // 渡せたので、古いトークンは失効させる（失敗しても終端で失効する）
    for (const old of this.tokenRows(`revoked = 0 AND id < ${latest.id}`)) {
      await this.revokeToken(old).catch(() => {});
    }
  }

  private async revokeToken(r: TokenRow): Promise<void> {
    const expired = r.expires_at <= this.now();
    if (!expired) {
      await this.appClient().revokeInstallationToken(await this.decryptToken(r));
    }
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec("UPDATE git_token SET revoked = 1 WHERE id = ?", r.id);
      this.auditBoth("credential_revoked", {
        kind: r.kind,
        reason: expired ? "already_expired" : "revoked",
      });
    });
    this.notifyWaiters();
  }

  // ---- 終端: PR の更新とトークンの失効 ----

  /** FAILED になったときの status_changed の reason（SetupFailure のコードなど）。無ければ undefined。 */
  private failedReason(): string | undefined {
    const rows = this.ctx.storage.sql
      .exec<{ payload: string }>(
        "SELECT payload FROM events WHERE type = 'status_changed' ORDER BY seq DESC",
      )
      .toArray();
    for (const r of rows) {
      const p = JSON.parse(r.payload) as { status?: unknown; reason?: unknown };
      if (p.status === "FAILED") return typeof p.reason === "string" ? p.reason : undefined;
    }
    return undefined;
  }

  private terminalReason(): string | undefined {
    const rows = this.ctx.storage.sql
      .exec<{ payload: string }>(
        "SELECT payload FROM events WHERE type IN ('status_changed', 'cancelled') ORDER BY seq DESC LIMIT 5",
      )
      .toArray();
    for (const r of rows) {
      const p = JSON.parse(r.payload) as { reason?: unknown };
      if (typeof p.reason === "string") return p.reason;
    }
    return undefined;
  }

  /** 終端を確定し、AgentDO の停止を確かめた後に 1 回だけ（冪等に）行う。予約の返却とは独立。 */
  private async finalizeGithub(): Promise<void> {
    const row = this.getRow();
    const link = this.getLink();
    const gl = this.getGithub();
    if (!row || !link || !gl || gl.finalize_done === 1) return;
    const status = this.statusOf(row);
    if (!isTerminal(status) || link.cancel_state !== "stopped") return;
    if (this.now() < gl.finalize_retry_at) return;

    // worker_review: レビューの投稿は PR の本文の更新と自動の Ready より先（投稿してから Ready にする。
    // 投稿できなかったときの review_comment_failed は、本文の更新が書く warnings に入る）。PR が無ければ投稿しない
    if (this.getWorkerReview() && gl.pr_number !== null && !(await this.postReview(row, status))) {
      return;
    }
    // 投稿で warnings（review_comment_failed）が増えたかもしれないので、本文の更新には読み直した行を使う
    const fresh = this.getGithub() ?? gl;
    if (fresh.pr_number !== null && fresh.body_done === 0) {
      try {
        await this.updatePullBody(row, fresh, status);
      } catch (e) {
        this.onGithubError(e, "finalize");
        // 本文の更新が済んでいない（再試行待ち）あいだは、失効しない
        if ((this.getGithub() as GithubRow).body_done === 0) return;
      }
    }
    // task_review: レビューの投稿（再試行待ちのあいだは、失効しない）
    if (this.isReview(row) && !(await this.postReview(row, status))) return;

    for (const t of this.tokenRows("revoked = 0")) {
      try {
        await this.revokeToken(t);
      } catch (e) {
        if (e instanceof SetupFailure) {
          // App の設定が失われている・暗号文を復号できない。再試行しても直らないので、記録だけ閉じる（期限は 1 時間）。
          this.ctx.storage.transactionSync(() => {
            this.ctx.storage.sql.exec("UPDATE git_token SET revoked = 1 WHERE id = ?", t.id);
            // 既存の warning が無い経路なので、events にも audit で残す
            this.auditBoth("credential_revoke_given_up", {
              kind: t.kind,
              reason: "setup_failure",
            });
          });
          this.notifyWaiters();
          continue;
        }
        this.onRevokeError(e);
        return;
      }
    }
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec("UPDATE github_link SET finalize_done = 1");
      this.scrubTokenCiphertext();
    });
  }

  /**
   * 失効の失敗。レート制限・5xx・ネットワークは backoff で再試行し、REVOKE_MAX_ATTEMPTS で諦める。
   * 403 / 422 などの再試行しても直らない 4xx は、その場で諦める。諦めたら記録を閉じて finalize_done に進める
   * （トークンの期限は 1 時間）。PR 本文の更新（pr_update_failed）とは別に token_revoke_failed を出す。
   */
  private onRevokeError(e: unknown): void {
    const gl = this.getGithub();
    if (!gl) return;
    console.error("task_do_revoke_error", e instanceof GitHubApiError ? e.status : typeof e);
    const retryable =
      !(e instanceof GitHubApiError) || e.rateLimited || e.status === 0 || e.status >= 500;
    const attempts = gl.revoke_attempts + 1;
    if (!retryable || attempts >= REVOKE_MAX_ATTEMPTS) {
      this.ctx.storage.transactionSync(() => {
        const sql = this.ctx.storage.sql;
        sql.exec("UPDATE git_token SET revoked = 1 WHERE revoked = 0");
        const warning =
          "token_revoke_failed: the installation token could not be revoked; it expires on its own within an hour";
        sql.exec(
          "UPDATE github_link SET revoke_attempts = ?, finalize_retry_at = 0, finalize_done = 1, warnings = ?",
          attempts,
          JSON.stringify([...(JSON.parse(gl.warnings) as string[]), warning]),
        );
        this.scrubTokenCiphertext();
        this.appendEvent("warning", { code: "token_revoke_failed" }, this.now());
        // events には既存の warning(token_revoke_failed) があるので、監査ログだけに出す
        this.emitAudit("credential_revoke_given_up", {
          reason: retryable ? "attempts_exhausted" : "not_retryable",
        });
      });
      this.notifyWaiters();
      return;
    }
    const backoff = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (attempts - 1));
    const retryAfter = e instanceof GitHubApiError ? e.retryAfterMs : undefined;
    const delay =
      retryAfter !== undefined ? Math.min(Math.max(retryAfter, 0), RETRY_AFTER_MAX_MS) : backoff;
    this.ctx.storage.sql.exec(
      "UPDATE github_link SET revoke_attempts = ?, finalize_retry_at = ?",
      attempts,
      this.now() + delay,
    );
  }

  /**
   * task_review の終了処理: AgentDO が返した本文を、PR のレビュー（event は COMMENT に固定。repo-api が決める）として 1 回だけ投稿する。
   * 投稿するのは COMPLETED で本文があるときだけ（それ以外は何も書かない）。PR の状態・本文・ブランチは変えない。
   * 一時的な失敗（5xx・429・ネットワーク）は backoff で再試行し、FINALIZE_MAX_ATTEMPTS で諦める。再試行しても直らない失敗はその場で諦め、
   * warnings に review_comment_failed を足す（本文は task_result の review.body で読める）。
   * 戻り値: 終わった（投稿した・諦めた・投稿しない）なら true、再試行を待つなら false。
   */
  private async postReview(row: TaskRow, status: TaskStatus): Promise<boolean> {
    const target = this.reviewPostTarget();
    if (target?.posted !== 0) return true;
    if (this.now() < target.post_retry_at) return false;
    let dto: ResultDto;
    try {
      dto = await this.withTimeout(this.agentStub().getResult(), this.resultTimeoutMs);
    } catch {
      // AgentDO が結果を返せない。有限回で諦める（終了処理とトークンの失効を止めない）
      if (target.post_attempts + 1 < FINALIZE_MAX_ATTEMPTS) {
        this.schedulePostRetry(target, true);
        return false;
      }
      this.giveUpReviewPost(row, target, "result_unavailable");
      return true;
    }
    const review = dto.status === "not_ready" ? undefined : dto.review;
    const audit = {
      userId: row.owner_id,
      model: target.model,
      ...(review ? { cost_usd: review.usage.costUsd } : {}),
    };
    // 投稿先の PR。task_review はクライアントの PR（固定した head）、worker_review はタスクの PR（検証した commit）
    const pullNumber = target.pull_number;
    const headSha = target.table === "review_link" ? target.head_sha : review?.headSha;
    if (status !== "COMPLETED" || !review?.body || pullNumber === null || !headSha) {
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec(`UPDATE ${target.table} SET posted = 3`);
        this.appendEvent("review_finished", { stage: "skipped" }, this.now());
        this.bumpIndexRevision();
        // worker_review でレビューの段まで進まなかった（検証の失敗・取消しなど）ときは、レビューの失敗として監査しない
        if (target.table === "review_link" || review !== undefined) {
          this.emitAudit("review_failed", {
            ...audit,
            reason: review?.failure ?? status.toLowerCase(),
          });
        }
      });
      this.notifyWaiters();
      return true;
    }
    try {
      const api = this.repoApi(row, await this.workingToken(row));
      const posted = await api.createPullReview(pullNumber, review.body, headSha);
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec(
          `UPDATE ${target.table} SET posted = 1, comment_url = ?`,
          posted.url.length <= 2_000 ? posted.url : null,
        );
        const at = this.now();
        this.appendEvent(
          "review_posted",
          {
            comment_url: posted.url.length <= 2_000 ? posted.url : null,
            must_fix_count: review.mustFixCount,
            suggestion_count: review.suggestionCount,
          },
          at,
        );
        this.appendEvent("review_finished", { stage: "done" }, at);
        this.bumpIndexRevision();
        this.emitAudit("review_posted", {
          ...audit,
          must_fix_count: review.mustFixCount,
          suggestion_count: review.suggestionCount,
        });
      });
      this.notifyWaiters();
      return true;
    } catch (e) {
      const retryable =
        !(e instanceof GitHubApiError) || e.rateLimited || e.status === 0 || e.status >= 500;
      console.error("task_do_review_post_error", e instanceof GitHubApiError ? e.status : typeof e);
      if (retryable && target.post_attempts + 1 < FINALIZE_MAX_ATTEMPTS) {
        this.schedulePostRetry(
          target,
          true,
          e instanceof GitHubApiError ? e.retryAfterMs : undefined,
        );
        return false;
      }
      this.giveUpReviewPost(row, target, "comment_failed", audit.cost_usd);
      return true;
    }
  }

  /**
   * レビューの投稿の進み具合の持ち主（task_review は review_link、worker_review は worker_review の行）。無ければ undefined。
   * 投稿先の PR の番号は、task_review は対象の PR、worker_review はタスクの PR（github_link）。
   */
  private reviewPostTarget(): ReviewPostTarget | undefined {
    const rl = this.getReview();
    if (rl) {
      return {
        table: "review_link",
        posted: rl.posted,
        post_attempts: rl.post_attempts,
        post_retry_at: rl.post_retry_at,
        model: rl.review_model,
        pull_number: rl.pull_number,
        head_sha: rl.head_sha,
      };
    }
    const wr = this.getWorkerReview();
    if (!wr) return undefined;
    return {
      table: "worker_review",
      posted: wr.posted,
      post_attempts: wr.post_attempts,
      post_retry_at: wr.post_retry_at,
      model: wr.review_model,
      pull_number: this.getGithub()?.pr_number ?? null,
    };
  }

  /** レビューの投稿を諦める: warnings に review_comment_failed（本文は task_result の review.body で読める）、監査に review_failed */
  private giveUpReviewPost(
    row: TaskRow,
    target: ReviewPostTarget,
    reason: string,
    costUsd?: number,
  ): void {
    this.ctx.storage.transactionSync(() => {
      const gl = this.getGithub();
      const own = gl ? (JSON.parse(gl.warnings) as string[]) : [];
      if (!own.includes("review_comment_failed")) own.push("review_comment_failed");
      this.ctx.storage.sql.exec("UPDATE github_link SET warnings = ?", JSON.stringify(own));
      this.ctx.storage.sql.exec(`UPDATE ${target.table} SET posted = 2`);
      const at = this.now();
      this.appendEvent("warning", { code: "review_comment_failed" }, at);
      this.appendEvent("review_finished", { stage: "done" }, at);
      this.bumpIndexRevision();
      this.emitAudit("review_failed", {
        userId: row.owner_id,
        model: target.model,
        ...(costUsd !== undefined ? { cost_usd: costUsd } : {}),
        reason,
      });
    });
    this.notifyWaiters();
  }

  private schedulePostRetry(target: ReviewPostTarget, count: boolean, retryAfterMs?: number): void {
    const attempts = target.post_attempts + (count ? 1 : 0);
    const backoff = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1));
    const delay =
      retryAfterMs !== undefined
        ? Math.min(Math.max(retryAfterMs, 0), RETRY_AFTER_MAX_MS)
        : backoff;
    this.ctx.storage.sql.exec(
      `UPDATE ${target.table} SET post_attempts = ?, post_retry_at = ?`,
      attempts,
      this.now() + delay,
    );
  }

  /** 失効していない、期限に余裕のあるトークン。無ければ発行する。 */
  private async workingToken(row: TaskRow): Promise<string> {
    for (const t of this.tokenRows("revoked = 0").reverse()) {
      if (t.expires_at - this.now() > 60_000) return this.decryptToken(t);
    }
    return (await this.issueToken(row, "final")).token;
  }

  private async updatePullBody(row: TaskRow, gl: GithubRow, status: TaskStatus): Promise<void> {
    const number = gl.pr_number as number;
    const dto = await this.withTimeout(this.agentStub().getResult(), this.resultTimeoutMs);
    const view =
      dto.status === "not_ready" ? this.synthesizeResult(row, status) : shapeResult(status, dto);
    const pushed = dto.status === "not_ready" ? undefined : safeSha(dto.pushedSha);

    const api = this.repoApi(row, await this.workingToken(row));
    const pull = await api.getPull(number);
    // 真偽は GitHub から読んだ head を正とする。比べる基準は pushedSha（AgentDO が push して ls-remote で確かめた SHA）。
    // pushedSha が無い（push に失敗した）ときは比べない: head_matches は null、PR の head も記録しない
    // （警告は AgentDO の push_failed だけ）。pushedSha と検証済みの commit_sha が食い違うときは、
    // push したコミットが検証したものと違うので、PR の head が pushedSha と同じでも不一致として扱う。
    const verified = view.verification.commit_sha;
    // 完了以外（予算超過・期限など）で検証した commit が無いまま push 済みの SHA がある（チェックポイントの push）。
    // 検証していない commit なので head_matches_verified は false（head_sha は記録する）
    const neverVerified = status !== "COMPLETED" && verified === undefined;
    const matches =
      pushed === undefined
        ? null
        : !neverVerified &&
          pull.headSha === pushed &&
          (verified === undefined || verified === pushed);
    const own = JSON.parse(gl.warnings) as string[];
    if (matches === false && !neverVerified) {
      const w = `head_moved_after_verification: the PR head ${pull.headSha} differs from the verified commit ${verified ?? pushed}`;
      if (!own.includes(w)) own.push(w);
    }
    const headSha = pushed === undefined ? null : pull.headSha;
    const reason = view.reason ?? this.terminalReason();
    const block = renderReportBlock(
      {
        taskId: row.id,
        status,
        ...(reason !== undefined ? { reason } : {}),
        summary: view.summary,
        verified: view.verification.verified,
        ...(view.verification.commit_sha !== undefined
          ? { commitSha: view.verification.commit_sha }
          : {}),
        results: view.verification.results.map((r) => ({
          argv: r.argv,
          exitCode: r.exit_code,
          timedOut: r.timed_out,
          output: r.output,
        })),
        warnings: [...view.warnings, ...own],
        headSha,
        headMatches: matches,
        costUsd: view.usage.cost_usd,
      },
      { showCost: this.env.PR_SHOW_COST === "true" },
    );
    const body = applyManagedBlock(pull.body, block);
    if (body !== pull.body) await api.updatePullBody(number, body);
    this.ctx.storage.sql.exec(
      "UPDATE github_link SET head_sha = ?, head_matches = ?, warnings = ?, body_done = 1, finalize_attempts = 0, finalize_retry_at = 0",
      headSha,
      matches === null ? null : matches ? 1 : 0,
      JSON.stringify(own),
    );
    this.notifyWaiters();
    await this.closeEmptyPull(row, gl, status, api, pull);
    await this.autoReady(row, status, api, pull, pushed !== undefined);
  }

  /**
   * client_review のタスクが COMPLETED になり、最終の push が済んだ（pushedSha がある）Draft PR を、rovo が Ready for review にする。
   * Installation Token（finalize の他の操作と同じもの）で GraphQL を呼ぶ。FAILED / BUDGET_EXCEEDED / CANCELLED などは Draft のまま。
   * fail-soft: 失敗してもタスクは COMPLETED のまま。warn と warning イベント（auto_ready_failed）を残し、
   * task_result の next_steps が task_pr_ready を促す。task_pr_merge を止めないよう、結果の warnings には足さない。
   * 冪等: 読んだ PR がすでに Ready・閉じている・空の Draft PR を閉じた場合は何もしない。
   */
  private async autoReady(
    row: TaskRow,
    status: TaskStatus,
    api: GitHubRepoApi,
    pull: { number: number; draft: boolean; state: string; nodeId: string | null },
    pushed: boolean,
  ): Promise<void> {
    // client_review と worker_review のどちらも、完了で rovo が Ready にする（worker_review はレビューの投稿のあと）
    if (status !== "COMPLETED" || !pushed) return;
    const gl = this.getGithub();
    if (!gl || gl.closed_empty === 1 || gl.pr_merged === 1) return;
    if (!pull.draft || pull.state !== "open") return;
    let code = "mark_ready_failed";
    try {
      if (pull.nodeId === null) {
        code = "pull_node_id_missing";
        throw new Error(code);
      }
      await api.markReadyForReview(pull.nodeId);
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec("UPDATE github_link SET pr_draft = 0");
        this.bumpIndexRevision();
      });
      this.emitAudit("pr_ready", {
        caller: "system",
        kind: "ready",
        reason: "auto_ready",
        review_policy: policyOf(row),
      });
    } catch (e) {
      const http = e instanceof GitHubApiError ? e.status : undefined;
      console.warn(
        "task_do_auto_ready_failed",
        code,
        http ?? (e instanceof Error ? e.name : typeof e),
      );
      this.appendEvent("warning", { code: "auto_ready_failed" }, this.now());
    }
    this.notifyWaiters();
  }

  /**
   * 変更なし（PR の head もブランチの先頭も initial_sha のまま）で終端になった Draft PR を、close → コメント → ブランチ削除の順で片付ける。
   * 判定は pushedSha に頼らない（push が無い終端でも空の PR が残るため）。GitHub から読んだ PR の head と、読み直した
   * ブランチの先頭が、どちらも initial_sha と同じときだけ閉じる。読めなかったときは何もしない（安全側）。
   * 失敗してもタスクの終端は変えず、warnings に固定のコードを足すだけ（再試行しない）。
   */
  private async closeEmptyPull(
    row: TaskRow,
    gl: GithubRow,
    status: TaskStatus,
    api: GitHubRepoApi,
    pull: { number: number; draft: boolean; state: string; headSha: string },
  ): Promise<void> {
    if (gl.closed_empty === 1 || gl.pr_merged === 1) return;
    if (gl.initial_sha === null || pull.headSha !== gl.initial_sha) return;
    if (!pull.draft || pull.state !== "open") return;
    if (status === "FAILED" && gl.setup_done === 0) return;
    try {
      const branchHead = await api.getBranchSha(gl.branch);
      if (branchHead !== gl.initial_sha) return;
    } catch (e) {
      console.error(
        "task_do_close_empty_read_error",
        e instanceof GitHubApiError ? e.status : typeof e,
      );
      return;
    }
    let code: string | undefined;
    try {
      // close を先にする: close が失敗したのに「閉じました」というコメントだけが残らないように
      code = "close_failed";
      await api.closePull(pull.number);
      this.ctx.storage.sql.exec("UPDATE github_link SET closed_empty = 1");
      try {
        await api.commentPull(
          pull.number,
          `このタスクは変更を作らずに終わったので、rovo が Draft PR を閉じました（task ${row.id}）`,
        );
      } catch (e) {
        // コメントの失敗では、閉じた PR のブランチ削除を止めない
        console.error(
          "task_do_close_empty_comment_error",
          e instanceof GitHubApiError ? e.status : typeof e,
        );
      }
      code = "delete_branch_failed";
      await api.deleteBranch(gl.branch, gl.initial_sha);
      code = undefined;
    } catch (e) {
      console.error("task_do_close_empty_error", e instanceof GitHubApiError ? e.status : typeof e);
    }
    if (code !== undefined) {
      const cur = this.getGithub() as GithubRow;
      const own = JSON.parse(cur.warnings) as string[];
      own.push(`empty draft PR could not be closed: ${code}`);
      this.ctx.storage.sql.exec("UPDATE github_link SET warnings = ?", JSON.stringify(own));
    }
    this.notifyWaiters();
  }

  // ---- 要約（task_summary。phase6.md「M3 で決めたこと」）----

  /** 現在の状態から要約レコードを作る（読むだけ）。 */
  private buildSummary(row: TaskRow, link: LinkRow): TaskSummary {
    const sql = this.ctx.storage.sql;
    const gl = this.getGithub();
    const status = this.statusOf(row);
    const changes = sql
      .exec<{ payload: string; created_at: number }>(
        "SELECT payload, created_at FROM events WHERE type = 'status_changed' ORDER BY seq",
      )
      .toArray()
      .map((r) => ({
        p: JSON.parse(r.payload) as { status?: unknown; reason?: unknown },
        at: r.created_at,
      }))
      .filter((r) => typeof r.p.status === "string");
    const last = changes.filter((c) => c.p.status === status).at(-1);
    const verifications = sql
      .exec<{ payload: string }>(
        "SELECT payload FROM events WHERE type = 'verification' ORDER BY seq",
      )
      .toArray()
      .map((r) => JSON.parse(r.payload) as { attempt?: unknown; passed?: unknown });
    const countEvents = (type: string) =>
      sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM events WHERE type = ?", type).one().n;
    const up = parseUsagePublic(link.usage_public);
    const observed = up.sandbox_runtime_ms !== undefined;
    return buildTaskSummary({
      taskId: row.id,
      userId: row.owner_id,
      repository: row.repository,
      prUrl: gl?.pr_url ?? row.draft_pr_url ?? null,
      status,
      reason: typeof last?.p.reason === "string" ? last.p.reason : null,
      createdAt: row.created_at,
      transitions: changes.map((c) => ({ status: String(c.p.status), at: c.at })),
      usage: {
        costMicroUsd: link.usage_micro,
        inputTokens: up.input_tokens ?? 0,
        outputTokens: up.output_tokens ?? 0,
        cacheReadTokens: up.cache_read_tokens ?? 0,
        cacheWriteTokens: up.cache_write_tokens ?? 0,
        web: { search: up.web_search ?? 0, fetch: up.web_fetch ?? 0, browse: up.web_browse ?? 0 },
        sandbox: observed
          ? {
              runtimeMs: up.sandbox_runtime_ms ?? 0,
              restarts: up.sandbox_restarts ?? 0,
              bootRetries: up.sandbox_boot_retries ?? 0,
              ...(up.sandbox_instance !== undefined ? { instance: up.sandbox_instance } : {}),
              ...(up.sandbox_promoted_to !== undefined
                ? {
                    promotedTo: up.sandbox_promoted_to,
                    ...(up.sandbox_promoted_at !== undefined
                      ? { promotedAt: up.sandbox_promoted_at }
                      : {}),
                    runtimeMsBeforePromotion: up.sandbox_runtime_ms_before_promotion ?? 0,
                  }
                : {}),
              ...(up.sandbox_promotion_reason !== undefined
                ? { promotionReason: up.sandbox_promotion_reason }
                : {}),
              ...(up.sandbox_promotions !== undefined ? { promotions: up.sandbox_promotions } : {}),
              ...(up.sandbox_heavy_commands_after_agent_scale_up !== undefined
                ? { heavyCommandsAfterAgentScaleUp: up.sandbox_heavy_commands_after_agent_scale_up }
                : {}),
              ...(up.sandbox_heavy_commands_covered_by_agent !== undefined
                ? { heavyCommandsCoveredByAgent: up.sandbox_heavy_commands_covered_by_agent }
                : {}),
              ...(up.sandbox_promotion_failures !== undefined
                ? { promotionFailures: up.sandbox_promotion_failures }
                : {}),
              ...((up.sandbox_scale_decisions ?? 0) > 0 || (up.sandbox_scale_skipped_light ?? 0) > 0
                ? {
                    scaleStats: {
                      decisions: up.sandbox_scale_decisions ?? 0,
                      raised: up.sandbox_scale_raised ?? 0,
                      clefFailures: up.sandbox_scale_clef_failures ?? 0,
                      slowNotRaised: up.sandbox_scale_slow_not_raised ?? 0,
                      skippedLight: up.sandbox_scale_skipped_light ?? 0,
                    },
                  }
                : {}),
            }
          : null,
      },
      questions: countEvents("question"),
      verification: {
        attempts: Math.max(
          0,
          ...verifications.map((v) => (typeof v.attempt === "number" ? v.attempt : 0)),
        ),
        passed: verifications.length === 0 ? null : verifications.at(-1)?.passed === true,
      },
      agentErrors: countEvents("agent_error"),
      prices: parsePrices(this.env),
    });
  }

  /**
   * 終端で、費用の精算（finished）と GitHub の終了処理（finalize_done。GitHub と紐付かないタスクは満たしているものとして扱う）が
   * 済んだら、task_summary を監査ログに 1 回だけ出す。R2 への保存は M4。出力の失敗でタスクの進行を止めない。
   */
  private logSummaryIfReady(): void {
    try {
      const row = this.getRow();
      const link = this.getLink();
      if (!row || !link || link.summary_logged === 1 || link.finished === 0) return;
      const status = this.statusOf(row);
      if (!isTerminal(status)) return;
      const gl = this.getGithub();
      if (gl !== undefined && gl.finalize_done === 0) return;
      const summary = this.buildSummary(row, link);
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec("UPDATE agent_link SET summary_logged = 1 WHERE singleton = 1");
        this.emitAudit("task_summary", {
          userId: row.owner_id,
          reason: summary.reason ?? undefined,
          kind: status.toLowerCase(),
          metrics: summaryMetrics(summary),
        });
      });
    } catch (e) {
      console.error("task_summary_error", e instanceof Error ? e.name : typeof e);
    }
  }

  // ---- R2 アーカイブ（phase6.md「R2 への保存」「M4 で決めたこと」）----

  /** `tasks/<yyyy>/<mm>/<task_id>/`。<yyyy>/<mm> はタスクの作成時刻（UTC）なので、再試行でキーが変わらない。 */
  private archivePrefix(row: TaskRow): string {
    const d = new Date(row.created_at);
    const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
    return `tasks/${d.getUTCFullYear()}/${mm}/${row.id}/`;
  }

  /** 公開イベントの全件（TaskDO が既に持っているもの。archive の境界で新たに生のデータを足さない）を 1 行 1 イベントで。 */
  private eventsJsonl(): string {
    return `${this.ctx.storage.sql
      .exec<EventRow>("SELECT seq, type, payload, created_at FROM events ORDER BY seq")
      .toArray()
      .map((e) =>
        JSON.stringify({
          seq: e.seq,
          type: e.type,
          payload: JSON.parse(e.payload) as EventPayload,
          created_at: new Date(e.created_at).toISOString(),
        }),
      )
      .join("\n")}\n`;
  }

  /**
   * 終端で、費用の精算（finished）と GitHub の終了処理（finalize_done。GitHub と紐付かないタスクは満たしているものとして扱う）が
   * 済んだら、events.jsonl → result.json → summary.json の順で R2 に書く（summary.json が完了の印）。コピーであり、
   * 失敗してもタスクの結果と予算の精算には影響させない。LOGS が無ければ fail-open（archive_skipped）。
   */
  private async archiveIfReady(): Promise<void> {
    if (this.running.has("archive")) return;
    this.running.add("archive");
    try {
      await this.runArchive();
    } catch (e) {
      console.error("task_archive_error", e instanceof Error ? e.name : typeof e);
    } finally {
      this.running.delete("archive");
    }
  }

  private async runArchive(): Promise<void> {
    const row = this.getRow();
    const link = this.getLink();
    if (!row || !link || link.archive_done === 1 || link.finished === 0) return;
    const status = this.statusOf(row);
    if (!isTerminal(status)) return;
    const gl = this.getGithub();
    if (gl !== undefined && gl.finalize_done === 0) return;
    if (this.now() < link.archive_retry_at) return;

    const bucket = this.env.LOGS;
    if (!bucket) {
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec("UPDATE agent_link SET archive_done = 1 WHERE singleton = 1");
        this.emitAudit("archive_skipped", { userId: row.owner_id, reason: "no_binding" });
      });
      return;
    }

    let stage: "result_unavailable" | "put_failed" = "result_unavailable";
    try {
      const result = await this.composeResult(row, status);
      // 結果を待っている間にも状態は進みうる。要約と events は、書く直前に同期で作る（同じ時点のスナップショット）
      const link2 = this.getLink() as LinkRow;
      const files: [string, string, string][] = [
        ["events.jsonl", this.eventsJsonl(), "application/x-ndjson"],
        ["result.json", JSON.stringify(result), "application/json"],
        ["summary.json", JSON.stringify(this.buildSummary(row, link2)), "application/json"],
      ];
      stage = "put_failed";
      const prefix = this.archivePrefix(row);
      let bytes = 0;
      for (const [name, body, contentType] of files) {
        await this.withTimeout(
          Promise.resolve(bucket.put(prefix + name, body, { httpMetadata: { contentType } })),
          ARCHIVE_PUT_TIMEOUT_MS,
        );
        bytes += new TextEncoder().encode(body).length;
      }
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec("UPDATE agent_link SET archive_done = 1 WHERE singleton = 1");
        this.emitAudit("archive_completed", { userId: row.owner_id, prefix, bytes });
      });
    } catch (e) {
      // エラーのメッセージにはデータが入りうるので、名前だけを記録する
      console.error("task_archive_attempt_error", stage, e instanceof Error ? e.name : typeof e);
      const attempts = link.archive_attempts + 1;
      if (attempts >= ARCHIVE_MAX_ATTEMPTS) {
        // アーカイブの後（events の確定後）なので、events には入れず、監査ログにだけ出す
        this.ctx.storage.transactionSync(() => {
          this.ctx.storage.sql.exec(
            "UPDATE agent_link SET archive_done = 1, archive_attempts = ? WHERE singleton = 1",
            attempts,
          );
          this.emitAudit("archive_failed", { userId: row.owner_id, reason: stage });
        });
      } else {
        const backoff = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (attempts - 1));
        this.ctx.storage.sql.exec(
          "UPDATE agent_link SET archive_attempts = ?, archive_retry_at = ? WHERE singleton = 1",
          attempts,
          this.now() + backoff,
        );
      }
    }
  }

  /** テスト専用: 現在の状態から作った要約レコード。ENVIRONMENT=test のときだけ。 */
  testSummary(): TaskSummary {
    if (this.env.ENVIRONMENT !== "test") throw new Error("test only");
    const row = this.getRow();
    const link = this.getLink();
    if (!row || !link) throw new Error("task missing");
    return this.buildSummary(row, link);
  }

  // ---- ダッシュボードの索引（docs/specs/dashboard.md D10 / M3a）----

  /** Directory への配送の待ちの上限（ms）。テストで短くする。 */
  protected indexTimeoutMs = INDEX_TIMEOUT_MS;

  /** 再試行間隔のジッター用の乱数（[0, 1)）。テストで差し替える。 */
  protected random: () => number = Math.random;

  /** 索引のシングルトン。テストで差し替える。 */
  protected directoryStub() {
    return this.env.DIRECTORY_DO.getByName(DIRECTORY_NAME);
  }

  /**
   * 索引に出る値を変える同期区間の中で呼ぶ（transactionSync の中。行の更新と同じトランザクションで revision を上げる）。
   * 配送は alarm が最新の snapshot を 1 回送るので、usage のように頻繁な更新でも配送は alarm の周期にまとまる。
   */
  private bumpIndexRevision(): void {
    this.ctx.storage.sql.exec(
      "UPDATE agent_link SET index_revision = index_revision + 1 WHERE singleton = 1",
    );
  }

  /**
   * 最新の snapshot を Directory へ配送する（alarm からだけ呼ぶ）。失敗してもタスクの本体を止めない（索引は派生データ）。
   * snapshot と revision は await を挟まず同期で読み、成功したら送った revision まで sent を進める
   * （送っている間に revision が上がっていても取りこぼさない）。失敗は指数バックオフで再試行する。
   */
  private async deliverIndex(): Promise<void> {
    try {
      if (this.env.DIRECTORY_DO === undefined) return;
      const row = this.getRow();
      const link = this.getLink();
      if (!row || !link || link.index_revision <= link.index_sent_revision) return;
      if (this.now() < link.index_retry_at) return;
      const revision = link.index_revision;
      const snapshot = this.buildIndexSnapshot(row, link);
      try {
        const call = this.directoryStub().upsertTask(
          snapshot,
          revision,
        ) as unknown as Promise<UpsertTaskResult>;
        const res = await this.withTimeout(call, this.indexTimeoutMs);
        if (!res.ok) {
          if (res.code === "invalid_input") {
            // 恒久的な拒否（snapshot がスキーマに合わない）。再送しても通らないので、この revision は送信済みとして捨てる。
            // ログにはコード（名前）だけを出す。次の更新（新しい revision）で、また送る
            console.error("task_index_rejected", res.code);
            this.ctx.storage.sql.exec(
              "UPDATE agent_link SET index_sent_revision = MAX(index_sent_revision, ?), index_attempts = 0, index_retry_at = 0 WHERE singleton = 1",
              revision,
            );
            return;
          }
          throw new Error(`rejected: ${res.code}`);
        }
      } catch (e) {
        // エラーのメッセージにはデータが入りうるので、名前だけを記録する
        console.error("task_index_deliver_error", e instanceof Error ? e.name : typeof e);
        const attempts = link.index_attempts + 1;
        const backoff = indexBackoffMs(attempts, this.random);
        this.ctx.storage.sql.exec(
          "UPDATE agent_link SET index_attempts = ?, index_retry_at = ? WHERE singleton = 1",
          attempts,
          this.now() + backoff,
        );
        return;
      }
      this.ctx.storage.sql.exec(
        "UPDATE agent_link SET index_sent_revision = MAX(index_sent_revision, ?), index_attempts = 0, index_retry_at = 0 WHERE singleton = 1",
        revision,
      );
    } catch (e) {
      console.error("task_index_error", e instanceof Error ? e.name : typeof e);
    }
  }

  /** 索引に入れる値（読むだけ）。入力（instructions など）・トークン・PR の本文は入れない。 */
  private buildIndexSnapshot(row: TaskRow, link: LinkRow): TaskIndexSnapshot {
    const gl = this.getGithub();
    const status = this.statusOf(row);
    const changes = this.ctx.storage.sql
      .exec<{ type: string; payload: string; created_at: number }>(
        "SELECT type, payload, created_at FROM events WHERE type IN ('status_changed', 'cancelled') ORDER BY seq",
      )
      .toArray()
      .map((e) => ({
        type: e.type,
        at: e.created_at,
        p: JSON.parse(e.payload) as { status?: unknown; reason?: unknown },
      }));
    const terminal = isTerminal(status);
    const startedAt =
      changes.find((c) => c.type === "status_changed" && c.p.status === "RUNNING")?.at ?? null;
    const last = terminal ? changes.filter((c) => c.p.status === status).at(-1) : undefined;
    const up = parseUsagePublic(link.usage_public);
    const model = this.modelOf(row);
    return {
      task_id: row.id,
      owner_id: row.owner_id,
      owner_login: clip(row.owner_login, INDEX_LIMITS.login),
      repository: clip(row.repository, INDEX_LIMITS.repository),
      repository_id: row.repository_id,
      title: clip(row.title, INDEX_LIMITS.title),
      status,
      model: clip(model, INDEX_LIMITS.model),
      effort: this.effortOfRow(row),
      created_at: row.created_at,
      updated_at: row.updated_at,
      started_at: startedAt,
      // updated_at は状態が変わったときにしか動かない（changeStatus / cancel）ので、終端の updated_at が終了の時刻
      ended_at: terminal ? row.updated_at : null,
      cost_micro: link.usage_micro,
      input_tokens: Math.floor(up.input_tokens ?? 0),
      output_tokens: Math.floor(up.output_tokens ?? 0),
      cache_read_tokens: Math.floor(up.cache_read_tokens ?? 0),
      cache_write_tokens: Math.floor(up.cache_write_tokens ?? 0),
      pr_number: gl?.pr_number ?? null,
      // URL は切り詰めると壊れるので、上限を超えたら入れない
      pr_url: gl?.pr_url != null && gl.pr_url.length <= INDEX_LIMITS.url ? gl.pr_url : null,
      pr_draft: gl?.pr_draft === undefined || gl.pr_draft === null ? null : gl.pr_draft === 1,
      pr_merged: gl?.pr_merged === 1,
      reason: typeof last?.p.reason === "string" ? clip(last.p.reason, INDEX_LIMITS.reason) : null,
      failure_phase:
        status === "FAILED" && gl !== undefined && gl.setup_done === 0 ? "setup" : null,
      ...this.indexStageFields(row, status),
      // deps_cache は終端の結果（AgentDO の getResult）にしか無く、TaskDO が同期で持つ値ではない。詳細は TaskDO から読む（M7）
      deps_cache: null,
      sandbox_runtime_ms:
        up.sandbox_runtime_ms !== undefined ? Math.floor(up.sandbox_runtime_ms) : null,
    };
  }

  /**
   * task_list の stage に要る値（kind・review の段・検証に入ったか・検証の試行回数・review の対象 PR）。
   * review の段は、終端でも途中の段を残す（失敗したレビューの止まった段が分かる）。COMPLETED は投稿が済んだか（posting / done）。
   */
  private indexStageFields(
    row: TaskRow,
    status: TaskStatus,
  ): Pick<
    TaskIndexSnapshot,
    | "kind"
    | "review_stage"
    | "reached_verifying"
    | "verify_attempt"
    | "target_pr_number"
    | "target_pr_url"
  > {
    const sql = this.ctx.storage.sql;
    const reachedVerifying = this.reachedStatuses().verifying;
    if (this.isReview(row)) {
      const rl = this.getReview();
      const seen = new Set(
        sql
          .exec<{ type: string }>(
            "SELECT DISTINCT type FROM events WHERE type IN ('review_started', 'review_commands_finished', 'review_finished')",
          )
          .toArray()
          .map((r) => r.type),
      );
      let reviewStage: "waiting" | "commands" | "reviewing" | "posting" | "done" = "waiting";
      if (status === "COMPLETED") reviewStage = seen.has("review_finished") ? "done" : "posting";
      else if (seen.has("review_commands_finished")) reviewStage = "reviewing";
      else if (seen.has("review_started")) {
        const commands = rl ? (JSON.parse(rl.review_commands) as unknown[]) : [];
        reviewStage = commands.length > 0 ? "commands" : "reviewing";
      }
      return {
        kind: "review",
        review_stage: reviewStage,
        reached_verifying: reachedVerifying,
        verify_attempt: null,
        target_pr_number: rl?.pull_number ?? null,
        // URL は切り詰めると壊れるので、上限を超えたら入れない
        target_pr_url:
          rl?.pull_url != null && rl.pull_url.length <= INDEX_LIMITS.url ? rl.pull_url : null,
      };
    }
    const last = sql
      .exec<{ a: number | null }>(
        "SELECT MAX(json_extract(payload, '$.attempt')) AS a FROM events WHERE type = 'verification'",
      )
      .toArray()[0]?.a;
    return {
      kind: "task",
      review_stage: null,
      reached_verifying: reachedVerifying,
      verify_attempt: typeof last === "number" && Number.isInteger(last) && last > 0 ? last : null,
      target_pr_number: null,
      target_pr_url: null,
    };
  }

  /** 未配送の索引があるか。Directory が未束縛の環境（migration の前など）では無いものとして扱う（alarm を回し続けない） */
  private indexDirty(): boolean {
    if (this.env.DIRECTORY_DO === undefined) return false;
    const link = this.getLink();
    return link !== undefined && link.index_revision > link.index_sent_revision;
  }

  private needsAlarm(): boolean {
    return this.indexDirty() || this.needsTaskAlarm();
  }

  /** 索引以外の仕事（start / cancel の再送、取り込み、精算、終了処理、アーカイブ）が残っているか。 */
  private needsTaskAlarm(): boolean {
    const link = this.getLink();
    const row = this.getRow();
    if (!link || !row) return false;
    if (link.start_state === "pending" || link.cancel_state === "pending") return true;
    if (!isTerminal(this.statusOf(row))) return link.start_state === "accepted";
    const gl = this.getGithub();
    return (
      link.usage_seq > link.settled_seq ||
      link.finished === 0 ||
      (gl !== undefined && gl.finalize_done === 0) ||
      link.archive_done === 0
    );
  }

  /**
   * 次の alarm までの間隔。INPUT_REQUIRED の間は 60 秒に延ばす（クライアントの回答を待っているだけなので）。
   * 回答や steer の配送が pending、cancel / start の再送、トークンの更新・配送が必要なときは 10 秒。
   */
  private alarmDelay(): number {
    const row = this.getRow();
    const link = this.getLink();
    if (!row || !link) return ALARM_INTERVAL_MS;
    // 索引だけが残っているときは、配送の再試行の間隔（バックオフ）に合わせる
    if (this.indexDirty() && !this.needsTaskAlarm()) {
      return Math.max(ALARM_INTERVAL_MS, link.index_retry_at - this.now());
    }
    const idle =
      !this.indexDirty() &&
      this.statusOf(row) === "INPUT_REQUIRED" &&
      link.start_state === "accepted" &&
      link.cancel_state === "none" &&
      !this.hasPendingDelivery() &&
      !this.credentialWorkPending();
    return idle ? INPUT_REQUIRED_ALARM_INTERVAL_MS : ALARM_INTERVAL_MS;
  }

  /** 新しいトークンを渡せていない、または期限が近く更新が要る。 */
  private credentialWorkPending(): boolean {
    const gl = this.getGithub();
    const latest = this.tokenRows("revoked = 0").at(-1);
    if (!gl || !latest) return false;
    return (
      latest.id > gl.cred_delivered_id || latest.expires_at - this.now() <= TOKEN_REFRESH_BEFORE_MS
    );
  }

  /** 次の alarm を明示的に設定し直す。仕事が無ければ消す。 */
  private async syncAlarm(): Promise<void> {
    if (this.needsAlarm()) await this.ctx.storage.setAlarm(Date.now() + this.alarmDelay());
    else await this.ctx.storage.deleteAlarm();
  }

  /** alarm が ms より先なら、前倒しする（回答や steer を受け付けたとき。60 秒の待機を待たせない）。 */
  private async pullAlarmIn(ms: number): Promise<void> {
    const target = Date.now() + ms;
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > target) await this.ctx.storage.setAlarm(target);
  }

  /** 仕事があるのに alarm が無いときだけ設定する（作成直後・再起動後）。 */
  private async ensureAlarm(): Promise<void> {
    if (!this.needsAlarm()) return;
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
    }
  }

  private currentStatus(): TaskStatus {
    const row = this.getRow();
    if (!row) throw new Error("task row missing");
    return this.statusOf(row);
  }

  private waitResult(cursor: number, events: TaskEvent[], retryAfter?: number): WaitResult {
    const last = events[events.length - 1];
    return {
      ok: true,
      status: this.currentStatus(),
      cursor: String(last ? last.seq : cursor),
      events,
      ...(retryAfter !== undefined ? { retry_after_seconds: retryAfter } : {}),
    };
  }
}

function isNullableId(v: unknown): boolean {
  return v === undefined || v === null || (typeof v === "number" && Number.isSafeInteger(v));
}

function shapeCommand(c: { argv: string[]; cwd?: string; timeoutSeconds?: number }): {
  argv: string[];
  cwd?: string;
  timeout_seconds?: number;
} {
  return {
    argv: c.argv,
    ...(c.cwd !== undefined ? { cwd: c.cwd } : {}),
    ...(c.timeoutSeconds !== undefined ? { timeout_seconds: c.timeoutSeconds } : {}),
  };
}

function shapeUsage(u: UsageDto): ResultView["usage"] {
  return {
    cost_usd: u.costUsd,
    input_tokens: u.inputTokens,
    output_tokens: u.outputTokens,
    cache_read_tokens: u.cacheReadTokens,
    cache_write_tokens: u.cacheWriteTokens,
    web: {
      search: count(u.web?.search),
      fetch: count(u.web?.fetch),
      browse: count(u.web?.browse),
    },
    ...sandboxRuntimeUsage(u.sandbox),
    ...sandboxInstanceUsage(u.sandbox),
    ...sandboxPromotionUsage(u.sandbox),
    ...sandboxScaleUsage(u.sandbox),
    ...depsUsage(u.sandbox),
  };
}

/** usage.sandbox の runtimeMs（task_summary の sandbox_runtime_ms と同じ値の写し方: 小数は切り捨て、壊れた値は 0）。sandbox が無ければ付けない */
function sandboxRuntimeUsage(sb: UsageDto["sandbox"]): { sandbox_runtime_ms?: number } {
  if (typeof sb !== "object" || sb === null) return {};
  const ms = sb.runtimeMs;
  return {
    sandbox_runtime_ms:
      typeof ms === "number" && Number.isFinite(ms) && ms > 0 ? Math.floor(ms) : 0,
  };
}

/** usage.sandbox の実際の大きさ。packages/models の表にある名前だけ通す（任意の文字列を公開しない）。無ければ付けない */
function sandboxInstanceUsage(sb: UsageDto["sandbox"]): { sandbox_instance?: string } {
  const name = sandboxInstanceName(sb?.instance);
  return name !== undefined ? { sandbox_instance: name } : {};
}

/**
 * usage.sandbox の昇格（重いコマンドの初回に大きい Sandbox へ）。昇格先は表にある名前だけ、理由は固定コードだけ通す（任意の文字列を公開しない）。
 * 昇格前の時間は昇格したときだけ付ける。何も無ければ何も付けない。
 */
function sandboxPromotionUsage(sb: UsageDto["sandbox"]): {
  sandbox_promoted_to?: string;
  sandbox_promoted_at?: number;
  sandbox_runtime_ms_before_promotion?: number;
  sandbox_promotion_reason?: string;
  sandbox_promotions?: PublicPromotion[];
  sandbox_heavy_commands_after_agent_scale_up?: number;
  sandbox_heavy_commands_covered_by_agent?: number;
  sandbox_promotion_failures?: PublicPromotionFailure[];
} {
  const promotedTo = sandboxInstanceName(sb?.promotedTo);
  const promotions = sanitizePromotions(sb?.promotions, "camel");
  const reason = isSandboxPromotionReason(sb?.promotionReason) ? sb?.promotionReason : undefined;
  const failures = sanitizePromotionFailures(sb?.promotionFailures);
  const legacy = sb as Record<string, unknown> | undefined;
  const ms = (v: unknown) =>
    typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
  return {
    ...(promotedTo !== undefined
      ? {
          sandbox_promoted_to: promotedTo,
          ...(ms(sb?.promotedAt) > 0 ? { sandbox_promoted_at: ms(sb?.promotedAt) } : {}),
          sandbox_runtime_ms_before_promotion: ms(sb?.runtimeMsBeforePromotion),
        }
      : {}),
    ...(reason !== undefined ? { sandbox_promotion_reason: reason } : {}),
    ...(promotions.length > 0 ? { sandbox_promotions: promotions } : {}),
    // 古い agent の報告（ワーカーの sandbox_scale_up と規則があった頃の本数）。今の agent は報告しない
    ...(typeof legacy?.heavyCommandsAfterAgentScaleUp === "number"
      ? { sandbox_heavy_commands_after_agent_scale_up: ms(legacy.heavyCommandsAfterAgentScaleUp) }
      : {}),
    ...(typeof legacy?.heavyCommandsCoveredByAgent === "number"
      ? { sandbox_heavy_commands_covered_by_agent: ms(legacy.heavyCommandsCoveredByAgent) }
      : {}),
    ...(failures.length > 0 ? { sandbox_promotion_failures: failures } : {}),
  };
}

/**
 * usage.sandbox の Clef の判断の集計と記録。集計は数値だけ、記録は公開用の形（固定の値と数値だけ。argv・自由文は入らない）。
 * Clef を呼ばなかったタスク（無い・0 回）には何も付けない。
 */
function sandboxScaleUsage(sb: UsageDto["sandbox"]): {
  sandbox_scale_decisions?: number;
  sandbox_scale_raised?: number;
  sandbox_scale_clef_failures?: number;
  sandbox_scale_slow_not_raised?: number;
  sandbox_scale_skipped_light?: number;
  sandbox_scale_log?: PublicScaleDecision[];
} {
  const stats = sanitizeScaleStats(sb?.scaleStats);
  const log = sanitizeScaleDecisions(sb?.scaleDecisions);
  return {
    ...(stats !== undefined
      ? {
          sandbox_scale_decisions: stats.decisions,
          sandbox_scale_raised: stats.raised,
          sandbox_scale_clef_failures: stats.clef_failures,
          sandbox_scale_slow_not_raised: stats.slow_not_raised,
          sandbox_scale_skipped_light: stats.skipped_light,
        }
      : {}),
    ...(log.length > 0 ? { sandbox_scale_log: log } : {}),
  };
}

/** usage.sandbox の依存関係のキャッシュ（D14）の結果。sandbox が無い・値が表に無いときは何も付けない */
function depsUsage(sb: UsageDto["sandbox"]): {
  deps_cache?: "hit" | "miss" | "built" | "disabled";
  deps_cache_miss_reason?: string;
  cache_build_ms?: number;
} {
  const status = depsCacheStatus(sb?.depsCache);
  const reason = depsMissReason(sb?.depsCache, sb?.depsMissReason);
  const ms = sb?.cacheBuildMs;
  const buildMs = typeof ms === "number" && Number.isFinite(ms) && ms > 0 ? Math.floor(ms) : 0;
  return {
    ...(status !== undefined ? { deps_cache: status } : {}),
    // 使えなかった理由は miss のときだけ（ログにしか出ていなかった固定コード）
    ...(reason !== undefined ? { deps_cache_miss_reason: reason } : {}),
    // deps_cache が出るときは cache_build_ms も常に出す（作っていなければ 0）
    ...(status !== undefined ? { cache_build_ms: buildMs } : {}),
  };
}

/** 文字列の末尾を、UTF-8 で maxBytes 以下になるように残す（文字の途中では切らない）。 */
function tailUtf8(text: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= maxBytes) return text;
  let start = bytes.length - maxBytes;
  // 継続バイト（10xxxxxx）から始まるなら、文字の途中なので次の文字の先頭まで進める
  while (start < bytes.length && ((bytes[start] ?? 0) & 0xc0) === 0x80) start++;
  return new TextDecoder().decode(bytes.subarray(start));
}

/** 検証コマンドの出力 1 件あたりの上限（UTF-8 のバイト数）。AgentDO が持つ全文のうち、末尾だけを返す。 */
const MAX_RESULT_OUTPUT = 16 * 1024;

function shapeResult(
  status: TaskStatus,
  dto: Exclude<ResultDto, { status: "not_ready" }>,
): ResultCore {
  const v = dto.verification;
  return {
    status,
    ...(dto.reason !== undefined ? { reason: dto.reason } : {}),
    summary: dto.summary,
    verification: {
      commands: v.commands.map(shapeCommand),
      results: v.results.map((r) => ({
        argv: r.argv,
        exit_code: r.exitCode,
        timed_out: r.timedOut,
        output: tailUtf8(r.output, MAX_RESULT_OUTPUT),
        // 古い agent の結果には durationMs が無いので、あるときだけ付ける
        ...(typeof r.durationMs === "number" && Number.isFinite(r.durationMs) && r.durationMs >= 0
          ? { duration_ms: r.durationMs }
          : {}),
      })),
      verified: v.verified,
      attempts: v.attempts,
      ...(safeSha(v.commitSha) !== undefined ? { commit_sha: safeSha(v.commitSha) as string } : {}),
    },
    warnings: dto.warnings,
    pr: null,
    ...(dto.patch !== undefined ? { patch: dto.patch } : {}),
    ...(dto.diffstat !== undefined ? { diffstat: dto.diffstat } : {}),
    patch_too_large: dto.patchTooLarge,
    usage: shapeUsage(dto.usage),
  };
}
