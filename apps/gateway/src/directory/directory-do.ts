import { DurableObject } from "cloudflare:workers";
import {
  type ConsultIndexRow,
  type ConsultIndexSnapshot,
  ConsultIndexSnapshotSchema,
  type ListConsultsQuery,
  type ListConsultsResult,
  type ListOwnTasksQuery,
  type ListOwnTasksResult,
  type ListTasksQuery,
  type ListTasksResult,
  type ListWaitingQuery,
  type ListWaitingResult,
  MAX_CONSULT_LIMIT,
  MAX_LIST_LIMIT,
  MAX_REPO_IDS,
  type SummarizeConsultsResult,
  type SummarizeQuery,
  type SummarizeResult,
  type TaskIndexRow,
  type TaskIndexSnapshot,
  TaskIndexSnapshotSchema,
  type UpsertConsultResult,
  type UpsertTaskResult,
  type VisibleModelsResult,
} from "./types";

type ConsultDbRow = Omit<ConsultIndexRow, "estimated"> & { estimated: number };

/** TaskIndexRow の列（task_index の列と同じ名前。pr_draft / pr_merged は 0/1 で持つ） */
type DbRow = Omit<TaskIndexSnapshot, "pr_draft" | "pr_merged" | "reached_verifying"> & {
  pr_draft: number | null;
  pr_merged: number;
  reached_verifying: number | null;
  revision: number;
};

const COLUMNS = [
  "task_id",
  "owner_id",
  "owner_login",
  "repository",
  "repository_id",
  "title",
  "status",
  "model",
  "effort",
  "created_at",
  "updated_at",
  "started_at",
  "ended_at",
  "cost_micro",
  "input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
  "pr_number",
  "pr_url",
  "pr_draft",
  "pr_merged",
  "reason",
  "failure_phase",
  "deps_cache",
  "sandbox_runtime_ms",
  "kind",
  "review_stage",
  "reached_verifying",
  "verify_attempt",
  "target_pr_number",
  "target_pr_url",
] as const;

/** 後から足した列（既存の索引には ALTER TABLE で足す。値の無い行は NULL） */
const ADDED_COLUMNS = [
  ["kind", "TEXT"],
  ["review_stage", "TEXT"],
  ["reached_verifying", "INTEGER"],
  ["verify_attempt", "INTEGER"],
  ["target_pr_number", "INTEGER"],
  ["target_pr_url", "TEXT"],
] as const;

/**
 * ダッシュボードの索引（シングルトン。docs/specs/dashboard.md D10）。
 * TaskDO が outbox で送ってくる snapshot を task_index に持ち、一覧・集計・タイムラインの読み取りに答える。
 *
 * - 書き込みは revision 方式: タスクごとに単調増加の revision を持ち、保存済み以下の revision は無視する
 *   （順序の入れ替わり・重複・再送で索引が逆戻りしない。冪等）。
 * - **索引は権限の根拠にしない**。ここは repoIds で絞るだけで、閲覧者の権限の判定はしない。
 *   repository_id が NULL の行は、どの repoIds にも一致しない（fail closed）。
 * - 保持: 削除しない。SQLite の DO は 1 つあたり 10 GB まで（Cloudflare Docs「SQLite in Durable Objects GA」2025-04-07）。
 *   1 件 1 KB 未満の見積もりで約 1,000 万件、1 日 1,000 件でも 27 年分。掃除は後回し（docs/specs/dashboard.md の未決事項）。
 * - 読み取り専用の管理操作は作らない。壊れても次の更新（新しい revision）で追いつく。
 */
export class DirectoryDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.migrate();
  }

  private migrate(): void {
    const sql = this.ctx.storage.sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS task_index (
      task_id TEXT PRIMARY KEY,
      owner_id INTEGER NOT NULL,
      owner_login TEXT NOT NULL,
      repository TEXT NOT NULL,
      repository_id INTEGER,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      model TEXT NOT NULL,
      effort TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      started_at INTEGER,
      ended_at INTEGER,
      cost_micro INTEGER NOT NULL,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      cache_read_tokens INTEGER NOT NULL,
      cache_write_tokens INTEGER NOT NULL,
      pr_number INTEGER,
      pr_url TEXT,
      pr_draft INTEGER,
      pr_merged INTEGER NOT NULL,
      reason TEXT,
      failure_phase TEXT,
      deps_cache TEXT,
      sandbox_runtime_ms INTEGER,
      revision INTEGER NOT NULL
    )`);
    const have = new Set(
      sql
        .exec<{ name: string }>("SELECT name FROM pragma_table_info('task_index')")
        .toArray()
        .map((c) => c.name),
    );
    for (const [name, type] of ADDED_COLUMNS) {
      if (!have.has(name)) sql.exec(`ALTER TABLE task_index ADD COLUMN ${name} ${type}`);
    }
    sql.exec(
      "CREATE INDEX IF NOT EXISTS task_index_created ON task_index (created_at DESC, task_id)",
    );
    sql.exec("CREATE INDEX IF NOT EXISTS task_index_repo ON task_index (repository_id)");
    // 「待ち」の一覧（状態で絞って新しい順）
    sql.exec(
      "CREATE INDEX IF NOT EXISTS task_index_status ON task_index (status, created_at DESC, task_id)",
    );
    // consult の索引（D9）。リポジトリが無いので権限の列は無い。本文は持たない
    sql.exec(`CREATE TABLE IF NOT EXISTS consult_index (
      consult_id TEXT PRIMARY KEY,
      owner_id INTEGER NOT NULL,
      owner_login TEXT NOT NULL,
      at INTEGER NOT NULL,
      model TEXT NOT NULL,
      cost_micro INTEGER NOT NULL,
      estimated INTEGER NOT NULL,
      revision INTEGER NOT NULL
    )`);
    sql.exec("CREATE INDEX IF NOT EXISTS consult_index_at ON consult_index (at DESC, consult_id)");
  }

  /**
   * 1 件の consult を保存する（UserDO の outbox から）。revision が保存済みより大きいときだけ反映する（冪等）。
   */
  upsertConsult(snapshot: ConsultIndexSnapshot, revision: number): UpsertConsultResult {
    const parsed = ConsultIndexSnapshotSchema.safeParse(snapshot);
    if (!parsed.success || !Number.isSafeInteger(revision) || revision < 1) {
      return { ok: false, code: "invalid_input" };
    }
    const s = parsed.data;
    return this.ctx.storage.transactionSync((): UpsertConsultResult => {
      const sql = this.ctx.storage.sql;
      const stored = sql
        .exec<{ revision: number }>(
          "SELECT revision FROM consult_index WHERE consult_id = ?",
          s.consult_id,
        )
        .toArray()[0];
      if (stored && stored.revision >= revision) {
        return { ok: true, applied: false, revision: stored.revision };
      }
      sql.exec(
        `INSERT OR REPLACE INTO consult_index
           (consult_id, owner_id, owner_login, at, model, cost_micro, estimated, revision)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        s.consult_id,
        s.owner_id,
        s.owner_login,
        s.at,
        s.model,
        s.cost_micro,
        s.estimated ? 1 : 0,
        revision,
      );
      return { ok: true, applied: true, revision };
    });
  }

  /** タイムラインの灰の点。at が [from, to) の consult を新しい順に。全員分（ownerId で自分に絞れる） */
  listConsults(query: ListConsultsQuery): ListConsultsResult {
    if (
      !Number.isSafeInteger(query?.from) ||
      !Number.isSafeInteger(query.to) ||
      !Number.isSafeInteger(query.limit) ||
      query.limit < 1 ||
      (query.ownerId !== undefined && !Number.isSafeInteger(query.ownerId))
    ) {
      return { ok: false, code: "invalid_input" };
    }
    const owner = query.ownerId ?? null;
    const rows = this.ctx.storage.sql
      .exec<ConsultDbRow>(
        `SELECT * FROM consult_index WHERE at >= ? AND at < ? AND (? IS NULL OR owner_id = ?)
         ORDER BY at DESC, consult_id DESC LIMIT ?`,
        query.from,
        query.to,
        owner,
        owner,
        Math.min(query.limit, MAX_CONSULT_LIMIT),
      )
      .toArray()
      .map((r) => ({ ...r, estimated: r.estimated === 1 }));
    return { ok: true, rows };
  }

  /** 月などの consult の集計（at が [from, to)）。全員分の合計と、モデル別の費用 */
  summarizeConsults(query: { from: number; to: number }): SummarizeConsultsResult {
    if (!Number.isSafeInteger(query?.from) || !Number.isSafeInteger(query.to)) {
      return { ok: false, code: "invalid_input" };
    }
    const sql = this.ctx.storage.sql;
    const total = sql
      .exec<{ n: number; c: number; e: number }>(
        `SELECT COUNT(*) AS n, COALESCE(SUM(cost_micro), 0) AS c,
                COALESCE(SUM(CASE WHEN estimated = 1 THEN cost_micro ELSE 0 END), 0) AS e
         FROM consult_index WHERE at >= ? AND at < ?`,
        query.from,
        query.to,
      )
      .one();
    const models = sql
      .exec<{ model: string; c: number }>(
        `SELECT model, SUM(cost_micro) AS c FROM consult_index
         WHERE at >= ? AND at < ? GROUP BY model ORDER BY model`,
        query.from,
        query.to,
      )
      .toArray()
      .map((m) => ({ model: m.model, cost_micro: m.c }));
    return {
      ok: true,
      count: total.n,
      cost_micro: total.c,
      estimated_micro: total.e,
      models,
    };
  }

  /** テスト専用: 1 件の consult の行（revision つき）。ENVIRONMENT=test のときだけ。 */
  testGetConsult(consultId: string): ConsultIndexRow | null {
    if (this.env.ENVIRONMENT !== "test") throw new Error("test only");
    const row = this.ctx.storage.sql
      .exec<ConsultDbRow>("SELECT * FROM consult_index WHERE consult_id = ?", consultId)
      .toArray()[0];
    return row ? { ...row, estimated: row.estimated === 1 } : null;
  }

  /**
   * 1 タスクの snapshot を保存する。revision が保存済みより大きいときだけ反映する（applied: true）。
   * 以下・同じ revision は何もしない（applied: false。戻りの revision は保存済みの値）。
   */
  upsertTask(snapshot: TaskIndexSnapshot, revision: number): UpsertTaskResult {
    const parsed = TaskIndexSnapshotSchema.safeParse(snapshot);
    if (!parsed.success || !Number.isSafeInteger(revision) || revision < 1) {
      return { ok: false, code: "invalid_input" };
    }
    const s = parsed.data;
    return this.ctx.storage.transactionSync((): UpsertTaskResult => {
      const sql = this.ctx.storage.sql;
      const stored = sql
        .exec<{ revision: number }>("SELECT revision FROM task_index WHERE task_id = ?", s.task_id)
        .toArray()[0];
      if (stored && stored.revision >= revision) {
        return { ok: true, applied: false, revision: stored.revision };
      }
      const values = [
        s.task_id,
        s.owner_id,
        s.owner_login,
        s.repository,
        s.repository_id,
        s.title,
        s.status,
        s.model,
        s.effort,
        s.created_at,
        s.updated_at,
        s.started_at,
        s.ended_at,
        s.cost_micro,
        s.input_tokens,
        s.output_tokens,
        s.cache_read_tokens,
        s.cache_write_tokens,
        s.pr_number,
        s.pr_url,
        s.pr_draft === null ? null : s.pr_draft ? 1 : 0,
        s.pr_merged ? 1 : 0,
        s.reason,
        s.failure_phase,
        s.deps_cache,
        s.sandbox_runtime_ms,
        s.kind ?? null,
        s.review_stage ?? null,
        s.reached_verifying === undefined ? null : s.reached_verifying ? 1 : 0,
        s.verify_attempt ?? null,
        s.target_pr_number ?? null,
        s.target_pr_url ?? null,
      ];
      sql.exec(
        `INSERT OR REPLACE INTO task_index (${COLUMNS.join(", ")}, revision)
         VALUES (${[...COLUMNS, "revision"].map(() => "?").join(", ")})`,
        ...values,
        revision,
      );
      return { ok: true, applied: true, revision };
    });
  }

  /**
   * 閲覧者に見える（repoIds に repository_id がある）タスクの一覧。絞ってから数え、ページを切る。
   * 範囲は「期間と重なるタスク」: created_at < to かつ（ended_at が無い、または ended_at >= from）。
   * 新しい順（created_at DESC, task_id）。
   */
  listTasks(query: ListTasksQuery): ListTasksResult {
    const bad = this.checkIds(query?.repoIds);
    if (bad) return bad;
    if (
      !Number.isSafeInteger(query.from) ||
      !Number.isSafeInteger(query.to) ||
      !Number.isSafeInteger(query.limit) ||
      query.limit < 1 ||
      !Number.isSafeInteger(query.offset) ||
      query.offset < 0 ||
      (query.ownerId !== undefined && !Number.isSafeInteger(query.ownerId))
    ) {
      return { ok: false, code: "invalid_input" };
    }
    const limit = Math.min(query.limit, MAX_LIST_LIMIT);
    const owner = query.ownerId ?? null;
    const sql = this.ctx.storage.sql;
    // 条件は 1 か所に置き、COUNT と SELECT で同じものを使う（件数と中身が食い違わない）
    const where = `repository_id IN (SELECT value FROM json_each(?))
      AND created_at < ? AND (ended_at IS NULL OR ended_at >= ?)
      AND (? IS NULL OR owner_id = ?)`;
    const args = [JSON.stringify(query.repoIds), query.to, query.from, owner, owner];
    const total = sql
      .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM task_index WHERE ${where}`, ...args)
      .one().n;
    const rows = sql
      .exec<DbRow>(
        `SELECT * FROM task_index WHERE ${where} ORDER BY created_at DESC, task_id LIMIT ? OFFSET ?`,
        ...args,
        limit,
        query.offset,
      )
      .toArray()
      .map(toRow);
    return { ok: true, total, rows };
  }

  /**
   * ある所有者のタスク（task_list）。リポジトリでは絞らない（所有者本人の一覧で、task_status と同じ「自分のタスクだけ」）。
   * 終端でない（ended_at が無い）タスクと、scope が recent なら endedSince 以降に終端になったタスクを、新しい順に最大 limit 件。
   * 1 件多く読んで、続きがあるか（truncated）を返す。
   */
  listOwnTasks(query: ListOwnTasksQuery): ListOwnTasksResult {
    if (
      !Number.isSafeInteger(query?.ownerId) ||
      !Number.isSafeInteger(query.endedSince) ||
      !Number.isSafeInteger(query.limit) ||
      query.limit < 1 ||
      (query.scope !== "active" && query.scope !== "recent")
    ) {
      return { ok: false, code: "invalid_input" };
    }
    const limit = Math.min(query.limit, MAX_LIST_LIMIT);
    const since = query.scope === "recent" ? query.endedSince : null;
    const rows = this.ctx.storage.sql
      .exec<DbRow>(
        `SELECT * FROM task_index WHERE owner_id = ?
           AND (ended_at IS NULL OR (? IS NOT NULL AND ended_at >= ?))
         ORDER BY created_at DESC, task_id LIMIT ?`,
        query.ownerId,
        since,
        since,
        limit + 1,
      )
      .toArray()
      .map(toRow);
    return { ok: true, rows: rows.slice(0, limit), truncated: rows.length > limit };
  }

  /**
   * 「待ち」のタスク（期間を切らない）: INPUT_REQUIRED、または COMPLETED で PR があり Draft でなく rovo の記録で未マージ。
   * 見える分（repoIds）は新しい順にページを切って返し、権限の無い分（repository_id が NULL を含む）は件数だけ返す。
   */
  listWaiting(query: ListWaitingQuery): ListWaitingResult {
    const bad = this.checkIds(query?.repoIds);
    if (bad) return bad;
    if (
      !Number.isSafeInteger(query.limit) ||
      query.limit < 1 ||
      !Number.isSafeInteger(query.offset) ||
      query.offset < 0 ||
      (query.ownerId !== undefined && !Number.isSafeInteger(query.ownerId))
    ) {
      return { ok: false, code: "invalid_input" };
    }
    const limit = Math.min(query.limit, MAX_LIST_LIMIT);
    const owner = query.ownerId ?? null;
    const sql = this.ctx.storage.sql;
    const waiting = `(status = 'INPUT_REQUIRED' OR (status = 'COMPLETED' AND pr_number IS NOT NULL
      AND pr_url IS NOT NULL AND pr_draft = 0 AND pr_merged = 0))
      AND (? IS NULL OR owner_id = ?)`;
    const visible = "repository_id IN (SELECT value FROM json_each(?))";
    const ids = JSON.stringify(query.repoIds);
    const total = sql
      .exec<{ n: number }>(
        `SELECT COUNT(*) AS n FROM task_index WHERE ${waiting} AND ${visible}`,
        owner,
        owner,
        ids,
      )
      .one().n;
    // NULL の repository_id は IN に一致しない（NOT IN は NULL で不定になるので、IS NULL を別に数える）
    const hidden = sql
      .exec<{ n: number }>(
        `SELECT COUNT(*) AS n FROM task_index WHERE ${waiting}
         AND (repository_id IS NULL OR repository_id NOT IN (SELECT value FROM json_each(?)))`,
        owner,
        owner,
        ids,
      )
      .one().n;
    const rows = sql
      .exec<DbRow>(
        `SELECT * FROM task_index WHERE ${waiting} AND ${visible}
         ORDER BY created_at DESC, task_id LIMIT ? OFFSET ?`,
        owner,
        owner,
        ids,
        limit,
        query.offset,
      )
      .toArray()
      .map(toRow);
    return { ok: true, total, hidden, rows };
  }

  /**
   * 月などの集計（created_at が [from, to)）。見える分と、権限の無い分（NULL を含む）の件数・費用を分ける。
   * 権限の無い分は件数と合計だけを返し、個別の値は返さない。モデル別の費用は全員分。
   */
  summarize(query: SummarizeQuery): SummarizeResult {
    const bad = this.checkIds(query?.repoIds);
    if (bad) return bad;
    if (!Number.isSafeInteger(query.from) || !Number.isSafeInteger(query.to)) {
      return { ok: false, code: "invalid_input" };
    }
    const sql = this.ctx.storage.sql;
    const visible = sql
      .exec<{ n: number; c: number }>(
        `SELECT COUNT(*) AS n, COALESCE(SUM(cost_micro), 0) AS c FROM task_index
         WHERE created_at >= ? AND created_at < ? AND repository_id IN (SELECT value FROM json_each(?))`,
        query.from,
        query.to,
        JSON.stringify(query.repoIds),
      )
      .one();
    const all = sql
      .exec<{ n: number; c: number }>(
        "SELECT COUNT(*) AS n, COALESCE(SUM(cost_micro), 0) AS c FROM task_index WHERE created_at >= ? AND created_at < ?",
        query.from,
        query.to,
      )
      .one();
    const models = sql
      .exec<{ model: string; c: number }>(
        `SELECT model, SUM(cost_micro) AS c FROM task_index
         WHERE created_at >= ? AND created_at < ? GROUP BY model ORDER BY model`,
        query.from,
        query.to,
      )
      .toArray()
      .map((m) => ({ model: m.model, cost_micro: m.c }));
    return {
      ok: true,
      visible: { count: visible.n, cost_micro: visible.c },
      hidden: { count: all.n - visible.n, cost_micro: all.c - visible.c },
      models,
    };
  }

  /**
   * 見える（repoIds に repository_id がある）タスクが使ったモデルの名前の一覧（created_at が [from, to)）。
   * モデル別の費用の表で、見えないタスクだけが使うモデルの名前を出さないために使う（M5b）。名前だけで、費用は返さない。
   */
  visibleModels(query: SummarizeQuery): VisibleModelsResult {
    const bad = this.checkIds(query?.repoIds);
    if (bad) return bad;
    if (!Number.isSafeInteger(query.from) || !Number.isSafeInteger(query.to)) {
      return { ok: false, code: "invalid_input" };
    }
    const models = this.ctx.storage.sql
      .exec<{ model: string }>(
        `SELECT DISTINCT model FROM task_index
         WHERE created_at >= ? AND created_at < ? AND repository_id IN (SELECT value FROM json_each(?))
         ORDER BY model`,
        query.from,
        query.to,
        JSON.stringify(query.repoIds),
      )
      .toArray()
      .map((m) => m.model);
    return { ok: true, models };
  }

  /** テスト専用: 1 タスクの行（revision つき）。ENVIRONMENT=test のときだけ。 */
  testGetTask(taskId: string): TaskIndexRow | null {
    if (this.env.ENVIRONMENT !== "test") throw new Error("test only");
    const row = this.ctx.storage.sql
      .exec<DbRow>("SELECT * FROM task_index WHERE task_id = ?", taskId)
      .toArray()[0];
    return row ? toRow(row) : null;
  }

  private checkIds(
    ids: unknown,
  ): { ok: false; code: "invalid_input" | "too_many_repo_ids" } | null {
    if (!Array.isArray(ids) || !ids.every((x) => Number.isSafeInteger(x))) {
      return { ok: false, code: "invalid_input" };
    }
    if (ids.length > MAX_REPO_IDS) return { ok: false, code: "too_many_repo_ids" };
    return null;
  }
}

function toRow(r: DbRow): TaskIndexRow {
  const { reached_verifying, ...rest } = r;
  const row: TaskIndexRow = {
    ...rest,
    pr_draft: r.pr_draft === null ? null : r.pr_draft === 1,
    pr_merged: r.pr_merged === 1,
    failure_phase: r.failure_phase === "setup" ? "setup" : null,
  };
  // task_list 用の列は、値の無い行（古い snapshot）では項目ごと省く
  if (reached_verifying !== null) row.reached_verifying = reached_verifying === 1;
  for (const k of [
    "kind",
    "review_stage",
    "verify_attempt",
    "target_pr_number",
    "target_pr_url",
  ] as const) {
    if (row[k] === null) delete row[k];
  }
  return row;
}
