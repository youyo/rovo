import type { TaskDetailDto } from "@rovo/dashboard-contract";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import type { Scope } from "./api";
import type { DayKey } from "./day";
import type { DetailCache } from "./detail-cache";
import { Header } from "./header";
import type { T } from "./i18n";
import { useT } from "./lang";
import { OverviewView, type RailTab } from "./overview-view";
import { loadAutoRefresh, saveAutoRefresh } from "./prefs";
import { daySummary, pickConsoleTask } from "./rail";
import type { Route } from "./route";
import { TaskScreen } from "./task-screen";
import { TeamBoard } from "./team-board";
import { useBudget } from "./use-budget";
import { type CloudflareDeps, useCloudflare } from "./use-cloudflare";
import { type OverviewDeps, useOverview } from "./use-overview";
import { useWaiting } from "./use-waiting";

/**
 * ログイン後の画面（個別ページは無い）:
 * ヘッダ → 細いタイムライン帯 → 左のレール + 中央のコンソール → 下のステータスバー。
 * コンソールは、/dashboard/tasks/:id ならその URL のタスク。/dashboard は実行中のタスクがあれば最新の実行中、なければ最新のタスク。
 * ただしチーム（scope = all）で何も選んでいない（/dashboard）ときは、コンソールの代わりにチームボード（人ごとの「いま」とリポジトリ別）。
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
  const t = useT();
  const [autoRefresh, setAutoRefresh] = useState(() => loadAutoRefresh());
  const { state, refresh } = useOverview(scope, day, autoRefresh, props.deps);
  // Cloudflare は一覧とは別の 60 秒間隔。失敗しても一覧は出す（401 だけは一覧と同じ扱い）
  const cloudflare = useCloudflare(autoRefresh, props.cloudflareDeps);
  // 一覧が届くまでのステータスバーの予算（/budget。軽い）
  const budget = useBudget(props.deps);
  // 日をまたいだ「待ち」。日付に関係なく scope だけで決まる。失敗しても一覧は出す（401 だけは一覧と同じ扱い）
  const waiting = useWaiting(scope, autoRefresh, props.deps);
  const [railTab, setRailTab] = useState<RailTab>("day");
  const unauthorized =
    state.phase === "unauthorized" ||
    cloudflare.phase === "unauthorized" ||
    waiting.state.phase === "unauthorized";

  useEffect(() => {
    if (unauthorized) onUnauthorized();
  }, [unauthorized, onUnauthorized]);

  const onAutoRefreshChange = useCallback((on: boolean) => {
    setAutoRefresh(on);
    saveAutoRefresh(on);
  }, []);

  const refreshWaiting = waiting.refresh;
  const refreshAll = useCallback(() => {
    refresh();
    refreshWaiting();
  }, [refresh, refreshWaiting]);

  const data = state.phase === "ready" ? state.data : null;
  // チームで何も選んでいないとき（一覧の URL）は、コンソールではなくチームボードを出す。マイタスクは今までどおり既定のタスク
  const showBoard = route.kind === "overview" && scope === "all";
  const consoleId =
    route.kind === "task"
      ? route.id
      : data && !showBoard
        ? (pickConsoleTask(data.tasks)?.task_id ?? null)
        : null;

  const header = (
    <Header
      scope={scope}
      onScopeChange={props.onScopeChange}
      summary={data ? daySummary(data, t) : null}
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

  const consoleNode = showBoard ? (
    data === null ? (
      <section className="console console--empty" aria-label={t("board.label")}>
        <p className="soft" role="status">
          {t("common.loading")}
        </p>
      </section>
    ) : (
      <TeamBoard
        data={data}
        waiting={waiting.state.phase === "ready" ? waiting.state.data : null}
        isToday={day === null}
        onSelectTask={props.onSelectTask}
      />
    )
  ) : consoleId === null ? (
    <section className="console console--empty" aria-label={t("console.label")}>
      {data === null ? (
        <p className="soft" role="status">
          {t("common.loading")}
        </p>
      ) : (
        <p className="soft">{t("console.selectHint")}</p>
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
        onRefresh={refreshAll}
        waiting={waiting.state}
        railTab={railTab}
        onRailTabChange={setRailTab}
        selectedId={consoleId}
        onSelectTask={props.onSelectTask}
        console={consoleNode}
        railNote={railNote(state.phase, t)}
        showRefreshControls={consoleId === null}
      />
    </>
  );
}

function railNote(phase: ReturnType<typeof useOverview>["state"]["phase"], t: T): string {
  switch (phase) {
    case "loading":
      return t("common.loading");
    case "error":
      return t("state.railError");
    case "not_found":
      return t("state.railNotFound");
    default:
      return "";
  }
}

/** 一覧の取得中・失敗の表示（一覧の画面で、コンソールに出すタスクが決まる前） */
function OverviewState(props: {
  phase: "loading" | "ready" | "error" | "unauthorized" | "not_found";
  onRetry: () => void;
}) {
  const t = useT();
  switch (props.phase) {
    case "unauthorized":
      return (
        <div className="state">
          <h1>{t("dashboard.title")}</h1>
          <p>{t("state.expired")}</p>
        </div>
      );
    case "not_found":
      return (
        <div className="state">
          <h1>{t("dashboard.title")}</h1>
          <p role="alert">{t("state.overviewNotFound")}</p>
        </div>
      );
    case "error":
      return (
        <div className="state">
          <h1>{t("dashboard.title")}</h1>
          <p role="alert">{t("state.error")}</p>
          <button type="button" onClick={props.onRetry}>
            {t("common.reload")}
          </button>
        </div>
      );
    default:
      return (
        <div className="state">
          <h1>{t("dashboard.title")}</h1>
          <p role="status">{t("common.loading")}</p>
        </div>
      );
  }
}
