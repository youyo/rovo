import { useCallback, useEffect, useState } from "react";
import type { Scope } from "./api";
import { AuthView } from "./auth-view";
import { OverviewScreen } from "./overview-screen";
import { type AuthState, fetchMe, loginHref, logout } from "./session";

const SCOPES: { value: Scope; label: string }[] = [
  { value: "all", label: "全員" },
  { value: "me", label: "自分" },
];

/** 一覧（M6）。ログインの確認（M4）→ 今日のタスクと費用。期間は「今日」だけ。 */
export function App() {
  const [auth, setAuth] = useState<AuthState>({ state: "loading" });
  const [scope, setScope] = useState<Scope>("all");

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
  const signedIn = auth.state === "signed-in";
  return (
    <main className="shell">
      <header className="top">
        <div className="brand">rovo</div>
        {signedIn ? (
          <>
            <fieldset className="seg" aria-label="表示するタスク">
              {SCOPES.map((s) => (
                <button
                  key={s.value}
                  type="button"
                  aria-pressed={scope === s.value}
                  onClick={() => setScope(s.value)}
                >
                  {s.label}
                </button>
              ))}
            </fieldset>
            <fieldset className="period" aria-label="期間">
              <span aria-current="true">今日</span>
            </fieldset>
          </>
        ) : null}
        <div className="grow" />
        <div className="user">
          <AuthView auth={auth} loginHref={href} onLogout={onLogout} />
        </div>
      </header>
      {signedIn ? (
        <OverviewScreen scope={scope} onUnauthorized={onUnauthorized} />
      ) : (
        <div className="state">
          <h1>ダッシュボード</h1>
          {auth.state === "loading" ? null : (
            <p>ログインすると、今日のタスクと費用を見られます。</p>
          )}
        </div>
      )}
    </main>
  );
}
