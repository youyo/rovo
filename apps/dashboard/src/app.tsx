import { useCallback, useEffect, useMemo, useState } from "react";
import type { Scope } from "./api";
import { AuthView } from "./auth-view";
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
