import type { ChecksDto } from "@rovo/dashboard-contract";
import { useCallback, useEffect, useRef, useState } from "react";
import { CHECKS_POLL_ACTIVE_MS, checksPollMs } from "./checks";
import { fetchTaskChecks } from "./detail-api";
import { createPoller, type Poller, type PollerDeps, type PollOutcome } from "./poller";

export type ChecksState =
  | { phase: "loading" }
  | { phase: "ready"; data: ChecksDto; stale: boolean }
  /** まだ 1 度も取れていない（権限・通信の失敗。401 / 404 もここ。タスク本体の取得が扱う） */
  | { phase: "error" };

export type TaskChecksDeps = {
  fetchImpl?: typeof fetch;
  pollerDeps?: PollerDeps;
};

/**
 * タスクの PR の CI を取り、自動更新する。タスク本体（use-task-detail。5 秒）とは別のポーリング:
 * 実行中・待ちが 1 つでもあれば 10 秒、全部終わっていたら 60 秒（後からの push を拾う）。
 * タブが隠れたら止まる（poller）。enabled=false（PR が無い）の間は取りに行かず、state は null。
 * id が変わる・enabled が変わると、前の取得は AbortController で止め、届いた応答も捨てる。
 */
export function useTaskChecks(
  id: string,
  enabled: boolean,
  autoRefresh: boolean,
  deps: TaskChecksDeps = {},
): { state: ChecksState | null; refresh: () => void } {
  const [state, setState] = useState<ChecksState | null>(enabled ? { phase: "loading" } : null);
  const autoRef = useRef(autoRefresh);
  autoRef.current = autoRefresh;
  const depsRef = useRef(deps);
  depsRef.current = deps;
  const pollerRef = useRef<Poller | null>(null);

  useEffect(() => {
    if (!enabled) {
      setState(null);
      return;
    }
    let alive = true;
    const abort = new AbortController();
    let data: ChecksDto | null = null;
    setState({ phase: "loading" });

    const poll = async (): Promise<PollOutcome> => {
      const r = await fetchTaskChecks(id, depsRef.current.fetchImpl, abort.signal);
      if (!alive) return "ok";
      if (r.kind === "ok") {
        data = r.data;
        setState({ phase: "ready", data: r.data, stale: false });
        return "ok";
      }
      if (data === null) setState({ phase: "error" });
      else setState({ phase: "ready", data, stale: true });
      return r.kind === "error" ? "error" : r.kind;
    };

    const poller = createPoller({
      autoRefresh: autoRef.current,
      deps: depsRef.current.pollerDeps,
      // まだ何も取れていない間は短い間隔を基準にする（失敗しても 60 秒の倍まで待たない）
      intervalMs: () => (data === null ? CHECKS_POLL_ACTIVE_MS : checksPollMs(data)),
      run: poll,
    });
    pollerRef.current = poller;
    poller.start();
    return () => {
      alive = false;
      abort.abort();
      poller.stop();
      pollerRef.current = null;
    };
  }, [id, enabled]);

  useEffect(() => {
    pollerRef.current?.setAutoRefresh(autoRefresh);
  }, [autoRefresh]);

  const refresh = useCallback(() => pollerRef.current?.refresh(), []);
  return { state, refresh };
}
