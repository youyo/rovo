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

  async function registerClient() {
    const res = await SELF.fetch(`${env.PUBLIC_BASE_URL}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "unit",
        redirect_uris: ["http://127.0.0.1:9/callback"],
        grant_types: ["authorization_code"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { client_id: string }).client_id;
  }

  it("本番設定の /authorize は GitHub のログインへ redirect し、MCP の code を発行しない", async () => {
    const clientId = await registerClient();
    const q = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: "http://127.0.0.1:9/callback",
      code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
      code_challenge_method: "S256",
      state: "client-state",
    });
    const res = await SELF.fetch(`${env.PUBLIC_BASE_URL}/authorize?${q}`, { redirect: "manual" });
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
