import type { AuthState } from "./session";

/** ログインの状態の表示（最小）。login は React が文字として出力する（HTML として解釈しない）。 */
export function AuthView(props: { auth: AuthState; loginHref: string; onLogout?: () => void }) {
  const { auth } = props;
  if (auth.state === "loading") return <p>確認中…</p>;
  if (auth.state === "signed-in") {
    return (
      <p>
        <span>{auth.login}</span>{" "}
        <button type="button" onClick={props.onLogout}>
          ログアウト
        </button>
      </p>
    );
  }
  return (
    <p>
      {auth.state === "error" ? <span>ログイン状態を確認できませんでした。 </span> : null}
      <a href={props.loginHref}>GitHub でログイン</a>
    </p>
  );
}
