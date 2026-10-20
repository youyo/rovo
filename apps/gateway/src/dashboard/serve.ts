import { isTaskId } from "../tasks/ulid";
import { handleLogout, handleMe, startDashboardLogin } from "./auth";
import { fetchSiteGate, jsonResponse } from "./guard";

/**
 * ダッシュボード（読み取り専用の SPA）の配信（docs/specs/dashboard.md D11）。
 *
 * assets は `run_worker_first: true` なので、すべてのリクエストがまず Worker に来る。ここは `/dashboard` と
 * `/dashboard/*` だけを扱い、それ以外（/mcp・/authorize・/.well-known/...）は呼び出し側が OAuthProvider に渡す。
 * SPA のフォールバック（どのパスで index.html を返すか）は assets に任せず、この 1 か所で決める
 * （not_found_handling は使わない）。
 */

const PREFIX = "/dashboard";

/** HTML の CSP。style-src 'self' に合わせ、<style> 要素とマークアップの style 属性は作らない（dist の検査で固定）。 */
const HTML_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

const IMMUTABLE = "public, max-age=31536000, immutable";

/** assets 配下で許すパス（`/dashboard/assets/` のあと）。`..` や `//`・エスケープされた区切りは ASSETS に渡さない。 */
const ASSET_PATH_RE = /^\/dashboard\/assets\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/;

/** `/dashboard` 本体と `/dashboard/` 配下か。`/dashboardx` のような接頭辞だけ同じパスは含めない。 */
export function isDashboardPath(pathname: string): boolean {
  return pathname === PREFIX || pathname.startsWith(`${PREFIX}/`);
}

function plain(status: number, extra: HeadersInit = {}): Response {
  return new Response(status === 404 ? "not found" : "unavailable", {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
      ...extra,
    },
  });
}

/**
 * `/dashboard/api` と配下。入口で Sec-Fetch-Site を検査し（ルートの有無を漏らさないよう、ルーティングより前）、
 * そのあと /me・/logout だけを扱う。M5 で読み取り API を足すまで、それ以外は JSON の 404。CORS ヘッダは出さない。
 */
async function handleApi(request: Request, env: Env, pathname: string): Promise<Response> {
  const blocked = fetchSiteGate(request, env);
  if (blocked) return blocked;
  const method = request.method.toUpperCase();
  try {
    if (pathname === `${PREFIX}/api/me`) {
      if (method === "GET" || method === "HEAD") return await handleMe(request, env);
      return jsonResponse(405, { error: "method_not_allowed" }, { allow: "GET, HEAD" });
    }
    if (pathname === `${PREFIX}/api/logout`) {
      if (method === "POST") return await handleLogout(request, env);
      return jsonResponse(405, { error: "method_not_allowed" }, { allow: "POST" });
    }
  } catch (error) {
    // UserDO などの障害。内容（スタック・トークン）は出さない
    console.error("dashboard_api_error", error instanceof Error ? error.name : typeof error);
    return jsonResponse(503, { error: "unavailable" });
  }
  return jsonResponse(404, { error: "not_found" });
}

/** SPA の index.html。dist 直下の index.html は "/" で取る（/index.html は / へリダイレクトされうる）。 */
async function serveIndex(request: Request, env: Env): Promise<Response> {
  const origin = new URL(request.url).origin;
  let upstream: Response | undefined;
  try {
    upstream = await env.ASSETS?.fetch(new Request(`${origin}/`, { method: "GET" }));
  } catch {
    upstream = undefined;
  }
  // 未ビルドなどで取れないときは、HTML の代わりに 503（内部の詳細は出さない）
  if (upstream?.status !== 200) {
    await upstream?.body?.cancel();
    return plain(503);
  }
  return new Response(request.method === "HEAD" ? null : upstream.body, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": HTML_CSP,
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "cache-control": "no-store",
    },
  });
}

/** ハッシュ付きの静的ファイル。ファイルが無ければ 404 で、index.html は返さない。 */
async function serveAsset(request: Request, env: Env, pathname: string): Promise<Response> {
  if (!ASSET_PATH_RE.test(pathname) || pathname.split("/").includes("..")) return plain(404);
  const origin = new URL(request.url).origin;
  // assets のパスは dist 直下から（Vite の base は /dashboard/ だが、出力は dist/assets/...）。接頭辞を剥がして渡す。
  let upstream: Response | undefined;
  try {
    upstream = await env.ASSETS?.fetch(
      new Request(`${origin}${pathname.slice(PREFIX.length)}`, { method: "GET" }),
    );
  } catch {
    upstream = undefined;
  }
  if (!upstream) return plain(503);
  if (upstream.status !== 200) {
    await upstream.body?.cancel();
    return plain(404);
  }
  const headers = new Headers();
  const type = upstream.headers.get("content-type");
  if (type) headers.set("content-type", type);
  headers.set("x-content-type-options", "nosniff");
  headers.set("cache-control", IMMUTABLE);
  return new Response(request.method === "HEAD" ? null : upstream.body, { status: 200, headers });
}

/** `/dashboard` と `/dashboard/*` のリクエストを処理する（呼び出し側が isDashboardPath で振り分ける）。 */
export async function handleDashboard(request: Request, env: Env): Promise<Response> {
  const { pathname } = new URL(request.url);

  if (pathname === `${PREFIX}/api` || pathname.startsWith(`${PREFIX}/api/`)) {
    return handleApi(request, env, pathname);
  }

  // ログインの開始（ナビゲーション。クロスサイトのリンクから開かれても害はない: state + 専用 Cookie で守る）
  if (pathname === `${PREFIX}/auth/login`) return startDashboardLogin(request, env);

  if (request.method !== "GET" && request.method !== "HEAD") {
    return plain(405, { allow: "GET, HEAD" });
  }

  if (pathname === PREFIX || pathname === `${PREFIX}/`) return serveIndex(request, env);

  const taskPrefix = `${PREFIX}/tasks/`;
  if (pathname.startsWith(taskPrefix) && isTaskId(pathname.slice(taskPrefix.length))) {
    return serveIndex(request, env);
  }

  if (pathname.startsWith(`${PREFIX}/assets/`)) return serveAsset(request, env, pathname);

  return plain(404);
}
