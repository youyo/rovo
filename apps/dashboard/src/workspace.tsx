import { type ReactNode, useCallback, useEffect, useState } from "react";
import type { Scope } from "./api";
import type { DayKey } from "./day";
import { Header } from "./header";
import { OverviewView } from "./overview-view";
import { loadAutoRefresh, saveAutoRefresh } from "./prefs";
import { daySummary, pickConsoleTask } from "./rail";
import type { Route } from "./route";
import { TaskScreen } from "./task-screen";
import { type CloudflareDeps, useCloudflare } from "./use-cloudflare";
import { type OverviewDeps, useOverview } from "./use-overview";

/**
 * ログイン後の画面（個別ページは無い）:
 * ヘッダ → 細いタイムライン帯 → 左のレール + 中央のコンソール → 下のステータスバー。
 * コンソールは、/dashboard/tasks/:id ならその URL のタスク。/dashboard は走行中のタスクがあれば最新の走行中、なければ最新のタスク。
 * 自動更新の入切は一覧・Cloudflare・コンソールで共有する（読み取り専用）。
 */
export function Workspace(props: {
  route: Route;
  scope: Scope;
  onScopeChange: (scope: Scope) => void;
  /** 表示する日（null = 今日）と、前後送り */
  day: DayKey;
  onDayChange: (move: -1 | 1 | "today") => void;
  onUnauthorized: () => void;
  /** 利用者名とログアウト */
  user: ReactNode;
  deps?: OverviewDeps;
  cloudflareDeps?: CloudflareDeps;
}) {
  const { route, scope, day, onUnauthorized } = props;
  const [autoRefresh, setAutoRefresh] = useState(() => loadAutoRefresh());
  const { state, refresh } = useOverview(scope, day, autoRefresh, props.deps);
  // Cloudflare は一覧とは別の 60 秒間隔。失敗しても一覧は出す（401 だけは一覧と同じ扱い）
  const cloudflare = useCloudflare(autoRefresh, props.cloudflareDeps);
  const unauthorized = state.phase === "unauthorized" || cloudflare.phase === "unauthorized";

  useEffect(() => {
    if (unauthorized) onUnauthorized();
  }, [unauthorized, onUnauthorized]);

  const onAutoRefreshChange = useCallback((on: boolean) => {
    setAutoRefresh(on);
    saveAutoRefresh(on);
  }, []);

  const data = state.phase === "ready" ? state.data : null;
  const consoleId =
    route.kind === "task" ? route.id : data ? (pickConsoleTask(data.tasks)?.task_id ?? null) : null;

  const header = (
    <Header
      scope={scope}
      onScopeChange={props.onScopeChange}
      summary={data ? daySummary(data) : null}
      day={day}
      onDayChange={props.onDayChange}
    >
      {props.user}
    </Header>
  );

  // 一覧の画面で、一覧がまだ・もう取れないとき: 状態だけを出す（コンソールに出すタスクが決まらない）
  if (route.kind === "overview" && data === null) {
    return (
      <>
        {header}
        <OverviewState phase={state.phase} onRetry={refresh} />
      </>
    );
  }

  const consoleNode =
    consoleId === null ? (
      <section className="console console--empty" aria-label="コンソール">
        <p className="soft">タスクを選ぶと、ここに進み具合が流れます。</p>
      </section>
    ) : (
      <TaskScreen
        key={consoleId}
        id={consoleId}
        onUnauthorized={onUnauthorized}
        autoRefresh={autoRefresh}
        onAutoRefreshChange={onAutoRefreshChange}
        onRefreshAlso={refresh}
      />
    );

  return (
    <>
      {header}
      <OverviewView
        data={data}
        isToday={day === null}
        stale={state.phase === "ready" ? state.stale : false}
        cloudflare={cloudflare}
        autoRefresh={autoRefresh}
        onAutoRefreshChange={onAutoRefreshChange}
        onRefresh={refresh}
        selectedId={consoleId}
        console={consoleNode}
        railNote={railNote(state.phase)}
        showRefreshControls={consoleId === null}
      />
    </>
  );
}

function railNote(phase: ReturnType<typeof useOverview>["state"]["phase"]): string {
  switch (phase) {
    case "loading":
      return "読み込み中…";
    case "error":
      return "タスクの一覧を読み込めませんでした。自動で再試行します。";
    case "not_found":
      return "タスクの一覧は見られません。";
    default:
      return "";
  }
}

/** 一覧の取得中・失敗の表示（一覧の画面で、コンソールに出すタスクが決まる前） */
function OverviewState(props: {
  phase: "loading" | "ready" | "error" | "unauthorized" | "not_found";
  onRetry: () => void;
}) {
  switch (props.phase) {
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
          <button type="button" onClick={props.onRetry}>
            再読み込み
          </button>
        </div>
      );
    default:
      return (
        <div className="state">
          <h1>ダッシュボード</h1>
          <p role="status">読み込み中…</p>
        </div>
      );
  }
}
