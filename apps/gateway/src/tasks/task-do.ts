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
import { canTransition, isTaskStatus, isTerminal, type TaskStatus } from "./state";
import { isTaskId } from "./ulid";
import { TASK_BUDGET_USD, type UserDO } from "./user-do";
import {
  computeFingerprint,
  MAX_CONCURRENT_WAITERS,
  MAX_EVENTS_PER_WAIT,
  parseCursor,
  parseTimeoutSeconds,
  taskInputSchema,
  WAIT_RETRY_AFTER_SECONDS,
} from "./validation";

/** 子エージェントに許す実行時間（開始から）。AgentDO も同じ上限で丸める。 */
export const AGENT_DEADLINE_MS = 2 * 60 * 60 * 1000;
/** alarm の間隔。start / cancel の再送、取り込み、精算の再試行に使う。 */
export const ALARM_INTERVAL_MS = 10_000;
/** task_wait が待機中に AgentDO から取り込み直す間隔。 */
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const EVENT_PAGE_LIMIT = 100;
/** task_wait が入口の取り込みを最低限待つ時間。timeout 0 や終端のタスクでも、速い応答は拾う。 */
const SYNC_GRACE_MS = 500;
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

  /** 子エージェントの RPC。テストで差し替える。 */
  protected agentStub(): AgentRpc {
    const taskId = this.getRow()?.id;
    if (!taskId) throw new Error("task row missing");
    return this.env.AGENT_DO.getByName(taskId) as unknown as AgentRpc;
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

  private getLink(): LinkRow | undefined {
    return this.ctx.storage.sql.exec<LinkRow>("SELECT * FROM agent_link").toArray()[0];
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
    if (isTerminal(to)) {
      this.ctx.storage.sql.exec(
        "UPDATE agent_link SET cancel_state = 'pending' WHERE cancel_state = 'none'",
      );
    }
    return true;
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
      const spec: TaskSpec = {
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
      return { ok: true, status: "CANCELLED", changed: true };
    });
    if (result.ok && result.changed) {
      this.notifyWaiters();
      await this.ensureAlarm();
    }
    return result;
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

  /** 利用者に結果を返せる状態か（終端 + AgentDO の停止確認済み）を確かめて、結果を整形して返す。 */
  async result(ownerId: number): Promise<ResultOutcome> {
    const row = this.getRow();
    if (!row || row.owner_id !== ownerId) return { ok: false, code: "not_found" };
    const status = this.statusOf(row);
    if (!isTerminal(status) || !this.isStopped()) return { ok: false, code: "not_ready" };
    let dto: ResultDto;
    try {
      dto = await this.agentStub().getResult();
    } catch (e) {
      console.error("task_do_result_error", e instanceof Error ? e.name : typeof e);
      return { ok: false, code: "upstream_unavailable" };
    }
    return {
      ok: true,
      result:
        dto.status === "not_ready" ? this.synthesizeResult(row, status) : shapeResult(status, dto),
    };
  }

  /** AgentDO に結果が無い（start より先に cancel した、start が rejected など）終端タスクの結果。 */
  private synthesizeResult(row: TaskRow, status: TaskStatus): ResultView {
    const link = this.getLink();
    const spec = link ? (JSON.parse(link.spec) as TaskSpec) : undefined;
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

  private async guard(step: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (e) {
      // メッセージにタスクの内容が入りうるので、エラー名だけを記録する。次の alarm で再試行される。
      console.error("task_do_step_error", step, e instanceof Error ? e.name : typeof e);
    }
  }

  private async pump(): Promise<void> {
    const first = this.getLink();
    if (!first) return;
    await this.guard("start", () => this.deliverStart());
    await this.guard("cancel", () => this.deliverCancel());
    await this.guard("sync", () => this.syncFromAgent());
    // エージェント側の終端をこの回で取り込んだときは、その場で停止確認（cancel）まで進める。
    // （cancel を送ったのに未停止だったものは、次の alarm で再送する。1 回の advance で繰り返さない）
    if (first.cancel_state === "none" && this.getLink()?.cancel_state === "pending") {
      await this.guard("cancel", () => this.deliverCancel());
      await this.guard("sync", () => this.syncFromAgent());
    }
  }

  private async deliverStart(): Promise<void> {
    const link = this.getLink();
    if (link?.start_state !== "pending") return;
    if (isTerminal(this.currentStatus())) {
      // 終端のタスクの start は送らない（cancel の tombstone が遅れて届く start を拒否する）。
      this.ctx.storage.sql.exec(
        "UPDATE agent_link SET start_state = 'skipped' WHERE start_state = 'pending'",
      );
      return;
    }
    const result = await this.agentStub().start(JSON.parse(link.spec) as TaskSpec);
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

  private needsAlarm(): boolean {
    const link = this.getLink();
    const row = this.getRow();
    if (!link || !row) return false;
    if (link.start_state === "pending" || link.cancel_state === "pending") return true;
    if (!isTerminal(this.statusOf(row))) return link.start_state === "accepted";
    return link.usage_seq > link.settled_seq || link.finished === 0;
  }

  /** 次の alarm を明示的に設定し直す。仕事が無ければ消す。 */
  private async syncAlarm(): Promise<void> {
    if (this.needsAlarm()) await this.ctx.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
    else await this.ctx.storage.deleteAlarm();
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
      ...(v.commitSha !== undefined ? { commit_sha: v.commitSha } : {}),
    },
    warnings: dto.warnings,
    ...(dto.patch !== undefined ? { patch: dto.patch } : {}),
    ...(dto.diffstat !== undefined ? { diffstat: dto.diffstat } : {}),
    patch_too_large: dto.patchTooLarge,
    usage: shapeUsage(dto.usage),
  };
}
