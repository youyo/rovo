import { decryptString, encryptString, importEncryptionKey } from "../github/crypto";

/**
 * ダッシュボードのブラウザセッション（docs/specs/dashboard.md D3）。
 *
 * Cookie は `{uid, sid, ver, iat, exp}` の JSON を TOKEN_ENC_KEY の AES-GCM で暗号化したもの。GitHub のトークンは入れない。
 * AAD を専用のラベルにして、MCP の資格（access / refresh）の暗号文を Cookie として差し込んでも復号できないようにする。
 * サーバー側の記録（失効・無操作の期限・ログイン世代）は UserDO の dashboard_session / dashboard_epoch にあり、
 * Cookie の復号に成功しただけではセッションとして認めない。
 */

/** セッション Cookie。`__Host-` は Secure・Path=/・Domain なしを強制する。 */
export const SESSION_COOKIE = "__Host-rovo_dash";
/** ログイン開始 Cookie（state と開始したブラウザを結ぶ）。 */
export const LOGIN_COOKIE = "__Host-rovo_dash_login";
/** Cookie の暗号化の AAD。別用途の暗号文の流用を拒否する。 */
export const SESSION_AAD = "dashboard-session-v1";

/** 絶対期限 7 日。 */
export const SESSION_ABSOLUTE_MS = 7 * 24 * 60 * 60 * 1000;
/** 無操作の期限 8 時間。 */
export const SESSION_IDLE_MS = 8 * 60 * 60 * 1000;
/** last_seen を更新する最小の間隔 5 分（毎回書かない）。 */
export const SESSION_TOUCH_MS = 5 * 60 * 1000;
/** ログイン開始から callback までの猶予 10 分。 */
export const LOGIN_TTL_SECONDS = 600;
/** iat がこれより未来なら壊れた（または偽造の）Cookie として拒否する。 */
const CLOCK_SKEW_MS = 60 * 1000;

export interface SessionClaims {
  /** GitHub の user id（UserDO の名前） */
  uid: number;
  /** セッション ID（UserDO の dashboard_session の主キー） */
  sid: string;
  /** ログイン世代（UserDO の dashboard_epoch と一致するときだけ有効） */
  ver: number;
  iat: number;
  exp: number;
}

/** sid・ログインの紐付け値: base64url の 32 バイト。 */
export const SID_RE = /^[A-Za-z0-9_-]{43}$/;

export function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function sealSession(encryptionKey: string, claims: SessionClaims): Promise<string> {
  const key = await importEncryptionKey(encryptionKey);
  // 項目は固定の 5 つだけ。呼び出し側が余計な項目を渡しても書き出さない
  const { uid, sid, ver, iat, exp } = claims;
  return encryptString(key, JSON.stringify({ uid, sid, ver, iat, exp }), SESSION_AAD);
}

const isSafeNonNegInt = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;

/**
 * Cookie の値を復号して検証する。失敗はすべて null（理由を区別しない）。
 * ここで見るのは Cookie 自体の整合と期限だけ。失効・無操作・世代は UserDO で確かめる。
 */
export async function openSession(
  encryptionKey: string,
  value: string,
  now: number,
): Promise<SessionClaims | null> {
  let parsed: unknown;
  try {
    const key = await importEncryptionKey(encryptionKey);
    parsed = JSON.parse(await decryptString(key, value, SESSION_AAD));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const p = parsed as Record<string, unknown>;
  const { uid, sid, ver, iat, exp } = p;
  if (!Number.isSafeInteger(uid) || (uid as number) <= 0) return null;
  if (typeof sid !== "string" || !SID_RE.test(sid)) return null;
  if (!isSafeNonNegInt(ver) || !isSafeNonNegInt(iat) || !isSafeNonNegInt(exp)) return null;
  if (iat > now + CLOCK_SKEW_MS) return null;
  if (exp <= now) return null;
  // 絶対期限より長い exp は、正規に発行されたものではない
  if (exp - iat > SESSION_ABSOLUTE_MS) return null;
  return { uid: uid as number, sid, ver, iat, exp };
}

/** Cookie ヘッダから名前が完全一致するものの値を取る。無い・空・同名が複数あるときは null。 */
export function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  let found: string | null = null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    if (found !== null) return null;
    found = part.slice(eq + 1).trim();
  }
  return found === "" ? null : found;
}

/** `__Host-` の条件（Secure・Path=/・Domain なし）。SameSite=Lax: GitHub からの戻りはクロスサイトの GET で、Strict だと送られない。 */
const ATTRS = "Path=/; Secure; HttpOnly; SameSite=Lax";

export function sessionCookie(value: string, maxAgeSeconds: number): string {
  return `${SESSION_COOKIE}=${value}; ${ATTRS}; Max-Age=${maxAgeSeconds}`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; ${ATTRS}; Max-Age=0`;
}

export function loginCookie(value: string): string {
  return `${LOGIN_COOKIE}=${value}; ${ATTRS}; Max-Age=${LOGIN_TTL_SECONDS}`;
}

export function clearLoginCookie(): string {
  return `${LOGIN_COOKIE}=; ${ATTRS}; Max-Age=0`;
}
