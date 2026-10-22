import { useCallback, useEffect, useMemo, useState } from "react";
import type { Scope } from "./api";
import { AuthView } from "./auth-view";
import { OverviewScreen } from "./overview-screen";
import { parseRoute } from "./route";
import { type AuthState, fetchMe, loginHref, logout } from "./session";
import { TaskScreen } from "./task-screen";

const SCOPES: { value: Scope; label: string }[] = [
  { value: "all", label: "全員" },
  { value: "me", label: "自分" },
];

/**
 * 一覧（M6）と詳細（M8）。ログインの確認（M4）→ `/dashboard/tasks/<ULID>` なら詳細、それ以外は今日のタスクと費用。
 * 画面の切り替えは通常のリンク（全リロード）で、ブラウザの履歴は使わない。
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
  const signedIn = auth.state === "signed-in";
  return (
    <main className="shell">
      <header className="top">
        <div className="brand">rovo</div>
        {route.kind === "task" ? (
          <a className="back" href="/dashboard/">
            ダッシュボードに戻る
          </a>
        ) : null}
        {signedIn && route.kind === "overview" ? (
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
      {signedIn && route.kind === "task" ? (
        <TaskScreen id={route.id} onUnauthorized={onUnauthorized} />
      ) : signedIn ? (
        <OverviewScreen scope={scope} onUnauthorized={onUnauthorized} />
      ) : (
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
      )}
    </main>
  );
}
