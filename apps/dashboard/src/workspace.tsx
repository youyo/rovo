import type { TaskDetailDto } from "@rovo/dashboard-contract";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import type { Scope } from "./api";
import type { DayKey } from "./day";
import type { DetailCache } from "./detail-cache";
import { Header } from "./header";
import { OverviewView } from "./overview-view";
import { loadAutoRefresh, saveAutoRefresh } from "./prefs";
import { daySummary, pickConsoleTask } from "./rail";
import type { Route } from "./route";
import { TaskScreen } from "./task-screen";
import { useBudget } from "./use-budget";
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
  /** 表示する日（null = 今日。undefined = まだ決まらない。タスクの URL で、詳細が届くまで）と、前後送り */
  day: DayKey | undefined;
  onDayChange: (move: -1 | 1 | "today") => void;
  /** コンソールの最初の詳細の取得が決着したとき（タスクの URL の日を決める） */
  onTaskSettled?: (task: TaskDetailDto["task"] | null) => void;
  onUnauthorized: () => void;
  /** レール・タイムラインの行の左クリック。ページを読み直さず、URL を pushState で変えて選ぶ（修飾キー付き・中クリックは呼ばれない） */
  onSelectTask?: (id: string) => void;
  /** 開いたことのあるタスクの最後の詳細（メモリ上）。切り替えた瞬間にすぐ描くため。無ければキャッシュしない */
  detailCache?: DetailCache;
  /**
   * 最初の取得に ?fresh=1 を付けるタスクの ID（URL を直接開いたとき、その URL のタスクだけ。D6）。null は付けない。
   * 指定しなければ（undefined）、コンソールの既定のとおり最初の取得に付ける。
   */
  freshTaskId?: string | null;
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
  // 一覧が届くまでのステータスバーの予算（/budget。軽い）
  const budget = useBudget(props.deps);
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
      day={day ?? null}
      onDayChange={props.onDayChange}
    >
      {props.user}
    </Header>
  );

  // 一覧の画面で、一覧が失敗・期限切れのとき: 状態を出す（コンソールに出すタスクが決まらない）。
  // 取得中（loading）は画面全体を止めず、骨格を出して一覧の場所（レール）とコンソールの場所だけ「読み込み中」にする
  if (route.kind === "overview" && data === null && state.phase !== "loading") {
    return (
      <>
        {header}
        <OverviewState phase={state.phase} onRetry={refresh} />
      </>
    );
  }

  // 切り替えた瞬間に描く、一覧の行の情報（一覧で権限を確かめ済みのタスク）。詳細が届くまでの見出し
  const row =
    data && consoleId !== null ? data.tasks.find((t) => t.task_id === consoleId) : undefined;
  const preview =
    data && row
      ? {
          task: row,
          at: Number.isFinite(Date.parse(data.generated_at))
            ? Date.parse(data.generated_at)
            : Date.now(),
        }
      : null;

  const consoleNode =
    consoleId === null ? (
      <section className="console console--empty" aria-label="コンソール">
        {data === null ? (
          <p className="soft" role="status">
            読み込み中…
          </p>
        ) : (
          <p className="soft">タスクを選ぶと、ここに進み具合が流れます。</p>
        )}
      </section>
    ) : (
      <TaskScreen
        key={consoleId}
        id={consoleId}
        cache={props.detailCache}
        fresh={props.freshTaskId === undefined ? undefined : consoleId === props.freshTaskId}
        preview={preview}
        onUnauthorized={onUnauthorized}
        autoRefresh={autoRefresh}
        onAutoRefreshChange={onAutoRefreshChange}
        onRefreshAlso={refresh}
        onSettled={props.onTaskSettled}
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
        budget={budget}
        autoRefresh={autoRefresh}
        onAutoRefreshChange={onAutoRefreshChange}
        onRefresh={refresh}
        selectedId={consoleId}
        onSelectTask={props.onSelectTask}
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
