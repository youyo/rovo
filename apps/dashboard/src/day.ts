import { localDayRange } from "./api";
import { parseDay, type Route } from "./route";

/**
 * 一覧で見る日の計算（ブラウザのローカルの暦日）。day は "YYYY-MM-DD"（過去の日）か null（今日）。
 * null の今日は日付が変わると新しい今日に追従する。過去の日はその日のまま。
 */

export type DayKey = string | null;

const pad = (n: number) => String(n).padStart(2, "0");

function keyOf(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function startOf(key: string): Date {
  const [y, m, d] = key.split("-").map(Number) as [number, number, number];
  return new Date(y, m - 1, d);
}

/** URL の day を表示する日にする。今日・未来・不正は null（今日）。 */
export function resolveDay(search: string, nowMs: number): DayKey {
  const day = parseDay(search);
  return day !== null && day < keyOf(new Date(nowMs)) ? day : null;
}

/**
 * URL（ページの読み込み・popstate）が指す日。一覧は ?day=（無い・今日以降は今日 = null）。
 * タスクの URL は、?day= があればその日（画面の中で選んだときに、見ていた日を残した URL）、無ければ未確定（undefined）。
 * 未確定は、そのタスクが始まった日（dayOfTask）を詳細の取得から決める。
 */
export function routeDay(route: Route, search: string, nowMs: number): DayKey | undefined {
  if (route.kind === "overview") return resolveDay(search, nowMs);
  return parseDay(search) === null ? undefined : resolveDay(search, nowMs);
}

/** 前後に送る。今日より先へは行けない（null のまま）。今日に届いたら null。 */
export function shiftDay(day: DayKey, delta: -1 | 1, nowMs: number): DayKey {
  const base = day === null ? startOf(keyOf(new Date(nowMs))) : startOf(day);
  base.setDate(base.getDate() + delta);
  const key = keyOf(base);
  return key < keyOf(new Date(nowMs)) ? key : null;
}

/**
 * タスクが始まったローカルの日（started_at、無ければ created_at）。今日・未来・壊れた日時は null（今日）。
 * `/dashboard/tasks/<ULID>` を開いたとき、一覧で表示する日を決めるのに使う。
 */
export function dayOfTask(
  task: { created_at: string; started_at: string | null },
  nowMs: number,
): DayKey {
  const ms = Date.parse(task.started_at ?? task.created_at);
  if (Number.isNaN(ms)) return null;
  const key = keyOf(new Date(ms));
  return key < keyOf(new Date(nowMs)) ? key : null;
}

/** 取得する範囲。過去の日はローカル 0 時〜翌日 0 時、今日は 0 時〜いま（D18）。 */
export function dayRange(day: DayKey, nowMs: number): { from: number; to: number } {
  if (day === null) return localDayRange(nowMs);
  const from = startOf(day);
  const to = new Date(from.getFullYear(), from.getMonth(), from.getDate() + 1);
  return { from: from.getTime(), to: to.getTime() };
}

export function dayHref(pathname: string, day: DayKey): string {
  return day === null ? pathname : `${pathname}?day=${day}`;
}
