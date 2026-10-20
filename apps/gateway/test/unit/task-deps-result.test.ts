import { describe, expect, it } from "vitest";
import { fakeAgent, newTaskId, sampleInput, taskStub } from "./helpers";

// D14: task_result の usage に deps_cache と cache_build_ms を出す（agent の usage.sandbox から）。

const OWNER = 703;

async function resultWith(sandbox: unknown) {
  const id = newTaskId();
  const stub = taskStub(id);
  const created = await stub.ensureCreated(sampleInput(id, OWNER));
  if (!created.ok) throw new Error("create");
  const agent = fakeAgent(id);
  await stub.advance();
  await agent.setProgram({
    result: {
      status: "completed",
      summary: "done",
      verification: { commands: [], results: [], verified: false, attempts: 0 },
      warnings: [],
      patchTooLarge: false,
      usage: {
        costUsd: 1,
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        web: { search: 0, fetch: 0, browse: 0 },
        ...(sandbox !== undefined ? { sandbox: sandbox as never } : {}),
      },
    },
  });
  await agent.setPhase("completed");
  await stub.advance();
  const r = await stub.result(OWNER);
  if (!r.ok) throw new Error("result");
  return r.result.usage as Record<string, unknown>;
}

describe("task_result の usage（依存関係のキャッシュ）", () => {
  it("built: deps_cache と cache_build_ms を返す", async () => {
    const usage = await resultWith({
      runtimeMs: 90_000,
      restarts: 0,
      bootRetries: 0,
      depsCache: "built",
      cacheBuildMs: 60_000,
    });
    expect(usage).toMatchObject({ deps_cache: "built", cache_build_ms: 60_000 });
  });

  it("hit / miss / disabled は deps_cache だけ（cache_build_ms は付けない）", async () => {
    for (const depsCache of ["hit", "miss", "disabled"]) {
      const usage = await resultWith({ runtimeMs: 1, restarts: 0, bootRetries: 0, depsCache });
      expect(usage.deps_cache).toBe(depsCache);
      expect(usage).not.toHaveProperty("cache_build_ms");
    }
  });

  it("agent がカウンタを読めなかった（sandbox が無い）ときは、どちらも付けない", async () => {
    const usage = await resultWith(undefined);
    expect(usage).not.toHaveProperty("deps_cache");
    expect(usage).not.toHaveProperty("cache_build_ms");
  });

  it("表に無い値は返さない", async () => {
    const usage = await resultWith({ runtimeMs: 1, depsCache: "weird", cacheBuildMs: "x" });
    expect(usage).not.toHaveProperty("deps_cache");
    expect(usage).not.toHaveProperty("cache_build_ms");
  });
});
