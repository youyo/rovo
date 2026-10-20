import { useCallback, useEffect, useState } from "react";
import { AuthView } from "./auth-view";
import { type AuthState, fetchMe, loginHref, logout } from "./session";

/** M4: ログインとログアウトだけ。中身のある画面は M6 以降。 */
export function App() {
  const [auth, setAuth] = useState<AuthState>({ state: "loading" });

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

  const href = loginHref(typeof location === "undefined" ? "/dashboard/" : location.pathname);
  return (
    <main className="shell">
      <h1>ダッシュボード</h1>
      <AuthView auth={auth} loginHref={href} onLogout={onLogout} />
      <p>準備中</p>
    </main>
  );
}
