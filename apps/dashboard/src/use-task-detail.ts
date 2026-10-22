import type { TaskDetailDto, TaskEventDto } from "@rovo/dashboard-contract";
import { useCallback, useEffect, useRef, useState } from "react";
import { fetchTaskDetail, fetchTaskEvents } from "./detail-api";
import { createPoller, type Poller, type PollerDeps, type PollOutcome } from "./poller";
import { isTerminal } from "./status";
import { mergeEvents } from "./steps";

export type TaskDetailState =
  | { phase: "loading" }
  | {
      phase: "ready";
      detail: TaskDetailDto;
      /** seq の昇順・重複なし */
      events: TaskEventDto[];
      /** これより古いイベントが残っているか（「さらに読む」） */
      hasOlder: boolean;
      /** 直近の更新に失敗した（前のデータを出し続けている） */
      stale: boolean;
      /** 「さらに読む」の取得中 */
      loadingOlder: boolean;
      /** 「さらに読む」に失敗した */
      olderError: boolean;
    }
  | { phase: "error" }
  | { phase: "unauthorized" }
  | { phase: "not_found" };

export type TaskDetailDeps = {
  fetchImpl?: typeof fetch;
  /** 現在時刻（ms）。終端の時刻が分からないときだけ使う */
  now?: () => number;
  pollerDeps?: PollerDeps;
};

/** 終端になってから追い続ける時間（D15） */
export const TERMINAL_CHASE_MS = 30_000;
/** 1 回の更新で続けて取るページ数の上限（200 件ずつ） */
const MAX_CATCH_UP_PAGES = 5;
/** events の 1 ページの上限（契約の EVENTS_PER_PAGE と同じ。契約のランタイムは画面に入れない） */
export const EVENTS_PER_PAGE = 200;

/**
 * タスクの詳細と events を取り、自動更新する（D15）。
 * - 詳細 → events（cursor＝最後の seq の差分）の順に、1 本ずつ取る。最初の events は末尾から。
 * - 「さらに読む」（before）も同じ列に並べて、取得を重ねない。
 * - 終端になってから 30 秒（サーバーの時刻の差で数える）追ったら止まる。401 / 404 でも止まる。
 */
export function useTaskDetail(id: string, autoRefresh: boolean, deps: TaskDetailDeps = {}) {
  const [state, setState] = useState<TaskDetailState>({ phase: "loading" });
  const autoRef = useRef(autoRefresh);
  autoRef.current = autoRefresh;
  const depsRef = useRef(deps);
  depsRef.current = deps;
  const pollerRef = useRef<Poller | null>(null);
  const chainRef = useRef<Promise<unknown>>(Promise.resolve());
  const dataRef = useRef<{
    detail: TaskDetailDto | null;
    events: TaskEventDto[];
    hasOlder: boolean;
    firstTerminalAt: number | null;
  }>({ detail: null, events: [], hasOlder: false, firstTerminalAt: null });

  /** 取得を 1 本ずつにする（ポーリングと「さらに読む」を重ねない） */
  const enqueue = useCallback(<T>(fn: () => Promise<T>): Promise<T> => {
    const next = chainRef.current.then(fn, fn);
    chainRef.current = next.catch(() => {});
    return next;
  }, []);

  useEffect(() => {
    let alive = true;
    const data = dataRef.current;
    data.detail = null;
    data.events = [];
    data.hasOlder = false;
    data.firstTerminalAt = null;
    setState({ phase: "loading" });
    const fetchImpl = () => depsRef.current.fetchImpl;
    const clock = () => (depsRef.current.now ?? Date.now)();

    const publish = (stale: boolean) => {
      if (!alive || data.detail === null) return;
      const detail = data.detail;
      setState((prev) => ({
        phase: "ready",
        detail,
        events: data.events,
        hasOlder: data.hasOlder,
        stale,
        loadingOlder: prev.phase === "ready" ? prev.loadingOlder : false,
        olderError: prev.phase === "ready" ? prev.olderError : false,
      }));
    };

    const finishedChasing = (detail: TaskDetailDto): boolean => {
      if (!isTerminal(detail.task.status)) return false;
      const ended = detail.task.ended_at === null ? Number.NaN : Date.parse(detail.task.ended_at);
      const generated = Date.parse(detail.generated_at);
      if (Number.isFinite(ended) && Number.isFinite(generated)) {
        return generated - ended >= TERMINAL_CHASE_MS;
      }
      // 終端の時刻が分からないときは、画面が終端を見てからの時間で数える
      data.firstTerminalAt ??= clock();
      return clock() - data.firstTerminalAt >= TERMINAL_CHASE_MS;
    };

    const poll = async (): Promise<PollOutcome> => {
      const d = await fetchTaskDetail(id, fetchImpl());
      if (!alive) return "ok";
      if (d.kind === "unauthorized" || d.kind === "not_found") {
        setState({ phase: d.kind });
        return d.kind;
      }
      if (d.kind === "error") {
        if (data.detail === null) setState({ phase: "error" });
        else publish(true);
        return "error";
      }
      data.detail = d.data;

      let outcome: PollOutcome = "ok";
      for (let page = 0; page < MAX_CATCH_UP_PAGES; page++) {
        const newest = data.events.at(-1)?.seq;
        const tail = newest === undefined;
        const r = await fetchTaskEvents(id, tail ? {} : { cursor: newest }, fetchImpl());
        if (!alive) return "ok";
        if (r.kind !== "ok") {
          outcome = r.kind;
          break;
        }
        data.events = mergeEvents(data.events, r.data.events);
        if (tail) data.hasOlder = r.data.has_older;
        if (r.data.events.length < EVENTS_PER_PAGE) break;
      }
      if (outcome === "unauthorized" || outcome === "not_found") {
        setState({ phase: outcome });
        return outcome;
      }
      publish(outcome === "error");
      if (outcome === "ok" && finishedChasing(d.data)) return "finished";
      return outcome;
    };

    const poller = createPoller({
      autoRefresh: autoRef.current,
      deps: depsRef.current.pollerDeps,
      run: () => enqueue(poll),
    });
    pollerRef.current = poller;
    poller.start();
    return () => {
      alive = false;
      poller.stop();
      pollerRef.current = null;
    };
  }, [id, enqueue]);

  useEffect(() => {
    pollerRef.current?.setAutoRefresh(autoRefresh);
  }, [autoRefresh]);

  const refresh = useCallback(() => pollerRef.current?.refresh(), []);

  /** 古い側を 1 ページ読む（before＝いちばん古い seq）。 */
  const loadOlder = useCallback(() => {
    const data = dataRef.current;
    const patch = (p: { loadingOlder: boolean; olderError: boolean }) =>
      setState((prev) => (prev.phase === "ready" ? { ...prev, ...p } : prev));
    patch({ loadingOlder: true, olderError: false });
    return enqueue(async () => {
      const oldest = data.events[0]?.seq;
      if (oldest === undefined) return patch({ loadingOlder: false, olderError: false });
      const r = await fetchTaskEvents(id, { before: oldest }, depsRef.current.fetchImpl);
      if (r.kind === "unauthorized" || r.kind === "not_found") {
        // ポーリングと同じ。401 はログインへ、404 は 404 画面へ（止める）
        pollerRef.current?.stop();
        setState({ phase: r.kind });
        return;
      }
      if (r.kind !== "ok") return patch({ loadingOlder: false, olderError: true });
      data.events = mergeEvents(data.events, r.data.events);
      data.hasOlder = r.data.has_older;
      setState((prev) =>
        prev.phase === "ready"
          ? {
              ...prev,
              events: data.events,
              hasOlder: data.hasOlder,
              loadingOlder: false,
              olderError: false,
            }
          : prev,
      );
    });
  }, [id, enqueue]);

  return { state, refresh, loadOlder };
}
