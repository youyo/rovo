import { DurableObject } from "cloudflare:workers";
import {
  type ListTasksQuery,
  type ListTasksResult,
  MAX_LIST_LIMIT,
  MAX_REPO_IDS,
  type SummarizeQuery,
  type SummarizeResult,
  type TaskIndexRow,
  type TaskIndexSnapshot,
  TaskIndexSnapshotSchema,
  type UpsertTaskResult,
} from "./types";

/** TaskIndexRow の列（task_index の列と同じ名前。pr_draft / pr_merged は 0/1 で持つ） */
type DbRow = Omit<TaskIndexSnapshot, "pr_draft" | "pr_merged"> & {
  pr_draft: number | null;
  pr_merged: number;
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
    sql.exec(
      "CREATE INDEX IF NOT EXISTS task_index_created ON task_index (created_at DESC, task_id)",
    );
    sql.exec("CREATE INDEX IF NOT EXISTS task_index_repo ON task_index (repository_id)");
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
  return {
    ...r,
    pr_draft: r.pr_draft === null ? null : r.pr_draft === 1,
    pr_merged: r.pr_merged === 1,
    failure_phase: r.failure_phase === "setup" ? "setup" : null,
  };
}
