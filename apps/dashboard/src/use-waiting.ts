import type { WaitingDto } from "@rovo/dashboard-contract";
import { useCallback, useEffect, useRef, useState } from "react";
import { fetchWaiting, type Scope } from "./api";
import { createPoller, type Poller, type PollerDeps, type PollOutcome } from "./poller";

export type WaitingState =
  | { phase: "loading" }
  /** stale: 直近の更新に失敗した（前のデータを出し続けている） */
  | { phase: "ready"; data: WaitingDto; stale: boolean }
  | { phase: "error" }
  | { phase: "unauthorized" }
  | { phase: "not_found" };

export type WaitingDeps = {
  fetchImpl?: typeof fetch;
  pollerDeps?: PollerDeps;
};

/** 待ちは日をまたぐ長い時間の話なので、一覧（5 秒）より間隔を空ける */
const WAITING_INTERVAL_MS = 30_000;

/**
 * 日をまたいだ「待ち」を取り、自動更新する。日付に関係なく scope（全員 / 自分）だけで決まる。
 * 「この日」のタブを開いていても取る（タブに件数を添えるため）。scope を変えると取り直し、別の scope の結果は捨てる。
 * 失敗しても一覧は壊さない（呼び出し側は状態を見て案内を出すだけ）。
 */
export function useWaiting(scope: Scope, autoRefresh: boolean, deps: WaitingDeps = {}) {
  const [state, setState] = useState<WaitingState>({ phase: "loading" });
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
      intervalMs: WAITING_INTERVAL_MS,
      deps: depsRef.current.pollerDeps,
      run: async (): Promise<PollOutcome> => {
        const sc = scopeRef.current;
        fetchedScope.current = sc;
        const r = await fetchWaiting(sc, depsRef.current.fetchImpl);
        if (alive && scopeRef.current === sc) {
          if (r.kind === "ok") setState({ phase: "ready", data: r.data, stale: false });
          else if (r.kind === "unauthorized") setState({ phase: "unauthorized" });
          else if (r.kind === "not_found") setState({ phase: "not_found" });
          else
            setState((prev) =>
              prev.phase === "ready" && prev.data.scope === sc
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

  useEffect(() => {
    if (fetchedScope.current !== scope) pollerRef.current?.refresh();
  }, [scope]);

  useEffect(() => {
    pollerRef.current?.setAutoRefresh(autoRefresh);
  }, [autoRefresh]);

  const refresh = useCallback(() => pollerRef.current?.refresh(), []);
  // 別の scope の結果は出さない（切替直後は、新しい応答が来るまで読み込み中に戻す）
  const shown: WaitingState =
    state.phase === "ready" && state.data.scope !== scope ? { phase: "loading" } : state;
  return { state: shown, refresh };
}
