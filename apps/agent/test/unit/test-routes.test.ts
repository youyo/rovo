import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../../src/index";
import { handleTestRoute } from "../../src/test-routes";

const post = (path: string, body: unknown = {}) =>
  new Request(`http://x${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const production = { ...env, ENVIRONMENT: "production" } as Env;

describe("テストルートは ENVIRONMENT=test 限定", () => {
  it.each([
    "/test/agent/set-script",
    "/test/agent/start",
    "/test/agent/cancel",
    "/test/agent/events",
    "/test/agent/result",
    "/test/agent/debug",
    "/test/sandbox/exec",
    "/test/sandbox/seed-workspace",
  ])("production では %s は 404（handleTestRoute は何も処理しない）", async (path) => {
    expect(await handleTestRoute(post(path, { name: "x" }), production)).toBeUndefined();
    const res = await worker.fetch(post(path, { name: "x" }) as never, production);
    expect(res.status).toBe(404);
  });

  it("test では台本の設定ルートが応答する", async () => {
    const res = await handleTestRoute(
      post("/test/agent/set-script", { name: "route-script", key: "k", script: [{ text: "hi" }] }),
      env,
    );
    expect(res?.status).toBe(200);
  });

  it("test では作業ツリーの仕込みルートが応答する（仕様が未設定のサンドボックスは 500 で理由を返す）", async () => {
    const res = await handleTestRoute(
      post("/test/sandbox/seed-workspace", { name: "route-seed-none" }),
      env,
    );
    expect(res?.status).toBe(500);
    expect(await res?.text()).toMatch(/not ready/);
  });

  it("SandboxDO の仕込みは ENVIRONMENT=test 以外では拒否する", async () => {
    const stub = env.SANDBOX_DO.getByName("route-seed-prod");
    type Seedable = { env: unknown; seedWorkspaceForTest(): Promise<void> };
    await runInDurableObject(stub, async (inst) => {
      const sandbox = inst as unknown as Seedable;
      sandbox.env = { ...(sandbox.env as object), ENVIRONMENT: "production" };
      await expect(sandbox.seedWorkspaceForTest()).rejects.toThrow(/only available in test/);
    });
  });

  it("test でも未知のパスは処理しない", async () => {
    expect(await handleTestRoute(post("/test/agent/unknown", { name: "x" }), env)).toBeUndefined();
  });
});
