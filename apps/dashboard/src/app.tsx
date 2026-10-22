import type { TaskDetailDto } from "@rovo/dashboard-contract";
import { useCallback, useEffect, useState } from "react";
import type { Scope } from "./api";
import { AuthView } from "./auth-view";
import { type DayKey, dayHref, dayOfTask, routeDay, shiftDay } from "./day";
import { createDetailCache } from "./detail-cache";
import { Header } from "./header";
import { parseRoute, type Route, taskPath } from "./route";
import { type AuthState, fetchMe, loginHref, logout } from "./session";
import { Workspace } from "./workspace";

/**
 * ダッシュボード。ログインの確認（M4）→ ログイン済みなら骨格（Workspace）、そうでなければログインの案内。
 * 個別ページは無い。`/dashboard/tasks/<ULID>` は一覧の画面で、そのタスクを選んだ状態（MCP の dashboard_url の行き先）。
 * 表示する日はそのタスクが始まった日（URL は置き換えず、リロード・共有でも同じタスクが開く）。
 * レール・タイムラインでの切り替えと日付の前後送りは、ページを読み直さず history.pushState で URL を変え、popstate に追従する。
 * 修飾キー付き・中クリックは通常のリンクのまま（ブラウザが新しいタブで開く）。
 * ?fresh=1 は、URL を直接開いたときのそのタスクの最初の取得だけ（切り替えとポーリングには付けない。D6）。
 */
export function App() {
  const [auth, setAuth] = useState<AuthState>({ state: "loading" });
  // 既定は「自分」（切り替えは使える）
  const [scope, setScope] = useState<Scope>("me");
  const [route, setRoute] = useState<Route>(() =>
    parseRoute(typeof location === "undefined" ? "/dashboard/" : location.pathname),
  );
  // 表示する日。一覧は URL の ?day=（無ければ今日）。タスクの URL は ?day=（画面の中で選んだときに残した日）があればその日、
  // 無ければタスクの詳細が取れるまで決まらない（undefined）
  const [day, setDay] = useState<DayKey | undefined>(() =>
    routeDay(route, typeof location === "undefined" ? "" : location.search, Date.now()),
  );
  // ページの読み込み時の URL がタスクを指していたときの、そのタスクの ID。最初の取得だけ ?fresh=1 を付ける（D6）。
  // 画面の中で切り替えた（pushState・popstate）あとは付けない（レールのタスクは一覧の取得で権限を確かめ済み）
  const [freshTaskId, setFreshTaskId] = useState<string | null>(() =>
    route.kind === "task" ? route.id : null,
  );
  // 開いたことのあるタスクの最後の詳細。メモリだけ（ページを読み直すと空。ログアウト・期限切れで捨てる）
  const [detailCache] = useState(() => createDetailCache());

  useEffect(() => {
    let alive = true;
    void fetchMe().then((next) => {
      if (alive) setAuth(next);
    });
    return () => {
      alive = false;
    };
  }, []);

  // タスクの URL: そのタスクが始まった日を、コンソールの最初の詳細の取得から決める（詳細を二重に取らない）。
  // 取れないとき（404・失敗）は今日。一覧は日が決まるまで取りに行かないが、画面は止めない（コンソールと予算・Cloudflare は先に出る）
  const onTaskSettled = useCallback((task: TaskDetailDto["task"] | null) => {
    setDay((cur) => (cur === undefined ? (task ? dayOfTask(task, Date.now()) : null) : cur));
  }, []);

  useEffect(() => {
    const onPop = () => {
      const next = parseRoute(location.pathname);
      setFreshTaskId(null);
      setRoute(next);
      setDay(routeDay(next, location.search, Date.now()));
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const onDayChange = useCallback(
    (move: -1 | 1 | "today") => {
      const current = day === undefined ? null : day;
      const next = move === "today" ? null : shiftDay(current, move, Date.now());
      // タスクの URL から日を送ったら、一覧の URL（選択は外れる）。戻るで元のタスクの表示に戻る
      const path = route.kind === "task" ? "/dashboard/" : location.pathname;
      history.pushState(null, "", dayHref(path, next));
      setFreshTaskId(null);
      setRoute({ kind: "overview" });
      setDay(next);
    },
    [day, route.kind],
  );

  // レール・タイムラインの行の左クリック。日付の前後送りと同じ流儀: ページを読み直さず、URL を pushState で
  // /dashboard/tasks/<ID> に変える。クエリは dayHref で作り直す（見ている日だけ ?day= に残し、ほかは引き継がない）。
  // 見ている日は変えない（同じ日の中で選ぶ）。選んでいるタスクをもう一度選んでも履歴は積まない
  const onSelectTask = useCallback(
    (id: string) => {
      if (route.kind === "task" && route.id === id) return;
      history.pushState(null, "", dayHref(taskPath(id), day ?? null));
      setFreshTaskId(null);
      setRoute({ kind: "task", id });
    },
    [route, day],
  );

  const onLogout = useCallback(() => {
    void logout().then((ok) => {
      // 失敗したときは、ログイン済みの表示のままにする（サーバー側で失効したと誤解させない）
      if (ok) {
        detailCache.clear();
        setAuth({ state: "signed-out" });
      }
    });
  }, [detailCache]);

  const onUnauthorized = useCallback(() => {
    detailCache.clear();
    setAuth({ state: "signed-out" });
  }, [detailCache]);

  const href = loginHref(typeof location === "undefined" ? "/dashboard/" : location.pathname);
  const user = <AuthView auth={auth} loginHref={href} onLogout={onLogout} />;

  return (
    <main className="shell">
      {auth.state === "signed-in" ? (
        <Workspace
          route={route}
          scope={scope}
          onScopeChange={setScope}
          day={day}
          onDayChange={onDayChange}
          onTaskSettled={onTaskSettled}
          onSelectTask={onSelectTask}
          detailCache={detailCache}
          freshTaskId={freshTaskId}
          onUnauthorized={onUnauthorized}
          user={user}
        />
      ) : (
        <>
          <Header summary={null}>{user}</Header>
          <div className="state">
            <h1>{route.kind === "task" ? "タスクの詳細" : "ダッシュボード"}</h1>
            {auth.state === "loading" ? null : (
              <p>
                {route.kind === "task"
                  ? "ログインすると、このタスクの詳細を見られます。"
                  : "ログインすると、今日のタスクと費用を見られます。"}
              </p>
            )}
          </div>
        </>
      )}
    </main>
  );
}
