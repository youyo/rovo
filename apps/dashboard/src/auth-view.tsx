import { useT } from "./lang";
import type { AuthState } from "./session";
import { useNarrow } from "./use-narrow";

/** 頭文字（丸に入れる 1 文字） */
function initialOf(login: string): string {
  return (Array.from(login)[0] ?? "").toUpperCase();
}

/** ログインの状態の表示（最小）。login は React が文字として出力する（HTML として解釈しない）。 */
export function AuthView(props: { auth: AuthState; loginHref: string; onLogout?: () => void }) {
  const { auth } = props;
  const t = useT();
  const narrow = useNarrow();
  if (auth.state === "loading") return <p>{t("auth.checking")}</p>;
  if (auth.state === "signed-in") {
    // 狭い画面では頭文字の丸（summary）に畳み、開くと名前とログアウトが出る
    if (narrow) {
      return (
        <details className="user-menu">
          <summary aria-label={auth.login}>
            <span aria-hidden="true">{initialOf(auth.login)}</span>
          </summary>
          <p>
            <span>{auth.login}</span>{" "}
            <button type="button" onClick={props.onLogout}>
              {t("auth.signOut")}
            </button>
          </p>
        </details>
      );
    }
    return (
      <p>
        <span>{auth.login}</span>{" "}
        <button type="button" onClick={props.onLogout}>
          {t("auth.signOut")}
        </button>
      </p>
    );
  }
  return (
    <p>
      {auth.state === "error" ? <span>{t("auth.checkFailed")} </span> : null}
      <a href={props.loginHref}>{t("auth.signIn")}</a>
    </p>
  );
}
