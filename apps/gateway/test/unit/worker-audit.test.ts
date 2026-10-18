import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { readWorkerAudit } from "../../src/audit-sink";
import worker from "../../src/index";
import { clearWorkerAudit } from "./helpers";

beforeEach(clearWorkerAudit);

const testEnv = () => ({ ...env, ENVIRONMENT: "test" }) as unknown as Env;

async function fetchWith(e: Env, path: string, init: RequestInit = {}) {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`${e.PUBLIC_BASE_URL}${path}`, init) as never, e, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

describe("Worker のエントリ: OAuthProvider が弾いた認証の失敗の監査", () => {
  it("不正なトークンの /mcp（401）は auth_failed(token_rejected)。トークンの値は出さない", async () => {
    const e = testEnv();
    const res = await fetchWith(e, "/mcp", {
      method: "POST",
      headers: {
        authorization: "Bearer ghs_SECRETSECRETSECRETSECRET",
        "cf-ray": "8a1b2c3d4e5f6071-NRT",
      },
      body: "{}",
    });
    expect(res.status).toBe(401);
    const recs = await readWorkerAudit(e);
    expect(recs).toEqual([
      expect.objectContaining({
        audit: true,
        event: "auth_failed",
        reason: "token_rejected",
        requestId: "8a1b2c3d4e5f6071-NRT",
      }),
    ]);
    expect(JSON.stringify(recs)).not.toContain("SECRET");
  });

  it("トークンを提示していない /mcp（401。MCP クライアントの最初の探索）は認証の失敗ではないので出さない", async () => {
    const e = testEnv();
    const res = await fetchWith(e, "/mcp", { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
    expect(await readWorkerAudit(e)).toEqual([]);
  });

  it("/oauth/token の拒否（不正な code）は auth_failed(token_request_rejected)", async () => {
    const e = testEnv();
    const res = await fetchWith(e, "/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: "nope",
        client_id: "x",
        redirect_uri: "http://127.0.0.1:9/callback",
        code_verifier: "v",
      }).toString(),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect((await readWorkerAudit(e)).map((r) => [r.event, r.reason])).toEqual([
      ["auth_failed", "token_request_rejected"],
    ]);
  });

  it("認証の失敗でない応答（メタデータの 200）では何も出さない", async () => {
    const e = testEnv();
    const res = await fetchWith(e, "/.well-known/oauth-authorization-server");
    expect(res.status).toBe(200);
    expect(await readWorkerAudit(e)).toEqual([]);
  });

  it("production では記録しない（応答は変わらない）", async () => {
    const res = await fetchWith(env as unknown as Env, "/mcp", { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
    expect(await readWorkerAudit({ ...env, ENVIRONMENT: "test" } as unknown as Env)).toEqual([]);
  });
});
