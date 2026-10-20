/**
 * DO の SQLite に、列が無ければ足す（スキーマの追加移行用）。冪等。
 * TaskDO と UserDO が同じ処理を使う。
 */
export function addColumnIfMissing(
  sql: SqlStorage,
  table: string,
  column: string,
  definition: string,
): void {
  const has = sql
    .exec<{ name: string }>(`PRAGMA table_info(${table})`)
    .toArray()
    .some((c) => c.name === column);
  if (!has) sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
