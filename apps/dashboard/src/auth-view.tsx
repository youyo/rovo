import { useT } from "./lang";
import type { AuthState } from "./session";

/** ログインの状態の表示（最小）。login は React が文字として出力する（HTML として解釈しない）。 */
export function AuthView(props: { auth: AuthState; loginHref: string; onLogout?: () => void }) {
  const { auth } = props;
  const t = useT();
  if (auth.state === "loading") return <p>{t("auth.checking")}</p>;
  if (auth.state === "signed-in") {
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
