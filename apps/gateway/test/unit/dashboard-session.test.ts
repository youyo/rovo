import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  clearLoginCookie,
  clearSessionCookie,
  LOGIN_COOKIE,
  loginCookie,
  openSession,
  readCookie,
  SESSION_AAD,
  SESSION_ABSOLUTE_MS,
  SESSION_COOKIE,
  type SessionClaims,
  sealSession,
  sessionCookie,
} from "../../src/dashboard/session";
import { encryptString, importEncryptionKey } from "../../src/github/crypto";

const KEY = (env as unknown as { TOKEN_ENC_KEY: string }).TOKEN_ENC_KEY;
const NOW = 1_800_000_000_000;

const claims = (over: Partial<SessionClaims> = {}): SessionClaims => ({
  uid: 1001,
  sid: "S".repeat(43),
  ver: 3,
  iat: NOW,
  exp: NOW + SESSION_ABSOLUTE_MS,
  ...over,
});

/** 暗号文を別の AAD で作る（別用途の暗号文の流用を再現する） */
async function sealWithAad(aad: string, value: unknown): Promise<string> {
  return encryptString(await importEncryptionKey(KEY), JSON.stringify(value), aad);
}

describe("セッション Cookie の中身", () => {
  it("暗号化して復号でき、AAD は dashboard-session-v1", async () => {
    expect(SESSION_AAD).toBe("dashboard-session-v1");
    const sealed = await sealSession(KEY, claims());
    expect(await openSession(KEY, sealed, NOW + 1000)).toEqual(claims());
  });

  it("平文の項目は uid / sid / ver / iat / exp だけで、暗号文から読めない", async () => {
    const sealed = await sealSession(KEY, claims());
    // AAD が合う鍵で復号した平文の項目を検査する
    const plain = await decryptForTest(sealed);
    expect(Object.keys(JSON.parse(plain)).sort()).toEqual(["exp", "iat", "sid", "uid", "ver"]);
    expect(plain).not.toContain("ghu_");
    expect(plain).not.toContain("ghr_");
    expect(atob(sealed)).not.toContain("uid");
  });

  it("改ざんした暗号文は拒否する", async () => {
    const sealed = await sealSession(KEY, claims());
    const bytes = Uint8Array.from(atob(sealed), (c) => c.charCodeAt(0));
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 1;
    const tampered = btoa(String.fromCharCode(...bytes));
    expect(await openSession(KEY, tampered, NOW)).toBeNull();
  });

  it("別の AAD の暗号文（MCP の access / refresh の暗号文など）は拒否する", async () => {
    for (const aad of ["access", "refresh", "dashboard-session-v0", ""]) {
      const sealed = await sealWithAad(aad, claims());
      expect(await openSession(KEY, sealed, NOW), aad).toBeNull();
    }
  });

  it("別の鍵で作った暗号文・壊れた文字列・空は拒否する", async () => {
    const other = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));
    expect(await openSession(KEY, await sealSession(other, claims()), NOW)).toBeNull();
    for (const junk of ["", "%%%", "AAAA", "x".repeat(10)]) {
      expect(await openSession(KEY, junk, NOW), junk).toBeNull();
    }
  });

  it("期限切れ（exp <= now）・未来の iat は拒否する", async () => {
    const sealed = await sealSession(KEY, claims());
    expect(await openSession(KEY, sealed, NOW + SESSION_ABSOLUTE_MS - 1)).not.toBeNull();
    expect(await openSession(KEY, sealed, NOW + SESSION_ABSOLUTE_MS)).toBeNull();
    expect(await openSession(KEY, sealed, NOW + SESSION_ABSOLUTE_MS + 1)).toBeNull();
    // 1 分を超える未来の iat
    const future = await sealSession(KEY, claims({ iat: NOW + 10 * 60_000 }));
    expect(await openSession(KEY, future, NOW)).toBeNull();
  });

  it("項目の型・形が不正な JSON は拒否する", async () => {
    const bad: unknown[] = [
      { ...claims(), uid: "1001" },
      { ...claims(), uid: -1 },
      { ...claims(), uid: 1.5 },
      { ...claims(), sid: "short" },
      { ...claims(), sid: "!".repeat(43) },
      { ...claims(), ver: -1 },
      { ...claims(), ver: "3" },
      { ...claims(), exp: "x" },
      { ...claims(), iat: null },
      { ...claims(), exp: NOW + 400 * 24 * 3600 * 1000 }, // 絶対期限を超える
      { uid: 1, sid: "S".repeat(43), ver: 1, iat: NOW }, // exp なし
      [],
      "str",
      null,
    ];
    for (const value of bad) {
      expect(await openSession(KEY, await sealWithAad(SESSION_AAD, value), NOW)).toBeNull();
    }
  });

  it("余分な項目（トークンなど）が混ざっていても結果に含めない", async () => {
    const sealed = await sealWithAad(SESSION_AAD, { ...claims(), access: "ghu_x" });
    const opened = await openSession(KEY, sealed, NOW);
    expect(opened).toEqual(claims());
    expect(JSON.stringify(opened)).not.toContain("ghu_");
  });
});

async function decryptForTest(sealed: string): Promise<string> {
  const { decryptString } = await import("../../src/github/crypto");
  return decryptString(await importEncryptionKey(KEY), sealed, SESSION_AAD);
}

describe("Set-Cookie の属性", () => {
  it("セッション: __Host-・Path=/・Secure・HttpOnly・SameSite=Lax・Max-Age があり、Domain は無い", () => {
    const c = sessionCookie("VALUE", 604800);
    expect(c.startsWith(`${SESSION_COOKIE}=VALUE;`)).toBe(true);
    expect(SESSION_COOKIE.startsWith("__Host-")).toBe(true);
    const attrs = c.split("; ").map((s) => s.toLowerCase());
    expect(attrs).toContain("path=/");
    expect(attrs).toContain("secure");
    expect(attrs).toContain("httponly");
    expect(attrs).toContain("samesite=lax");
    expect(attrs).toContain("max-age=604800");
    expect(c.toLowerCase()).not.toContain("domain");
  });

  it("ログイン開始の Cookie: SameSite=Lax（Strict は GitHub からの戻りで送られない）。10 分", () => {
    const c = loginCookie("BIND");
    expect(c.startsWith(`${LOGIN_COOKIE}=BIND;`)).toBe(true);
    expect(LOGIN_COOKIE.startsWith("__Host-")).toBe(true);
    const attrs = c.split("; ").map((s) => s.toLowerCase());
    expect(attrs).toContain("samesite=lax");
    expect(attrs).not.toContain("samesite=strict");
    expect(attrs).toContain("secure");
    expect(attrs).toContain("httponly");
    expect(attrs).toContain("path=/");
    expect(attrs).toContain("max-age=600");
    expect(c.toLowerCase()).not.toContain("domain");
  });

  it("削除用の Cookie は Max-Age=0 で、同じ属性（__Host- の条件）を保つ", () => {
    for (const c of [clearSessionCookie(), clearLoginCookie()]) {
      const attrs = c.split("; ").map((s) => s.toLowerCase());
      expect(attrs).toContain("max-age=0");
      expect(attrs).toContain("path=/");
      expect(attrs).toContain("secure");
      expect(attrs).toContain("httponly");
      expect(c.toLowerCase()).not.toContain("domain");
    }
  });
});

describe("readCookie", () => {
  it("名前が完全一致する Cookie の値を返す", () => {
    expect(readCookie("a=1; __Host-rovo_dash=XYZ; b=2", SESSION_COOKIE)).toBe("XYZ");
    // 接頭辞が同じだけの別名は取らない
    expect(readCookie("__Host-rovo_dash_login=L", SESSION_COOKIE)).toBeNull();
    expect(readCookie("__Host-rovo_dash_login=L", LOGIN_COOKIE)).toBe("L");
  });
  it("無い・空・同名が複数ある場合は null（曖昧なら拒否）", () => {
    expect(readCookie(null, SESSION_COOKIE)).toBeNull();
    expect(readCookie("", SESSION_COOKIE)).toBeNull();
    expect(readCookie(`${SESSION_COOKIE}=`, SESSION_COOKIE)).toBeNull();
    expect(readCookie(`${SESSION_COOKIE}=A; ${SESSION_COOKIE}=B`, SESSION_COOKIE)).toBeNull();
  });
});
