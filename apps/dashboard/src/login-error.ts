import type { T } from "./i18n";

/**
 * ログインの失敗の表示。gateway の callback は失敗を `/dashboard/?login_error=<code>` へ 303 で戻す。
 * code は固定の許可リストだけ（gateway の LoginErrorCode と同じ 3 つ）。それ以外の値は無視し、画面に値を出さない。
 * 文は辞書（loginError.<code>）から引き、言語を切り替えたら引き直す。
 */
const CODES = Object.freeze(["denied", "invalid", "unavailable"] as const);
// denied: GitHub 側で拒否した、または許可ルール（アカウント・組織）に当たらない
// invalid: state の不正・期限切れ・code が無い
// unavailable: GitHub に問い合わせられない
export type LoginErrorCode = (typeof CODES)[number];

const PARAM = "login_error";

/** 許可リストに当たる code だけを返す（Object のプロパティ名も通さない）。無ければ null。 */
export function loginErrorCode(code: string | null): LoginErrorCode | null {
  return CODES.find((c) => c === code) ?? null;
}

/** code を表示言語の文に引く。許可リストに無ければ null。 */
export function loginErrorMessage(code: string | null, t: T): string | null {
  const known = loginErrorCode(code);
  return known === null ? null : t(`loginError.${known}`);
}

/** URL のクエリから login_error の code を読む（無い・未知の値は null）。 */
export function readLoginErrorCode(search: string): LoginErrorCode | null {
  return loginErrorCode(new URLSearchParams(search).get(PARAM));
}

/** URL に login_error が付いているか。 */
export function hasLoginError(search: string): boolean {
  return new URLSearchParams(search).has(PARAM);
}

/** login_error だけをクエリから消す（履歴は積まない。パス・ほかのクエリ・ハッシュは残す）。 */
export function clearLoginErrorFromUrl(): void {
  const url = new URL(location.href);
  if (!url.searchParams.has(PARAM)) return;
  url.searchParams.delete(PARAM);
  history.replaceState(history.state, "", `${url.pathname}${url.search}${url.hash}`);
}
