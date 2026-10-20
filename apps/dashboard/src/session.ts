/** ブラウザ側のセッションの確認・ログアウト（gateway の /dashboard/api/me・/logout）。GitHub のトークンは扱わない。 */

export type AuthState =
  | { state: "loading" }
  | { state: "signed-out" }
  | { state: "signed-in"; login: string }
  /** 確認できなかった（障害・別サイトの扱い・壊れた応答）。ログイン済みとは見なさない */
  | { state: "error" };

const ME = "/dashboard/api/me";
const LOGOUT = "/dashboard/api/logout";
const LOGIN = "/dashboard/auth/login";
const TASK_PATH_RE = /^\/dashboard\/tasks\/[0-9A-HJKMNP-TV-Z]{26}$/;

export async function fetchMe(fetchImpl: typeof fetch = fetch): Promise<AuthState> {
  try {
    const res = await fetchImpl(ME, {
      credentials: "same-origin",
      headers: { accept: "application/json" },
    });
    if (res.status === 401) return { state: "signed-out" };
    if (res.status !== 200) return { state: "error" };
    const body = (await res.json()) as { login?: unknown };
    return typeof body.login === "string"
      ? { state: "signed-in", login: body.login }
      : { state: "error" };
  } catch {
    return { state: "error" };
  }
}

/** ログアウト。成功（204）なら true。 */
export async function logout(fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    const res = await fetchImpl(LOGOUT, { method: "POST", credentials: "same-origin" });
    return res.status === 204;
  } catch {
    return false;
  }
}

/**
 * ログインのリンク。タスク詳細を開いていたら戻り先として付ける（サーバー側でも同じ形だけを通す）。
 * それ以外は付けず、既定の戻り先（/dashboard/）になる。
 */
export function loginHref(pathname: string): string {
  return TASK_PATH_RE.test(pathname) ? `${LOGIN}?return_to=${encodeURIComponent(pathname)}` : LOGIN;
}
