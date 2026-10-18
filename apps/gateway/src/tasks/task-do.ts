import { DurableObject } from "cloudflare:workers";
import { canTransition, isTaskStatus, isTerminal, type TaskStatus } from "./state";
import { isTaskId } from "./ulid";
import {
  computeFingerprint,
  MAX_CONCURRENT_WAITERS,
  MAX_EVENTS_PER_WAIT,
  parseCursor,
  parseTimeoutSeconds,
  type TaskInput,
  taskInputSchema,
  WAIT_RETRY_AFTER_SECONDS,
} from "./validation";

/** TaskDO.ensureCreated の入力。TaskInput に、タスク ID と所有者・GitHub 側の ID を足したもの。 */
export type EnsureCreatedInput = TaskInput & {
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
  | { kind: "created"; status: TaskStatus };

export type AbandonResult = { result: "abandoned" } | { result: "created"; status: TaskStatus };

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
 * このクラスは UserDO を呼ばない（DO 間の呼び出しが循環しないようにする）。
 */
export class TaskDO extends DurableObject<Env> {
  /** wait 中の呼び出し。イベント追加時に全員を起こし、各自が自分の cursor で再読する。 */
  private waiters = new Set<Waiter>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.migrate();
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

  /** seq を採番してイベントを挿入する。 */
  private appendEvent(type: string, payload: EventPayload, at: number): number {
    const seq = this.latestSeq() + 1;
    this.ctx.storage.sql.exec(
      "INSERT INTO events (seq, type, payload, created_at) VALUES (?, ?, ?, ?)",
      seq,
      type,
      JSON.stringify(payload),
      at,
    );
    return seq;
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
           constraints, fingerprint, status, draft_pr_url, created_at, updated_at)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'CREATING', NULL, ?, ?)`,
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
        fingerprint,
        at,
        at,
      );
      this.appendEvent("created", { status: "CREATING" }, at);
      const row = this.getRow();
      if (!row) throw new Error("task row missing after insert");
      return { ok: true, created: true, task: this.view(row) };
    });
    if (result.ok && result.created) this.notifyWaiters();
    return result;
  }

  /** 未作成なら取り消せない tombstone を記録する。作成済みなら何もしない。 */
  async abandonIfUncreated(): Promise<AbandonResult> {
    return this.ctx.storage.transactionSync((): AbandonResult => {
      const row = this.getRow();
      if (row) return { result: "created", status: this.statusOf(row) };
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
    if (row) return { kind: "created", status: this.statusOf(row) };
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
      return { ok: true, status: "CANCELLED", changed: true };
    });
    if (result.ok && result.changed) this.notifyWaiters();
    return result;
  }

  /**
   * bounded long polling。seq > cursor のイベントを最大 100 件返す。
   * blockConcurrencyWhile では包まない（待機中も cancel などを受け付けるため）。
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
    if (c.value > this.latestSeq()) return { ok: false, code: "invalid_cursor" };

    let events = this.readEvents(c.value);
    const done = () => events.length > 0 || isTerminal(this.currentStatus());
    if (done() || t.value === 0) return this.waitResult(c.value, events);

    if (this.waiters.size >= MAX_CONCURRENT_WAITERS) {
      return this.waitResult(c.value, [], WAIT_RETRY_AFTER_SECONDS);
    }

    // 待機者を登録してから再読する（登録前に追加されたイベントを取りこぼさない）。
    const waiter: Waiter = { wake: () => {} };
    const woken = new Promise<void>((resolve) => {
      waiter.wake = resolve;
    });
    waiter.timer = setTimeout(waiter.wake, t.value * 1000);
    this.waiters.add(waiter);
    try {
      events = this.readEvents(c.value);
      if (!done()) await woken;
      events = this.readEvents(c.value);
    } finally {
      clearTimeout(waiter.timer);
      this.waiters.delete(waiter);
    }
    return this.waitResult(c.value, events);
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
