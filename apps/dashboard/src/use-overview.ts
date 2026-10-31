import type { OverviewDto } from "@rovo/dashboard-contract";
import { useCallback, useEffect, useRef, useState } from "react";
import { fetchOverview, type Scope } from "./api";
import { type DayKey, dayRange } from "./day";
import {
  browserDeps,
  createPoller,
  overviewKeepAlive,
  type Poller,
  type PollerDeps,
  type PollOutcome,
  withKeepAlive,
} from "./poller";

export type OverviewState =
  | { phase: "loading" }
  /** stale: 直近の更新に失敗した（前のデータを出し続けている） */
  | { phase: "ready"; data: OverviewDto; stale: boolean; key?: string }
  | { phase: "error" }
  | { phase: "unauthorized" }
  | { phase: "not_found" };

export type OverviewDeps = {
  fetchImpl?: typeof fetch;
  /** 「今日」の範囲を決める現在時刻（注入できる） */
  now?: () => number;
  pollerDeps?: PollerDeps;
};

/**
 * 一覧のデータを取り、自動更新する（D15）。scope を変えると取り直す。
 * 取得中の結果が別の scope のものなら捨てる（画面を古い scope で上書きしない）。
 * 工場の小窓が見えている間（overviewKeepAlive）は、元のタブが hidden でも自動更新を続ける。
 */
export function useOverview(
  scope: Scope,
  /** undefined は「日がまだ決まらない」（タスクの URL で、詳細が届くまで）。決まるまで取りに行かない */
  day: DayKey | undefined,
  autoRefresh: boolean,
  deps: OverviewDeps = {},
) {
  const [state, setState] = useState<OverviewState>({ phase: "loading" });
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const dayRef = useRef(day);
  dayRef.current = day;
  const autoRef = useRef(autoRefresh);
  autoRef.current = autoRefresh;
  const depsRef = useRef(deps);
  depsRef.current = deps;
  const pollerRef = useRef<Poller | null>(null);
  const fetchedKey = useRef<string | null>(null);

  useEffect(() => {
    let alive = true;
    const poller = createPoller({
      autoRefresh: autoRef.current,
      // 工場の小窓が見えている間は、元のタブが hidden でも続ける（docs/specs/dashboard-factory.md の「小窓」）
      deps: withKeepAlive(depsRef.current.pollerDeps ?? browserDeps, overviewKeepAlive),
      run: async (): Promise<PollOutcome> => {
        const sc = scopeRef.current;
        const d = dayRef.current;
        if (d === undefined) return "ok"; // 日が決まったら wantedKey の変化で取りに行く
        const key = `${sc}|${d ?? "today"}`;
        fetchedKey.current = key;
        const now = depsRef.current.now ?? Date.now;
        const r = await fetchOverview(dayRange(d, now()), sc, depsRef.current.fetchImpl);
        if (alive && scopeRef.current === sc && dayRef.current === d) {
          if (r.kind === "ok") setState({ phase: "ready", data: r.data, stale: false, key });
          else if (r.kind === "unauthorized") setState({ phase: "unauthorized" });
          else if (r.kind === "not_found") setState({ phase: "not_found" });
          else
            setState((prev) =>
              prev.phase === "ready" && prev.key === key
                ? { ...prev, stale: true }
                : { phase: "error" },
            );
        }
        return r.kind === "ok" ? "ok" : r.kind;
      },
    });
    pollerRef.current = poller;
    poller.start();
    return () => {
      alive = false;
      poller.stop();
      pollerRef.current = null;
    };
  }, []);

  const wantedKey = day === undefined ? `${scope}|pending` : `${scope}|${day ?? "today"}`;
  useEffect(() => {
    if (fetchedKey.current !== wantedKey) pollerRef.current?.refresh();
  }, [wantedKey]);

  useEffect(() => {
    pollerRef.current?.setAutoRefresh(autoRefresh);
  }, [autoRefresh]);

  const refresh = useCallback(() => pollerRef.current?.refresh(), []);
  // 別の scope・別の日のデータは出さない（切替直後は、新しい応答が来るまで読み込み中に戻す）
  const shown: OverviewState =
    state.phase === "ready" && (state.data.scope !== scope || state.key !== wantedKey)
      ? { phase: "loading" }
      : state;
  return { state: shown, refresh };
}
