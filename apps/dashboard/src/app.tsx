import type { TaskDetailDto } from "@rovo/dashboard-contract";
import { useCallback, useEffect, useState } from "react";
import type { Scope } from "./api";
import { AuthView } from "./auth-view";
import { type DayKey, dayHref, dayOfTask, routeDay, shiftDay } from "./day";
import { createDetailCache } from "./detail-cache";
import { Header } from "./header";
import { LangProvider, useT } from "./lang";
import {
  clearLoginErrorFromUrl,
  hasLoginError,
  loginErrorMessage,
  readLoginErrorCode,
} from "./login-error";
import { LoginView } from "./login-view";
import { parseRoute, type Route, taskPath } from "./route";
import { type AuthState, fetchMe, loginHref, logout } from "./session";
import { useNarrow } from "./use-narrow";
import { Workspace } from "./workspace";

/**
 * ダッシュボード。ログインの確認（M4）→ ログイン済みなら骨格（Workspace）、そうでなければログインの案内。
 * 個別ページは無い。`/dashboard/tasks/<ULID>` は一覧の画面で、そのタスクを選んだ状態（MCP の dashboard_url の行き先）。
 * 表示する日はそのタスクが始まった日（URL は置き換えず、リロード・共有でも同じタスクが開く）。
 * レール・タイムラインでの切り替えと日付の前後送りは、ページを読み直さず history.pushState で URL を変え、popstate に追従する。
 * 修飾キー付き・中クリックは通常のリンクのまま（ブラウザが新しいタブで開く）。
 * ?fresh=1 は、URL を直接開いたときのそのタスクの最初の取得だけ（切り替えとポーリングには付けない。D6）。
 * 表示の言語（英語が既定。日本語に切り替えられる）は LangProvider が持つ。
 */
export function App() {
  return (
    <LangProvider>
      <Dashboard />
    </LangProvider>
  );
}

function Dashboard() {
  const t = useT();
  const narrow = useNarrow();
  const [auth, setAuth] = useState<AuthState>({ state: "loading" });
  // 既定は「マイタスク」（scope = me。切り替えは使える）
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

  // ログインに失敗して戻ってきたときの code（?login_error= を許可リストで引く。読んだらクエリは消す）。
  // 文は表示のたびに言語で引く（言語を切り替えたら文も変わる）
  const [loginErrorCode] = useState(() =>
    typeof location === "undefined" ? null : readLoginErrorCode(location.search),
  );
  useEffect(() => {
    if (hasLoginError(location.search)) clearLoginErrorFromUrl();
  }, []);

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
      // 一覧から選んだ印（狭い幅の「← 一覧」は、印があれば履歴を戻る）
      history.pushState({ from: "list" }, "", dayHref(taskPath(id), day ?? null));
      setFreshTaskId(null);
      setRoute({ kind: "task", id });
    },
    [route, day],
  );

  // 狭い幅の詳細の「← 一覧」。日付の前後送りと同じ流儀で pushState（見ている日は残す）。戻るで詳細に戻れる
  const onBack = useCallback(() => {
    // 一覧から選んで開いたなら履歴を戻る（[一覧, 詳細, 一覧] と積まない。route は popstate が更新する）
    if ((history.state as { from?: string } | null)?.from === "list") {
      history.back();
      return;
    }
    history.pushState(null, "", dayHref("/dashboard/", day ?? null));
    setFreshTaskId(null);
    setRoute({ kind: "overview" });
  }, [day]);

  // 「チーム」をもう一度押す: タスクを選んでいるなら選択を外してチームボードに戻る（見ている日は残す）
  const onScopeChange = useCallback(
    (next: Scope) => {
      if (next === scope && next === "all" && route.kind === "task") {
        history.pushState(null, "", dayHref("/dashboard/", day ?? null));
        setFreshTaskId(null);
        setRoute({ kind: "overview" });
        return;
      }
      // 狭い幅の詳細でスコープを押したら、一覧へ移る
      if (narrow && route.kind === "task") {
        history.pushState(null, "", dayHref("/dashboard/", day ?? null));
        setFreshTaskId(null);
        setRoute({ kind: "overview" });
      }
      setScope(next);
    },
    [scope, route.kind, day, narrow],
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
          onScopeChange={onScopeChange}
          day={day}
          onDayChange={onDayChange}
          onTaskSettled={onTaskSettled}
          onSelectTask={onSelectTask}
          onBack={onBack}
          detailCache={detailCache}
          freshTaskId={freshTaskId}
          onUnauthorized={onUnauthorized}
          user={user}
        />
      ) : (
        <>
          {/* 未ログインのヘッダにログインのリンクは出さない（画面の中のボタンと重複させない） */}
          <Header summary={null}>{null}</Header>
          {auth.state === "loading" ? null : (
            <LoginView
              variant={auth.state === "error" ? "error" : "signed-out"}
              taskDetail={route.kind === "task"}
              loginHref={href}
              message={loginErrorMessage(loginErrorCode, t)}
              onReload={() => location.reload()}
            />
          )}
        </>
      )}
    </main>
  );
}
