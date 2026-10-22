/** 画面の振り分け。`/dashboard/tasks/<ULID>` だけ詳細で、それ以外（不正な ID を含む）は一覧。 */

export type Route = { kind: "overview" } | { kind: "task"; id: string };

const TASK_PATH = /^\/dashboard\/tasks\/([0-9A-HJKMNP-TV-Z]{26})\/?$/;

/**
 * 一覧で表示する日: クエリ `?day=YYYY-MM-DD`（ローカルの暦日）。無い・不正・存在しない日付は null（= 今日）。
 * 今日・未来かどうかの判断は day.ts（resolveDay）。
 */
export function parseDay(search: string): string | null {
  const raw = new URLSearchParams(search).get("day");
  const m = raw === null ? null : /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(y, mo - 1, d);
  const real = date.getFullYear() === y && date.getMonth() === mo - 1 && date.getDate() === d;
  return real ? (raw as string) : null;
}

export function parseRoute(pathname: string): Route {
  const m = TASK_PATH.exec(pathname);
  return m?.[1] ? { kind: "task", id: m[1] } : { kind: "overview" };
}

/** タスクを選んだ一覧の URL のパス（レール・タイムラインの行の href と、画面の中で切り替えるときの pushState の行き先） */
export function taskPath(id: string): string {
  return `/dashboard/tasks/${id}`;
}
