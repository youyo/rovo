import type { TaskDetailDto, VisibleTaskDto } from "@rovo/dashboard-contract";
import { useCallback, useEffect, useRef, useState } from "react";
import type { DetailCache } from "./detail-cache";
import { useT } from "./lang";
import { loadAutoRefresh, saveAutoRefresh } from "./prefs";
import { TaskPreview, TaskView } from "./task-view";
import { useNarrow } from "./use-narrow";
import { type TaskChecksDeps, useTaskChecks } from "./use-task-checks";
import { type TaskDetailDeps, useTaskDetail } from "./use-task-detail";

const BACK = "/dashboard/";

/**
 * コンソール（取得・自動更新・各状態）。401 は onUnauthorized で再ログインの表示へ。404 は題名の断片も出さない。
 * 切り替えた瞬間は、キャッシュの詳細（あれば）か、一覧の行（preview）の情報を先に描き、詳細は裏で取って差し替える。
 */
export function TaskScreen(props: {
  id: string;
  onUnauthorized: () => void;
  deps?: TaskDetailDeps;
  /** PR の CI の取得の差し替え（テスト用。ポーリングは詳細とは別なので、タイマーも別に差し替える）。fetchImpl は deps のものを引き継ぐ */
  checksDeps?: TaskChecksDeps;
  /** 開いたことのあるタスクの最後の詳細（メモリ上）。無ければキャッシュしない */
  cache?: DetailCache;
  /** 最初の取得に ?fresh=1 を付けるか（既定 true）。URL を直接開いたときだけ true、画面の中での切り替えは false */
  fresh?: boolean;
  /** 詳細が届くまで描く、一覧の行の情報（at は経過時間の基準にする一覧の時刻 ms） */
  preview?: { task: VisibleTaskDto; at: number } | null;
  /** 自動更新の入切を親（一覧と共有する画面）が持つとき。無ければこの画面で持つ */
  autoRefresh?: boolean;
  onAutoRefreshChange?: (on: boolean) => void;
  /** 「今すぐ更新」で詳細のほかに取り直したいもの（一覧など） */
  onRefreshAlso?: () => void;
  /** 最初の取得が決着したとき 1 回だけ呼ぶ。ready はタスク、404・失敗は null（一覧の日を決めるのに使う） */
  onSettled?: (task: TaskDetailDto["task"] | null) => void;
}) {
  const t = useT();
  const narrow = useNarrow();
  const [ownAutoRefresh, setOwnAutoRefresh] = useState(() => loadAutoRefresh());
  const autoRefresh = props.autoRefresh ?? ownAutoRefresh;
  const { state, refresh, loadOlder } = useTaskDetail(props.id, autoRefresh, {
    ...props.deps,
    ...(props.cache === undefined ? {} : { cache: props.cache }),
    ...(props.fresh === undefined ? {} : { fresh: props.fresh }),
  });
  // PR があるタスクだけ、その CI を別のポーリングで取る（PR が無ければ取りに行かず、CI の表示も出さない）
  const hasPr = state.phase === "ready" && state.detail.task.pr !== null;
  const checks = useTaskChecks(props.id, hasPr, autoRefresh, {
    ...(props.deps?.fetchImpl === undefined ? {} : { fetchImpl: props.deps.fetchImpl }),
    ...props.checksDeps,
  });
  const { onUnauthorized, onSettled } = props;
  const settledRef = useRef(false);

  useEffect(() => {
    if (settledRef.current || state.phase === "loading" || state.phase === "unauthorized") return;
    settledRef.current = true;
    onSettled?.(state.phase === "ready" ? state.detail.task : null);
  }, [state, onSettled]);

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
  const refreshChecks = checks.refresh;
  const onRefresh = useCallback(() => {
    refresh();
    refreshChecks();
    onRefreshAlso?.();
  }, [refresh, refreshChecks, onRefreshAlso]);

  switch (state.phase) {
    case "loading":
      if (props.preview) return <TaskPreview task={props.preview.task} at={props.preview.at} />;
      return (
        <div className="state">
          <h1>{t("detail.title")}</h1>
          <p role="status">{t("common.loading")}</p>
        </div>
      );
    case "unauthorized":
      return (
        <div className="state">
          <h1>{t("detail.title")}</h1>
          <p>{t("state.expired")}</p>
        </div>
      );
    case "not_found":
      return (
        <div className="state">
          <h1>{t("state.notFoundTitle")}</h1>
          <p role="alert">{t("state.notFound")}</p>
          {/* 狭い幅は上に「← 一覧」があるので、素のリンクは出さない */}
          {narrow ? null : (
            <p>
              <a href={BACK}>{t("state.backToDashboard")}</a>
            </p>
          )}
        </div>
      );
    case "error":
      return (
        <div className="state">
          <h1>{t("detail.title")}</h1>
          <p role="alert">{t("state.error")}</p>
          <button type="button" onClick={refresh}>
            {t("common.reload")}
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
          checks={checks.state}
        />
      );
  }
}
