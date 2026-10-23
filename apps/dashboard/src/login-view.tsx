import { useT } from "./lang";

/** 未ログインの画面（カード 1 つを中央に）。ロゴ・見出し・説明・ログインのボタン・補足。 */
export function LoginView(props: {
  /** signed-out = 未ログイン、error = ログインの状態を確認できなかった */
  variant: "signed-out" | "error";
  /** タスク詳細の URL から来たとき（説明の文が変わる） */
  taskDetail: boolean;
  loginHref: string;
  /** ログインに失敗して戻ってきたときの文（許可リストから引いた固定の文。無ければ null） */
  message: string | null;
  onReload?: () => void;
}) {
  const t = useT();
  return (
    <section className="login" aria-labelledby="login-title">
      <div className="login-card">
        <img
          className="brand-mark"
          src="/dashboard/assets/brand/rovo-mark.svg"
          alt=""
          width={80}
          height={80}
        />
        <h1 id="login-title">{t("login.title")}</h1>
        <p className="login-lead">
          {props.taskDetail ? t("login.leadTask") : t("login.leadOverview")}
        </p>
        {props.message !== null ? (
          <p className="login-alert" role="alert">
            {props.message}
          </p>
        ) : null}
        {props.variant === "error" ? (
          <p className="login-alert" role="alert">
            {t("login.statusFailed")}
          </p>
        ) : null}
        <div className="login-actions">
          <a className="login-button" href={props.loginHref}>
            <svg
              className="login-gh"
              viewBox="0 0 16 16"
              width="18"
              height="18"
              aria-hidden="true"
              focusable="false"
            >
              <path
                fill="currentColor"
                d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z"
              />
            </svg>
            {t("auth.signIn")}
          </a>
          {props.variant === "error" ? (
            <button type="button" className="login-secondary" onClick={props.onReload}>
              {t("login.reload")}
            </button>
          ) : null}
        </div>
        <p className="login-note">{t("login.note")}</p>
      </div>
    </section>
  );
}
