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

  it("本番設定では /authorize のスタブが無効（認可されない）", async () => {
    const res = await SELF.fetch(
      `${env.PUBLIC_BASE_URL}/authorize?response_type=code&client_id=x&redirect_uri=https%3A%2F%2Fexample.com%2Fcb`,
      { redirect: "manual" },
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.headers.get("location")).toBeNull();
  });
});
