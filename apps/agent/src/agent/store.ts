import type { AgentEventDto, Phase, UsageDto } from "./types";
import { isTerminal } from "./types";

/** received: 受け取った / submitted: Pi へ渡している最中 / buffered: 次の submit に添えるため保留 / accepted: Pi に渡し終えた */
export type SteerState = "received" | "submitted" | "buffered" | "accepted";
export interface SteerRow {
  steerId: string;
  message: string;
  state: SteerState;
}

export const ZERO_USAGE: UsageDto = {
  costUsd: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

const PATCH_CHUNK = 128 * 1024;

/**
 * AgentDO 自身の永続状態（メタ情報・イベント・patch）。
 * phase の変化とイベントは同じトランザクションで書く。Pi のテーブル（pi_ 接頭辞）とは別。
 */
export class AgentStore {
  constructor(
    private readonly ctx: DurableObjectState,
    private readonly now: () => number,
  ) {
    const sql = ctx.storage.sql;
    sql.exec("CREATE TABLE IF NOT EXISTS agent_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    sql.exec(
      "CREATE TABLE IF NOT EXISTS agent_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL)",
    );
    sql.exec(
      "CREATE TABLE IF NOT EXISTS agent_steers (seq INTEGER PRIMARY KEY AUTOINCREMENT, steer_id TEXT NOT NULL UNIQUE, message TEXT NOT NULL, state TEXT NOT NULL, announced INTEGER NOT NULL DEFAULT 0)",
    );
    sql.exec(
      "CREATE TABLE IF NOT EXISTS agent_patch (idx INTEGER PRIMARY KEY, chunk TEXT NOT NULL)",
    );
  }

  tx<T>(fn: () => T): T {
    return this.ctx.storage.transactionSync(fn);
  }

  meta<T>(key: string): T | undefined {
    const row = this.ctx.storage.sql
      .exec<{ value: string }>("SELECT value FROM agent_meta WHERE key = ?", key)
      .toArray()[0];
    return row === undefined ? undefined : (JSON.parse(row.value) as T);
  }

  setMeta(key: string, value: unknown): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO agent_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      key,
      JSON.stringify(value),
    );
  }

  appendEvent(type: string, data: unknown): number {
    const cursor = this.ctx.storage.sql.exec<{ seq: number }>(
      "INSERT INTO agent_events (ts, type, data) VALUES (?, ?, ?) RETURNING seq",
      this.now(),
      type,
      JSON.stringify(data),
    );
    return cursor.one().seq;
  }

  phase(): Phase | undefined {
    return this.meta<Phase>("phase");
  }

  phaseAsOfSeq(): number {
    return this.meta<number>("phase_seq") ?? 0;
  }

  /** phase を変えてイベントを積む。同じ phase への遷移と、終端からの遷移は何もしない。 */
  setPhase(next: Phase, reason?: string): boolean {
    return this.tx(() => {
      const cur = this.phase();
      if (cur === next || isTerminal(cur)) return false;
      const seq = this.appendEvent(
        "phase",
        reason === undefined ? { phase: next } : { phase: next, reason },
      );
      this.setMeta("phase", next);
      this.setMeta("phase_seq", seq);
      return true;
    });
  }

  events(afterSeq: number, limit: number): { events: AgentEventDto[]; hasMore: boolean } {
    const rows = this.ctx.storage.sql
      .exec<{ seq: number; ts: number; type: string; data: string }>(
        "SELECT seq, ts, type, data FROM agent_events WHERE seq > ? ORDER BY seq LIMIT ?",
        afterSeq,
        limit + 1,
      )
      .toArray();
    return { events: rows.slice(0, limit), hasMore: rows.length > limit };
  }

  /** 最後のイベントの seq（無ければ 0） */
  lastSeq(): number {
    const row = this.ctx.storage.sql
      .exec<{ seq: number | null }>("SELECT MAX(seq) AS seq FROM agent_events")
      .one();
    return row.seq ?? 0;
  }

  usage(): UsageDto {
    return this.meta<UsageDto>("usage") ?? ZERO_USAGE;
  }

  steer(steerId: string): SteerRow | undefined {
    const row = this.ctx.storage.sql
      .exec<{ steer_id: string; message: string; state: SteerState }>(
        "SELECT steer_id, message, state FROM agent_steers WHERE steer_id = ?",
        steerId,
      )
      .toArray()[0];
    return row && { steerId: row.steer_id, message: row.message, state: row.state };
  }

  insertSteer(steerId: string, message: string, state: SteerState): void {
    this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO agent_steers (steer_id, message, state) VALUES (?, ?, ?)",
      steerId,
      message,
      state,
    );
  }

  setSteerState(steerId: string, state: SteerState): void {
    this.ctx.storage.sql.exec(
      "UPDATE agent_steers SET state = ? WHERE steer_id = ?",
      state,
      steerId,
    );
  }

  /** steer_accepted を出したことを記録する。初めて記録したときだけ true（二重に出さないため） */
  markAnnounced(steerId: string): boolean {
    const cursor = this.ctx.storage.sql.exec(
      "UPDATE agent_steers SET announced = 1 WHERE steer_id = ? AND announced = 0",
      steerId,
    );
    return cursor.rowsWritten > 0;
  }

  /** 受け取った順の保留中の steer */
  steersIn(state: SteerState): SteerRow[] {
    return this.ctx.storage.sql
      .exec<{ steer_id: string; message: string; state: SteerState }>(
        "SELECT steer_id, message, state FROM agent_steers WHERE state = ? ORDER BY seq",
        state,
      )
      .toArray()
      .map((r) => ({ steerId: r.steer_id, message: r.message, state: r.state }));
  }

  savePatch(patch: string): void {
    const sql = this.ctx.storage.sql;
    sql.exec("DELETE FROM agent_patch");
    for (let i = 0, idx = 0; i < patch.length; i += PATCH_CHUNK, idx++) {
      sql.exec(
        "INSERT INTO agent_patch (idx, chunk) VALUES (?, ?)",
        idx,
        patch.slice(i, i + PATCH_CHUNK),
      );
    }
  }

  loadPatch(): string {
    return this.ctx.storage.sql
      .exec<{ chunk: string }>("SELECT chunk FROM agent_patch ORDER BY idx")
      .toArray()
      .map((r) => r.chunk)
      .join("");
  }
}
