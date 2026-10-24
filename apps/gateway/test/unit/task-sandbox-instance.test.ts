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

describe("task_result の usage.sandbox_promotions（昇格の履歴）とワーカーが上げたあとの重いコマンドの本数", () => {
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
        { to: "standard-3", at: 1, trigger: "rule", runtimeMsBefore: 1, ruleMatch: "Any;Command" },
      ],
      heavyCommandsAfterAgentScaleUp: "many",
    });
    // 規則名が表に無い rule の昇格は、規則名だけ外して残す
    expect(bad.sandbox_promotions).toEqual([
      { to: "standard-3", at: 1, trigger: "rule", runtime_ms_before: 1 },
    ]);
    expect(JSON.stringify(bad)).not.toContain("Any;Command");
    expect(bad).not.toHaveProperty("sandbox_heavy_commands_after_agent_scale_up");
    const none = await usageWith({ runtimeMs: 1, restarts: 0, bootRetries: 0 });
    expect(none).not.toHaveProperty("sandbox_promotions");
    expect(none).not.toHaveProperty("sandbox_heavy_commands_after_agent_scale_up");
  });
});

describe("task_wait の usage イベント: 昇格の履歴・失敗の内訳は配列で出す（task_result の usage と同じ形）", () => {
  it("sandbox_promotions / sandbox_promotion_failures は JSON 文字列ではなく配列。ほかの項目はそのまま", async () => {
    const id = newTaskId();
    const stub = taskStub(id);
    const owner = newUserId();
    const created = await stub.ensureCreated(sampleInput(id, owner));
    if (!created.ok) throw new Error("create");
    const agent = fakeAgent(id);
    await stub.advance();
    await agent.setUsage(0.1, {
      sandbox: {
        runtimeMs: 90_000,
        restarts: 0,
        bootRetries: 0,
        instance: "standard-2",
        promotedTo: "standard-3",
        promotedAt: 1_700_000_000_000,
        runtimeMsBeforePromotion: 30_000,
        promotions: [
          { to: "standard-3", at: 1_700_000_000_000, trigger: "clef", runtimeMsBefore: 30_000 },
        ],
        promotionFailures: [{ trigger: "clef", reason: "snapshot_failed" }],
      },
    } as never);
    await stub.advance();
    const w = await createTaskService(env).wait(
      { githubUserId: owner, login: "alice" },
      {
        task_id: id,
        timeout_seconds: 0,
      },
    );
    if (!w.ok) throw new Error("wait");
    const usage = w.value.events.filter((e) => e.type === "usage").at(-1)?.payload;
    expect(usage?.sandbox_promotions).toEqual([
      { to: "standard-3", at: 1_700_000_000_000, trigger: "clef", runtime_ms_before: 30_000 },
    ]);
    expect(usage?.sandbox_promotion_failures).toEqual([
      { trigger: "clef", reason: "snapshot_failed" },
    ]);
    expect(usage?.sandbox_instance).toBe("standard-2");
    expect(usage?.sandbox_promoted_to).toBe("standard-3");
  });
});

describe("task_result の usage: 的中の本数と昇格の失敗の内訳", () => {
  it("agent が報告した値を、公開用の形（固定の値だけ）で返す", async () => {
    const usage = await usageWith({
      runtimeMs: 90_000,
      restarts: 0,
      bootRetries: 0,
      instance: "standard-2",
      heavyCommandsAfterAgentScaleUp: 3,
      heavyCommandsCoveredByAgent: 2.8,
      promotionFailures: [
        { trigger: "rule", reason: "snapshot_failed" },
        { trigger: "agent", reason: "start_failed", text: "secret-text" },
        { trigger: "me", reason: "start_failed" },
        { trigger: "rule", reason: "anything" },
      ],
    });
    expect(usage).toMatchObject({
      sandbox_heavy_commands_after_agent_scale_up: 3,
      sandbox_heavy_commands_covered_by_agent: 2,
    });
    expect(usage.sandbox_promotion_failures).toEqual([
      { trigger: "rule", reason: "snapshot_failed" },
      { trigger: "agent", reason: "start_failed" },
    ]);
    expect(JSON.stringify(usage)).not.toContain("secret-text");
  });

  it("無ければ付かない", async () => {
    const none = await usageWith({ runtimeMs: 1, restarts: 0, bootRetries: 0 });
    expect(none).not.toHaveProperty("sandbox_heavy_commands_covered_by_agent");
    expect(none).not.toHaveProperty("sandbox_promotion_failures");
    const bad = await usageWith({
      runtimeMs: 1,
      restarts: 0,
      bootRetries: 0,
      heavyCommandsCoveredByAgent: "many",
      promotionFailures: [{ trigger: "x", reason: "y" }],
    });
    expect(bad).not.toHaveProperty("sandbox_heavy_commands_covered_by_agent");
    expect(bad).not.toHaveProperty("sandbox_promotion_failures");
  });
});

describe("task_result の usage: Clef による昇格の判断の集計と記録（sandbox_scale_*）", () => {
  const decision = (over: Record<string, unknown> = {}) => ({
    at: 1_700_000_000_000,
    from: "standard-2",
    to: "standard-3",
    heavy: 0.95,
    fast4: 0.1,
    choice: [0.2, 0.5, 0.3],
    model: "flash",
    clefMs: 380,
    cmdMs: 41_000,
    exitCode: 0,
    cmd: "pnpm",
    ...over,
  });

  it("agent が報告した集計と判断ごとの記録を、公開用の形（snake_case・固定の値と数値だけ）で返す", async () => {
    const usage = await usageWith({
      runtimeMs: 90_000,
      restarts: 0,
      bootRetries: 0,
      instance: "standard-2",
      scaleStats: { decisions: 55, raised: 2, clefFailures: 1, slowNotRaised: 3 },
      scaleDecisions: [
        decision(),
        {
          at: 1_700_000_000_000,
          from: "standard-2",
          to: null,
          failed: true,
          clefMs: 15_000,
          cmd: "ls",
        },
      ],
    });
    expect(usage).toMatchObject({
      sandbox_scale_decisions: 55,
      sandbox_scale_raised: 2,
      sandbox_scale_clef_failures: 1,
      sandbox_scale_slow_not_raised: 3,
    });
    expect(usage.sandbox_scale_log).toEqual([
      {
        at: 1_700_000_000_000,
        from: "standard-2",
        to: "standard-3",
        heavy: 0.95,
        fast4: 0.1,
        choice: [0.2, 0.5, 0.3],
        model: "flash",
        clef_ms: 380,
        cmd_ms: 41_000,
        exit_code: 0,
        cmd: "pnpm",
      },
      {
        at: 1_700_000_000_000,
        from: "standard-2",
        to: null,
        failed: true,
        clef_ms: 15_000,
        cmd: "ls",
      },
    ]);
  });

  it("表に無い大きさ・範囲外の確率・余計なキーは捨てる。cmd は先頭の語の安全な文字だけ。記録は最後の 50 件まで", async () => {
    const many = Array.from({ length: 60 }, (_, i) => decision({ at: i + 1 }));
    const usage = await usageWith({
      runtimeMs: 1,
      restarts: 0,
      bootRetries: 0,
      scaleStats: { decisions: 60, raised: 0, clefFailures: 0, slowNotRaised: 0 },
      scaleDecisions: [decision({ from: "evil" }), ...many],
    });
    const log = usage.sandbox_scale_log as Record<string, unknown>[];
    expect(log).toHaveLength(50);
    expect(log[0]?.at).toBe(11);
    expect(log.at(-1)?.at).toBe(60);

    const bad = await usageWith({
      runtimeMs: 1,
      restarts: 0,
      bootRetries: 0,
      scaleDecisions: [
        decision({
          to: "evil",
          heavy: 7,
          fast4: -1,
          model: "x",
          cmd: "rm -rf /; echo $SECRET",
          argv: ["secret"],
          reason: "free text",
        }),
      ],
    });
    expect(bad.sandbox_scale_log).toEqual([
      {
        at: 1_700_000_000_000,
        from: "standard-2",
        to: null,
        choice: [0.2, 0.5, 0.3],
        clef_ms: 380,
        cmd_ms: 41_000,
        exit_code: 0,
        cmd: "rm",
      },
    ]);
    expect(JSON.stringify(bad)).not.toContain("secret");
    expect(JSON.stringify(bad)).not.toContain("SECRET");
    expect(JSON.stringify(bad)).not.toContain("free text");
  });

  it("skipped_light は sandbox_scale_skipped_light に写る（decisions が 0 でも。欄が無い古い記録は 0）", async () => {
    const only = await usageWith({
      runtimeMs: 1,
      restarts: 0,
      bootRetries: 0,
      scaleStats: { decisions: 0, raised: 0, clefFailures: 0, slowNotRaised: 0, skippedLight: 7 },
    });
    expect(only).toMatchObject({ sandbox_scale_skipped_light: 7, sandbox_scale_decisions: 0 });
    const old = await usageWith({
      runtimeMs: 1,
      restarts: 0,
      bootRetries: 0,
      scaleStats: { decisions: 3, raised: 0, clefFailures: 0, slowNotRaised: 0 },
    });
    expect(old).toMatchObject({ sandbox_scale_skipped_light: 0 });
  });

  it("Clef を呼ばなかったタスク（報告が無い・空）には付かない", async () => {
    const none = await usageWith({ runtimeMs: 1, restarts: 0, bootRetries: 0 });
    for (const k of [
      "sandbox_scale_decisions",
      "sandbox_scale_raised",
      "sandbox_scale_clef_failures",
      "sandbox_scale_slow_not_raised",
      "sandbox_scale_log",
    ]) {
      expect(none, k).not.toHaveProperty(k);
    }
    const empty = await usageWith({
      runtimeMs: 1,
      restarts: 0,
      bootRetries: 0,
      scaleStats: { decisions: 0, raised: 0, clefFailures: 0, slowNotRaised: 0 },
      scaleDecisions: [],
    });
    expect(empty).not.toHaveProperty("sandbox_scale_decisions");
    expect(empty).not.toHaveProperty("sandbox_scale_log");
  });

  it("古いタスクの記録（trigger の agent / rule / verification と rule_match）は読めるまま。rule_match は安全な短い名前だけ通す", async () => {
    const usage = await usageWith({
      runtimeMs: 90_000,
      restarts: 0,
      bootRetries: 0,
      instance: "standard-2",
      promotedTo: "standard-3",
      promotions: [
        {
          to: "standard-3",
          at: 1,
          trigger: "rule",
          runtimeMsBefore: 1,
          ruleMatch: "python -m pytest",
        },
        {
          to: "standard-3",
          at: 2,
          trigger: "rule",
          runtimeMsBefore: 2,
          ruleMatch: "Any;Command $(x)",
        },
        { to: "standard-4", at: 3, trigger: "clef", runtimeMsBefore: 3, ruleMatch: "vitest" },
      ],
    });
    expect(usage.sandbox_promotions).toEqual([
      {
        to: "standard-3",
        at: 1,
        trigger: "rule",
        runtime_ms_before: 1,
        rule_match: "python -m pytest",
      },
      { to: "standard-3", at: 2, trigger: "rule", runtime_ms_before: 2 },
      { to: "standard-4", at: 3, trigger: "clef", runtime_ms_before: 3 },
    ]);
  });
});
