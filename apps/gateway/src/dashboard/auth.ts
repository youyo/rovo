import { auditFromWorker } from "../audit-sink";
import { type LoginConfig, loadConfig, verifyIdentity } from "../auth/identity";
import { importEncryptionKey } from "../github/crypto";
import { isTaskId } from "../tasks/ulid";
import { jsonResponse } from "./guard";
import {
  clearLoginCookie,
  clearSessionCookie,
  LOGIN_COOKIE,
  LOGIN_TTL_SECONDS,
  loginCookie,
  openSession,
  randomToken,
  readCookie,
  SESSION_ABSOLUTE_MS,
  SESSION_COOKIE,
  sealSession,
  sessionCookie,
} from "./session";

/**
 * ダッシュボードのブラウザのログイン（docs/specs/dashboard.md D2・D3・M4）。
 *
 * GitHub App の callback URL は `/callback` の 1 本だけなので、URL は MCP のログインと共有し、
 * **state の接頭辞（rovo-dash.）だけ**で振り分ける。OAuthProvider の state は base64url（32 バイト = 43 文字）で `.` を含まない
 * ので衝突しない（test/unit/worker.test.ts で固定）。接頭辞が付いていれば必ずここに入り、KV・Cookie の不一致・期限切れ・
 * 再使用はすべて 400（fail closed）。MCP の経路（finishUpstream）には落とさない。
 */

/** ダッシュボード由来の state の接頭辞。 */
export const DASH_STATE_PREFIX = "rovo-dash.";
/** state の記録の KV キー。OAuthProvider の `transaction:` とは別の接頭辞。 */
export const DASH_STATE_KV_PREFIX = "dash-state:";

const STATE_RE = /^rovo-dash\.[A-Za-z0-9_-]{43}$/;
const DEFAULT_RETURN = "/dashboard/";

const NO_STORE_TEXT = {
  "content-type": "text/plain; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
} as const;

/** /callback の state が接頭辞付きか。複数の state のどれかが接頭辞付きなら true（MCP の経路に落とさない）。 */
export function isDashboardState(url: URL): boolean {
  return url.searchParams.getAll("state").some((s) => s.startsWith(DASH_STATE_PREFIX));
}

/**
 * ログイン後の戻り先。ダッシュボードの正規のパス（/dashboard・/dashboard/・/dashboard/tasks/<ULID>）だけを通し、
 * それ以外はすべて既定（/dashboard/）に倒す。外部 URL・プロトコル相対・バックスラッシュ・`..` は通らない。
 */
export function safeReturnTo(raw: string | null): string {
  if (raw === null) return DEFAULT_RETURN;
  if (raw === "/dashboard" || raw === "/dashboard/") return raw;
  const prefix = "/dashboard/tasks/";
  if (raw.startsWith(prefix) && isTaskId(raw.slice(prefix.length))) return raw;
  return DEFAULT_RETURN;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** KV に置く state の記録。Cookie の値そのものは保存せず、ハッシュだけ。 */
interface StateRecord {
  bindingHash: string;
  returnTo: string;
  expiresAt: number;
}

function parseRecord(raw: string | null): StateRecord | null {
  if (raw === null) return null;
  try {
    const v = JSON.parse(raw) as Partial<StateRecord>;
    if (
      typeof v.bindingHash !== "string" ||
      typeof v.returnTo !== "string" ||
      typeof v.expiresAt !== "number"
    ) {
      return null;
    }
    return { bindingHash: v.bindingHash, returnTo: v.returnTo, expiresAt: v.expiresAt };
  } catch {
    return null;
  }
}

function text(status: number, body: string, cookies: string[] = []): Response {
  const headers = new Headers(NO_STORE_TEXT);
  for (const c of cookies) headers.append("set-cookie", c);
  return new Response(body, { status, headers });
}

/**
 * GET /dashboard/auth/login: state と専用 Cookie を発行して GitHub の認可画面へ。
 * state は 1 回限り・10 分。Cookie（__Host-rovo_dash_login）が開始したブラウザと state を結ぶ（ログイン CSRF の対策）。
 */
export async function startDashboardLogin(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET") {
    return methodNotAllowed();
  }
  const config = loadConfig(env, {});
  try {
    // 後で Cookie を作れない設定なら、GitHub へ行かせない
    await importEncryptionKey(env.TOKEN_ENC_KEY);
  } catch {
    return misconfigured();
  }
  if (!config) return misconfigured();

  const state = `${DASH_STATE_PREFIX}${randomToken()}`;
  const binding = randomToken();
  const returnTo = safeReturnTo(new URL(request.url).searchParams.get("return_to"));
  const record: StateRecord = {
    bindingHash: await sha256Hex(binding),
    returnTo,
    expiresAt: Date.now() + LOGIN_TTL_SECONDS * 1000,
  };
  try {
    await env.OAUTH_KV.put(`${DASH_STATE_KV_PREFIX}${state}`, JSON.stringify(record), {
      expirationTtl: LOGIN_TTL_SECONDS,
    });
  } catch {
    console.error("dashboard_login_state_put_failed");
    return text(503, "login is not available");
  }
  const headers = new Headers({
    location: config.client.authorizeUrl({ redirectUri: config.redirectUri, state }),
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
  });
  headers.append("set-cookie", loginCookie(binding));
  return new Response(null, { status: 302, headers });
}

function methodNotAllowed(): Response {
  const res = text(405, "method not allowed");
  res.headers.set("allow", "GET");
  return res;
}

function misconfigured(): Response {
  // 原因（どの設定が足りないか）は応答に出さない
  console.error("dashboard_login_misconfigured");
  return text(500, "login is not available");
}

/**
 * /callback の接頭辞付きの state。KV の記録・Cookie・期限・再使用を確かめ、通れば共通の身元確認 → セッション作成。
 * どの失敗でもログイン Cookie は消し、セッションは作らない。
 */
export async function finishDashboardLogin(
  request: Request,
  env: Env,
  config: LoginConfig,
): Promise<Response> {
  const url = new URL(request.url);
  const clearLogin = [clearLoginCookie()];
  const invalidState = async () => {
    await auditFromWorker(env, "auth_failed", {
      caller: "dashboard",
      reason: "dashboard_invalid_state",
    });
    return text(
      400,
      "The sign-in session is invalid or has expired. Please start again.",
      clearLogin,
    );
  };

  const states = url.searchParams.getAll("state");
  const state = states[0];
  if (states.length !== 1 || state === undefined || !STATE_RE.test(state)) return invalidState();

  // 1 回限り: 検証より先に記録を消す。不一致の試行でも消費され、同じ state で試行を重ねられない
  const key = `${DASH_STATE_KV_PREFIX}${state}`;
  const record = parseRecord(await env.OAUTH_KV.get(key));
  await env.OAUTH_KV.delete(key);
  const binding = readCookie(request.headers.get("cookie"), LOGIN_COOKIE);
  if (record === null || binding === null) return invalidState();
  if (record.expiresAt <= Date.now()) return invalidState();
  if ((await sha256Hex(binding)) !== record.bindingHash) return invalidState();

  const failed = (reason: string) =>
    auditFromWorker(env, "auth_failed", { caller: "dashboard", reason });
  if (url.searchParams.get("error")) {
    await failed("github_denied");
    return text(403, "Sign-in was denied.", clearLogin);
  }
  const code = url.searchParams.get("code");
  if (!code) {
    await failed("missing_code");
    return text(400, "The sign-in response is invalid. Please start again.", clearLogin);
  }

  // 身元確認（交換 → 本人 → 許可ルール → 資格の保存）は MCP と共通。ルールを通らなければセッションは作らない
  const identity = await verifyIdentity(env, config, code, "dashboard");
  if (!identity.ok) {
    return identity.kind === "unavailable"
      ? text(503, "GitHub is temporarily unavailable. Please try again.", clearLogin)
      : text(403, "Sign-in was denied.", clearLogin);
  }

  // セッションは常に新しく作る（ログイン前の Cookie・sid は引き継がない = セッション固定の対策）。古い sid は全部失効する
  const session = await env.USER_DO.getByName(String(identity.user.id)).createDashboardSession(
    identity.user.login,
  );
  const now = Date.now();
  let value: string;
  try {
    value = await sealSession(env.TOKEN_ENC_KEY, {
      uid: identity.user.id,
      sid: session.sid,
      ver: session.version,
      iat: now,
      exp: now + SESSION_ABSOLUTE_MS,
    });
  } catch {
    return misconfigured();
  }
  const headers = new Headers({
    location: safeReturnTo(record.returnTo), // 開始時に検証して保存した値だけを使う（callback の URL からは取らない）
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
  });
  headers.append("set-cookie", sessionCookie(value, Math.floor(SESSION_ABSOLUTE_MS / 1000)));
  headers.append("set-cookie", clearLoginCookie());
  return new Response(null, { status: 302, headers });
}

/** 許可ルールを確かめられない障害（GitHub の障害など）。呼び出し側は 503 にする（401 にするとセッションの失効と区別できない）。 */
export class DashboardUnavailableError extends Error {
  constructor() {
    super("dashboard authorization is temporarily unavailable");
    this.name = "DashboardUnavailableError";
  }
}

export interface DashboardSession {
  uid: number;
  sid: string;
  login: string;
}

/**
 * セッションの検証（認証のミドルウェア）。Cookie の復号・期限 → UserDO の記録（失効・無操作・世代）の順に確かめる。
 * 失敗の理由は区別しない（呼び出し側は一律 401）。UserDO を引けない障害・許可ルールを確かめられない障害は例外
 * （DashboardUnavailableError など）のまま投げ、呼び出し側が 503 にする。許可ルールはセッションを使うたびに確かめ直す（M5a）。
 */
export async function requireSession(request: Request, env: Env): Promise<DashboardSession | null> {
  const value = readCookie(request.headers.get("cookie"), SESSION_COOKIE);
  if (value === null) return null;
  const claims = await openSession(env.TOKEN_ENC_KEY, value, Date.now());
  if (claims === null) return null;
  // セッションの記録に加え、使うたびに今の許可ルールを確かめ直す（外れた利用者は、セッションが生きていても通さない）
  const checked = await env.USER_DO.getByName(String(claims.uid)).authorizeDashboardSession(
    claims.uid,
    claims.sid,
    claims.ver,
  );
  if (checked.ok) return { uid: claims.uid, sid: claims.sid, login: checked.login };
  // GitHub に確かめられない障害は 401 にしない（通さず、呼び出し側が 503 にする。セッションは消えない）
  if (checked.kind === "unavailable") throw new DashboardUnavailableError();
  return null;
}

const UNAUTHORIZED = () => jsonResponse(401, { error: "unauthorized" });

/** GET /dashboard/api/me: ログイン中の login だけを返す。 */
export async function handleMe(request: Request, env: Env): Promise<Response> {
  const session = await requireSession(request, env);
  if (!session) return UNAUTHORIZED();
  return jsonResponse(200, { login: session.login });
}

/**
 * POST /dashboard/api/logout: sid を失効し、Cookie を消す。セッションが無くても 204（冪等）。
 * GitHub の資格には触れない（MCP と共用のため）。クロスサイトの拒否は呼び出し側（fetchSiteGate）。
 */
export async function handleLogout(request: Request, env: Env): Promise<Response> {
  const value = readCookie(request.headers.get("cookie"), SESSION_COOKIE);
  if (value !== null) {
    const claims = await openSession(env.TOKEN_ENC_KEY, value, Date.now());
    if (claims !== null) {
      await env.USER_DO.getByName(String(claims.uid)).revokeDashboardSession(claims.sid);
    }
  }
  const headers = new Headers({
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  headers.append("set-cookie", clearSessionCookie());
  return new Response(null, { status: 204, headers });
}
