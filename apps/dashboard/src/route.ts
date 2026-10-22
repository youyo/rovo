/** 画面の振り分け。`/dashboard/tasks/<ULID>` だけ詳細で、それ以外（不正な ID を含む）は一覧。 */

export type Route = { kind: "overview" } | { kind: "task"; id: string };

const TASK_PATH = /^\/dashboard\/tasks\/([0-9A-HJKMNP-TV-Z]{26})\/?$/;

export function parseRoute(pathname: string): Route {
  const m = TASK_PATH.exec(pathname);
  return m?.[1] ? { kind: "task", id: m[1] } : { kind: "overview" };
}
