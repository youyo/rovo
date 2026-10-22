import type { TaskDetailDto, TaskEventsPageDto } from "@rovo/dashboard-contract";

/** 詳細・events の読み取り API の呼び出し（同一オリジン・Cookie）。契約は型だけ取り込む。 */

export type DetailResult =
  | { kind: "ok"; data: TaskDetailDto }
  | { kind: "unauthorized" }
  | { kind: "not_found" }
  | { kind: "error" };

export type EventsResult =
  | { kind: "ok"; data: TaskEventsPageDto }
  | { kind: "unauthorized" }
  | { kind: "not_found" }
  | { kind: "error" };

/** cursor: これより新しいものを古い順に。before: これより古いもの（末尾から 1 ページ）。どちらも 1 以上の整数だけ。 */
export type EventsQuery = { cursor?: number; before?: number };

const base = (id: string) => `/dashboard/api/tasks/${encodeURIComponent(id)}`;
const isSeq = (n: unknown): n is number =>
  typeof n === "number" && Number.isSafeInteger(n) && n >= 1;

export function eventsUrl(id: string, q: EventsQuery): string {
  const url = `${base(id)}/events`;
  if (isSeq(q.cursor)) return `${url}?cursor=${q.cursor}`;
  if (isSeq(q.before)) return `${url}?before=${q.before}`;
  return url;
}

const obj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/** 応答の形の最低限の確認（契約の検証は gateway が出力時に行う）。壊れた応答で画面を落とさない。 */
function looksLikeDetail(b: unknown): b is TaskDetailDto {
  return (
    obj(b) &&
    typeof b.generated_at === "string" &&
    obj(b.task) &&
    typeof b.task.task_id === "string" &&
    typeof b.task.title === "string" &&
    typeof b.task.status === "string" &&
    obj(b.task.cost) &&
    typeof b.phase === "string" &&
    obj(b.settings) &&
    obj(b.output)
  );
}

function looksLikeEvents(b: unknown): b is TaskEventsPageDto {
  return (
    obj(b) &&
    Array.isArray(b.events) &&
    b.events.every((e) => obj(e) && isSeq(e.seq) && typeof e.type === "string") &&
    typeof b.has_older === "boolean"
  );
}

async function get<T>(
  url: string,
  check: (b: unknown) => b is T,
  fetchImpl: typeof fetch,
): Promise<{ kind: "ok"; data: T } | { kind: "unauthorized" | "not_found" | "error" }> {
  try {
    const res = await fetchImpl(url, {
      credentials: "same-origin",
      headers: { accept: "application/json" },
    });
    if (res.status === 401) return { kind: "unauthorized" };
    if (res.status === 404) return { kind: "not_found" };
    if (res.status !== 200) return { kind: "error" };
    const body: unknown = await res.json();
    return check(body) ? { kind: "ok", data: body } : { kind: "error" };
  } catch {
    return { kind: "error" };
  }
}

/** fresh: true は、開いた最初の取得だけに付ける（サーバーが GitHub で権限を取り直す。D6）。ポーリングには付けない。 */
export function fetchTaskDetail(
  id: string,
  fetchImpl: typeof fetch = fetch,
  opts: { fresh?: boolean } = {},
): Promise<DetailResult> {
  return get(opts.fresh ? `${base(id)}?fresh=1` : base(id), looksLikeDetail, fetchImpl);
}

export function fetchTaskEvents(
  id: string,
  q: EventsQuery,
  fetchImpl: typeof fetch = fetch,
): Promise<EventsResult> {
  return get(eventsUrl(id, q), looksLikeEvents, fetchImpl);
}
