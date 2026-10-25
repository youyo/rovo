import { DurableObject } from "cloudflare:workers";
import type { AgentRpc, ConsultRequest, ConsultResult } from "../agent/contract";
import { auditFromWorker } from "../audit-sink";
import { isUserIdAllowed, loadAllowRules } from "../auth/allowlist";
import {
  type ConsultFailure,
  type ConsultValue,
  interpretConsult,
  unavailableFailure,
} from "../consult-answer";
import {
  randomToken,
  SESSION_ABSOLUTE_MS,
  SESSION_IDLE_MS,
  SESSION_MAX_PER_USER,
  SESSION_TOUCH_MS,
} from "../dashboard/session";
import { indexBackoffMs } from "../directory/backoff";
import {
  type ConsultIndexSnapshot,
  DIRECTORY_NAME,
  type UpsertConsultResult,
} from "../directory/types";
import {
  CredentialManager,
  type CredentialState,
  type CredentialStorage,
  GitHubClient,
  GitHubError,
  type GitHubErrorCode,
  MAX_PULL_STATE_BATCH,
  type PullRef,
  type PullStateValue,
  resolveGitHubBaseUrls,
  type StoredCredential,
  type TokenSet,
  type UserPull,
  VisibleSetTooLargeError,
} from "../github";
import { errorMessageForLog } from "../log-error";
import { testConsultTiming, withTestScripts } from "../test-routes";
import { consultBudgetUsd, maxConcurrentTasks, taskBudgetUsd } from "./budget";
import { MAX_BUDGET_EXTENSIONS } from "./budget-question";
import { addColumnIfMissing } from "./sql-schema";
import type { TaskDO } from "./task-do";
import { isConsultId, isTaskId, ulid, ulidTime } from "./ulid";
import { MAX_CONCURRENT_WAITERS, MAX_WAIT_SECONDS, WAIT_RETRY_AFTER_SECONDS } from "./validation";

/** requests の保存期間。 */
export const REQUEST_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** 未作成の予約を回収し始めるまでの運用値。安全性は TaskDO の tombstone が保証する。 */
export const RESERVATION_RECLAIM_AFTER_MS = 10 * 60 * 1000;
/** team 所属の再検証結果をキャッシュする時間。team から外れてから使えなくなるまでの遅れの上限。 */
export const MEMBERSHIP_CACHE_TTL_MS = 5 * 60 * 1000;
/** 閲覧者の見えるリポジトリの集合のキャッシュ時間（D6。権限の取り消しが一覧に反映されるまでの遅れの上限）。 */
export const VISIBLE_CACHE_TTL_MS = 30 * 1000;
/** PR の状態（ダッシュボード）のキャッシュ時間。open は変わりやすいので短く、merged / closed は変わりにくいので長く。 */
export const PR_STATE_OPEN_TTL_MS = 30 * 1000;
export const PR_STATE_FINAL_TTL_MS = 10 * 60 * 1000;
/** 取得に失敗した（unknown）PR を、GitHub を叩き直さずに待つ時間。障害中に画面の更新のたびに叩かない */
export const PR_STATE_FAILURE_TTL_MS = 10 * 1000;
/** 1 回の dashboardPullStates で問い合わせる PR の上限。超える分は問い合わせず unknown */
export const MAX_PR_STATE_REFS = 200;
/** GraphQL の問い合わせを同時に進める本数 */
const PR_STATE_CONCURRENCY = 3;
/** PR の状態のキャッシュの最大件数（メモリのみ） */
const PR_STATE_CACHE_MAX = 2_000;
/** 見えるリポジトリの集合の上限（D5）。超えたら部分的な集合を使わず fail closed にする。 */
export const MAX_VISIBLE_REPOSITORIES = 10_000;
/** web の1日あたりの回数の既定値（ユーザーごと・UTC）。env の WEB_SEARCH_DAILY_LIMIT / WEB_FETCH_DAILY_LIMIT で変える。 */
export const DEFAULT_WEB_SEARCH_DAILY_LIMIT = 200;
export const DEFAULT_WEB_FETCH_DAILY_LIMIT = 500;
export const DEFAULT_WEB_BROWSE_DAILY_LIMIT = 50;
/** web_usage の行を残す日数（古い日は消す）。 */
const WEB_USAGE_RETAIN_DAYS = 3;

export type WebQuotaKind = "search" | "fetch" | "browse";
export type WebQuotaResult = { ok: boolean; used: number; limit: number };

/** 0 以上の整数だけを使う。未設定・不正な値は既定に戻す。 */
export function parseDailyLimit(raw: string | undefined, fallback: number): number {
  if (typeof raw !== "string" || !/^\d+$/.test(raw.trim())) return fallback;
  const n = Number(raw.trim());
  return Number.isSafeInteger(n) ? n : fallback;
}

/** 所属確認の途中で再ログインされ、結果を捨てたことを示す。 */
const STALE = Symbol("stale");
/** 再ログインと重なって確認をやり直す回数の上限。 */
const MAX_MEMBER_ATTEMPTS = 3;
/** 照合中に予約が入れ替わったときの再判定の上限。 */
const MAX_RECONCILE_ATTEMPTS = 5;

const MICRO = 1_000_000;
/** MONTHLY_BUDGET_USD が未設定・不正なときの月額上限（USD）。 */
export const DEFAULT_MONTHLY_BUDGET_USD = 100;

export type ReserveResult =
  | { ok: true; task_id: string; reused: boolean }
  | { ok: false; code: "conflict" | "concurrency_limit" | "budget_exceeded" };

/**
 * 裏のモデル呼び出し（AgentDO.consult）を UserDO が待つ上限。超えたら実費不明として予約額で精算し、failed（upstream_unavailable）にする。
 * クライアントの待ち時間（50 秒）とは別で、consult の答えは consult_result で受け取る。
 */
export const CONSULT_BACKGROUND_TIMEOUT_MS = 5 * 60 * 1000;
/**
 * 精算されないまま残った consult の予約を、予約額で閉じるまでの時間（裏の上限 + 余裕 = 10 分）。
 * 精算は UserDO の中で完結するので、通常は期限に当たらない。UserDO の作り直しなどで裏の処理が失われたときの最後の網。
 * 裏の上限より短いと、pending 中に閉じてしまう。
 */
export const CONSULT_STALE_AFTER_MS = CONSULT_BACKGROUND_TIMEOUT_MS + 5 * 60 * 1000;
/** 完了した consult の答え（consult_answer）を持つ期間。過ぎたら本文ごと捨てる（以後 not_found） */
export const CONSULT_ANSWER_TTL_MS = 60 * 60 * 1000;
/** 同時に開いておける consult の数（予約から精算まで）。超えたら concurrency_limit。暴走時の UserDO の負荷を抑える */
export const MAX_PENDING_CONSULTS = 4;
/** consult_answer の 1 行の上限（バイト。DO の SQLite は 1 行 2MB 未満）。超える答えは切り詰めず failed にする */
const CONSULT_ANSWER_MAX_BYTES = 1_900_000;

/** consult の索引（Directory）への配送の周期（ms）。TaskDO の alarm と同じ */
export const CONSULT_INDEX_ALARM_INTERVAL_MS = 10_000;
/** Directory への 1 回の呼び出しの待ちの上限（ms） */
const CONSULT_INDEX_TIMEOUT_MS = 10_000;
/** 1 回の alarm で送る件数の上限（残りは次の alarm で） */
const CONSULT_INDEX_BATCH = 50;
/** 配送済みの consult_log の行を残す期間。過ぎたら消す（Directory が正本。UserDO を太らせない） */
const CONSULT_LOG_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

/** reserveConsult に渡す所有者（索引の「誰が」。質問の本文は渡さない） */
export type ConsultOwner = { id: number; login: string };

export type ConsultReserveResult =
  | { ok: true; reserved_usd: number }
  | { ok: false; code: "budget_exceeded" | "concurrency_limit" | "invalid_input" };

export type ConsultStartResult = { ok: true } | { ok: false; code: "not_found" | "invalid_input" };

/**
 * consult の答えの取得（waitConsult）の結果。not_found は、不正な ID・存在しない・他人・保持期間切れのすべて（区別しない）。
 * pending の retry_after_seconds は、待機の枠が埋まっていて待てなかったときだけ付く。
 */
export type ConsultWaitResult =
  | { ok: false; code: "not_found" }
  | { ok: true; status: "pending"; retry_after_seconds?: number }
  | { ok: true; status: "done"; value: ConsultValue }
  | { ok: true; status: "failed"; error: ConsultFailure; cost_usd: number };

/** 裏の AgentDO の呼び出し（UserDO の consultAgent。Unit が差し替える） */
export type ConsultAgent = { consult(request: ConsultRequest): Promise<ConsultResult> };

type ConsultAnswerRow = {
  consult_id: string;
  owner_id: number;
  status: "pending" | "done" | "failed";
  result_json: string | null;
};
type ConsultWaiter = { consultId: string; wake: () => void; timer?: ReturnType<typeof setTimeout> };

/** budget_status の応答（D10）。金額は USD。 */
export type BudgetStatus = {
  monthly_budget_usd: number;
  /** 今月使った実費（精算済み）。estimated_usd を含む */
  spent_usd: number;
  /**
   * spent_usd のうち、実費が分からず見積もり（予約額や最悪の見積り）で確定した分（spent_usd の内数）。
   * 失敗して実費が分からない consult は予約額で確定する
   */
  estimated_usd: number;
  reserved_usd: number;
  remaining_usd: number;
  task_budget_usd: number;
  consult_budget_usd: number;
  /** 残りの月額予算で、タスクの予約額（task_budget_usd）を何件分予約できるかの見積もり。同時実行の上限ではない（上限は concurrency_limit） */
  max_concurrent_tasks: number;
  /** 利用者ごとに同時に実行できるタスクの上限（設定値 MAX_CONCURRENT_TASKS。既定 2）。実際に同時に実行できる数は、これと max_concurrent_tasks の小さいほう */
  concurrency_limit: number;
  /** 開いている consult の数（予約から精算まで。pending の consult と、始めたばかりのもの）。同時の上限は MAX_PENDING_CONSULTS（超えたら consult は concurrency_limit） */
  pending_consults: number;
  /** 今月（UTC）。end は翌月の頭（含まない） */
  period: { start: string; end: string };
};

export type SettleResult = { ok: true; applied: boolean } | { ok: false };
export type FinishResult = { ok: true; released: boolean };

type ConsultLogRow = {
  consult_id: string;
  owner_id: number;
  owner_login: string;
  at: number;
  model: string;
  cost_micro: number;
  estimated: number;
  revision: number;
};

/** 索引に送る値。Directory のスキーマの上限に合わせて送る前に切り詰める（長すぎて恒久的に拒否されないように） */
function consultSnapshot(row: ConsultLogRow): ConsultIndexSnapshot {
  return {
    consult_id: row.consult_id,
    owner_id: row.owner_id,
    owner_login: row.owner_login.slice(0, 200),
    at: row.at,
    model: row.model.slice(0, 200),
    cost_micro: row.cost_micro,
    estimated: row.estimated === 1,
  };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("timeout")), ms);
    }),
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/** consult_answer の done / failed の行を応答にする。壊れた行は failed（internal） */
function parseStoredAnswer(row: ConsultAnswerRow): ConsultWaitResult {
  try {
    const v = JSON.parse(row.result_json ?? "null") as unknown;
    if (row.status === "done") return { ok: true, status: "done", value: v as ConsultValue };
    const f = v as { error: ConsultFailure; cost_usd: number };
    return { ok: true, status: "failed", error: f.error, cost_usd: f.cost_usd };
  } catch {
    return {
      ok: true,
      status: "failed",
      error: { code: "internal", message: "internal error" },
      cost_usd: 0,
    };
  }
}

/** 開始時刻の月（UTC, "YYYY-MM"）。月またぎのタスクは開始した月に計上する。 */
function monthOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 7);
}

/** 同時実行の枠を持っているタスク。1 タスクにつき 1 行。 */
type SlotRow = { task_id: string; reserved_at: number };
type RequestRow = { task_id: string; fingerprint: string };

/**
 * GitHub 連携の失敗。GitHubError の code をそのまま使い、想定外の例外だけ internal にする。
 * Workers RPC は Error の独自プロパティを落とすので、throw ではなく戻り値で返す。
 */
export type AuthzFailure = {
  ok: false;
  code: GitHubErrorCode | "internal";
  message: string;
};
export type MemberResult = { ok: true } | AuthzFailure;
/**
 * 閲覧者の見える repository id の集合（ダッシュボードの認可）。失敗の code:
 * - unauthenticated: 許可ルールを満たさない・資格が無い / 失効（401 相当。再ログインが必要）
 * - denied: GitHub が列挙を拒否した（403。見えるものは無いとして扱う）
 * - unavailable: GitHub の障害・タイムアウト・列挙の途中の失敗・想定外の応答（503 相当）
 * - too_large: 集合が上限を超えた（503 相当）
 * どの失敗でも中身（部分的な集合）は返さない。
 */
export type VisibleResult =
  | { ok: true; ids: number[] }
  | { ok: false; code: "unauthenticated" | "denied" | "unavailable" | "too_large" };
/** セッション + 許可ルールの確かめ直しの結果。unavailable は GitHub に確かめられない（通さない。セッションは消さない）。 */
export type DashboardAuthResult =
  | { ok: true; login: string }
  | { ok: false; kind: "unauthenticated" | "unavailable" };
export type StartAuthzResult =
  | { ok: true; repositoryId: number; installationId: number }
  | AuthzFailure;

/** task_review の対象の PR（利用者本人のトークンで読んだ値。head はこの時点で固定する） */
export type ReviewPull = {
  number: number;
  url: string;
  headSha: string;
  headRef: string;
  baseSha: string;
  baseRef: string;
  title: string;
  /** 非信頼データ（PR を書いた人の文） */
  body: string;
  draft: boolean;
};
/**
 * task_review の権限の結果。invalid_input は PR の状態による拒否で、message は理由のコードで始まる
 * （fork_not_supported / pull_request_closed / pull_request_merged）。not_found は見えない・無い PR（存在を教えない）。
 */
export type ReviewAuthzResult =
  | { ok: true; repositoryId: number; installationId: number; pull: ReviewPull }
  | AuthzFailure
  | { ok: false; code: "not_found" | "invalid_input"; message: string };

/** PR の操作の対象。TaskDO の記録から作る（呼び出し元の入力からは取らない）。 */
export type PrTarget = { repository: string; number: number; branch: string };
/**
 * PR の操作の失敗。code は GitHub の失敗（GitHubError.code）か、PR の状態による conflict。
 * reason は監査に出す固定のコード（英小文字・数字・_）。
 */
export type PrFailure = {
  ok: false;
  code: GitHubErrorCode | "conflict" | "internal";
  message: string;
  reason: string;
};
export type PrReadyResult = { ok: true; already_ready: boolean } | PrFailure;
export type PrMergeOptions = {
  /** 検証済みの head の sha。GitHub のマージ API に sha として渡し、ブランチが動いていたら GitHub が拒否する */
  expectedSha: string;
  method: "squash" | "merge" | "rebase";
  deleteBranch: boolean;
};
export type PrMergeResult =
  | {
      ok: true;
      already_merged: boolean;
      merge_sha: string | null;
      /** delete_branch を求めなかったときは null */
      branch_deleted: boolean | null;
      warnings: string[];
    }
  | PrFailure;

type CredentialRow = {
  generation: number;
  access_token_enc: string | null;
  refresh_token_enc: string | null;
  access_expires_at: number | null;
  refresh_expires_at: number | null;
  version: number | null;
  updated_at: number | null;
};

type TaskInspector = Pick<DurableObjectStub<TaskDO>, "inspect" | "abandonIfUncreated">;

/**
 * ユーザーごとの状態。同時実行の予約・冪等キー(requests)・GitHub 資格（暗号化）・team 所属のキャッシュ。
 *
 * GitHub のトークンはこの DO の中だけで取り出して使い、RPC の戻り値には含めない
 * （入ってくるのはログイン時の saveCredential だけ）。
 * DO 間の呼び出しは UserDO → TaskDO（照合のみ。TaskDO の取り込みは待たない）に限る。
 */
export class UserDO extends DurableObject<Env> {
  /** 現在時刻(ms)。テストで差し替える。 */
  now: () => number = () => Date.now();
  /** GitHub への fetch。テストで差し替える。 */
  githubFetch: typeof fetch = (...args) => fetch(...args);
  private credentials: CredentialManager | null = null;
  private githubClientInstance: GitHubClient | null = null;
  /**
   * ログインの世代。saveCredential のたびに進める（メモリ上のみ。進行中の確認もメモリ上にしかないので十分）。
   * 旧世代の資格で始まった所属確認の結果は、キャッシュにも呼び出し元にも使わない。
   */
  private loginEpoch = 0;
  /** 進行中の所属確認。キーは「世代:githubUserId」。同じキーの呼び出しだけが共有する。 */
  private memberInflight = new Map<string, Promise<MemberResult | typeof STALE>>();
  /** 見えるリポジトリの集合の上限。テストで変える。 */
  maxVisibleRepositories = MAX_VISIBLE_REPOSITORIES;
  /** 閲覧者の見えるリポジトリの集合のキャッシュ（メモリのみ。DO の退避で消え、権限をディスクに残さない）。 */
  private visibleCache: { ids: number[]; at: number; epoch: number } | null = null;
  /** キャッシュを破棄するたびに進める。破棄の前に始まった取得の結果で、破棄したキャッシュを復活させない。 */
  private visibleGen = 0;
  /** 進行中の集合の取得。キーは世代（loginEpoch）。最新のものを 1 本だけ持ち、fresh でない呼び出しは束ねる。 */
  private visibleInflight = new Map<number, Promise<VisibleResult>>();
  /** PR の状態のキャッシュ（メモリのみ。キーは "owner/name#番号" の小文字）。閲覧者のトークンで取った値で、この利用者の DO の中だけで使う */
  private prStateCache = new Map<string, { state: PullStateValue; at: number; ttl: number }>();
  /** 進行中の PR の状態の問い合わせ（キー別）。同じ PR の同時の呼び出しを 1 本に束ねる */
  private prStateInflight = new Map<string, Promise<PullStateValue>>();
  /** 再試行間隔のジッター用の乱数（[0, 1)）。テストで差し替える。 */
  protected random: () => number = Math.random;
  /** 索引の配送を始める alarm が要るか（同期区間の中で立て、区間の後に requestConsultAlarm が消す） */
  private consultAlarmWanted = false;
  /**
   * 裏のモデル呼び出し（AgentDO.consult）の相手。consult ごとの AgentDO インスタンス（名前は consultId）。
   * test のときだけ、E2E が預けた台本を渡す（それ以外は元のスタブのまま）。Unit が差し替える。
   */
  consultAgent: (consultId: string) => ConsultAgent = (consultId) =>
    withTestScripts(this.env, this.env.AGENT_DO.getByName(consultId) as unknown as AgentRpc);
  /** 裏のモデル呼び出しを待つ上限（ms）。Unit が短くする */
  consultBackgroundTimeoutMs = CONSULT_BACKGROUND_TIMEOUT_MS;
  /** consult の答えを待っている呼び出し（メモリのみ。UserDO が作り直されたら消える。正本は consult_answer の行） */
  private consultWaiters = new Set<ConsultWaiter>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const sql = ctx.storage.sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS requests (
      request_key TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`);
    sql.exec("CREATE INDEX IF NOT EXISTS requests_created_at ON requests (created_at)");
    // 同時実行の枠。タスクごとに 1 行（上限は MAX_CONCURRENT_TASKS）。task_id は ULID で一意なので、
    // 照合の await をまたいで枠が入れ替わっても、task_id を指定した解放が他のタスクの枠を消すことはない。
    sql.exec(`CREATE TABLE IF NOT EXISTS reservation_slot (
      task_id TEXT PRIMARY KEY,
      reserved_at INTEGER NOT NULL
    )`);
    this.migrateLegacyReservation();
    // タスクごとの予算。reserved は開始時に予約した額、settled は取り込んだ usage の累計（実費）。
    // closed の後は予約を数えず、実費だけが月の枠を使う。単位はマイクロドル（整数）。
    sql.exec(`CREATE TABLE IF NOT EXISTS task_budget (
      task_id TEXT PRIMARY KEY,
      month TEXT NOT NULL,
      reserved_micro INTEGER NOT NULL,
      settled_micro INTEGER NOT NULL DEFAULT 0,
      settled_seq INTEGER NOT NULL DEFAULT 0,
      closed INTEGER NOT NULL DEFAULT 0
    )`);
    sql.exec("CREATE INDEX IF NOT EXISTS task_budget_month ON task_budget (month)");
    // consult の索引の outbox（D9 / M3b）。モデル名・所有者・時刻・費用だけを持ち、質問・応答の本文は持たない。
    // settled=1 になる同期区間で revision を上げて index_dirty=1 にし、alarm が Directory へ配送して index_dirty=0 にする。
    // 行が無い consult（デプロイ前の予約・モデルを渡さなかった呼び出し）は索引に入れない（過去分はバックフィルしない）。
    sql.exec(`CREATE TABLE IF NOT EXISTS consult_log (
      consult_id TEXT PRIMARY KEY,
      owner_id INTEGER NOT NULL,
      owner_login TEXT NOT NULL,
      at INTEGER NOT NULL,
      model TEXT NOT NULL,
      cost_micro INTEGER NOT NULL DEFAULT 0,
      estimated INTEGER NOT NULL DEFAULT 0,
      settled INTEGER NOT NULL DEFAULT 0,
      revision INTEGER NOT NULL DEFAULT 0,
      index_dirty INTEGER NOT NULL DEFAULT 0
    )`);
    sql.exec(
      "CREATE INDEX IF NOT EXISTS consult_log_dirty ON consult_log (index_dirty) WHERE index_dirty = 1",
    );
    // consult の答え（docs/specs/consult-pending.md）。裏の完了で、精算（task_budget）・索引（consult_log）と同じ同期区間で書く。
    // pending は裏で続いている間、done / failed は完了から CONSULT_ANSWER_TTL_MS（expires_at）まで本文を持つ。本文はここにしか残さない。
    sql.exec(`CREATE TABLE IF NOT EXISTS consult_answer (
      consult_id TEXT PRIMARY KEY,
      owner_id INTEGER NOT NULL,
      status TEXT NOT NULL,
      result_json TEXT,
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      expires_at INTEGER
    )`);
    // 配送の失敗の記録（バックオフ）。1 行だけ
    sql.exec(`CREATE TABLE IF NOT EXISTS consult_outbox (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      attempts INTEGER NOT NULL,
      retry_at INTEGER NOT NULL
    )`);
    sql.exec(
      "INSERT OR IGNORE INTO consult_outbox (singleton, attempts, retry_at) VALUES (1, 0, 0)",
    );
    // settled が実費ではなく見積もり（予約額など）で確定した行は 1。列の追加前の行は 0（見積もりではない扱い）。
    addColumnIfMissing(sql, "task_budget", "settled_estimated", "INTEGER NOT NULL DEFAULT 0");
    // settled_micro の出どころ。既定の estimate は agent の見積もり、gateway は終端後に AI Gateway のログで確定した額（1 回だけ上書き）。
    // 既存の行は DEFAULT で estimate になる（過去のタスクはさかのぼって補正しない）
    addColumnIfMissing(sql, "task_budget", "cost_source", "TEXT NOT NULL DEFAULT 'estimate'");
    // 予算の延長（budget_policy: ask）で承認された回数。延長のたびに reserved_micro へタスク予算と同じ額を足す
    addColumnIfMissing(sql, "task_budget", "extensions", "INTEGER NOT NULL DEFAULT 0");
    // クライアント（MCP の web_search / web_fetch / web_browse）の回数。UTC の日付ごと・種別ごと。
    sql.exec(`CREATE TABLE IF NOT EXISTS web_usage (
      day TEXT NOT NULL,
      kind TEXT NOT NULL,
      count INTEGER NOT NULL,
      PRIMARY KEY (day, kind)
    )`);
    sql.exec(`CREATE TABLE IF NOT EXISTS membership_cache (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      checked_at INTEGER NOT NULL,
      result TEXT NOT NULL,
      github_user_id INTEGER
    )`);
    // 旧スキーマ（github_user_id なし）の DO を移行する。NULL の行はキャッシュとして使わない。
    addColumnIfMissing(sql, "membership_cache", "github_user_id", "INTEGER");
    // 資格の正本。access_token_enc が NULL の行は「削除済み」（世代だけを残す tombstone）。
    sql.exec(`CREATE TABLE IF NOT EXISTS github_credential (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      generation INTEGER NOT NULL,
      access_token_enc TEXT,
      refresh_token_enc TEXT,
      access_expires_at INTEGER,
      refresh_expires_at INTEGER,
      version INTEGER,
      updated_at INTEGER
    )`);
    sql.exec("INSERT OR IGNORE INTO github_credential (singleton, generation) VALUES (1, 0)");
    // ダッシュボードのブラウザセッション（D3）。epoch は全端末ログアウト用の永続の世代（ログインでは進めない。複数端末で同時に使える）で、MCP の loginEpoch（メモリのみ）とは別。
    // 資格（github_credential）とは独立に持つ。GitHub のトークンは入れない。
    sql.exec(`CREATE TABLE IF NOT EXISTS dashboard_epoch (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      epoch INTEGER NOT NULL
    )`);
    sql.exec("INSERT OR IGNORE INTO dashboard_epoch (singleton, epoch) VALUES (1, 0)");
    sql.exec(`CREATE TABLE IF NOT EXISTS dashboard_session (
      sid TEXT PRIMARY KEY,
      version INTEGER NOT NULL,
      login TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      last_seen INTEGER NOT NULL
    )`);
  }

  /**
   * ブラウザのログイン成功後にセッションを作る。複数の端末で同時に使える（ログインで他の端末を落とさない）。
   * ログインのたびに新しい sid を発行し、ログイン前の sid は引き継がない（セッション固定の対策）。
   * 世代（epoch）は進めず、今の世代を version に入れる。epoch は「全端末ログアウト」のために残してあり、進めると全 sid が失効する。
   * INSERT の前に同じトランザクションで、期限切れ（絶対・無操作）の行を消し、残りが上限以上なら last_seen の古い順に消す。
   */
  async createDashboardSession(
    login: string,
  ): Promise<{ sid: string; version: number; expiresAt: number }> {
    const sql = this.ctx.storage.sql;
    const now = this.now();
    const sid = randomToken();
    const expiresAt = now + SESSION_ABSOLUTE_MS;
    const version = this.ctx.storage.transactionSync(() => {
      const epoch = sql
        .exec<{ epoch: number }>("SELECT epoch FROM dashboard_epoch WHERE singleton = 1")
        .one().epoch;
      sql.exec(
        "DELETE FROM dashboard_session WHERE expires_at <= ? OR last_seen <= ?",
        now,
        now - SESSION_IDLE_MS,
      );
      // 新しい 1 件を入れたあとに上限以下になるよう、上限 - 1 件まで残す
      sql.exec(
        `DELETE FROM dashboard_session WHERE sid IN (
           SELECT sid FROM dashboard_session ORDER BY last_seen DESC, created_at DESC LIMIT -1 OFFSET ?
         )`,
        SESSION_MAX_PER_USER - 1,
      );
      sql.exec(
        "INSERT INTO dashboard_session (sid, version, login, created_at, expires_at, last_seen) VALUES (?, ?, ?, ?, ?, ?)",
        sid,
        epoch,
        login,
        now,
        expiresAt,
        now,
      );
      return epoch;
    });
    return { sid, version, expiresAt };
  }

  /**
   * Cookie の sid と世代を、サーバー側の記録と照合する。失敗の理由は区別しない（呼び出し側は一律 401 にする）。
   * 絶対期限・無操作の期限を過ぎた記録は、ここで消す。last_seen の更新は最大 5 分に 1 回。
   */
  async checkDashboardSession(
    sid: string,
    version: number,
  ): Promise<{ ok: true; login: string } | { ok: false }> {
    const sql = this.ctx.storage.sql;
    const row = sql
      .exec<{ version: number; login: string; expires_at: number; last_seen: number }>(
        "SELECT version, login, expires_at, last_seen FROM dashboard_session WHERE sid = ?",
        sid,
      )
      .toArray()[0];
    if (!row) return { ok: false };
    const epoch = sql
      .exec<{ epoch: number }>("SELECT epoch FROM dashboard_epoch WHERE singleton = 1")
      .one().epoch;
    const now = this.now();
    if (row.version !== version || version !== epoch) return { ok: false };
    if (now >= row.expires_at || now - row.last_seen >= SESSION_IDLE_MS) {
      sql.exec("DELETE FROM dashboard_session WHERE sid = ?", sid);
      return { ok: false };
    }
    if (now - row.last_seen >= SESSION_TOUCH_MS) {
      sql.exec("UPDATE dashboard_session SET last_seen = ? WHERE sid = ?", now, sid);
    }
    return { ok: true, login: row.login };
  }

  /**
   * セッションの検証 + 許可ルールの確かめ直し（M5a。セッションを使うたびに呼ぶ）。
   * セッションの記録（checkDashboardSession）に加え、**今の許可ルール**を満たすかを毎回確かめる。ルールから外れた利用者は、
   * セッションが生きていても通さない（記録は消さない: ルールが戻れば使える）。GitHub に確かめられないとき（障害）は
   * unavailable で通さない。githubUserId は Cookie の uid（この DO の名前と同じ）。
   */
  async authorizeDashboardSession(
    githubUserId: number,
    sid: string,
    version: number,
  ): Promise<DashboardAuthResult> {
    const session = await this.checkDashboardSession(sid, version);
    if (!session.ok) return { ok: false, kind: "unauthenticated" };
    const allowed = await this.dashboardAllowed(githubUserId);
    if (allowed === "allowed") return { ok: true, login: session.login };
    return { ok: false, kind: allowed === "denied" ? "unauthenticated" : "unavailable" };
  }

  /**
   * 今の許可ルールを満たすか。ルールは毎回読み直す（不正・不足は denied = fail closed）。
   * user ID のルールは GitHub を呼ばずに判定し、team のルールだけ ensureMember（5 分キャッシュ）で確かめる。
   * user ID のルールだけの構成で ID が外れたときは、team のキャッシュが残っていても通さない。
   */
  private async dashboardAllowed(
    githubUserId: number,
  ): Promise<"allowed" | "denied" | "unavailable"> {
    // 呼び出し側の約束は「Cookie の uid で DO を選ぶ」。DO 自身の名前（= uid）が分かるときは、不一致を拒否して二重に守る
    const owner = this.ctx.id.name;
    if (owner !== undefined && owner !== String(githubUserId)) return "denied";
    const rules = loadAllowRules(this.env);
    if (!rules) return "denied";
    if (isUserIdAllowed(rules, githubUserId)) return "allowed";
    if (!rules.team) return "denied";
    const member = await this.ensureMember(githubUserId);
    if (member.ok) return "allowed";
    return member.code === "forbidden" || member.code === "reauth_required"
      ? "denied"
      : "unavailable";
  }

  /**
   * 閲覧者のユーザートークンで見える repository id の集合を返す（D5・D6。トークンは戻り値に出さない）。
   * 一覧は 30 秒のキャッシュを使う。fresh: true（詳細を開いた最初）はキャッシュを使わず必ず GitHub で取り直す。
   * 失敗したときはキャッシュを破棄し、古い集合を使わない。許可ルールは毎回確かめる（キャッシュより先）。
   */
  async visibleRepositoryIds(
    githubUserId: number,
    opts: { fresh?: boolean } = {},
  ): Promise<VisibleResult> {
    const allowed = await this.dashboardAllowed(githubUserId);
    if (allowed !== "allowed") {
      this.dropVisible();
      return { ok: false, code: allowed === "denied" ? "unauthenticated" : "unavailable" };
    }
    const epoch = this.loginEpoch;
    const now = this.now();
    if (!opts.fresh) {
      const c = this.visibleCache;
      if (c && c.epoch === epoch && now - c.at >= 0 && now - c.at < VISIBLE_CACHE_TTL_MS) {
        return { ok: true, ids: [...c.ids] };
      }
      const running = this.visibleInflight.get(epoch);
      if (running) return running;
    }
    const created: Promise<VisibleResult> = this.fetchVisible(epoch, now).finally(() => {
      // 自分が登録したものだけを消す
      if (this.visibleInflight.get(epoch) === created) this.visibleInflight.delete(epoch);
    });
    this.visibleInflight.set(epoch, created);
    return created;
  }

  /**
   * ダッシュボードの PR の状態（open / merged / closed。取れなければ unknown）を、閲覧者のユーザートークンで GitHub から取る。
   * refs と同じ並びで返す。呼び出し側（gateway の読み取り API）は、**閲覧権限の判定に通ったタスクの PR だけ**を渡す。
   *
   * - 許可ルールを満たさない・資格が無い利用者は、GitHub を呼ばず全部 unknown（キャッシュも返さない）
   * - 呼び出しを抑える: GraphQL で MAX_PULL_STATE_BATCH 件ずつにまとめ、同時 PR_STATE_CONCURRENCY 本まで。重複は 1 件に、
   *   同じ PR の同時の呼び出しは 1 本に束ねる。上限 MAX_PR_STATE_REFS を超える分は問い合わせず unknown
   * - キャッシュ（メモリのみ）: open 30 秒・merged / closed 10 分・取れなかったもの 10 秒
   * - fail-soft: 401・403・404・レート制限・タイムアウトなどは例外にせず unknown（失敗の内容は返さない）
   */
  async dashboardPullStates(githubUserId: number, refs: PullRef[]): Promise<PullStateValue[]> {
    const out: PullStateValue[] = refs.map(() => "unknown");
    if (refs.length === 0) return out;
    const allowed = await this.dashboardAllowed(githubUserId);
    if (allowed !== "allowed") {
      this.prStateCache.clear();
      return out;
    }
    const epoch = this.loginEpoch;
    const now = this.now();
    const keyOf = (r: PullRef) => `${r.repository.toLowerCase()}#${r.number}`;

    // 重複を除き、上限までを問い合わせの対象にする
    const unique = new Map<string, PullRef>();
    for (const r of refs) {
      const k = keyOf(r);
      if (!unique.has(k) && unique.size < MAX_PR_STATE_REFS) unique.set(k, r);
    }
    const result = new Map<string, Promise<PullStateValue> | PullStateValue>();
    const misses: [string, PullRef][] = [];
    for (const [k, r] of unique) {
      const c = this.prStateCache.get(k);
      if (c && now - c.at >= 0 && now - c.at < c.ttl) {
        result.set(k, c.state);
        continue;
      }
      const running = this.prStateInflight.get(k);
      if (running) {
        result.set(k, running);
        continue;
      }
      misses.push([k, r]);
    }

    // 問い合わせる分を分割し、同時の本数を抑えて実行する（Promise は同期的に登録して、同時の呼び出しを束ねる）
    let active = 0;
    const waiting: (() => void)[] = [];
    const limited = async <T>(fn: () => Promise<T>): Promise<T> => {
      if (active >= PR_STATE_CONCURRENCY)
        await new Promise<void>((resolve) => waiting.push(resolve));
      active++;
      try {
        return await fn();
      } finally {
        active--;
        waiting.shift()?.();
      }
    };
    for (let i = 0; i < misses.length; i += MAX_PULL_STATE_BATCH) {
      const chunk = misses.slice(i, i + MAX_PULL_STATE_BATCH);
      const batch = limited(() =>
        this.fetchPullStates(
          epoch,
          chunk.map(([, r]) => r),
        ),
      );
      chunk.forEach(([k], j) => {
        const p: Promise<PullStateValue> = batch
          .then((states) => states[j] ?? "unknown")
          .finally(() => {
            if (this.prStateInflight.get(k) === p) this.prStateInflight.delete(k);
          });
        this.prStateInflight.set(k, p);
        result.set(k, p);
      });
    }

    const resolved = new Map<string, PullStateValue>();
    for (const [k, v] of result) resolved.set(k, await v);
    return refs.map((r) => resolved.get(keyOf(r)) ?? "unknown");
  }

  /** 1 回分の GraphQL。失敗は例外にせず全部 unknown（短くキャッシュ）。取得中に再ログインがあれば、結果はキャッシュしない */
  private async fetchPullStates(epoch: number, refs: PullRef[]): Promise<PullStateValue[]> {
    let states: PullStateValue[];
    try {
      const { client, credentials } = this.github();
      states = await credentials.withToken((tok) => client.getPullStates(tok, refs));
    } catch (e) {
      // エラー名（と GitHubError のコード）と、マスクして 200 文字に切ったメッセージを記録する
      console.error(
        "user_do_pull_states_error",
        e instanceof GitHubError ? e.code : e instanceof Error ? e.name : typeof e,
        errorMessageForLog(e),
      );
      states = refs.map(() => "unknown");
    }
    if (epoch === this.loginEpoch) {
      const at = this.now();
      refs.forEach((r, i) => {
        const state = states[i] ?? "unknown";
        const ttl =
          state === "open"
            ? PR_STATE_OPEN_TTL_MS
            : state === "unknown"
              ? PR_STATE_FAILURE_TTL_MS
              : PR_STATE_FINAL_TTL_MS;
        const k = `${r.repository.toLowerCase()}#${r.number}`;
        this.prStateCache.delete(k); // 挿入順を新しく保つ（古い順に捨てるため）
        this.prStateCache.set(k, { state, at, ttl });
      });
      this.trimPrStateCache(at);
    }
    return states;
  }

  private trimPrStateCache(now: number): void {
    if (this.prStateCache.size <= PR_STATE_CACHE_MAX) return;
    for (const [k, c] of this.prStateCache) {
      if (now - c.at >= c.ttl || now - c.at < 0) this.prStateCache.delete(k);
    }
    for (const k of this.prStateCache.keys()) {
      if (this.prStateCache.size <= PR_STATE_CACHE_MAX) break;
      this.prStateCache.delete(k);
    }
  }

  private dropVisible(): void {
    this.visibleCache = null;
    this.visibleGen++;
    // 破棄より前に始まった取得には、以降の呼び出しを束ねない
    this.visibleInflight.clear();
  }

  private async fetchVisible(epoch: number, startedAt: number): Promise<VisibleResult> {
    const gen = this.visibleGen;
    try {
      const { client, credentials } = this.github();
      const ids = await credentials.withToken((tok) =>
        client.listVisibleRepositoryIds(tok, this.maxVisibleRepositories),
      );
      // 取得中に再ログイン・破棄（別の呼び出しの失敗など）があったら、結果は返すがキャッシュしない
      if (gen === this.visibleGen && epoch === this.loginEpoch) {
        // 並行する取得のうち、後で終わった古い取得が新しい結果を上書きしない（開始が既存以上のときだけ書く）
        const cur = this.visibleCache;
        if (!cur || cur.epoch !== epoch || startedAt >= cur.at) {
          this.visibleCache = { ids, at: startedAt, epoch };
        }
      }
      return { ok: true, ids };
    } catch (e) {
      this.dropVisible();
      if (e instanceof VisibleSetTooLargeError) return { ok: false, code: "too_large" };
      if (e instanceof GitHubError) {
        if (e.code === "reauth_required") return { ok: false, code: "unauthenticated" };
        if (e.code === "forbidden") return { ok: false, code: "denied" };
        return { ok: false, code: "unavailable" };
      }
      // メッセージにトークン等が入りうるので、エラー名だけを記録する
      console.error("user_do_visible_error", e instanceof Error ? e.name : typeof e);
      return { ok: false, code: "unavailable" };
    }
  }

  /** ログアウト。sid の記録を消す（冪等）。GitHub の資格には触れない（MCP と共用のため）。 */
  async revokeDashboardSession(sid: string): Promise<void> {
    this.ctx.storage.sql.exec("DELETE FROM dashboard_session WHERE sid = ?", sid);
  }

  /**
   * 旧スキーマ（reservation: singleton の 1 行だけで、同時実行は 1 件）の DO を移行する。
   * 予約が入っていれば reservation_slot に移し（失わない）、旧テーブルを消す。冪等（旧テーブルが無ければ何もしない）。
   * 移行した予約は、これまでどおり finishTask の解放と reserve の照合による回収の対象になる。
   */
  private migrateLegacyReservation(): void {
    const sql = this.ctx.storage.sql;
    const legacy = sql
      .exec<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'reservation'",
      )
      .toArray();
    if (legacy.length === 0) return;
    this.ctx.storage.transactionSync(() => {
      sql.exec(
        `INSERT OR IGNORE INTO reservation_slot (task_id, reserved_at)
         SELECT active_task_id, reserved_at FROM reservation WHERE active_task_id IS NOT NULL`,
      );
      sql.exec("DROP TABLE reservation");
    });
  }

  /** 同時に実行できるタスクの上限。env の MAX_CONCURRENT_TASKS（既定 2）。テストで差し替える。 */
  concurrencyLimit: () => number = () => maxConcurrentTasks(this.env);

  /** 月額の費用上限（USD）。env の MONTHLY_BUDGET_USD（既定 100）。不正な値は既定に戻す。テストで差し替える。 */
  monthlyLimitUsd: () => number = () => {
    const raw = this.env.MONTHLY_BUDGET_USD;
    const n = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : Number.NaN;
    return Number.isFinite(n) && n >= 0 ? n : DEFAULT_MONTHLY_BUDGET_USD;
  };

  /** web の1日あたりの上限。env から読む。テストで差し替える。 */
  webDailyLimit: (kind: WebQuotaKind) => number = (kind) =>
    kind === "search"
      ? parseDailyLimit(this.env.WEB_SEARCH_DAILY_LIMIT, DEFAULT_WEB_SEARCH_DAILY_LIMIT)
      : kind === "browse"
        ? parseDailyLimit(this.env.WEB_BROWSE_DAILY_LIMIT, DEFAULT_WEB_BROWSE_DAILY_LIMIT)
        : parseDailyLimit(this.env.WEB_FETCH_DAILY_LIMIT, DEFAULT_WEB_FETCH_DAILY_LIMIT);

  /**
   * web の回数を1回分消費する（UTC の日付ごと）。上限に達していれば消費せず ok:false。
   * 呼び出しの前に消費する（web の呼び出しが失敗しても戻さない。課金と取得の副作用が起きうるため）。
   */
  consumeWebQuota(kind: WebQuotaKind): WebQuotaResult {
    const limit = this.webDailyLimit(kind);
    const now = this.now();
    const day = new Date(now).toISOString().slice(0, 10);
    const oldest = new Date(now - WEB_USAGE_RETAIN_DAYS * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    return this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      sql.exec("DELETE FROM web_usage WHERE day < ?", oldest);
      const row = sql
        .exec<{ count: number }>(
          "SELECT count FROM web_usage WHERE day = ? AND kind = ?",
          day,
          kind,
        )
        .toArray()[0];
      const used = row?.count ?? 0;
      if (used >= limit) return { ok: false, used, limit };
      sql.exec(
        "INSERT INTO web_usage (day, kind, count) VALUES (?, ?, 1) ON CONFLICT(day, kind) DO UPDATE SET count = count + 1",
        day,
        kind,
      );
      return { ok: true, used: used + 1, limit };
    });
  }

  /** 照合先の TaskDO。テストで差し替える。 */
  protected taskStub(taskId: string): TaskInspector {
    return this.env.TASK_DO.getByName(taskId);
  }

  /** 枠を持っているタスク（予約の古い順）。 */
  private slotRows(): SlotRow[] {
    return this.ctx.storage.sql
      .exec<SlotRow>(
        "SELECT task_id, reserved_at FROM reservation_slot ORDER BY reserved_at, task_id",
      )
      .toArray();
  }

  private slotCount(): number {
    return this.ctx.storage.sql
      .exec<{ n: number }>("SELECT COUNT(*) AS n FROM reservation_slot")
      .one().n;
  }

  /** そのタスクの枠を解放する。枠を持っていたときだけ true。同期区間内で呼ぶこと。 */
  private clearSlot(taskId: string): boolean {
    const sql = this.ctx.storage.sql;
    const had = sql
      .exec("DELETE FROM reservation_slot WHERE task_id = ? RETURNING task_id", taskId)
      .toArray();
    if (had.length === 0) return false;
    // 枠を手放したタスクは、予約額をもう数えない（実費だけが残る）。
    sql.exec("UPDATE task_budget SET closed = 1 WHERE task_id = ?", taskId);
    return true;
  }

  /**
   * 月の枠のうち、使用済み（実費）と予約中の残り（マイクロドル）。committedMicro = spent + reserved。
   * estimated は spent のうち見積もりで確定した分（内数）。
   */
  private spentAndReservedMicro(month: string): {
    spent: number;
    estimated: number;
    reserved: number;
  } {
    return this.ctx.storage.sql
      .exec<{ spent: number; estimated: number; reserved: number }>(
        `SELECT COALESCE(SUM(settled_micro), 0) AS spent,
                COALESCE(SUM(CASE WHEN settled_estimated = 1 THEN settled_micro ELSE 0 END), 0) AS estimated,
                COALESCE(SUM(CASE WHEN closed = 1 THEN 0
                                  ELSE MAX(reserved_micro - settled_micro, 0) END), 0) AS reserved
         FROM task_budget WHERE month = ?`,
        month,
      )
      .one();
  }

  /** 月の枠のうち、使用済みと予約中の合計（マイクロドル）。 */
  private committedMicro(month: string): number {
    return this.ctx.storage.sql
      .exec<{ total: number }>(
        `SELECT COALESCE(SUM(CASE WHEN closed = 1 THEN settled_micro
                                  ELSE MAX(reserved_micro, settled_micro) END), 0) AS total
         FROM task_budget WHERE month = ?`,
        month,
      )
      .one().total;
  }

  /**
   * 新規 / 再試行 / conflict / concurrency_limit を判定して task_id を返す。
   * 枠が上限まで埋まっていれば、枠を持つタスクを TaskDO に照合し、回収できるもの（終端でなく一度も作られなかった予約）を
   * 解放して再判定する。照合（await）はトランザクションの外で行い、解放は task_id を指定して行う
   * （入れ替わった別のタスクの枠は消えない）。
   */
  async reserve(requestKey: string, fingerprint: string): Promise<ReserveResult> {
    for (let attempt = 0; attempt < MAX_RECONCILE_ATTEMPTS; attempt++) {
      // 同期区間: 判定と記録を await なしで一度に行う（割り込まれない）。
      const step = this.ctx.storage.transactionSync(() => this.decide(requestKey, fingerprint));
      this.requestConsultAlarm(); // decide が古い consult を閉じたとき、その索引を配送する
      if (step.kind === "done") return step.result;

      // 枠が埋まっている。枠を持つタスクを TaskDO に照合する（ここで他の呼び出しが割り込みうる）。
      const verdicts = await Promise.all(
        step.slots.map(async (slot) => ({
          slot,
          release: await this.shouldRelease(slot.task_id, slot.reserved_at),
        })),
      );
      const releasable = verdicts.filter((v) => v.release).map((v) => v.slot.task_id);
      if (releasable.length > 0) {
        // 解放は task_id で行う。照合中に finishTask で先に解放されていれば何も起きない。
        this.ctx.storage.transactionSync(() => {
          for (const taskId of releasable) this.clearSlot(taskId);
        });
        continue;
      }
      // 解放できるものは無い。枠の顔ぶれが照合の前と同じなら、本当に埋まっている。
      // 照合中に入れ替わっていた（finishTask で空いた、同じキーの reserve が割り込んだ、など）ら、判定をやり直す。
      const before = step.slots.map((r) => r.task_id).join(",");
      const now = this.slotRows()
        .map((r) => r.task_id)
        .join(",");
      if (before === now) return { ok: false, code: "concurrency_limit" };
    }
    return { ok: false, code: "concurrency_limit" };
  }

  /**
   * 同期の判定。同じキーの再試行は既存を返し、予約が空なら新規発行して記録する。
   * 予約が埋まっていれば照合に必要な情報を返す。
   */
  private decide(
    requestKey: string,
    fingerprint: string,
  ): { kind: "done"; result: ReserveResult } | { kind: "occupied"; slots: SlotRow[] } {
    const sql = this.ctx.storage.sql;
    const at = this.now();
    sql.exec("DELETE FROM requests WHERE created_at < ?", at - REQUEST_RETENTION_MS);

    const existing = sql
      .exec<RequestRow>(
        "SELECT task_id, fingerprint FROM requests WHERE request_key = ?",
        requestKey,
      )
      .toArray()[0];
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        return { kind: "done", result: { ok: false, code: "conflict" } };
      }
      return { kind: "done", result: { ok: true, task_id: existing.task_id, reused: true } };
    }

    if (this.slotCount() >= this.concurrencyLimit()) {
      return { kind: "occupied", slots: this.slotRows() };
    }

    // 同時実行の枠が空いていても、月額の枠が足りなければ始めない（request_key は消費しない）。
    // 精算されないまま残った consult の予約は、判定の前に閉じる（予約額で数える。reserveConsult と同じ）
    this.closeStaleConsults(at);
    const month = monthOf(at);
    const reservedMicro = Math.round(taskBudgetUsd(this.env) * MICRO);
    if (this.committedMicro(month) + reservedMicro > Math.round(this.monthlyLimitUsd() * MICRO)) {
      return { kind: "done", result: { ok: false, code: "budget_exceeded" } };
    }

    const taskId = ulid(at);
    sql.exec(
      "INSERT INTO task_budget (task_id, month, reserved_micro) VALUES (?, ?, ?)",
      taskId,
      month,
      reservedMicro,
    );
    sql.exec(
      "INSERT INTO requests (request_key, task_id, fingerprint, created_at) VALUES (?, ?, ?, ?)",
      requestKey,
      taskId,
      fingerprint,
      at,
    );
    sql.exec("INSERT INTO reservation_slot (task_id, reserved_at) VALUES (?, ?)", taskId, at);
    return { kind: "done", result: { ok: true, task_id: taskId, reused: false } };
  }

  /**
   * TaskDO に照合して、予約を解放してよいか判定する。
   * 回収できるのは「一度も作られなかった」予約だけ（abandoned、または未作成で tombstone を打てたもの）。
   * Phase 1 のタスク（agent_link が無い CREATING。ワーカーも精算も無い）も同じ扱いで回収する。
   * 作成済みのタスクは、停止が確認できていても返さない。予算と同時実行枠の返却は、最終精算と同じ
   * トランザクションの finishTask だけが行う（未精算の予算を返して二重に渡さないため）。
   * finishTask が届かないときは、TaskDO の alarm が再送して収束する。
   */
  private async shouldRelease(taskId: string, reservedAt: number): Promise<boolean> {
    const task = this.taskStub(taskId);
    const inspection = await task.inspect();
    switch (inspection.kind) {
      case "abandoned":
      case "legacy":
        return true;
      case "created":
        return false;
      case "uncreated": {
        if (this.now() - reservedAt < RESERVATION_RECLAIM_AFTER_MS) return false;
        // 回収は tombstone を打てたときだけ。作成済みが返れば解放しない。
        const r = await task.abandonIfUncreated();
        return r.result === "abandoned";
      }
    }
  }

  /**
   * usage（累計）の精算。TaskDO が取り込んだ usage イベントの seq ごとに冪等に呼ばれる。
   * seq が記録済み以下なら何もしない。AgentDO は直接ここへ計上しない（一方向 RPC）。
   */
  async settleUsage(taskId: string, usageSeq: number, costMicroUsd: number): Promise<SettleResult> {
    const r = this.ctx.storage.transactionSync(() =>
      this.applySettle(taskId, usageSeq, costMicroUsd),
    );
    return r === "unknown" ? { ok: false } : { ok: true, applied: r === "applied" };
  }

  /** 精算を反映する。同期区間内で呼ぶこと。 */
  private applySettle(
    taskId: string,
    usageSeq: number,
    costMicroUsd: number,
  ): "applied" | "ignored" | "unknown" {
    const sql = this.ctx.storage.sql;
    const row = sql
      .exec<{ settled_seq: number }>(
        "SELECT settled_seq FROM task_budget WHERE task_id = ?",
        taskId,
      )
      .toArray()[0];
    if (!row) return "unknown";
    if (!Number.isSafeInteger(usageSeq) || !Number.isFinite(costMicroUsd) || costMicroUsd < 0) {
      return "ignored";
    }
    if (usageSeq <= row.settled_seq) return "ignored";
    sql.exec(
      "UPDATE task_budget SET settled_micro = ?, settled_seq = ? WHERE task_id = ?",
      Math.round(costMicroUsd),
      usageSeq,
      taskId,
    );
    return "applied";
  }

  /**
   * タスクの終了。最終の実費を精算し、予約を閉じて（予約額との差額は月の枠に戻る）、
   * 同時実行の枠を解放する。TaskDO が「終端 + AgentDO の停止確認済み」になってから呼ぶ。冪等。
   */
  async finishTask(taskId: string, usageSeq: number, costMicroUsd: number): Promise<FinishResult> {
    const released = this.ctx.storage.transactionSync(() => {
      this.applySettle(taskId, usageSeq, costMicroUsd);
      this.ctx.storage.sql.exec("UPDATE task_budget SET closed = 1 WHERE task_id = ?", taskId);
      return this.clearSlot(taskId);
    });
    return { ok: true, released };
  }

  /**
   * 終端後の費用の確定。AI Gateway のログの cost の合計（マイクロドル）で settled_micro を 1 回だけ上書きし、
   * cost_source を gateway にする。閉じた（closed = 1）行で、まだ estimate のものだけ。2 回目以降は無視する（冪等）。
   * applied: false には理由を付ける（invalid: 額が不正 / not_closed: まだ閉じていない / already: すでに確定済み）。
   * 月は予約した行の月のまま（月の集計は closed の行の settled_micro を数えるので、そのまま反映される）。
   */
  reconcileTaskCost(
    taskId: string,
    micro: number,
  ):
    | { ok: true; applied: true }
    | { ok: true; applied: false; reason: "not_closed" | "already" | "invalid" }
    | { ok: false } {
    if (!isTaskId(taskId)) return { ok: false };
    const sql = this.ctx.storage.sql;
    return this.ctx.storage.transactionSync(() => {
      const row = sql
        .exec<{ closed: number; cost_source: string }>(
          "SELECT closed, cost_source FROM task_budget WHERE task_id = ?",
          taskId,
        )
        .toArray()[0];
      if (!row) return { ok: false } as const;
      if (!Number.isFinite(micro) || micro < 0) {
        return { ok: true, applied: false, reason: "invalid" } as const;
      }
      if (row.closed !== 1) return { ok: true, applied: false, reason: "not_closed" } as const;
      if (row.cost_source !== "estimate") {
        return { ok: true, applied: false, reason: "already" } as const;
      }
      sql.exec(
        "UPDATE task_budget SET settled_micro = ?, settled_estimated = 0, cost_source = 'gateway' WHERE task_id = ?",
        Math.round(micro),
        taskId,
      );
      return { ok: true, applied: true } as const;
    });
  }

  /**
   * タスクの予算の延長（budget_policy: ask でクライアントが「続ける」を選んだとき）。n 回目（1 または 2）の延長として、
   * タスク予算（task_budget_usd）と同じ額を、月の枠から「その場で」そのタスクの予約に足す。
   * 月の枠はハードリミットのまま: 予約済み + 使用済み + 延長分が上限を超えるなら予約せず budget_exceeded。
   * 同じ n の再送は冪等（applied: false）。n は 1 から順に（2 回目は 1 回目の後）。精算済み（closed）のタスクは closed。
   */
  extendTaskBudget(
    taskId: string,
    n: number,
  ):
    | { ok: true; applied: boolean; reserved_usd: number }
    | { ok: false; code: "budget_exceeded" | "not_found" | "closed" | "invalid_input" } {
    if (!isTaskId(taskId)) return { ok: false, code: "not_found" };
    if (!Number.isInteger(n) || n < 1 || n > MAX_BUDGET_EXTENSIONS) {
      return { ok: false, code: "invalid_input" };
    }
    return this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      const row = sql
        .exec<{ month: string; reserved_micro: number; closed: number; extensions: number }>(
          "SELECT month, reserved_micro, closed, extensions FROM task_budget WHERE task_id = ?",
          taskId,
        )
        .toArray()[0];
      if (!row) return { ok: false as const, code: "not_found" as const };
      if (n <= row.extensions) {
        return { ok: true as const, applied: false, reserved_usd: row.reserved_micro / MICRO };
      }
      if (row.closed === 1) return { ok: false as const, code: "closed" as const };
      if (n !== row.extensions + 1) return { ok: false as const, code: "invalid_input" as const };
      const addMicro = Math.round(taskBudgetUsd(this.env) * MICRO);
      this.closeStaleConsults(this.now());
      if (this.committedMicro(row.month) + addMicro > Math.round(this.monthlyLimitUsd() * MICRO)) {
        return { ok: false as const, code: "budget_exceeded" as const };
      }
      sql.exec(
        "UPDATE task_budget SET reserved_micro = reserved_micro + ?, extensions = ? WHERE task_id = ?",
        addMicro,
        n,
        taskId,
      );
      return {
        ok: true as const,
        applied: true,
        reserved_usd: (row.reserved_micro + addMicro) / MICRO,
      };
    });
  }

  /**
   * 自分の予算の状況（budget_status）。金額は USD（マイクロドルを 6 桁に丸める）。
   * spent は精算済みの実費、reserved は実行中のタスク・consult の予約の残り。remaining は月の上限から両方を引く（負にしない）。
   */
  budgetStatus(): BudgetStatus {
    const at = this.now();
    // 期限を過ぎた consult の予約は、見せる前に予約額で閉じる（取り残された予約を reserved に出し続けない）
    this.ctx.storage.transactionSync(() => this.closeStaleConsults(at));
    this.requestConsultAlarm();
    const month = monthOf(at);
    const { spent, estimated, reserved } = this.spentAndReservedMicro(month);
    const limit = Math.round(this.monthlyLimitUsd() * MICRO);
    const remaining = Math.max(0, limit - spent - reserved);
    const taskMicro = Math.round(taskBudgetUsd(this.env) * MICRO);
    const d = new Date(at);
    const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
    const end = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
    return {
      monthly_budget_usd: limit / MICRO,
      spent_usd: spent / MICRO,
      estimated_usd: estimated / MICRO,
      reserved_usd: reserved / MICRO,
      remaining_usd: remaining / MICRO,
      task_budget_usd: taskMicro / MICRO,
      consult_budget_usd: consultBudgetUsd(this.env),
      max_concurrent_tasks: taskMicro > 0 ? Math.floor(remaining / taskMicro) : 0,
      concurrency_limit: this.concurrencyLimit(),
      pending_consults: this.openConsultCount(),
      period: { start: new Date(start).toISOString(), end: new Date(end).toISOString() },
    };
  }

  /**
   * ダッシュボードの予算の表示用（M5b）。budgetStatus に、いま同時実行の枠を持つタスクの数を足す。
   * BudgetStatus の型は MCP の budget_status と共用なので広げず、別のメソッドにする。許可ルールの確認は呼び出し側
   * （requireSession → authorizeDashboardSession）が済ませている。
   */
  dashboardBudget(): BudgetStatus & { running_slots: number } {
    return { ...this.budgetStatus(), running_slots: this.slotCount() };
  }

  /**
   * ダッシュボードの「全員の実績」用。今月の台帳の使用済み（spent）と、そのうち見積もりで確定した分（estimated）をマイクロドルで返す。
   * budgetStatus と同じ集計（タスク + consult。予約中の分は含めない）なので、「あなたの使った額」と同じ定義でそろう。
   * 他の利用者の閲覧者のポーリングから呼ばれるので、**読み取りだけ**（期限切れの consult を閉じず、alarm も立てない）。
   * 期限切れで閉じていない consult の予約は spent に入らない（本人が次に budgetStatus を呼んだときに閉じて入る）。
   */
  dashboardMonthSpent(): { spent_micro: number; estimated_micro: number } {
    const { spent, estimated } = this.spentAndReservedMicro(monthOf(this.now()));
    return { spent_micro: spent, estimated_micro: estimated };
  }

  /**
   * consult の予約。同時実行の枠は使わず、月の枠から CONSULT_BUDGET_USD を予約する（task_budget に consult の行を足す）。
   * 足りなければ budget_exceeded。同じ consultId の再送は冪等。
   * 精算されないまま CONSULT_STALE_AFTER_MS を過ぎた consult の予約は、予約額で閉じる（実費が分からないので、
   * 予約より少なく数えない側に倒す）。
   */
  reserveConsult(consultId: string, model?: string, owner?: ConsultOwner): ConsultReserveResult {
    if (!isConsultId(consultId)) return { ok: false, code: "invalid_input" };
    const reservedUsd = consultBudgetUsd(this.env);
    const result = this.ctx.storage.transactionSync((): ConsultReserveResult => {
      const sql = this.ctx.storage.sql;
      const at = this.now();
      this.closeStaleConsults(at);
      const existing = sql
        .exec<{ reserved_micro: number }>(
          "SELECT reserved_micro FROM task_budget WHERE task_id = ?",
          consultId,
        )
        .toArray()[0];
      if (existing) return { ok: true, reserved_usd: existing.reserved_micro / MICRO };
      // 開いている consult が上限なら断る（期限切れは上で閉じた後の数）。月の枠で抑えられるが、暴走時の負荷を抑える
      if (this.openConsultCount() >= MAX_PENDING_CONSULTS) {
        return { ok: false, code: "concurrency_limit" };
      }
      const month = monthOf(at);
      const reservedMicro = Math.round(reservedUsd * MICRO);
      if (this.committedMicro(month) + reservedMicro > Math.round(this.monthlyLimitUsd() * MICRO)) {
        return { ok: false, code: "budget_exceeded" };
      }
      sql.exec(
        "INSERT INTO task_budget (task_id, month, reserved_micro) VALUES (?, ?, ?)",
        consultId,
        month,
        reservedMicro,
      );
      // 索引用の行（モデルと所有者が分かるときだけ。予約と同じ同期区間で作る）
      if (typeof model === "string" && model !== "" && owner && Number.isSafeInteger(owner.id)) {
        sql.exec(
          `INSERT OR IGNORE INTO consult_log (consult_id, owner_id, owner_login, at, model)
           VALUES (?, ?, ?, ?, ?)`,
          consultId,
          owner.id,
          String(owner.login),
          at,
          model,
        );
      }
      return { ok: true, reserved_usd: reservedMicro / MICRO };
    });
    this.requestConsultAlarm();
    return result;
  }

  /** 開いている consult（予約から精算まで）の数。同期区間の外でも呼べる。 */
  private openConsultCount(): number {
    return this.ctx.storage.sql
      .exec<{ n: number }>(
        "SELECT COUNT(*) AS n FROM task_budget WHERE closed = 0 AND task_id LIKE 'consult-%'",
      )
      .one().n;
  }

  /**
   * 同期区間内で呼ぶ。古い consult の予約を、予約額（以上）で閉じる。pending の答えがあれば、同じ区間で failed
   * （upstream_unavailable）にする（pending のまま残さない）。保持期間を過ぎた答えもここで捨てる。
   */
  private closeStaleConsults(at: number): void {
    const sql = this.ctx.storage.sql;
    const open = sql
      .exec<{ task_id: string }>(
        "SELECT task_id FROM task_budget WHERE closed = 0 AND task_id LIKE 'consult-%'",
      )
      .toArray();
    for (const { task_id } of open) {
      const t = ulidTime(task_id.slice("consult-".length));
      if (t === undefined || at - t < CONSULT_STALE_AFTER_MS) continue;
      sql.exec(
        "UPDATE task_budget SET settled_micro = MAX(settled_micro, reserved_micro), settled_estimated = 1, closed = 1 WHERE task_id = ?",
        task_id,
      );
      this.markConsultSettled(task_id);
      const settled = sql
        .exec<{ settled_micro: number }>(
          "SELECT settled_micro FROM task_budget WHERE task_id = ?",
          task_id,
        )
        .one().settled_micro;
      this.writeConsultFailure(task_id, unavailableFailure(), settled / MICRO, at);
      this.wakeConsultSoon(task_id);
    }
    sql.exec("DELETE FROM consult_answer WHERE expires_at IS NOT NULL AND expires_at <= ?", at);
  }

  /** 同期区間内で呼ぶ。pending の答えを failed にする（pending でなければ何もしない）。 */
  private writeConsultFailure(
    consultId: string,
    error: ConsultFailure,
    costUsd: number,
    at: number,
  ): void {
    this.ctx.storage.sql.exec(
      `UPDATE consult_answer SET status = 'failed', result_json = ?, finished_at = ?, expires_at = ?
       WHERE consult_id = ? AND status = 'pending'`,
      JSON.stringify({ error, cost_usd: costUsd }),
      at,
      at + CONSULT_ANSWER_TTL_MS,
      consultId,
    );
  }

  /**
   * consult の精算: 実費（USD）を書いて閉じる。予約の余りは月の枠に戻る。1 回だけ（閉じた後の再送は applied:false）。
   * costUsd が null のとき（実費が分からない）は予約額で閉じる。壊れた値（負・NaN）は何もしない。
   * 実費が予約を超えて報告されたときは、そのまま実費を記録する（AgentDO が max_output_tokens で予約内に収める）。
   * 予約額で閉じたとき（costUsd が null）と、AgentDO が costUsd を見積もりと申告したとき（estimated）は、
   * 見積もりで確定した印（settled_estimated）を立てる（budget_status の estimated_usd に数える）。
   * 通常は裏の完了（finishConsult）が呼ぶ。gateway のリクエストは精算しない。
   */
  settleConsult(consultId: string, costUsd: number | null, estimated = false): SettleResult {
    if (!isConsultId(consultId)) return { ok: false };
    if (costUsd !== null && (!Number.isFinite(costUsd) || costUsd < 0)) {
      const known = this.ctx.storage.sql
        .exec("SELECT 1 FROM task_budget WHERE task_id = ?", consultId)
        .toArray();
      return known.length > 0 ? { ok: true, applied: false } : { ok: false };
    }
    const result = this.ctx.storage.transactionSync(() =>
      this.settleConsultInSection(consultId, costUsd, estimated),
    );
    this.requestConsultAlarm();
    if (!result.ok) return { ok: false };
    return { ok: true, applied: result.applied };
  }

  /** 同期区間内で呼ぶ。settleConsult の本体（値の検証は呼び出し側）。settled_micro は閉じた後の確定額。 */
  private settleConsultInSection(
    consultId: string,
    costUsd: number | null,
    estimated: boolean,
  ): { ok: true; applied: boolean; settled_micro: number } | { ok: false } {
    const sql = this.ctx.storage.sql;
    const row = sql
      .exec<{ reserved_micro: number; settled_micro: number; closed: number }>(
        "SELECT reserved_micro, settled_micro, closed FROM task_budget WHERE task_id = ?",
        consultId,
      )
      .toArray()[0];
    if (!row) return { ok: false };
    if (row.closed === 1) return { ok: true, applied: false, settled_micro: row.settled_micro };
    const micro = costUsd === null ? row.reserved_micro : Math.round(costUsd * MICRO);
    sql.exec(
      "UPDATE task_budget SET settled_micro = ?, settled_estimated = ?, closed = 1 WHERE task_id = ?",
      micro,
      costUsd === null || estimated ? 1 : 0,
      consultId,
    );
    // 索引の行を同じ同期区間で確定する（精算と索引が食い違わない）
    this.markConsultSettled(consultId);
    return { ok: true, applied: true, settled_micro: micro };
  }

  // ---- consult の裏の処理と答えの取得（docs/specs/consult-pending.md）----

  /**
   * consult の開始。consult_answer に pending の行を作り、AgentDO.consult の完了を待つ非同期処理を始めて、すぐ返る。
   * 処理は完了時に（成功・失敗・例外・時間切れのいずれでも）答えの保存・精算・索引の確定を同じ同期区間で行い、
   * 待っている呼び出しを起こす。呼び出し側（gateway のリクエスト）の切断に左右されない。
   * 予約（reserveConsult）が開いていない consult は始めない。同じ consult の再送は、モデルを二重に呼ばない。
   */
  async startConsult(request: ConsultRequest): Promise<ConsultStartResult> {
    const consultId = request?.consultId;
    if (!isConsultId(consultId)) return { ok: false, code: "invalid_input" };
    const ownerId = Number(request.userId);
    if (!Number.isSafeInteger(ownerId)) return { ok: false, code: "invalid_input" };
    // test のときだけ、E2E が裏の上限を縮める
    const backgroundMs =
      (await testConsultTiming(this.env))?.backgroundTimeoutMs ?? this.consultBackgroundTimeoutMs;
    const state = this.ctx.storage.transactionSync((): "not_found" | "exists" | "started" => {
      const sql = this.ctx.storage.sql;
      if (
        sql.exec("SELECT 1 FROM consult_answer WHERE consult_id = ?", consultId).toArray().length >
        0
      ) {
        return "exists";
      }
      const budget = sql
        .exec<{ closed: number }>("SELECT closed FROM task_budget WHERE task_id = ?", consultId)
        .toArray()[0];
      if (!budget || budget.closed === 1) return "not_found";
      sql.exec(
        `INSERT INTO consult_answer (consult_id, owner_id, status, started_at)
         VALUES (?, ?, 'pending', ?)`,
        consultId,
        ownerId,
        this.now(),
      );
      return "started";
    });
    if (state === "not_found") return { ok: false, code: "not_found" };
    if (state === "started") {
      // 完了まで待つ。待つ間は未完了の RPC が DO を生かす。waitUntil は念のため（失敗を握りつぶさない処理なので例外は出ない）
      this.ctx.waitUntil(this.runConsult(request, backgroundMs));
      this.scheduleConsultDeadlineAlarm();
    }
    return { ok: true };
  }

  /** 裏の処理。AgentDO.consult を上限まで待ち、完了処理に渡す。例外は出さない。 */
  private async runConsult(request: ConsultRequest, backgroundMs: number): Promise<void> {
    let result: ConsultResult | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      result = await Promise.race([
        this.consultAgent(request.consultId).consult(request),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("consult timeout")), backgroundMs);
        }),
      ]);
    } catch (e) {
      // 例外・時間切れは、実費が分からないので予約額で精算する（完了処理が undefined を実費不明として扱う）
      console.error("consult_error", e instanceof Error ? e.name : typeof e);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    try {
      await this.finishConsult(request, result);
    } catch (e) {
      // 保存と精算は同じ区間なので、失敗すれば両方とも起きていない（pending のまま。期限が予約額で閉じる）
      console.error("consult_finish_error", e instanceof Error ? e.name : typeof e);
    }
  }

  /**
   * 完了処理。答えの保存・精算（settleConsult と同じ規則）・consult_log の確定を、同じ同期区間で行う。
   * 期限で既に閉じられた consult（遅れて届いた完了）は、精算も保存もしない（二重に数えない。答えは捨てる）。
   */
  private async finishConsult(
    request: ConsultRequest,
    result: ConsultResult | undefined,
  ): Promise<void> {
    const consultId = request.consultId;
    let outcome = interpretConsult(result, request.effort);
    if (
      outcome.status === "done" &&
      new TextEncoder().encode(JSON.stringify(outcome.value)).length > CONSULT_ANSWER_MAX_BYTES
    ) {
      // 1 行に収まらない答えは、切り詰めず failed にする（費用は実費で精算する）
      outcome = {
        status: "failed",
        error: { code: "internal", message: "internal error" },
        settleUsd: outcome.settleUsd,
        estimated: outcome.estimated,
      };
    }
    const done = this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      const at = this.now();
      const row = sql
        .exec<ConsultAnswerRow>("SELECT status FROM consult_answer WHERE consult_id = ?", consultId)
        .toArray()[0];
      if (row?.status !== "pending") return null;
      const settled = this.settleConsultInSection(consultId, outcome.settleUsd, outcome.estimated);
      if (!settled.ok) return null;
      const costUsd = settled.settled_micro / MICRO;
      if (!settled.applied) {
        // 予約は別の経路で閉じられた。答えは捨て、pending のまま残さない
        this.writeConsultFailure(consultId, unavailableFailure(), costUsd, at);
        return null;
      }
      if (outcome.status === "done") {
        sql.exec(
          `UPDATE consult_answer SET status = 'done', result_json = ?, finished_at = ?, expires_at = ?
           WHERE consult_id = ? AND status = 'pending'`,
          JSON.stringify(outcome.value),
          at,
          at + CONSULT_ANSWER_TTL_MS,
          consultId,
        );
      } else {
        this.writeConsultFailure(consultId, outcome.error, costUsd, at);
      }
      return { costUsd };
    });
    this.wakeConsult(consultId);
    this.requestConsultAlarm();
    this.scheduleConsultDeadlineAlarm();
    if (done === null) return;
    await auditFromWorker(this.env, "consult_finished", {
      userId: Number(request.userId),
      caller: "parent",
      model: request.model,
      consult_id: consultId,
      cost_usd: done.costUsd,
      // 成功なのに usage が返らなかった（費用は呼ぶ前の見積りで精算した）
      ...(outcome.status === "done" && outcome.usageMissing ? { reason: "usage_missing" } : {}),
    });
  }

  /**
   * consult の答えを取る（long polling）。done / failed は保持期間内なら何度でも同じ答え。待つのは最大 50 秒。
   * 完了した答えがあればすぐ返し、無ければ（pending）完了か待ち時間の終わりまで待つ。待っている間にクライアントが切れても、
   * 裏の処理にも答えにも影響しない。UserDO が作り直されて待ちが消えても、行（SQLite）が正なので呼び直せば最新を返す。
   * not_found は、不正な ID・存在しない・他人（ownerId の照合）・保持期間切れのすべて。
   * 答えは返しても消さない（待っている間に呼び出し側が切れると、答えを受け取る人がいないまま消えてしまうため）。
   * consult が 50 秒以内に返した答えは、リクエストが答えを受け取れたあとで discardConsult が消す。
   */
  async waitConsult(
    consultId: string,
    ownerId: number,
    timeoutMs: number,
  ): Promise<ConsultWaitResult> {
    if (!isConsultId(consultId) || !Number.isSafeInteger(ownerId)) {
      return { ok: false, code: "not_found" };
    }
    const timeout =
      typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
        ? Math.min(timeoutMs, MAX_WAIT_SECONDS * 1000)
        : 0;
    let current = this.readConsultAnswer(consultId, ownerId);
    if (!(current.ok && current.status === "pending") || timeout === 0) return current;
    if (this.consultWaiters.size >= MAX_CONCURRENT_WAITERS) {
      return { ok: true, status: "pending", retry_after_seconds: WAIT_RETRY_AFTER_SECONDS };
    }

    // 待機者を登録してから再読する（登録前の完了を取りこぼさない）
    const waiter: ConsultWaiter = { consultId, wake: () => {} };
    this.consultWaiters.add(waiter);
    const deadline = Date.now() + timeout;
    try {
      for (;;) {
        current = this.readConsultAnswer(consultId, ownerId);
        if (!(current.ok && current.status === "pending")) break;
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        await new Promise<void>((resolve) => {
          waiter.wake = resolve;
          waiter.timer = setTimeout(resolve, remaining);
        });
        clearTimeout(waiter.timer);
      }
    } finally {
      clearTimeout(waiter.timer);
      this.consultWaiters.delete(waiter);
    }
    return current;
  }

  /**
   * 完了した答え（done / failed）の行を消す。consult が 50 秒以内に答えを受け取れたとき、返す前に呼ぶ（本文を UserDO に残さない）。
   * pending の行・他人の行・無い行は何もしない。受け取れなかった（待っている間にクライアントが切れた）答えは呼ばれないので、
   * 保持期間まで残り、consult_result で取れる。
   */
  discardConsult(consultId: string, ownerId: number): { ok: true; discarded: boolean } {
    if (!isConsultId(consultId) || !Number.isSafeInteger(ownerId))
      return { ok: true, discarded: false };
    const cursor = this.ctx.storage.sql.exec(
      "DELETE FROM consult_answer WHERE consult_id = ? AND owner_id = ? AND status != 'pending'",
      consultId,
      ownerId,
    );
    return { ok: true, discarded: cursor.rowsWritten > 0 };
  }

  /** consult_answer を読む。期限を過ぎた pending は閉じ、保持期間を過ぎた答えは捨ててから読む。 */
  private readConsultAnswer(consultId: string, ownerId: number): ConsultWaitResult {
    const result = this.ctx.storage.transactionSync((): ConsultWaitResult => {
      const sql = this.ctx.storage.sql;
      this.closeStaleConsults(this.now());
      const row = sql
        .exec<ConsultAnswerRow>(
          "SELECT consult_id, owner_id, status, result_json FROM consult_answer WHERE consult_id = ?",
          consultId,
        )
        .toArray()[0];
      // 所有者の照合も行う（UserDO はユーザーごとなので、他人の ID は通常ここに行が無い）
      if (!row || row.owner_id !== ownerId) return { ok: false, code: "not_found" };
      if (row.status === "pending") return { ok: true, status: "pending" };
      return parseStoredAnswer(row);
    });
    this.requestConsultAlarm();
    return result;
  }

  /** 待っている呼び出しを起こす（起きた側が行を読み直す） */
  private wakeConsult(consultId: string): void {
    for (const w of this.consultWaiters) if (w.consultId === consultId) w.wake();
  }

  /** 同期区間の中から呼ぶ用。区間が終わってから起こす。 */
  private wakeConsultSoon(consultId: string): void {
    queueMicrotask(() => this.wakeConsult(consultId));
  }

  /**
   * 次に必要な期限（pending の consult が失われたときの閉じ・保持期間を過ぎた答えの削除）に alarm を置く。
   * 既にそれより早い alarm があれば動かさない。同期メソッドから呼ぶので待たない（失敗しても consult は止めない）。
   */
  private scheduleConsultDeadlineAlarm(): void {
    const deadline = this.nextConsultDeadline();
    if (deadline === undefined) return;
    const target = Date.now() + Math.max(0, deadline - this.now());
    this.ctx.waitUntil(
      this.ctx.storage
        .getAlarm()
        .then((current) =>
          current === null || current > target ? this.ctx.storage.setAlarm(target) : undefined,
        )
        .catch((e) => {
          console.error("consult_deadline_alarm_error", e instanceof Error ? e.name : typeof e);
        }),
    );
  }

  /** 開いている consult を閉じる期限と、答えの保持期限のうち、いちばん早いもの（this.now() の時刻系。無ければ undefined） */
  private nextConsultDeadline(): number | undefined {
    const sql = this.ctx.storage.sql;
    let next: number | undefined;
    const consider = (t: number | undefined) => {
      if (t !== undefined && (next === undefined || t < next)) next = t;
    };
    for (const { task_id } of sql
      .exec<{ task_id: string }>(
        "SELECT task_id FROM task_budget WHERE closed = 0 AND task_id LIKE 'consult-%'",
      )
      .toArray()) {
      const t = ulidTime(task_id.slice("consult-".length));
      if (t !== undefined) consider(t + CONSULT_STALE_AFTER_MS);
    }
    const expiry = sql
      .exec<{ t: number | null }>(
        "SELECT MIN(expires_at) AS t FROM consult_answer WHERE expires_at IS NOT NULL",
      )
      .one().t;
    if (expiry !== null) consider(expiry);
    return next;
  }

  // ---- consult の索引（outbox と alarm。D9 / M3b）----

  /**
   * 同期区間の中で呼ぶ。task_budget で確定した consult の値を consult_log に写し、revision を上げて dirty にする。
   * consult_log に行が無い consult（デプロイ前の予約など）は何もしない。
   */
  private markConsultSettled(consultId: string): void {
    const cursor = this.ctx.storage.sql.exec(
      `UPDATE consult_log SET
         cost_micro = (SELECT settled_micro FROM task_budget WHERE task_id = consult_log.consult_id),
         estimated = (SELECT settled_estimated FROM task_budget WHERE task_id = consult_log.consult_id),
         settled = 1, revision = revision + 1, index_dirty = 1
       WHERE consult_id = ? AND settled = 0`,
      consultId,
    );
    if (cursor.rowsWritten > 0) this.consultAlarmWanted = true;
  }

  /**
   * 未配送の consult があるとき、alarm が無ければ設定する（同期メソッドから呼ぶので待たない。失敗しても consult は止めない）。
   * 既に十分早い alarm があれば動かさない（連続した consult で alarm が後ろへ押されない）。
   */
  private requestConsultAlarm(): void {
    if (!this.consultAlarmWanted) return;
    this.consultAlarmWanted = false;
    if (this.env.DIRECTORY_DO === undefined) return;
    this.ctx.waitUntil(
      this.ctx.storage
        .getAlarm()
        .then((current) => {
          // 既に十分早い alarm があれば動かさない（連続した consult で alarm が後ろへ押されない）。
          // 期限用の遠い alarm（consult の閉じ・答えの保持）があるときは、索引の配送のために手前へ寄せる
          const target = Date.now() + CONSULT_INDEX_ALARM_INTERVAL_MS;
          return current === null || current > target
            ? this.ctx.storage.setAlarm(target)
            : undefined;
        })
        .catch((e) => {
          console.error("consult_index_alarm_error", e instanceof Error ? e.name : typeof e);
        }),
    );
  }

  /**
   * alarm: dirty な consult を Directory へ配送する。失敗しても例外にしない（索引は派生データ。consult 本体は止めない）。
   * 失敗したら指数バックオフ（TaskDO と同じ INDEX_BACKOFF）で再設定し、復旧したら追いつく。
   * 恒久的な拒否（invalid_input）はその行を送信済みとして捨てる。
   */
  override async alarm(): Promise<void> {
    try {
      // 期限を過ぎた consult を閉じ、保持期間を過ぎた答えを捨てる（閉じた分の索引は、この後の配送に載る）
      this.ctx.storage.transactionSync(() => this.closeStaleConsults(this.now()));
      this.consultAlarmWanted = false;
    } catch (e) {
      console.error("consult_sweep_error", e instanceof Error ? e.name : typeof e);
    }
    try {
      await this.deliverConsultIndex();
    } catch (e) {
      console.error("consult_index_error", e instanceof Error ? e.name : typeof e);
    }
    try {
      await this.syncConsultAlarm();
    } catch (e) {
      console.error("consult_index_alarm_error", e instanceof Error ? e.name : typeof e);
    }
  }

  private async deliverConsultIndex(): Promise<void> {
    if (this.env.DIRECTORY_DO === undefined) return;
    const sql = this.ctx.storage.sql;
    const at = this.now();
    // 配送済みの古い行を掃除する（Directory が正本）
    sql.exec(
      "DELETE FROM consult_log WHERE settled = 1 AND index_dirty = 0 AND at < ?",
      at - CONSULT_LOG_RETENTION_MS,
    );
    const outbox = sql
      .exec<{ attempts: number; retry_at: number }>(
        "SELECT attempts, retry_at FROM consult_outbox WHERE singleton = 1",
      )
      .one();
    if (at < outbox.retry_at) return;
    const dirty = sql
      .exec<ConsultLogRow>(
        "SELECT * FROM consult_log WHERE index_dirty = 1 ORDER BY at, consult_id LIMIT ?",
        CONSULT_INDEX_BATCH,
      )
      .toArray();
    for (const row of dirty) {
      try {
        const snapshot = consultSnapshot(row);
        const call = this.env.DIRECTORY_DO.getByName(DIRECTORY_NAME).upsertConsult(
          snapshot,
          row.revision,
        ) as unknown as Promise<UpsertConsultResult>;
        const res = await withTimeout(call, CONSULT_INDEX_TIMEOUT_MS);
        if (!res.ok && res.code !== "invalid_input") throw new Error(`rejected: ${res.code}`);
        if (!res.ok) console.error("consult_index_rejected", res.code);
        // 成功、または恒久的な拒否（捨てる）。送っている間に revision が進んでいなければ dirty を外す
        sql.exec(
          "UPDATE consult_log SET index_dirty = 0 WHERE consult_id = ? AND revision = ?",
          row.consult_id,
          row.revision,
        );
        sql.exec("UPDATE consult_outbox SET attempts = 0, retry_at = 0 WHERE singleton = 1");
      } catch (e) {
        // エラーのメッセージにはデータが入りうるので、名前だけを記録する
        console.error("consult_index_deliver_error", e instanceof Error ? e.name : typeof e);
        const attempts = outbox.attempts + 1;
        sql.exec(
          "UPDATE consult_outbox SET attempts = ?, retry_at = ? WHERE singleton = 1",
          attempts,
          this.now() + indexBackoffMs(attempts, this.random),
        );
        return; // 残りは次の alarm（バックオフの後）に
      }
    }
  }

  /**
   * 次の alarm を設定する（alarm は消費済み）。未配送の索引が残っていれば（バックオフを考えて）その時刻、
   * 開いている consult の期限・答えの保持期限があればその時刻のうち早いほう。どちらも無ければ何もしない。
   */
  private async syncConsultAlarm(): Promise<void> {
    const sql = this.ctx.storage.sql;
    const waits: number[] = [];
    if (this.env.DIRECTORY_DO !== undefined) {
      const left = sql.exec("SELECT 1 FROM consult_log WHERE index_dirty = 1 LIMIT 1").toArray();
      if (left.length > 0) {
        const { retry_at } = sql
          .exec<{ retry_at: number }>("SELECT retry_at FROM consult_outbox WHERE singleton = 1")
          .one();
        waits.push(Math.max(CONSULT_INDEX_ALARM_INTERVAL_MS, retry_at - this.now()));
      }
    }
    const deadline = this.nextConsultDeadline();
    if (deadline !== undefined) waits.push(Math.max(1_000, deadline - this.now()));
    if (waits.length === 0) return;
    await this.ctx.storage.setAlarm(Date.now() + Math.min(...waits));
  }

  // ---- GitHub 連携 ----

  private readonly credentialStorage: CredentialStorage = {
    get: (): CredentialState => {
      const r = this.ctx.storage.sql
        .exec<CredentialRow>("SELECT * FROM github_credential WHERE singleton = 1")
        .one();
      if (r.access_token_enc === null) return { generation: r.generation, credential: null };
      const credential: StoredCredential = {
        accessTokenEnc: r.access_token_enc,
        refreshTokenEnc: r.refresh_token_enc,
        accessExpiresAt: r.access_expires_at,
        refreshExpiresAt: r.refresh_expires_at,
        version: r.version ?? 0,
        updatedAt: r.updated_at ?? 0,
      };
      return { generation: r.generation, credential };
    },
    // 世代の比較と書き込みを同期区間で行う（await を挟まないので原子的）。
    compareAndPut: (expected: number, value: StoredCredential | null): boolean =>
      this.ctx.storage.transactionSync(() => {
        const sql = this.ctx.storage.sql;
        const cur = sql
          .exec<{ generation: number }>("SELECT generation FROM github_credential")
          .one();
        if (cur.generation !== expected) return false;
        sql.exec(
          `UPDATE github_credential SET generation = ?, access_token_enc = ?, refresh_token_enc = ?,
             access_expires_at = ?, refresh_expires_at = ?, version = ?, updated_at = ? WHERE singleton = 1`,
          expected + 1,
          value?.accessTokenEnc ?? null,
          value?.refreshTokenEnc ?? null,
          value?.accessExpiresAt ?? null,
          value?.refreshExpiresAt ?? null,
          value?.version ?? null,
          value?.updatedAt ?? null,
        );
        return true;
      }),
  };

  private github(): { client: GitHubClient; credentials: CredentialManager } {
    if (this.credentials && this.githubClientInstance) {
      return { client: this.githubClientInstance, credentials: this.credentials };
    }
    const {
      GITHUB_APP_CLIENT_ID: id,
      GITHUB_APP_CLIENT_SECRET: secret,
      TOKEN_ENC_KEY: key,
    } = this.env;
    if (!id || !secret || !key || !loadAllowRules(this.env)) {
      throw new Error("GitHub integration is not configured");
    }
    const urls = resolveGitHubBaseUrls(this.env);
    const client = new GitHubClient({
      clientId: id,
      clientSecret: secret,
      oauthBase: urls.oauthBase,
      apiBase: urls.apiBase,
      fetch: (...args) => this.githubFetch(...args),
      now: () => this.now(),
    });
    // CredentialManager は 1 つを使い回す（進行中のリフレッシュを共有する single-flight のため）。
    const credentials = new CredentialManager({
      storage: this.credentialStorage,
      encryptionKey: key,
      client,
      now: () => this.now(),
    });
    this.githubClientInstance = client;
    this.credentials = credentials;
    return { client, credentials };
  }

  /** GitHubError は code を保ち、それ以外は内容を出さず internal にする。 */
  private toFailure(e: unknown): AuthzFailure {
    if (e instanceof GitHubError) return { ok: false, code: e.code, message: e.message };
    // メッセージにトークン等が入りうるので、エラー名だけを記録する
    console.error("user_do_error", e instanceof Error ? e.name : typeof e);
    return { ok: false, code: "internal", message: "internal error" };
  }

  /** ログイン（callback）で得た資格を保存する。既存を上書きし、team 所属のキャッシュは捨てる。 */
  async saveCredential(tokens: TokenSet): Promise<void> {
    await this.github().credentials.save(tokens);
    // 保存の完了後に世代を進める。旧資格で進行中の確認は、結果を捨てて新しい資格でやり直される。
    this.loginEpoch++;
    this.memberInflight.clear();
    this.visibleInflight.clear();
    this.dropVisible();
    this.prStateCache.clear();
    this.prStateInflight.clear();
    this.ctx.storage.sql.exec("DELETE FROM membership_cache");
  }

  /**
   * 指定 org / team の active メンバーであることを確かめる（結果は 5 分キャッシュ）。
   * fail-closed: GitHub に確かめられないときは必ず失敗を返す。失敗はキャッシュしない。
   */
  async ensureMember(githubUserId: number): Promise<MemberResult> {
    try {
      for (let attempt = 0; attempt < MAX_MEMBER_ATTEMPTS; attempt++) {
        const cached = this.cachedMembership(githubUserId);
        if (cached === "active") return { ok: true };
        if (cached === "denied") return this.notMember();
        const epoch = this.loginEpoch;
        // 同時の問い合わせは、同じ世代・同じユーザーの進行中の確認だけを共有する
        const key = `${epoch}:${githubUserId}`;
        let p = this.memberInflight.get(key);
        if (!p) {
          const created: Promise<MemberResult | typeof STALE> = this.checkMembership(
            githubUserId,
            epoch,
          ).finally(() => {
            // 自分が登録したものだけを消す（再ログインで作り直された新しい確認を消さない）
            if (this.memberInflight.get(key) === created) this.memberInflight.delete(key);
          });
          this.memberInflight.set(key, created);
          p = created;
        }
        const r = await p;
        if (r !== STALE) return r;
        // 確認中に再ログインされた: 古い結果を捨てて、新しい資格でやり直す
      }
      return {
        ok: false,
        code: "upstream_unavailable",
        message: "membership check was interrupted by re-login; retry",
      };
    } catch (e) {
      return this.toFailure(e);
    }
  }

  /** メンバー確認に加え、対象リポジトリが App の Installation 経由で push 可能かを確かめる。 */
  async authorizeStart(githubUserId: number, repository: string): Promise<StartAuthzResult> {
    const member = await this.ensureMember(githubUserId);
    if (!member.ok) return member;
    try {
      const { client, credentials } = this.github();
      const r = await credentials.withToken((tok) =>
        client.findWritableRepository(tok, repository),
      );
      return { ok: true, repositoryId: r.repositoryId, installationId: r.installationId };
    } catch (e) {
      return this.toFailure(e);
    }
  }

  /**
   * task_review の権限: task_start と同じ確認（team の再検証・App の Installation 経由で push できる）に加え、利用者本人の
   * トークンでその PR が見えること（App の権限だけで操作を許さない。design.md 6.2）。見えなければ not_found。
   * fork の PR（head のリポジトリが base と違う）・閉じた PR・マージ済みの PR は断る（draft は受け付ける）。
   */
  async authorizeReview(
    githubUserId: number,
    repository: string,
    number: number,
  ): Promise<ReviewAuthzResult> {
    const start = await this.authorizeStart(githubUserId, repository);
    if (!start.ok) return start;
    try {
      const { client, credentials } = this.github();
      const pull = await credentials.withToken((tok) => client.getPull(tok, repository, number));
      const same = (r: string | null) => r !== null && r.toLowerCase() === repository.toLowerCase();
      if (pull.number !== number || !same(pull.baseRepo)) {
        return { ok: false, code: "not_found", message: "pull request not found" };
      }
      if (!same(pull.headRepo)) {
        return {
          ok: false,
          code: "invalid_input",
          message:
            "fork_not_supported: pull requests from a fork cannot be reviewed yet (running review_commands on a fork's code would execute untrusted code)",
        };
      }
      if (pull.merged) {
        return {
          ok: false,
          code: "invalid_input",
          message: "pull_request_merged: the pull request is already merged",
        };
      }
      if (pull.state !== "open") {
        return {
          ok: false,
          code: "invalid_input",
          message: "pull_request_closed: the pull request is closed",
        };
      }
      if (pull.baseSha === null || !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(pull.baseSha)) {
        return {
          ok: false,
          code: "upstream_unavailable",
          message: "could not read the base commit",
        };
      }
      if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(pull.headSha)) {
        return {
          ok: false,
          code: "upstream_unavailable",
          message: "could not read the head commit",
        };
      }
      return {
        ok: true,
        repositoryId: start.repositoryId,
        installationId: start.installationId,
        pull: {
          number: pull.number,
          url: pull.url,
          headSha: pull.headSha,
          headRef: pull.headRef,
          baseSha: pull.baseSha,
          baseRef: pull.baseRef,
          title: pull.title,
          body: pull.body,
          draft: pull.draft,
        },
      };
    } catch (e) {
      const f = this.toFailure(e);
      // 見えない・無い PR（GitHub の 404 は client が forbidden に写す）は、存在を教えない
      if (f.code === "forbidden") {
        return { ok: false, code: "not_found", message: "pull request not found" };
      }
      return f;
    }
  }

  // ---- PR の Ready 化とマージ（D9）----
  // 利用者の GitHub のユーザートークンで行う（Installation Token は使わない: 利用者のブランチ保護の扱いと監査の主体を、
  // 利用者本人に合わせるため）。トークンはこの DO の中だけで使い、戻り値には出さない。
  // 対象（リポジトリ・PR 番号・ブランチ）は TaskDO の記録から来る。ここでは GitHub 上の PR がその記録と一致することを確かめる。

  /** Draft の PR を Ready にする。すでに Ready なら成功（冪等）。 */
  async prReady(target: PrTarget): Promise<PrReadyResult> {
    try {
      const { client, credentials } = this.github();
      return await credentials.withToken(async (tok): Promise<PrReadyResult> => {
        const pull = await client.getPull(tok, target.repository, target.number);
        const bad = this.pullProblem(pull, target);
        if (bad) return bad;
        if (!pull.draft) return { ok: true, already_ready: true };
        await client.markReadyForReview(tok, pull.nodeId);
        return { ok: true, already_ready: false };
      });
    } catch (e) {
      return this.toPrFailure(e);
    }
  }

  /**
   * PR をマージする。Ready であること・head が検証済みの sha であること・head に付いた GitHub の check がすべて成功している
   * （check が無ければ通す）ことを確かめ、sha 付きで GitHub に渡す
   * （確かめた後にブランチが動けば GitHub が 409 で拒否する）。ブランチ保護に拒否されたら merge_blocked。
   */
  async prMerge(target: PrTarget, opts: PrMergeOptions): Promise<PrMergeResult> {
    const { client, credentials } = this.github();
    let outcome: { already: boolean; sha: string | null };
    let checksUnreadable = false;
    try {
      const merged = await credentials.withToken(
        async (tok): Promise<PrFailure | { already: boolean; sha: string | null }> => {
          const pull = await client.getPull(tok, target.repository, target.number);
          const bad = this.pullProblem(pull, target, { allowMerged: true });
          if (bad) return bad;
          if (pull.merged) {
            return pull.headSha === opts.expectedSha
              ? { already: true, sha: null }
              : this.headMoved(pull.headSha);
          }
          if (pull.draft) {
            return {
              ok: false,
              code: "conflict",
              reason: "pr_draft",
              message: "the pull request is still a draft; call task_pr_ready first",
            };
          }
          if (pull.headSha !== opts.expectedSha) return this.headMoved(pull.headSha);
          // head の commit に GitHub の check（check run / commit status）が付いていれば、すべて成功していること。
          // 1 つも無ければ通す（厳しくしたいときは GitHub のブランチ保護を使う）。
          // 読めないとき（権限不足の 403 / 404・5xx・ネットワークの失敗）は止めずに通し、warnings に checks_unreadable を残す
          // （止めるかどうかは GitHub のブランチルールの責務）。読めて failing / pending なら止める
          checksUnreadable = false;
          let checks: Awaited<ReturnType<typeof client.getCheckState>> = "none";
          try {
            checks = await client.getCheckState(tok, target.repository, opts.expectedSha);
          } catch (e) {
            if (
              !(e instanceof GitHubError) ||
              !["forbidden", "upstream_unavailable"].includes(e.code)
            ) {
              throw e;
            }
            checksUnreadable = true;
          }
          if (checks === "failing" || checks === "pending") {
            return {
              ok: false,
              code: "merge_blocked",
              reason: checks === "failing" ? "checks_failing" : "checks_pending",
              message:
                checks === "failing"
                  ? "checks_failing: a GitHub check on the pull request head has failed; fix it and wait for the checks to pass, or merge by hand"
                  : "checks_pending: GitHub checks on the pull request head are still running or pending; wait for them to finish and retry",
            };
          }
          const r = await client.mergePull(tok, target.repository, target.number, {
            sha: opts.expectedSha,
            method: opts.method,
          });
          return { already: false, sha: r.sha };
        },
      );
      if ("ok" in merged) return merged;
      outcome = merged;
    } catch (e) {
      return this.toPrFailure(e);
    }

    // マージは取り消せない。ブランチの削除に失敗しても成功として返し、warnings に残す。
    let branchDeleted: boolean | null = null;
    const warnings: string[] = [];
    if (checksUnreadable) {
      warnings.push(
        "checks_unreadable: the GitHub checks (CI results) of the pull request head could not be read, so the pull request was merged without checking them; add the Checks: Read-only and Commit statuses: Read-only permissions to the GitHub App to have them checked (see docs/deploy.md)",
      );
    }
    if (opts.deleteBranch) {
      try {
        await credentials.withToken((tok) =>
          client.deleteBranch(tok, target.repository, target.branch),
        );
        branchDeleted = true;
      } catch (e) {
        branchDeleted = false;
        const detail = e instanceof GitHubError ? e.message : "unexpected error";
        warnings.push(`branch_delete_failed: the pull request was merged, but ${detail}`);
      }
    }
    return {
      ok: true,
      already_merged: outcome.already,
      merge_sha: outcome.sha,
      branch_deleted: branchDeleted,
      warnings,
    };
  }

  private headMoved(actual: string): PrFailure {
    return {
      ok: false,
      code: "head_moved",
      reason: "head_moved",
      message: `the pull request head ${actual.slice(0, 12)} differs from the verified commit; review the new changes before merging`,
    };
  }

  /** GitHub 上の PR が TaskDO の記録と一致し、開いているかを確かめる。問題があれば失敗を返す。 */
  private pullProblem(
    pull: UserPull,
    target: PrTarget,
    opts: { allowMerged?: boolean } = {},
  ): PrFailure | null {
    const same = (a: string | null) =>
      a !== null && a.toLowerCase() === target.repository.toLowerCase();
    if (
      pull.number !== target.number ||
      pull.headRef !== target.branch ||
      !same(pull.headRepo) ||
      !same(pull.baseRepo)
    ) {
      return {
        ok: false,
        code: "conflict",
        reason: "pr_mismatch",
        message: "the pull request no longer matches this task's branch",
      };
    }
    if (pull.merged && opts.allowMerged) return null;
    if (pull.merged || pull.state !== "open") {
      return {
        ok: false,
        code: "conflict",
        reason: "pr_closed",
        message: pull.merged ? "the pull request is already merged" : "the pull request is closed",
      };
    }
    return null;
  }

  private toPrFailure(e: unknown): PrFailure {
    const f = this.toFailure(e);
    return { ok: false, code: f.code, message: f.message, reason: f.code };
  }

  private notMember(): AuthzFailure {
    return { ok: false, code: "forbidden", message: "not an active member of the required team" };
  }

  /** キャッシュは、確認したユーザー本人の問い合わせにだけ使う（別の id は必ず確認し直す）。 */
  private cachedMembership(githubUserId: number): "active" | "denied" | null {
    const row = this.ctx.storage.sql
      .exec<{ checked_at: number; result: string; github_user_id: number | null }>(
        "SELECT checked_at, result, github_user_id FROM membership_cache WHERE singleton = 1",
      )
      .toArray()[0];
    if (!row || row.github_user_id !== githubUserId) return null;
    const age = this.now() - row.checked_at;
    if (age < 0 || age >= MEMBERSHIP_CACHE_TTL_MS) return null;
    return row.result === "active" ? "active" : "denied";
  }

  private async checkMembership(
    githubUserId: number,
    epoch: number,
  ): Promise<MemberResult | typeof STALE> {
    const { client, credentials } = this.github();
    // 設定は毎回読み直す。不正・不足なら例外（toFailure で internal。fail closed）
    const rules = loadAllowRules(this.env);
    if (!rules) throw new Error("allow rules are not configured");
    const state = await credentials.withToken(async (tok) => {
      // login は改名されうるので、毎回 GET /user で現在の値を得る。資格が別人のものなら拒否する。
      const user = await client.getUser(tok);
      if (user.id !== githubUserId) return "mismatch" as const;
      // user ID のルールは、その場で取得した user.id で判定する（通れば team の確認は不要）
      if (isUserIdAllowed(rules, user.id)) return "active" as const;
      // ID で通らず、org/team の対が設定されているときだけ team を確認する。無ければ拒否
      if (!rules.team) return "none" as const;
      return client.getTeamMembership(tok, {
        org: rules.team.org,
        teamSlug: rules.team.team,
        username: user.login,
      });
    });
    // 確認中に再ログインされていたら、結果はキャッシュにも呼び出し元にも使わない
    if (epoch !== this.loginEpoch) return STALE;
    if (state === "mismatch") return this.notMember();
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO membership_cache (singleton, checked_at, result, github_user_id) VALUES (1, ?, ?, ?)",
      this.now(),
      state === "active" ? "active" : "denied",
      githubUserId,
    );
    return state === "active" ? { ok: true } : this.notMember();
  }
}
