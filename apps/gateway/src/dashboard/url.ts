import { isTaskId } from "../tasks/ulid";

/**
 * タスクの詳細ページ（ダッシュボード）の URL（docs/specs/dashboard.md D16・M10）。
 * 形は `${PUBLIC_BASE_URL}/dashboard/tasks/<task_id>`。task_start / task_status / task_result の応答の `dashboard_url` になる。
 *
 * 作れないときは undefined を返す。呼び出し側は null ではなく、キー自体を付けない:
 * - PUBLIC_BASE_URL が空・文字列でない・不正
 * - task_id が ULID（26 文字の Crockford base32）でない
 *
 * URL 自体は秘密ではない。閲覧権限が無い人が開いても、ダッシュボードの詳細は 404 になるだけ。
 * ログイン後に同じ詳細へ戻る仕組みは dashboard/auth.ts の safeReturnTo（`/dashboard/tasks/<ULID>` の形だけを通す）。
 */

/**
 * 末尾の `/` を除いた PUBLIC_BASE_URL の形: `http(s)://<host>[:<port>]` だけ。
 * パス・クエリ・フラグメント・認証情報（`user@`）・バックスラッシュ・空白や制御文字は通さない
 * （ダッシュボードは Worker のルート直下の `/dashboard` なので、基底にパスがあると URL が合わない）。
 */
const BASE_URL_RE = /^https?:\/\/[^\s/?#\\@]+$/i;

/**
 * PUBLIC_BASE_URL を、末尾の `/` を除いた origin の文字列にする。不正なら undefined。
 * 末尾の `/` の除き方は OAuthProvider の issuer（index.ts の getProvider）と同じ（`/\/+$/`）。
 * 設定された文字列はそのまま使う（`new URL().origin` で正規化し直すと、設定した形と変わりうる）。
 */
function baseOrigin(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const base = raw.replace(/\/+$/, "");
  if (!BASE_URL_RE.test(base)) return undefined;
  try {
    // ホスト・ポートの妥当性（例: ポートが範囲外・ホストが空）は URL の解析に任せる
    const url = new URL(base);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    if (url.pathname !== "/" || url.search !== "" || url.hash !== "") return undefined;
    if (url.username !== "" || url.password !== "") return undefined;
  } catch {
    return undefined;
  }
  return base;
}

export function dashboardUrl(
  env: { PUBLIC_BASE_URL?: string | undefined },
  taskId: string,
): string | undefined {
  if (!isTaskId(taskId)) return undefined;
  const base = baseOrigin(env.PUBLIC_BASE_URL);
  if (base === undefined) return undefined;
  return `${base}/dashboard/tasks/${taskId}`;
}
