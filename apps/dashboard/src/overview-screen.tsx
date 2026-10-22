import { useCallback, useEffect, useState } from "react";
import type { Scope } from "./api";
import { OverviewView } from "./overview-view";
import { loadAutoRefresh, saveAutoRefresh } from "./prefs";
import { type CloudflareDeps, useCloudflare } from "./use-cloudflare";
import { type OverviewDeps, useOverview } from "./use-overview";

/** 一覧の画面（取得・自動更新・各状態）。401 は onUnauthorized で再ログインの表示へ。 */
export function OverviewScreen(props: {
  scope: Scope;
  onUnauthorized: () => void;
  deps?: OverviewDeps;
  cloudflareDeps?: CloudflareDeps;
}) {
  const [autoRefresh, setAutoRefresh] = useState(() => loadAutoRefresh());
  const { state, refresh } = useOverview(props.scope, autoRefresh, props.deps);
  // Cloudflare は一覧とは別の 60 秒間隔。失敗しても一覧は出す（401 だけは一覧と同じ扱い）
  const cloudflare = useCloudflare(autoRefresh, props.cloudflareDeps);
  const { onUnauthorized } = props;
  const unauthorized = state.phase === "unauthorized" || cloudflare.phase === "unauthorized";

  useEffect(() => {
    if (unauthorized) onUnauthorized();
  }, [unauthorized, onUnauthorized]);

  const onAutoRefreshChange = useCallback((on: boolean) => {
    setAutoRefresh(on);
    saveAutoRefresh(on);
  }, []);

  switch (state.phase) {
    case "loading":
      return (
        <div className="state">
          <h1>ダッシュボード</h1>
          <p role="status">読み込み中…</p>
        </div>
      );
    case "unauthorized":
      return (
        <div className="state">
          <h1>ダッシュボード</h1>
          <p>ログインの有効期限が切れました。もう一度ログインしてください。</p>
        </div>
      );
    case "not_found":
      return (
        <div className="state">
          <h1>ダッシュボード</h1>
          <p role="alert">この内容は見られません。権限が無いか、存在しません。</p>
        </div>
      );
    case "error":
      return (
        <div className="state">
          <h1>ダッシュボード</h1>
          <p role="alert">読み込めませんでした。自動で再試行します。</p>
          <button type="button" onClick={refresh}>
            再読み込み
          </button>
        </div>
      );
    case "ready":
      return (
        <OverviewView
          data={state.data}
          stale={state.stale}
          cloudflare={cloudflare}
          autoRefresh={autoRefresh}
          onAutoRefreshChange={onAutoRefreshChange}
          onRefresh={refresh}
        />
      );
  }
}
