import type { ChecksDto, TaskDetailDto, TaskEventsPageDto } from "@rovo/dashboard-contract";
import { isAllowedCheckUrl } from "./format";

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

export type ChecksResult =
  | { kind: "ok"; data: ChecksDto }
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

const CHECKS_STATES: ReadonlySet<string> = new Set([
  "none",
  "passing",
  "failing",
  "pending",
  "unreadable",
]);
const CHECK_STATUSES: ReadonlySet<string> = new Set(["queued", "in_progress", "completed"]);
const orNull = (v: unknown): boolean => v === null || typeof v === "string";

function looksLikeChecks(b: unknown): b is ChecksDto {
  return (
    obj(b) &&
    (b.head_sha === null || typeof b.head_sha === "string") &&
    typeof b.state === "string" &&
    CHECKS_STATES.has(b.state) &&
    typeof b.truncated === "boolean" &&
    typeof b.partial === "boolean" &&
    Array.isArray(b.checks) &&
    b.checks.every(
      (c) =>
        obj(c) &&
        typeof c.name === "string" &&
        (c.kind === "check_run" || c.kind === "status") &&
        typeof c.status === "string" &&
        CHECK_STATUSES.has(c.status) &&
        orNull(c.conclusion) &&
        orNull(c.started_at) &&
        orNull(c.completed_at) &&
        orNull(c.url),
    )
  );
}

async function get<T>(
  url: string,
  check: (b: unknown) => b is T,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<{ kind: "ok"; data: T } | { kind: "unauthorized" | "not_found" | "error" }> {
  try {
    const res = await fetchImpl(url, {
      credentials: "same-origin",
      headers: { accept: "application/json" },
      ...(signal ? { signal } : {}),
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

/**
 * fresh: true は、URL を直接開いたときの最初の取得だけに付ける（サーバーが GitHub で権限を取り直す。D6）。
 * 画面の中での切り替えとポーリングには付けない。signal は、選択が移ったときに前の取得を止めるため。
 */
export function fetchTaskDetail(
  id: string,
  fetchImpl: typeof fetch = fetch,
  opts: { fresh?: boolean; signal?: AbortSignal } = {},
): Promise<DetailResult> {
  return get(
    opts.fresh ? `${base(id)}?fresh=1` : base(id),
    looksLikeDetail,
    fetchImpl,
    opts.signal,
  );
}

export function fetchTaskEvents(
  id: string,
  q: EventsQuery,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<EventsResult> {
  return get(eventsUrl(id, q), looksLikeEvents, fetchImpl, signal);
}

/**
 * PR の CI。リンクは https://github.com/ で始まるものだけ残す（gateway も落としているが、外部が書ける値なので画面でも確かめる）。
 * 壊れた応答は error（画面を落とさない）。
 */
export async function fetchTaskChecks(
  id: string,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<ChecksResult> {
  const r = await get(`${base(id)}/checks`, looksLikeChecks, fetchImpl, signal);
  if (r.kind !== "ok") return r;
  return {
    kind: "ok",
    data: {
      ...r.data,
      checks: r.data.checks.map((c) => ({ ...c, url: isAllowedCheckUrl(c.url) ? c.url : null })),
    },
  };
}
