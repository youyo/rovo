import type { CloudflareSummaryDto } from "@rovo/dashboard-contract";
import { useEffect, useRef, useState } from "react";
import { fetchCloudflare } from "./api";
import { createPoller, type PollerDeps, type PollOutcome } from "./poller";

/** Cloudflare の集計の取り直しの間隔（サーバーのキャッシュは 45 秒）。 */
export const CLOUDFLARE_INTERVAL_MS = 60_000;

export type CloudflareState =
  | { phase: "loading" }
  | { phase: "ready"; data: CloudflareSummaryDto }
  /** 取れなかった（前の値があれば stale として出し続ける）。画面の他の部分は壊さない */
  | { phase: "failed"; stale: CloudflareSummaryDto | null }
  | { phase: "unauthorized" };

export type CloudflareDeps = { fetchImpl?: typeof fetch; pollerDeps?: PollerDeps };

/** 一覧とは別の 60 秒間隔で取る。hidden で止まり、復帰で取る（poller）。401 は unauthorized。 */
export function useCloudflare(autoRefresh: boolean, deps: CloudflareDeps = {}): CloudflareState {
  const [state, setState] = useState<CloudflareState>({ phase: "loading" });
  const depsRef = useRef(deps);
  depsRef.current = deps;
  const autoRef = useRef(autoRefresh);
  autoRef.current = autoRefresh;
  const pollerRef = useRef<ReturnType<typeof createPoller> | null>(null);

  useEffect(() => {
    let alive = true;
    const poller = createPoller({
      intervalMs: CLOUDFLARE_INTERVAL_MS,
      autoRefresh: autoRef.current,
      deps: depsRef.current.pollerDeps,
      run: async (): Promise<PollOutcome> => {
        const r = await fetchCloudflare(depsRef.current.fetchImpl);
        if (alive) {
          if (r.kind === "ok") setState({ phase: "ready", data: r.data });
          else if (r.kind === "unauthorized") setState({ phase: "unauthorized" });
          else
            setState((prev) => ({
              phase: "failed",
              stale:
                prev.phase === "ready" ? prev.data : prev.phase === "failed" ? prev.stale : null,
            }));
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
    pollerRef.current?.setAutoRefresh(autoRefresh);
  }, [autoRefresh]);

  return state;
}
