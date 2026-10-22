import { useCallback, useEffect, useState } from "react";
import { loadAutoRefresh, saveAutoRefresh } from "./prefs";
import { TaskView } from "./task-view";
import { type TaskDetailDeps, useTaskDetail } from "./use-task-detail";

const BACK = "/dashboard/";

/** コンソール（取得・自動更新・各状態）。401 は onUnauthorized で再ログインの表示へ。404 は題名の断片も出さない。 */
export function TaskScreen(props: {
  id: string;
  onUnauthorized: () => void;
  deps?: TaskDetailDeps;
  /** 自動更新の入切を親（一覧と共有する画面）が持つとき。無ければこの画面で持つ */
  autoRefresh?: boolean;
  onAutoRefreshChange?: (on: boolean) => void;
  /** 「今すぐ更新」で詳細のほかに取り直したいもの（一覧など） */
  onRefreshAlso?: () => void;
}) {
  const [ownAutoRefresh, setOwnAutoRefresh] = useState(() => loadAutoRefresh());
  const autoRefresh = props.autoRefresh ?? ownAutoRefresh;
  const { state, refresh, loadOlder } = useTaskDetail(props.id, autoRefresh, props.deps);
  const { onUnauthorized } = props;

  useEffect(() => {
    if (state.phase === "unauthorized") onUnauthorized();
  }, [state.phase, onUnauthorized]);

  const { onAutoRefreshChange: notifyAutoRefresh, onRefreshAlso } = props;
  const onAutoRefreshChange = useCallback(
    (on: boolean) => {
      setOwnAutoRefresh(on);
      saveAutoRefresh(on);
      notifyAutoRefresh?.(on);
    },
    [notifyAutoRefresh],
  );
  const onRefresh = useCallback(() => {
    refresh();
    onRefreshAlso?.();
  }, [refresh, onRefreshAlso]);

  switch (state.phase) {
    case "loading":
      return (
        <div className="state">
          <h1>タスクの詳細</h1>
          <p role="status">読み込み中…</p>
        </div>
      );
    case "unauthorized":
      return (
        <div className="state">
          <h1>タスクの詳細</h1>
          <p>ログインの有効期限が切れました。もう一度ログインしてください。</p>
        </div>
      );
    case "not_found":
      return (
        <div className="state">
          <h1>このタスクは見られません</h1>
          <p role="alert">権限が無いか、存在しません。</p>
          <p>
            <a href={BACK}>ダッシュボードに戻る</a>
          </p>
        </div>
      );
    case "error":
      return (
        <div className="state">
          <h1>タスクの詳細</h1>
          <p role="alert">読み込めませんでした。自動で再試行します。</p>
          <button type="button" onClick={refresh}>
            再読み込み
          </button>
        </div>
      );
    case "ready":
      return (
        <TaskView
          detail={state.detail}
          events={state.events}
          hasOlder={state.hasOlder}
          stale={state.stale}
          loadingOlder={state.loadingOlder}
          olderError={state.olderError}
          autoRefresh={autoRefresh}
          onAutoRefreshChange={onAutoRefreshChange}
          onRefresh={onRefresh}
          onLoadOlder={() => void loadOlder()}
        />
      );
  }
}
