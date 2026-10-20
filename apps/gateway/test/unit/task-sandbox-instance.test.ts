import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createTaskService, type Principal } from "../../src/tasks/service";
import { fakeAgent, newTaskId, newUserId, sampleInput, taskStub } from "./helpers";

const input = {
  repository: "acme/widgets",
  base_ref: "main",
  base_sha: "0123456789abcdef0123456789abcdef01234567",
  title: "t",
  instructions: "do it",
};

function principal(): Principal {
  return { githubUserId: newUserId(), login: "alice" };
}

const start = (p: Principal, extra: Record<string, unknown> = {}) =>
  createTaskService(env).start(
    p,
    { ...input, ...extra },
    { repositoryId: 4242, installationId: 77 },
  );

describe("task_start の sandbox_instance", () => {
  it("lite・未知の値は invalid_input。予約もしない", async () => {
    const p = principal();
    for (const sandbox_instance of ["lite", "standard-9", "nope"]) {
      const r = await start(p, { sandbox_instance });
      expect(r, sandbox_instance).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    }
    // 予約が残っていない（次の start が concurrency_limit にならない）
    expect(await start(p)).toMatchObject({ ok: true });
  });

  it("省略時は spec に sandboxInstance を載せない（従来どおり agent の env の既定）", async () => {
    const p = principal();
    const r = await start(p);
    if (!r.ok) throw new Error("start failed");
    const { specs } = await fakeAgent(r.value.task_id).calls();
    expect(specs[0]).not.toHaveProperty("sandboxInstance");
    // task_status は null（明示していない = 既定）
    const status = await createTaskService(env).status(p, r.value.task_id);
    expect(status).toMatchObject({ ok: true, value: { sandbox_instance: null } });
  });

  it("指定した大きさは spec.sandboxInstance として AgentDO に渡り、task_status に返る", async () => {
    const p = principal();
    const r = await start(p, { sandbox_instance: "standard-3" });
    if (!r.ok) throw new Error("start failed");
    const id = r.value.task_id;
    expect((await fakeAgent(id).calls()).specs[0]?.sandboxInstance).toBe("standard-3");
    expect(await createTaskService(env).status(p, id)).toMatchObject({
      ok: true,
      value: { sandbox_instance: "standard-3" },
    });
  });

  it("同じ idempotency_key で大きさが違えば conflict、同じなら同じタスク", async () => {
    const p = principal();
    const a = await start(p, { idempotency_key: "k1", sandbox_instance: "standard-4" });
    const b = await start(p, { idempotency_key: "k1", sandbox_instance: "standard-4" });
    const c = await start(p, { idempotency_key: "k1" });
    expect(a.ok && b.ok && a.value.task_id === b.value.task_id).toBe(true);
    expect(c).toMatchObject({ ok: false, error: { code: "conflict" } });
  });

  it("TaskDO も lite は受け付けない（invalid_input）", async () => {
    const id = newTaskId();
    const r = await taskStub(id).ensureCreated(
      sampleInput(id, newUserId(), { sandbox_instance: "lite" }),
    );
    expect(r).toEqual({ ok: false, code: "invalid_input" });
  });
});

async function usageWith(sandbox: unknown) {
  const id = newTaskId();
  const stub = taskStub(id);
  const owner = newUserId();
  const created = await stub.ensureCreated(sampleInput(id, owner));
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
  const r = await stub.result(owner);
  if (!r.ok) throw new Error("result");
  return r.result.usage as Record<string, unknown>;
}

describe("task_result の usage.sandbox_instance（実際に使った大きさ）", () => {
  it("agent が報告した大きさを返す", async () => {
    const usage = await usageWith({
      runtimeMs: 1000,
      restarts: 0,
      bootRetries: 0,
      instance: "standard-4",
    });
    expect(usage.sandbox_instance).toBe("standard-4");
  });

  it("起動しなかった（報告が無い）タスクと、表に無い値には付けない", async () => {
    expect(await usageWith(undefined)).not.toHaveProperty("sandbox_instance");
    expect(await usageWith({ runtimeMs: 0, restarts: 0, bootRetries: 0 })).not.toHaveProperty(
      "sandbox_instance",
    );
    expect(
      await usageWith({ runtimeMs: 0, restarts: 0, bootRetries: 0, instance: "evil" }),
    ).not.toHaveProperty("sandbox_instance");
  });
});
