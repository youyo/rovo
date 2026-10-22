import { useCallback, useEffect, useState } from "react";
import type { Scope } from "./api";
import { AuthView } from "./auth-view";
import { type DayKey, dayHref, dayOfTask, resolveDay, shiftDay } from "./day";
import { fetchTaskDetail } from "./detail-api";
import { Header } from "./header";
import { parseRoute, type Route } from "./route";
import { type AuthState, fetchMe, loginHref, logout } from "./session";
import { Workspace } from "./workspace";

/**
 * ダッシュボード。ログインの確認（M4）→ ログイン済みなら骨格（Workspace）、そうでなければログインの案内。
 * 個別ページは無い。`/dashboard/tasks/<ULID>` は一覧の画面で、そのタスクを選んだ状態（MCP の dashboard_url の行き先）。
 * 表示する日はそのタスクが始まった日（URL は置き換えず、リロード・共有でも同じタスクが開く）。
 * 画面の切り替えは通常のリンク（全リロード）。履歴を使うのは日付の前後送りだけ。
 */
export function App() {
  const [auth, setAuth] = useState<AuthState>({ state: "loading" });
  const [scope, setScope] = useState<Scope>("all");
  const [route, setRoute] = useState<Route>(() =>
    parseRoute(typeof location === "undefined" ? "/dashboard/" : location.pathname),
  );
  // 表示する日。一覧は URL の ?day=（無ければ今日）。タスクの URL は、タスクの詳細が取れるまで決まらない（undefined）
  const [day, setDay] = useState<DayKey | undefined>(() =>
    route.kind === "task"
      ? undefined
      : resolveDay(typeof location === "undefined" ? "" : location.search, Date.now()),
  );
  const taskId = route.kind === "task" ? route.id : null;

  useEffect(() => {
    let alive = true;
    void fetchMe().then((next) => {
      if (alive) setAuth(next);
    });
    return () => {
      alive = false;
    };
  }, []);

  // タスクの URL: そのタスクが始まった日を詳細から決める。取れないとき（404・失敗）は今日（コンソールが状態を出す）
  const signedIn = auth.state === "signed-in";
  const dayPending = day === undefined;
  useEffect(() => {
    if (!signedIn || !dayPending || taskId === null) return;
    let alive = true;
    void fetchTaskDetail(taskId).then((r) => {
      if (!alive) return;
      if (r.kind === "unauthorized") setAuth({ state: "signed-out" });
      else setDay(r.kind === "ok" ? dayOfTask(r.data.task, Date.now()) : null);
    });
    return () => {
      alive = false;
    };
  }, [signedIn, dayPending, taskId]);

  useEffect(() => {
    const onPop = () => {
      const next = parseRoute(location.pathname);
      setRoute(next);
      setDay(next.kind === "task" ? undefined : resolveDay(location.search, Date.now()));
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
      setRoute({ kind: "overview" });
      setDay(next);
    },
    [day, route.kind],
  );

  const onLogout = useCallback(() => {
    void logout().then((ok) => {
      // 失敗したときは、ログイン済みの表示のままにする（サーバー側で失効したと誤解させない）
      if (ok) setAuth({ state: "signed-out" });
    });
  }, []);

  const onUnauthorized = useCallback(() => setAuth({ state: "signed-out" }), []);

  const href = loginHref(typeof location === "undefined" ? "/dashboard/" : location.pathname);
  const user = <AuthView auth={auth} loginHref={href} onLogout={onLogout} />;

  return (
    <main className="shell">
      {auth.state === "signed-in" && day === undefined ? (
        <>
          <Header summary={null}>{user}</Header>
          <div className="state">
            <h1>ダッシュボード</h1>
            <p role="status">読み込み中…</p>
          </div>
        </>
      ) : auth.state === "signed-in" ? (
        <Workspace
          route={route}
          scope={scope}
          onScopeChange={setScope}
          day={day ?? null}
          onDayChange={onDayChange}
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
