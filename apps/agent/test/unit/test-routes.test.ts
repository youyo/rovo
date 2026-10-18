import { env } from "cloudflare:test";
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

  it("test でも未知のパスは処理しない", async () => {
    expect(await handleTestRoute(post("/test/agent/unknown", { name: "x" }), env)).toBeUndefined();
  });
});
