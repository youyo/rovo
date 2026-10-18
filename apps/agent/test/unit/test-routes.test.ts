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

  it("test では作業ツリーの仕込みルートが応答し、失敗はメッセージを本文にして 500 で返す", async () => {
    // 実 DO の RPC が reject すると、vitest-pool-workers が DO 側の Uncaught (in promise) を出して
    // Unhandled Error になる。ルートの 500 への変換は、reject する SandboxDO の代役で確かめる。
    const failing = {
      ...env,
      SANDBOX_DO: {
        getByName: () => ({
          seedWorkspaceForTest: async () => {
            throw new Error("sandbox is not ready: call ensureReady first");
          },
        }),
      },
    } as unknown as Env;
    const res = await handleTestRoute(post("/test/sandbox/seed-workspace", { name: "x" }), failing);
    expect(res?.status).toBe(500);
    expect(await res?.text()).toMatch(/not ready/);
  });

  it("仕様が未設定の SandboxDO は、作業ツリーの仕込みを not ready で拒否する", async () => {
    const stub = env.SANDBOX_DO.getByName("route-seed-none");
    type Seedable = { seedWorkspaceForTest(): Promise<void> };
    // DO の中で直接呼ぶ（RPC 越しの reject は上記の Uncaught を出すため）
    await runInDurableObject(stub, async (inst) => {
      await expect((inst as unknown as Seedable).seedWorkspaceForTest()).rejects.toThrow(
        /not ready/,
      );
    });
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
