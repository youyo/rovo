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

describe("task_result の usage.sandbox_promoted_*（昇格）", () => {
  it("agent が報告した昇格先・時刻・昇格までの時間を返す。sandbox_instance は最初の大きさ", async () => {
    const usage = await usageWith({
      runtimeMs: 90_000,
      restarts: 0,
      bootRetries: 0,
      instance: "standard-2",
      promotedTo: "standard-3",
      promotedAt: 1_700_000_000_000,
      runtimeMsBeforePromotion: 30_000.7,
    });
    expect(usage).toMatchObject({
      sandbox_instance: "standard-2",
      sandbox_promoted_to: "standard-3",
      sandbox_promoted_at: 1_700_000_000_000,
      sandbox_runtime_ms_before_promotion: 30_000,
    });
    expect(usage).not.toHaveProperty("sandbox_promotion_reason");
  });

  it("見送り・失敗の理由は固定コードだけ返す。昇格していなければ昇格先は付けない", async () => {
    const usage = await usageWith({
      runtimeMs: 10,
      restarts: 0,
      bootRetries: 0,
      instance: "standard-2",
      promotionReason: "snapshot_unsupported",
    });
    expect(usage.sandbox_promotion_reason).toBe("snapshot_unsupported");
    expect(usage).not.toHaveProperty("sandbox_promoted_to");
    const bad = await usageWith({
      runtimeMs: 10,
      restarts: 0,
      bootRetries: 0,
      promotedTo: "evil",
      promotionReason: "evil",
    });
    expect(bad).not.toHaveProperty("sandbox_promoted_to");
    expect(bad).not.toHaveProperty("sandbox_promotion_reason");
  });

  it("起動しなかった（sandbox の報告が無い）タスクには付かない", async () => {
    const usage = await usageWith(undefined);
    expect(Object.keys(usage).filter((k) => k.startsWith("sandbox_promot"))).toEqual([]);
  });
});

describe("task_result の usage.sandbox_promotions（昇格の履歴）と子が上げたあとの重いコマンドの本数", () => {
  it("agent が報告した履歴を、公開用の形（snake_case・固定の値だけ）で返す。sandbox_promoted_to は最終の大きさ", async () => {
    const usage = await usageWith({
      runtimeMs: 90_000,
      restarts: 0,
      bootRetries: 0,
      instance: "standard-2",
      promotedTo: "standard-4",
      promotedAt: 1_700_000_000_000,
      runtimeMsBeforePromotion: 30_000,
      promotions: [
        {
          to: "standard-3",
          at: 1_700_000_000_000,
          trigger: "rule",
          runtimeMsBefore: 30_000,
          ruleMatch: "vitest",
        },
        { to: "standard-4", at: 1_700_000_050_000, trigger: "agent", runtimeMsBefore: 60_000.5 },
      ],
      heavyCommandsAfterAgentScaleUp: 1,
    });
    expect(usage).toMatchObject({
      sandbox_promoted_to: "standard-4",
      sandbox_promoted_at: 1_700_000_000_000,
      sandbox_runtime_ms_before_promotion: 30_000,
      sandbox_heavy_commands_after_agent_scale_up: 1,
    });
    expect(usage.sandbox_promotions).toEqual([
      {
        to: "standard-3",
        at: 1_700_000_000_000,
        trigger: "rule",
        runtime_ms_before: 30_000,
        rule_match: "vitest",
      },
      { to: "standard-4", at: 1_700_000_050_000, trigger: "agent", runtime_ms_before: 60_000 },
    ]);
  });

  it("表に無い値は捨てる。履歴が無い・昇格していないタスクには付かない", async () => {
    const bad = await usageWith({
      runtimeMs: 1,
      restarts: 0,
      bootRetries: 0,
      promotions: [
        { to: "evil", at: 1, trigger: "agent", runtimeMsBefore: 1 },
        { to: "standard-3", at: 1, trigger: "me", runtimeMsBefore: 1 },
        { to: "standard-3", at: 1, trigger: "rule", runtimeMsBefore: 1, ruleMatch: "any command" },
      ],
      heavyCommandsAfterAgentScaleUp: "many",
    });
    // 規則名が表に無い rule の昇格は、規則名だけ外して残す
    expect(bad.sandbox_promotions).toEqual([
      { to: "standard-3", at: 1, trigger: "rule", runtime_ms_before: 1 },
    ]);
    expect(JSON.stringify(bad)).not.toContain("any command");
    expect(bad).not.toHaveProperty("sandbox_heavy_commands_after_agent_scale_up");
    const none = await usageWith({ runtimeMs: 1, restarts: 0, bootRetries: 0 });
    expect(none).not.toHaveProperty("sandbox_promotions");
    expect(none).not.toHaveProperty("sandbox_heavy_commands_after_agent_scale_up");
  });
});
