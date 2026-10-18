import { DurableObject } from "cloudflare:workers";
import { isTerminal } from "./state";
import type { TaskDO } from "./task-do";
import { ulid } from "./ulid";

/** requests の保存期間。 */
export const REQUEST_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** 未作成の予約を回収し始めるまでの運用値。安全性は TaskDO の tombstone が保証する。 */
export const RESERVATION_RECLAIM_AFTER_MS = 10 * 60 * 1000;
/** 照合中に予約が入れ替わったときの再判定の上限。 */
const MAX_RECONCILE_ATTEMPTS = 5;

export type ReserveResult =
  | { ok: true; task_id: string; reused: boolean }
  | { ok: false; code: "conflict" | "concurrency_limit" };

type ReservationRow = { active_task_id: string | null; reserved_at: number; version: number };
type RequestRow = { task_id: string; fingerprint: string };

type TaskInspector = Pick<DurableObjectStub<TaskDO>, "inspect" | "abandonIfUncreated">;

/**
 * ユーザーごとの状態。この段階（M2）では同時実行の予約と冪等キー(requests)だけを持つ。
 * membership_cache / github_credential は GitHub 連携（M3）で追加する。
 *
 * DO 間の呼び出しは UserDO → TaskDO（照合のみ）に限る。
 */
export class UserDO extends DurableObject<Env> {
  /** 現在時刻(ms)。テストで差し替える。 */
  now: () => number = () => Date.now();

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
    sql.exec(`CREATE TABLE IF NOT EXISTS reservation (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      active_task_id TEXT,
      reserved_at INTEGER NOT NULL,
      version INTEGER NOT NULL
    )`);
    sql.exec(
      "INSERT OR IGNORE INTO reservation (singleton, active_task_id, reserved_at, version) VALUES (1, NULL, 0, 0)",
    );
  }

  /** 照合先の TaskDO。テストで差し替える。 */
  protected taskStub(taskId: string): TaskInspector {
    return this.env.TASK_DO.getByName(taskId);
  }

  private reservationRow(): ReservationRow {
    return this.ctx.storage.sql
      .exec<ReservationRow>("SELECT active_task_id, reserved_at, version FROM reservation")
      .one();
  }

  /** 予約を空にする。version が expected と一致するときだけ。同期区間内で呼ぶこと。 */
  private clearIfUnchanged(taskId: string, version: number): boolean {
    const cur = this.reservationRow();
    if (cur.active_task_id !== taskId || cur.version !== version) return false;
    this.ctx.storage.sql.exec(
      "UPDATE reservation SET active_task_id = NULL, version = version + 1 WHERE singleton = 1",
    );
    return true;
  }

  /**
   * 新規 / 再試行 / conflict / concurrency_limit を判定して task_id を返す。
   * 予約が埋まっていれば TaskDO に照合し、終端または回収可能なら解放して再判定する。
   * 照合（await）はトランザクションの外で行い、反映時に task_id と version を再検証する。
   */
  async reserve(requestKey: string, fingerprint: string): Promise<ReserveResult> {
    for (let attempt = 0; attempt < MAX_RECONCILE_ATTEMPTS; attempt++) {
      // 同期区間: 判定と記録を await なしで一度に行う（割り込まれない）。
      const step = this.ctx.storage.transactionSync(() => this.decide(requestKey, fingerprint));
      if (step.kind === "done") return step.result;

      // 予約が埋まっている。TaskDO に照合する（ここで他の呼び出しが割り込みうる）。
      const { taskId, version, reservedAt } = step;
      if (await this.shouldRelease(taskId, reservedAt)) {
        // 反映時に task_id と version が変わっていなければ解放する。変わっていたら何もせず再判定。
        this.ctx.storage.transactionSync(() => this.clearIfUnchanged(taskId, version));
        continue;
      }
      // 解放できない。予約が同じまま（task_id も version も不変）なら本当に埋まっている。
      // 照合中に入れ替わっていたら、新しい予約を照合し直す。
      const cur = this.reservationRow();
      if (cur.active_task_id === taskId && cur.version === version) {
        return { ok: false, code: "concurrency_limit" };
      }
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
  ):
    | { kind: "done"; result: ReserveResult }
    | { kind: "occupied"; taskId: string; version: number; reservedAt: number } {
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

    const res = this.reservationRow();
    if (res.active_task_id !== null) {
      return {
        kind: "occupied",
        taskId: res.active_task_id,
        version: res.version,
        reservedAt: res.reserved_at,
      };
    }

    const taskId = ulid(at);
    sql.exec(
      "INSERT INTO requests (request_key, task_id, fingerprint, created_at) VALUES (?, ?, ?, ?)",
      requestKey,
      taskId,
      fingerprint,
      at,
    );
    sql.exec(
      "UPDATE reservation SET active_task_id = ?, reserved_at = ?, version = version + 1 WHERE singleton = 1",
      taskId,
      at,
    );
    return { kind: "done", result: { ok: true, task_id: taskId, reused: false } };
  }

  /** TaskDO に照合して、予約を解放してよいか判定する。 */
  private async shouldRelease(taskId: string, reservedAt: number): Promise<boolean> {
    const task = this.taskStub(taskId);
    const inspection = await task.inspect();
    switch (inspection.kind) {
      case "abandoned":
        return true;
      case "created":
        return isTerminal(inspection.status);
      case "uncreated": {
        if (this.now() - reservedAt < RESERVATION_RECLAIM_AFTER_MS) return false;
        // 回収は tombstone を打てたときだけ。作成済みが返れば解放しない。
        const r = await task.abandonIfUncreated();
        if (r.result === "abandoned") return true;
        return isTerminal(r.status);
      }
    }
  }

  /** 予約先が同じ task_id のときだけ解放する（compare-and-clear）。冪等。 */
  async release(taskId: string): Promise<{ released: boolean }> {
    const released = this.ctx.storage.transactionSync(() => {
      const cur = this.reservationRow();
      if (cur.active_task_id !== taskId) return false;
      return this.clearIfUnchanged(taskId, cur.version);
    });
    return { released };
  }
}
