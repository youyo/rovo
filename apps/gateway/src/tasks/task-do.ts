import { DurableObject } from "cloudflare:workers";
import type { z } from "zod";
import { mapAgentEvent } from "../agent/agent-events";
import type {
  AgentRpc,
  EventsPage,
  ResultDto,
  StartResult,
  TaskSpec,
  UsageDto,
} from "../agent/contract";
import {
  applyManagedBlock,
  decryptString,
  encryptString,
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
import { testDraftFallback, withTestScripts } from "../test-routes";
import { canTransition, isTaskStatus, isTerminal, type TaskStatus } from "./state";
import { isTaskId, ulid } from "./ulid";
import { TASK_BUDGET_USD, type UserDO } from "./user-do";
import {
  computeFingerprint,
  isValidIdempotencyKey,
  MAX_ANSWER_LENGTH,
  MAX_CONCURRENT_WAITERS,
  MAX_EVENTS_PER_WAIT,
  MAX_STEER_LENGTH,
  parseCursor,
  parseTimeoutSeconds,
  taskInputSchema,
  WAIT_RETRY_AFTER_SECONDS,
} from "./validation";

/** 子エージェントに許す実行時間（開始から）。AgentDO も同じ上限で丸める。 */
export const AGENT_DEADLINE_MS = 2 * 60 * 60 * 1000;
/** alarm の間隔。start / cancel の再送、取り込み、精算の再試行に使う。 */
export const ALARM_INTERVAL_MS = 10_000;
/** INPUT_REQUIRED の間で、配送すべきものが無いときの alarm の間隔（AgentDO の期限の監視と、トークンの更新の確認だけ）。 */
export const INPUT_REQUIRED_ALARM_INTERVAL_MS = 60_000;
/** 回答待ちの上限（AgentDO が数える。7.3）と、TaskDO がバックストップとして待つ猶予。 */
export const INPUT_TIMEOUT_MS = 24 * 60 * 60 * 1000;
export const INPUT_TIMEOUT_GRACE_MS = 10 * 60 * 1000;
const INPUT_REQUIRED_SINCE_KEY = "input_required_at";
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
const BOT_IDENTITY = { name: "rovo", email: "rovo@users.noreply.github.com" };
/** 1 回の取り込みで読むページ数の上限（残りは次の alarm / wait で取り込む）。 */
const MAX_PAGES_PER_SYNC = 20;

/** TaskDO.ensureCreated の入力。task_start の入力に、タスク ID と所有者・GitHub 側の ID を足したもの。 */
export type EnsureCreatedInput = z.input<typeof taskInputSchema> & {
  task_id: string;
  owner_id: number;
  owner_login: string;
  /** M3 以降で渡される。GitHub の repository ID / Installation ID。 */
  repository_id?: number | null;
  installation_id?: number | null;
};

export type TaskView = {
  task_id: string;
  owner_id: number;
  status: TaskStatus;
  repository: string;
  title: string;
  draft_pr_url: string | null;
  created_at: string;
  updated_at: string;
  /** 最後のイベントの seq（不透明な cursor 文字列）。 */
  latest_cursor: string;
  /** 子の未回答の質問（終端でないとき）。message は子が作った非信頼データ */
  pending_question: { question_id: string; message: string; options: string[] } | null;
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
  | { ok: false; code: "conflict" | "expired" | "invalid_input" };

/** UserDO が予約を照合するための最小の問い合わせ結果。 */
export type TaskInspection =
  | { kind: "uncreated" }
  | { kind: "abandoned" }
  | { kind: "created"; status: TaskStatus; stopped: boolean }
  /**
   * Phase 1 で作られたタスク（agent_link が無い）。子エージェントは存在せず、精算するものも無い。
   * UserDO は abandoned と同じ扱いで予約を回収してよい。
   */
  | { kind: "legacy" };

export type AbandonResult =
  | { result: "abandoned" }
  | { result: "created"; status: TaskStatus; stopped: boolean };

/** task_result の中身（公開用。snake_case）。 */
export type ResultView = {
  status: TaskStatus;
  reason?: string;
  summary: string;
  verification: {
    commands: { argv: string[]; cwd?: string; timeout_seconds?: number }[];
    results: { argv: string[]; exit_code: number; timed_out: boolean; output: string }[];
    verified: boolean;
    attempts: number;
    commit_sha?: string;
  };
  warnings: string[];
  /** Draft PR の情報。PR が無い（作成前に失敗した、Phase 2 のタスク）なら null */
  pr: {
    number: number;
    url: string;
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
  };
};

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
};

export type GetStatusResult = { ok: true; task: TaskView } | { ok: false; code: "not_found" };

export type CancelResult =
  | { ok: true; status: TaskStatus; changed: boolean }
  | { ok: false; code: "not_found" };

export type AnswerResult =
  | { ok: true; status: TaskStatus }
  | { ok: false; code: "not_found" | "conflict" | "invalid_input" };

export type SteerResult =
  | { ok: true; status: TaskStatus; steer_id: string }
  | { ok: false; code: "not_found" | "conflict" | "invalid_input" };

/** steer を受け付ける状態（4.6）。 */
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

type EventRow = { seq: number; type: string; payload: string; created_at: number };

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

  /** 子エージェントの RPC。テストで差し替える。 */
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
    this.addColumnIfMissing("task", "verification_commands", "TEXT NOT NULL DEFAULT '[]'");
    this.addColumnIfMissing("events", "operation_id", "TEXT");
    this.addColumnIfMissing("events", "agent_seq", "INTEGER");
    // AgentDO のイベントは (operation_id, agent_seq) で一意。取り込みの重複を DB でも防ぐ。
    sql.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS events_agent_seq ON events (operation_id, agent_seq) WHERE agent_seq IS NOT NULL",
    );
    // 子エージェントとの配送状態（1 行）。start / cancel の意図、取り込みカーソル、精算の進み具合。
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
    this.addColumnIfMissing("agent_link", "final_seq", "INTEGER");
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
    this.addColumnIfMissing("github_link", "revoke_attempts", "INTEGER NOT NULL DEFAULT 0");
    // Phase 4: 子の質問と回答、親からの追加の指示。配送の意図（delivery_state）を永続化し、alarm で再送する。
    sql.exec(`CREATE TABLE IF NOT EXISTS questions (
      question_id TEXT PRIMARY KEY,
      message TEXT NOT NULL,
      options TEXT NOT NULL,
      answer TEXT,
      delivery_state TEXT NOT NULL DEFAULT 'none',
      asked_at INTEGER NOT NULL
    )`);
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
  }

  private addColumnIfMissing(table: string, column: string, definition: string): void {
    const sql = this.ctx.storage.sql;
    const has = sql
      .exec<{ name: string }>(`PRAGMA table_info(${table})`)
      .toArray()
      .some((c) => c.name === column);
    if (!has) sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
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
        "SELECT seq, type, payload, created_at FROM events WHERE seq > ? ORDER BY seq LIMIT ?",
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

  private view(row: TaskRow): TaskView {
    return {
      task_id: row.id,
      owner_id: row.owner_id,
      status: this.statusOf(row),
      repository: row.repository,
      title: row.title,
      draft_pr_url: row.draft_pr_url,
      created_at: new Date(row.created_at).toISOString(),
      updated_at: new Date(row.updated_at).toISOString(),
      latest_cursor: String(this.latestSeq()),
      pending_question: this.pendingQuestion(this.statusOf(row)),
    };
  }

  /** 未回答の質問。終端のタスクには無い。 */
  private pendingQuestion(status: TaskStatus): TaskView["pending_question"] {
    if (isTerminal(status)) return null;
    const q = this.ctx.storage.sql
      .exec<{ question_id: string; message: string; options: string }>(
        "SELECT question_id, message, options FROM questions WHERE answer IS NULL ORDER BY asked_at DESC, rowid DESC LIMIT 1",
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
    return { question_id: q.question_id, message: q.message, options };
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
      this.ctx.storage.sql.exec(
        "UPDATE agent_link SET cancel_state = 'pending' WHERE cancel_state = 'none'",
      );
      this.skipPendingDeliveries();
    }
    return true;
  }

  /** 回答と steer の未配送の意図を取りやめる（終端に入ったトランザクションの中で呼ぶ）。 */
  private skipPendingDeliveries(): void {
    const sql = this.ctx.storage.sql;
    sql.exec("UPDATE questions SET delivery_state = 'skipped' WHERE delivery_state = 'pending'");
    sql.exec("UPDATE steers SET delivery_state = 'skipped' WHERE delivery_state = 'pending'");
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
    // await のあいだに他の呼び出しが進みうるので、状態の判定は await の後の同期区間で行う。
    const fingerprint = await computeFingerprint(data);

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
      this.ctx.storage.sql.exec(
        `INSERT INTO task (singleton, id, owner_id, owner_login, repository, repository_id,
           installation_id, base_ref, base_sha, title, instructions, acceptance_criteria,
           constraints, verification_commands, fingerprint, status, draft_pr_url, created_at, updated_at)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'CREATING', NULL, ?, ?)`,
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
        budgetUsd: TASK_BUDGET_USD,
        deadlineAt: at + AGENT_DEADLINE_MS,
      };
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
    if (!row || row.owner_id !== ownerId) return { ok: false, code: "not_found" };
    return { ok: true, task: this.view(row) };
  }

  /** CANCELLED に確定する。終端状態なら何もせず成功（イベントは追加しない）。 */
  async cancel(ownerId: number): Promise<CancelResult> {
    const result = this.ctx.storage.transactionSync((): CancelResult => {
      const row = this.getRow();
      if (!row || row.owner_id !== ownerId) return { ok: false, code: "not_found" };
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
      this.appendEvent("cancelled", { status: "CANCELLED", from }, at);
      // CANCELLED の確定と同じトランザクションで、AgentDO へ cancel を配送する意図を記録する。
      this.ctx.storage.sql.exec(
        "UPDATE agent_link SET cancel_state = 'pending' WHERE cancel_state = 'none'",
      );
      this.ctx.storage.sql.exec("DELETE FROM meta WHERE key = ?", INPUT_REQUIRED_SINCE_KEY);
      // 未配送の回答と steer は送らない（cancel と同じトランザクションで取りやめる）
      this.skipPendingDeliveries();
      return { ok: true, status: "CANCELLED", changed: true };
    });
    if (result.ok && result.changed) {
      this.notifyWaiters();
      await this.ensureAlarm();
    }
    return result;
  }

  /**
   * 子の質問への回答を受け付ける（task_answer）。
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
    const result = this.ctx.storage.transactionSync((): AnswerResult & { changed?: boolean } => {
      const row = this.getRow();
      if (!row || row.owner_id !== ownerId) return { ok: false, code: "not_found" };
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
        "UPDATE questions SET answer = ?, delivery_state = 'pending' WHERE question_id = ? AND answer IS NULL",
        answer,
        questionId,
      );
      return { ok: true, status, changed: true };
    });
    if (result.ok && result.changed) await this.pullAlarmIn(ALARM_INTERVAL_MS);
    return result.ok ? { ok: true, status: result.status } : result;
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
      if (!row || row.owner_id !== ownerId) return { ok: false, code: "not_found" };
      const status = this.statusOf(row);
      const existing = this.ctx.storage.sql
        .exec<{ message: string }>("SELECT message FROM steers WHERE steer_id = ?", steerId)
        .toArray()[0];
      if (existing) {
        return existing.message === message
          ? { ok: true, status, steer_id: steerId }
          : { ok: false, code: "conflict" };
      }
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
    if (!first || first.owner_id !== ownerId) return { ok: false, code: "not_found" };

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
    // 子エージェントが動いている間は、pollIntervalMs ごとに取り込み直す（alarm の 10 秒を待たせない）。
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

  // ---- 子エージェント（AgentDO）との配送・取り込み・精算 ----

  /**
   * 配送と取り込みを 1 回進める（task_start / task_cancel が呼び、alarm からも呼ばれる）。
   * start / cancel の再送、イベントの取り込み、usage の精算、終了時の返却を、冪等に行う。
   * 失敗は握りつぶして次の alarm に任せる。
   */
  async advance(): Promise<{ status: TaskStatus } | null> {
    try {
      await this.pump();
    } finally {
      await this.syncAlarm();
    }
    const row = this.getRow();
    return row ? { status: this.statusOf(row) } : null;
  }

  /** alarm は at-least-once で発火する。処理は冪等で、次の alarm は advance が明示的に設定し直す。 */
  override async alarm(): Promise<void> {
    await this.advance();
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

  /** 利用者に結果を返せる状態か（終端 + AgentDO の停止確認済み）を確かめて、結果を整形して返す。 */
  async result(ownerId: number): Promise<ResultOutcome> {
    const row = this.getRow();
    if (!row || row.owner_id !== ownerId) return { ok: false, code: "not_found" };
    const status = this.statusOf(row);
    if (!isTerminal(status) || !this.isStopped()) return { ok: false, code: "not_ready" };
    let dto: ResultDto;
    try {
      dto = await this.withTimeout(this.agentStub().getResult(), this.resultTimeoutMs);
    } catch (e) {
      console.error("task_do_result_error", e instanceof Error ? e.name : typeof e);
      return { ok: false, code: "upstream_unavailable" };
    }
    const view =
      dto.status === "not_ready" ? this.synthesizeResult(row, status) : shapeResult(status, dto);
    return { ok: true, result: this.withGithub(view) };
  }

  /** GitHub 側の情報（Draft PR・終端で読んだ head・警告）を結果に足す。 */
  private withGithub(view: ResultView): ResultView {
    const gl = this.getGithub();
    if (!gl) return { ...view, pr: null };
    const extra = (JSON.parse(gl.warnings) as string[]).filter((w) => !view.warnings.includes(w));
    return {
      ...view,
      warnings: [...view.warnings, ...extra],
      pr:
        gl.pr_number !== null && gl.pr_url !== null
          ? {
              number: gl.pr_number,
              url: gl.pr_url,
              head_sha: gl.head_sha,
              head_matches_verified: gl.head_matches === null ? null : gl.head_matches === 1,
            }
          : null,
    };
  }

  /** AgentDO に結果が無い（start より先に cancel した、start が rejected など）終端タスクの結果。 */
  private synthesizeResult(row: TaskRow, status: TaskStatus): ResultView {
    const link = this.getLink();
    const spec = link ? (JSON.parse(link.spec) as BaseSpec) : undefined;
    return {
      status,
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
      this.ctx.storage.sql.exec(
        "UPDATE agent_link SET start_state = 'skipped' WHERE start_state = 'pending'",
      );
      return;
    }
    const base = JSON.parse(link.spec) as BaseSpec;
    // 再送のたびに同じ spec（同じトークン）を送る。AgentDO は spec の同一性で冪等を判定する。
    const spec: TaskSpec = gl
      ? { ...base, ...(await this.githubSpecPart(gl)) }
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
      .exec<{ question_id: string; answer: string }>(
        "SELECT question_id, answer FROM questions WHERE delivery_state = 'pending' AND answer IS NOT NULL ORDER BY asked_at, rowid",
      )
      .toArray();
    for (const q of pending) {
      const r = await this.agentStub().answer(q.question_id, q.answer);
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
    if (this.now() - at > INPUT_TIMEOUT_MS + INPUT_TIMEOUT_GRACE_MS) this.failTask("input_timeout");
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
      for (const e of page.events) {
        if (e.seq <= cursor) continue;
        const m = mapAgentEvent(e);
        // 終端に確定した後は公開イベントを増やさない（利用者の cancel 後など）。usage だけは数え続ける。
        const open = !isTerminal(this.currentStatus());
        if (m.kind === "phase") {
          if (open && m.status !== null) this.applyPhase(m.status, m.reason);
        } else if (m.kind === "usage") {
          if (e.seq > usageSeq) {
            usageSeq = e.seq;
            usageMicro = m.costMicroUsd;
          }
          if (open) this.appendAgentEvent("usage", m.payload, e.ts, link.operation_id, e.seq);
        } else if (m.kind === "question") {
          if (open) this.applyQuestion(m.payload, e.ts, link.operation_id, e.seq);
        } else if (open) {
          this.appendAgentEvent(m.type, m.payload, e.ts, link.operation_id, e.seq);
        }
        cursor = e.seq;
      }
      this.ctx.storage.sql.exec(
        "UPDATE agent_link SET ingest_cursor = ?, usage_seq = ?, usage_micro = ? WHERE singleton = 1",
        cursor,
        usageSeq,
        usageMicro,
      );
      return cursor > link.ingest_cursor;
    });
    if (this.latestSeq() !== before) this.notifyWaiters();
    return progressed;
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
      "INSERT INTO questions (question_id, message, options, delivery_state, asked_at) VALUES (?, ?, ?, 'none', ?)",
      questionId,
      String(payload.message ?? ""),
      String(payload.options ?? "[]"),
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
    const id = this.ctx.storage.sql
      .exec<{ id: number }>(
        "INSERT INTO git_token (enc, expires_at, kind) VALUES (?, ?, ?) RETURNING id",
        enc,
        issued.expiresAt,
        kind,
      )
      .one().id;
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

  /** start の taskSpec に入れる部分（branch・initialSha・最初のトークン）。再送でも同じ値になる。 */
  private async githubSpecPart(
    gl: GithubRow,
  ): Promise<Pick<TaskSpec, "branch" | "initialSha" | "gitCredential">> {
    const start = this.tokenRows("kind = 'start'")[0];
    if (!start || gl.initial_sha === null) throw new Error("github setup is incomplete");
    return {
      branch: gl.branch,
      initialSha: gl.initial_sha,
      gitCredential: { token: await this.decryptToken(start), expiresAt: start.expires_at },
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
      await this.runSetup(row, gl);
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
      const sha = await api.createCommit({
        message: `rovo: start task ${row.id}`,
        treeSha: base.treeSha,
        parents: [base.sha],
        identity: { ...BOT_IDENTITY, date },
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
    if (r.expires_at > this.now()) {
      await this.appClient().revokeInstallationToken(await this.decryptToken(r));
    }
    this.ctx.storage.sql.exec("UPDATE git_token SET revoked = 1 WHERE id = ?", r.id);
  }

  // ---- 終端: PR の更新とトークンの失効 ----

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

    if (gl.pr_number !== null && gl.body_done === 0) {
      try {
        await this.updatePullBody(row, gl, status);
      } catch (e) {
        this.onGithubError(e, "finalize");
        // 本文の更新が済んでいない（再試行待ち）あいだは、失効しない
        if ((this.getGithub() as GithubRow).body_done === 0) return;
      }
    }

    for (const t of this.tokenRows("revoked = 0")) {
      try {
        await this.revokeToken(t);
      } catch (e) {
        if (e instanceof SetupFailure) {
          // App の設定が失われている・暗号文を復号できない。再試行しても直らないので、記録だけ閉じる（期限は 1 時間）。
          this.ctx.storage.sql.exec("UPDATE git_token SET revoked = 1 WHERE id = ?", t.id);
          continue;
        }
        this.onRevokeError(e);
        return;
      }
    }
    this.ctx.storage.sql.exec("UPDATE github_link SET finalize_done = 1");
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
        this.appendEvent("warning", { code: "token_revoke_failed" }, this.now());
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
    const matches =
      pushed === undefined
        ? null
        : pull.headSha === pushed && (verified === undefined || verified === pushed);
    const own = JSON.parse(gl.warnings) as string[];
    if (matches === false) {
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
  }

  private needsAlarm(): boolean {
    const link = this.getLink();
    const row = this.getRow();
    if (!link || !row) return false;
    if (link.start_state === "pending" || link.cancel_state === "pending") return true;
    if (!isTerminal(this.statusOf(row))) return link.start_state === "accepted";
    const gl = this.getGithub();
    return (
      link.usage_seq > link.settled_seq ||
      link.finished === 0 ||
      (gl !== undefined && gl.finalize_done === 0)
    );
  }

  /**
   * 次の alarm までの間隔。INPUT_REQUIRED の間は 60 秒に延ばす（親の回答を待っているだけなので）。
   * 回答や steer の配送が pending、cancel / start の再送、トークンの更新・配送が必要なときは 10 秒。
   */
  private alarmDelay(): number {
    const row = this.getRow();
    const link = this.getLink();
    if (!row || !link) return ALARM_INTERVAL_MS;
    const idle =
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
): ResultView {
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
