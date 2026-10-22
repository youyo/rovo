import { useCallback, useEffect, useMemo, useState } from "react";
import type { Scope } from "./api";
import { AuthView } from "./auth-view";
import { type DayKey, dayHref, resolveDay, shiftDay } from "./day";
import { Header } from "./header";
import { parseRoute } from "./route";
import { type AuthState, fetchMe, loginHref, logout } from "./session";
import { Workspace } from "./workspace";

/**
 * ダッシュボード。ログインの確認（M4）→ ログイン済みなら骨格（Workspace）、そうでなければログインの案内。
 * `/dashboard/tasks/<ULID>` なら詳細、それ以外は一覧。画面の切り替えは通常のリンク（全リロード）で、ブラウザの履歴は使わない。
 */
export function App() {
  const [auth, setAuth] = useState<AuthState>({ state: "loading" });
  const [scope, setScope] = useState<Scope>("all");
  // 表示する日は URL の ?day=（無ければ今日）。前後送りは履歴に積む（戻るで元の日へ）
  const [day, setDay] = useState<DayKey>(() =>
    resolveDay(typeof location === "undefined" ? "" : location.search, Date.now()),
  );
  const route = useMemo(
    () => parseRoute(typeof location === "undefined" ? "/dashboard/" : location.pathname),
    [],
  );

  useEffect(() => {
    let alive = true;
    void fetchMe().then((next) => {
      if (alive) setAuth(next);
    });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const onPop = () => setDay(resolveDay(location.search, Date.now()));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const onDayChange = useCallback(
    (move: -1 | 1 | "today") => {
      const now = Date.now();
      const next = move === "today" ? null : shiftDay(day, move, now);
      history.pushState(null, "", dayHref(location.pathname, next));
      setDay(next);
    },
    [day],
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
      {auth.state === "signed-in" ? (
        <Workspace
          route={route}
          scope={scope}
          onScopeChange={setScope}
          day={day}
          onDayChange={onDayChange}
          onUnauthorized={onUnauthorized}
          user={user}
        />
      ) : (
        <>
          <Header route={route} summary={null}>
            {user}
          </Header>
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
