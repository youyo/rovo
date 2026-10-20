import { DurableObject } from "cloudflare:workers";
import { isUserIdAllowed, loadAllowRules } from "../auth/allowlist";
import {
  CredentialManager,
  type CredentialState,
  type CredentialStorage,
  GitHubClient,
  GitHubError,
  type GitHubErrorCode,
  resolveGitHubBaseUrls,
  type StoredCredential,
  type TokenSet,
  type UserPull,
} from "../github";
import { consultBudgetUsd, taskBudgetUsd } from "./budget";
import type { TaskDO } from "./task-do";
import { isConsultId, ulid, ulidTime } from "./ulid";

/** requests の保存期間。 */
export const REQUEST_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** 未作成の予約を回収し始めるまでの運用値。安全性は TaskDO の tombstone が保証する。 */
export const RESERVATION_RECLAIM_AFTER_MS = 10 * 60 * 1000;
/** team 所属の再検証結果をキャッシュする時間。team から外れてから使えなくなるまでの遅れの上限。 */
export const MEMBERSHIP_CACHE_TTL_MS = 5 * 60 * 1000;
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

/** 精算されないまま残った consult の予約を、予約額で閉じるまでの時間。 */
export const CONSULT_STALE_AFTER_MS = 30 * 60 * 1000;

export type ConsultReserveResult =
  | { ok: true; reserved_usd: number }
  | { ok: false; code: "budget_exceeded" | "invalid_input" };

/** budget_status の応答（D10）。金額は USD。 */
export type BudgetStatus = {
  monthly_budget_usd: number;
  spent_usd: number;
  reserved_usd: number;
  remaining_usd: number;
  task_budget_usd: number;
  consult_budget_usd: number;
  /** 月の残りから、タスクの予約額で何件分を予約できるか（同時実行の枠は別で、ユーザーごとに 1 件まで） */
  max_concurrent_tasks: number;
  /** 今月（UTC）。end は翌月の頭（含まない） */
  period: { start: string; end: string };
};

export type SettleResult = { ok: true; applied: boolean } | { ok: false };
export type FinishResult = { ok: true; released: boolean };

/** 開始時刻の月（UTC, "YYYY-MM"）。月またぎのタスクは開始した月に計上する。 */
function monthOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 7);
}

type ReservationRow = { active_task_id: string | null; reserved_at: number; version: number };
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
export type StartAuthzResult =
  | { ok: true; repositoryId: number; installationId: number }
  | AuthzFailure;

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
    // 親（MCP の web_search / web_fetch / web_browse）の回数。UTC の日付ごと・種別ごと。
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
    const hasUserIdColumn = sql
      .exec<{ name: string }>("PRAGMA table_info(membership_cache)")
      .toArray()
      .some((c) => c.name === "github_user_id");
    if (!hasUserIdColumn) {
      sql.exec("ALTER TABLE membership_cache ADD COLUMN github_user_id INTEGER");
    }
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
    sql.exec(
      "INSERT OR IGNORE INTO reservation (singleton, active_task_id, reserved_at, version) VALUES (1, NULL, 0, 0)",
    );
  }

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
    // 枠を手放したタスクは、予約額をもう数えない（実費だけが残る）。
    this.ctx.storage.sql.exec("UPDATE task_budget SET closed = 1 WHERE task_id = ?", taskId);
    return true;
  }

  /** 月の枠のうち、使用済み（実費）と予約中の残り（マイクロドル）。committedMicro = spent + reserved。 */
  private spentAndReservedMicro(month: string): { spent: number; reserved: number } {
    return this.ctx.storage.sql
      .exec<{ spent: number; reserved: number }>(
        `SELECT COALESCE(SUM(settled_micro), 0) AS spent,
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
    sql.exec(
      "UPDATE reservation SET active_task_id = ?, reserved_at = ?, version = version + 1 WHERE singleton = 1",
      taskId,
      at,
    );
    return { kind: "done", result: { ok: true, task_id: taskId, reused: false } };
  }

  /**
   * TaskDO に照合して、予約を解放してよいか判定する。
   * 回収できるのは「一度も作られなかった」予約だけ（abandoned、または未作成で tombstone を打てたもの）。
   * Phase 1 のタスク（agent_link が無い CREATING。子エージェントも精算も無い）も同じ扱いで回収する。
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
      const cur = this.reservationRow();
      if (cur.active_task_id !== taskId) return false;
      return this.clearIfUnchanged(taskId, cur.version);
    });
    return { ok: true, released };
  }

  /**
   * 自分の予算の状況（budget_status）。金額は USD（マイクロドルを 6 桁に丸める）。
   * spent は精算済みの実費、reserved は実行中のタスク・consult の予約の残り。remaining は月の上限から両方を引く（負にしない）。
   */
  budgetStatus(): BudgetStatus {
    const at = this.now();
    const month = monthOf(at);
    const { spent, reserved } = this.spentAndReservedMicro(month);
    const limit = Math.round(this.monthlyLimitUsd() * MICRO);
    const remaining = Math.max(0, limit - spent - reserved);
    const taskMicro = Math.round(taskBudgetUsd(this.env) * MICRO);
    const d = new Date(at);
    const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
    const end = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
    return {
      monthly_budget_usd: limit / MICRO,
      spent_usd: spent / MICRO,
      reserved_usd: reserved / MICRO,
      remaining_usd: remaining / MICRO,
      task_budget_usd: taskMicro / MICRO,
      consult_budget_usd: consultBudgetUsd(this.env),
      max_concurrent_tasks: taskMicro > 0 ? Math.floor(remaining / taskMicro) : 0,
      period: { start: new Date(start).toISOString(), end: new Date(end).toISOString() },
    };
  }

  /**
   * consult の予約。同時実行の枠は使わず、月の枠から CONSULT_BUDGET_USD を予約する（task_budget に consult の行を足す）。
   * 足りなければ budget_exceeded。同じ consultId の再送は冪等。
   * 精算されないまま CONSULT_STALE_AFTER_MS を過ぎた consult の予約は、予約額で閉じる（実費が分からないので、
   * 予約より少なく数えない側に倒す）。
   */
  reserveConsult(consultId: string): ConsultReserveResult {
    if (!isConsultId(consultId)) return { ok: false, code: "invalid_input" };
    const reservedUsd = consultBudgetUsd(this.env);
    return this.ctx.storage.transactionSync((): ConsultReserveResult => {
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
      return { ok: true, reserved_usd: reservedMicro / MICRO };
    });
  }

  /** 同期区間内で呼ぶ。古い consult の予約を、予約額（以上）で閉じる。 */
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
        "UPDATE task_budget SET settled_micro = MAX(settled_micro, reserved_micro), closed = 1 WHERE task_id = ?",
        task_id,
      );
    }
  }

  /**
   * consult の精算: 実費（USD）を書いて閉じる。予約の余りは月の枠に戻る。1 回だけ（閉じた後の再送は applied:false）。
   * costUsd が null のとき（実費が分からない）は予約額で閉じる。壊れた値（負・NaN）は何もしない。
   * 実費が予約を超えて報告されたときは、そのまま実費を記録する（AgentDO が max_output_tokens で予約内に収める）。
   */
  settleConsult(consultId: string, costUsd: number | null): SettleResult {
    if (!isConsultId(consultId)) return { ok: false };
    if (costUsd !== null && (!Number.isFinite(costUsd) || costUsd < 0)) {
      const known = this.ctx.storage.sql
        .exec("SELECT 1 FROM task_budget WHERE task_id = ?", consultId)
        .toArray();
      return known.length > 0 ? { ok: true, applied: false } : { ok: false };
    }
    return this.ctx.storage.transactionSync((): SettleResult => {
      const sql = this.ctx.storage.sql;
      const row = sql
        .exec<{ reserved_micro: number; closed: number }>(
          "SELECT reserved_micro, closed FROM task_budget WHERE task_id = ?",
          consultId,
        )
        .toArray()[0];
      if (!row) return { ok: false };
      if (row.closed === 1) return { ok: true, applied: false };
      const micro = costUsd === null ? row.reserved_micro : Math.round(costUsd * MICRO);
      sql.exec(
        "UPDATE task_budget SET settled_micro = ?, closed = 1 WHERE task_id = ?",
        micro,
        consultId,
      );
      return { ok: true, applied: true };
    });
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
   * PR をマージする。Ready であること・head が検証済みの sha であることを確かめ、sha 付きで GitHub に渡す
   * （確かめた後にブランチが動けば GitHub が 409 で拒否する）。ブランチ保護に拒否されたら merge_blocked。
   */
  async prMerge(target: PrTarget, opts: PrMergeOptions): Promise<PrMergeResult> {
    const { client, credentials } = this.github();
    let outcome: { already: boolean; sha: string | null };
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
