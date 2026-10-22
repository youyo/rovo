import type { OverviewDto } from "@rovo/dashboard-contract";
import { useCallback, useEffect, useRef, useState } from "react";
import { fetchOverview, localDayRange, type Scope } from "./api";
import { createPoller, type Poller, type PollerDeps, type PollOutcome } from "./poller";

export type OverviewState =
  | { phase: "loading" }
  /** stale: 直近の更新に失敗した（前のデータを出し続けている） */
  | { phase: "ready"; data: OverviewDto; stale: boolean }
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
 */
export function useOverview(scope: Scope, autoRefresh: boolean, deps: OverviewDeps = {}) {
  const [state, setState] = useState<OverviewState>({ phase: "loading" });
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const autoRef = useRef(autoRefresh);
  autoRef.current = autoRefresh;
  const depsRef = useRef(deps);
  depsRef.current = deps;
  const pollerRef = useRef<Poller | null>(null);
  const fetchedScope = useRef<Scope | null>(null);

  useEffect(() => {
    let alive = true;
    const poller = createPoller({
      autoRefresh: autoRef.current,
      deps: depsRef.current.pollerDeps,
      run: async (): Promise<PollOutcome> => {
        const sc = scopeRef.current;
        fetchedScope.current = sc;
        const now = depsRef.current.now ?? Date.now;
        const r = await fetchOverview(localDayRange(now()), sc, depsRef.current.fetchImpl);
        if (alive && scopeRef.current === sc) {
          if (r.kind === "ok") setState({ phase: "ready", data: r.data, stale: false });
          else if (r.kind === "unauthorized") setState({ phase: "unauthorized" });
          else if (r.kind === "not_found") setState({ phase: "not_found" });
          else
            setState((prev) =>
              prev.phase === "ready" ? { ...prev, stale: true } : { phase: "error" },
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

  useEffect(() => {
    if (fetchedScope.current !== scope) pollerRef.current?.refresh();
  }, [scope]);

  useEffect(() => {
    pollerRef.current?.setAutoRefresh(autoRefresh);
  }, [autoRefresh]);

  const refresh = useCallback(() => pollerRef.current?.refresh(), []);
  // 別の scope のデータは出さない（切替直後は、新しい応答が来るまで読み込み中に戻す）
  const shown: OverviewState =
    state.phase === "ready" && state.data.scope !== scope ? { phase: "loading" } : state;
  return { state: shown, refresh };
}
