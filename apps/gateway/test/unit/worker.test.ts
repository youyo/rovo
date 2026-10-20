import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("Worker 全体（OAuthProvider で包んだ構成）", () => {
  it("未認証の /mcp は 401 と resource_metadata を含む WWW-Authenticate を返す", async () => {
    const res = await SELF.fetch(`${env.PUBLIC_BASE_URL}/mcp`, { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("resource_metadata=");
  });

  it("不正なトークンの /mcp は 401", async () => {
    const res = await SELF.fetch(`${env.PUBLIC_BASE_URL}/mcp`, {
      method: "POST",
      headers: { authorization: "Bearer invalid" },
      body: "{}",
    });
    expect(res.status).toBe(401);
  });

  it("認可サーバーのメタデータが公開される（DCR 有効）", async () => {
    const res = await SELF.fetch(`${env.PUBLIC_BASE_URL}/.well-known/oauth-authorization-server`);
    expect(res.status).toBe(200);
    const meta = (await res.json()) as Record<string, unknown>;
    expect(meta.registration_endpoint).toBeTruthy();
    expect(meta.code_challenge_methods_supported).toContain("S256");
  });

  async function registerClient(clientName = "unit") {
    const res = await SELF.fetch(`${env.PUBLIC_BASE_URL}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: clientName,
        redirect_uris: ["http://127.0.0.1:9/callback"],
        grant_types: ["authorization_code"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { client_id: string }).client_id;
  }

  async function authorizeUrl(clientName = "unit") {
    const clientId = await registerClient(clientName);
    const q = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: "http://127.0.0.1:9/callback",
      code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
      code_challenge_method: "S256",
      state: "client-state",
    });
    return `${env.PUBLIC_BASE_URL}/authorize?${q}`;
  }

  /** ブラウザの代わりに同意画面を開き、handle と Cookie を得る。 */
  async function openConsent(clientName = "unit") {
    const res = await SELF.fetch(await authorizeUrl(clientName), { redirect: "manual" });
    const html = await res.text();
    const handle = /name="handle" value="([^"]+)"/.exec(html)?.[1] ?? "";
    const cookie = res.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    return { res, html, handle, cookie };
  }

  function submit(handle: string, decision: string, cookie: string) {
    return SELF.fetch(`${env.PUBLIC_BASE_URL}/authorize`, {
      method: "POST",
      redirect: "manual",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        ...(cookie ? { cookie } : {}),
      },
      body: new URLSearchParams({ handle, decision }).toString(),
    });
  }

  it("/authorize は同意画面を出し、承認するまで GitHub へも MCP の code 発行へも進まない", async () => {
    const { res, html, handle } = await openConsent("<script>alert(1)</script>Acme");
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
    expect(handle).toBeTruthy();
    expect(html).not.toContain("<script>alert(1)");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;Acme");
    expect(html).toContain("<strong>127.0.0.1</strong>");
    expect(html).toContain("http://127.0.0.1:9/callback");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(res.headers.get("set-cookie")).toMatch(/__Host-oauth-consent-/);
    expect(res.headers.get("set-cookie")).toMatch(/SameSite=Lax/i);
  });

  it("承認すると GitHub のログインへ redirect し、MCP の code は発行しない", async () => {
    const { handle, cookie } = await openConsent();
    const res = await submit(handle, "approve", cookie);
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location") ?? "");
    expect(loc.origin + loc.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(loc.searchParams.get("client_id")).toBe(env.GITHUB_APP_CLIENT_ID);
    expect(loc.searchParams.get("redirect_uri")).toBe(`${env.PUBLIC_BASE_URL}/callback`);
    expect(loc.searchParams.get("state")).toBeTruthy();
    expect(loc.searchParams.get("code")).toBeNull();
    // state は開始したブラウザに紐付く Cookie と対で発行される
    expect(res.headers.get("set-cookie")).toMatch(/__Host-oauth-upstream-/);
  });

  it("OAuthProvider が発行する upstream の state は ^[A-Za-z0-9_-]{43}$ で、ダッシュボードの接頭辞 rovo-dash. と衝突しない（D2）", async () => {
    // /callback の振り分けは state の接頭辞だけで行う。OAuthProvider の state の形が変わって . を含むようになったら、ここで落ちる
    for (let i = 0; i < 3; i++) {
      const { handle, cookie } = await openConsent();
      const res = await submit(handle, "approve", cookie);
      const state = new URL(res.headers.get("location") ?? "").searchParams.get("state") ?? "";
      expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(state.startsWith("rovo-dash.")).toBe(false);
      expect(state).not.toContain(".");
    }
  });

  it("拒否すると client の redirect_uri へ access_denied（state 付き）。GitHub へは行かない", async () => {
    const { handle, cookie } = await openConsent();
    const res = await submit(handle, "deny", cookie);
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location") ?? "");
    expect(loc.origin + loc.pathname).toBe("http://127.0.0.1:9/callback");
    expect(loc.searchParams.get("error")).toBe("access_denied");
    expect(loc.searchParams.get("state")).toBe("client-state");
    expect(loc.searchParams.get("code")).toBeNull();
    expect(res.headers.get("set-cookie") ?? "").not.toMatch(/__Host-oauth-upstream-/);
  });

  it("CSRF: 同意の Cookie が無い POST（別サイトからの送信）は拒否される", async () => {
    const { handle } = await openConsent();
    const res = await submit(handle, "approve", "");
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
  });

  it("CSRF: 別の同意画面の Cookie では handle を使えない", async () => {
    const a = await openConsent();
    const b = await openConsent();
    const res = await submit(a.handle, "approve", b.cookie);
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
  });

  it("CSRF: 推測した・でたらめな handle は拒否される", async () => {
    const { cookie } = await openConsent();
    for (const handle of ["forged", "A".repeat(43), ""]) {
      const res = await submit(handle, "approve", cookie);
      expect(res.status).toBe(400);
      expect(res.headers.get("location")).toBeNull();
    }
  });

  it("CSRF: 使用済みの handle は再使用できない（承認も拒否も 1 回限り）", async () => {
    const a = await openConsent();
    expect((await submit(a.handle, "approve", a.cookie)).status).toBe(302);
    const replay = await submit(a.handle, "approve", a.cookie);
    expect(replay.status).toBe(400);
    expect(replay.headers.get("location")).toBeNull();

    const b = await openConsent();
    expect((await submit(b.handle, "deny", b.cookie)).status).toBe(302);
    const afterDeny = await submit(b.handle, "approve", b.cookie);
    expect(afterDeny.status).toBe(400);
    expect(afterDeny.headers.get("location")).toBeNull();
  });

  it("未登録のクライアントの /authorize は redirect せず 400", async () => {
    const res = await SELF.fetch(
      `${env.PUBLIC_BASE_URL}/authorize?response_type=code&client_id=x&redirect_uri=https%3A%2F%2Fexample.com%2Fcb`,
      { redirect: "manual" },
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.headers.get("location")).toBeNull();
  });

  it("state も Cookie も無い /callback は拒否される（認可は完了しない）", async () => {
    const res = await SELF.fetch(`${env.PUBLIC_BASE_URL}/callback?code=x&state=forged`, {
      redirect: "manual",
    });
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
  });
});
