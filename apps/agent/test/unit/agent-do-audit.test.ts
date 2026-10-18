import { abortAllDurableObjects, env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { clearAgentTestOverrides } from "../../src/agent/deps";
import type { SandboxMetrics } from "../../src/agent/types";
import {
  allEvents,
  ask,
  call,
  done,
  makeSpec,
  newFixture,
  report,
  waitForPhase,
  waitForTerminal,
  waitUntil,
} from "./support/agent-fixture";

afterEach(() => clearAgentTestOverrides());

// biome-ignore lint/suspicious/noExplicitAny: private メンバーの観測
type Inst = any;
const runInDO = runInDurableObject as unknown as <T>(
  stub: unknown,
  fn: (inst: Inst) => Promise<T> | T,
) => Promise<T>;

const M1: SandboxMetrics = { runtimeMs: 5_000, restarts: 1, bootRetries: 2 };

const usageEvents = async (fx: Parameters<typeof allEvents>[0]) =>
  (await allEvents(fx)).filter((e) => e.type === "usage");
const auditEvents = async (fx: Parameters<typeof allEvents>[0]) =>
  (await allEvents(fx)).filter((e) => e.type === "audit").map((e) => e.data);
const auditLog = async (fx: { stub: { testAudit(): Promise<unknown[]> } }) =>
  (await fx.stub.testAudit()) as Record<string, unknown>[];

describe("usage イベントの sandbox: {runtimeMs, restarts, bootRetries}", () => {
  it("SandboxDO のカウンタを usage イベントと結果に載せる", async () => {
    const fx = newFixture("sb-usage", [
      { ...call("write_note", { text: "x" }), usage: { input: 10 } },
      report(),
    ]);
    fx.sandbox.metricsValue = M1;
    await fx.stub.start(makeSpec("sb-usage"));
    expect(await waitForTerminal(fx)).toBe("completed");
    const usages = await usageEvents(fx);
    expect(usages.length).toBeGreaterThan(0);
    expect(usages.at(-1)?.data.sandbox).toEqual(M1);
    expect(done(await fx.stub.getResult()).usage.sandbox).toEqual(M1);
    expect((await fx.stub.getEvents(0, 1)).usage.sandbox).toEqual(M1);
  });

  it("終端の確定で最新の値に更新する（実行時間は増え続けるので、途中の usage イベントでは更新しない）", async () => {
    const fx = newFixture("sb-final", [call("gate"), report()]);
    fx.sandbox.metricsValue = M1;
    await fx.stub.start(makeSpec("sb-final"));
    await fx.gate.waitEntered();
    fx.sandbox.metricsValue = { ...M1, runtimeMs: 9_000 }; // 実行時間だけ増えた
    fx.gate.release();
    expect(await waitForTerminal(fx)).toBe("completed");
    expect(done(await fx.stub.getResult()).usage.sandbox).toEqual({ ...M1, runtimeMs: 9_000 });
    // 途中の usage イベントは runtimeMs の増加だけでは積まない: 最後の 1 件だけが 9_000
    const runtimes = (await usageEvents(fx)).map(
      (u) => (u.data.sandbox as SandboxMetrics | undefined)?.runtimeMs,
    );
    expect(runtimes.filter((r) => r === 9_000)).toHaveLength(1);
    expect(runtimes.at(-1)).toBe(9_000);
  });

  it("値は巻き戻さない（古い読み取りで小さい値が来ても、保存済みを下回らない）", async () => {
    const fx = newFixture("sb-mono", [call("gate"), report()]);
    fx.sandbox.metricsValue = { runtimeMs: 8_000, restarts: 2, bootRetries: 1 };
    await fx.stub.start(makeSpec("sb-mono"));
    await fx.gate.waitEntered();
    fx.sandbox.metricsValue = { runtimeMs: 100, restarts: 0, bootRetries: 0 };
    fx.gate.release();
    expect(await waitForTerminal(fx)).toBe("completed");
    expect(done(await fx.stub.getResult()).usage.sandbox).toEqual({
      runtimeMs: 8_000,
      restarts: 2,
      bootRetries: 1,
    });
  });

  it("カウンタを読めない実装（metrics が無い・undefined・例外）では sandbox を載せず、タスクは完了する", async () => {
    const none = newFixture("sb-none", [report()]);
    Object.defineProperty(none.sandbox, "metrics", { value: undefined });
    await none.stub.start(makeSpec("sb-none"));
    expect(await waitForTerminal(none)).toBe("completed");
    expect(done(await none.stub.getResult()).usage).not.toHaveProperty("sandbox");

    const undef = newFixture("sb-undef", [report()]); // fake の既定: metricsValue 未設定 → undefined
    await undef.stub.start(makeSpec("sb-undef"));
    expect(await waitForTerminal(undef)).toBe("completed");
    expect(done(await undef.stub.getResult()).usage).not.toHaveProperty("sandbox");

    const boom = newFixture("sb-boom", [report()]);
    boom.sandbox.metricsError = new Error("rpc failed");
    await boom.stub.start(makeSpec("sb-boom"));
    expect(await waitForTerminal(boom)).toBe("completed");
    expect(done(await boom.stub.getResult()).usage).not.toHaveProperty("sandbox");
  });

  it("cancel の確定でも最終の値が載る", async () => {
    const fx = newFixture("sb-cancel", [call("gate"), report()], { cancelWaitMs: 300 });
    fx.sandbox.metricsValue = M1;
    await fx.stub.start(makeSpec("sb-cancel"));
    await fx.gate.waitEntered();
    fx.sandbox.metricsValue = { ...M1, runtimeMs: 7_000 };
    await fx.stub.cancel(); // gate が走っている間は stopped:false で戻る
    fx.gate.release();
    await waitForPhase(fx, "cancelled");
    expect(done(await fx.stub.getResult()).usage.sandbox).toEqual({ ...M1, runtimeMs: 7_000 });
  });
});

describe("agent の監査: cancel", () => {
  it("cancel を受理すると agent_cancelled を events（audit）と監査ログの両方に残す", async () => {
    const fx = newFixture("au-cancel", [call("gate"), report()], { cancelWaitMs: 300 });
    await fx.stub.start(makeSpec("au-cancel"));
    await fx.gate.waitEntered();
    await fx.stub.cancel(); // gate が走っている間は stopped:false で戻る
    fx.gate.release();
    await waitForPhase(fx, "cancelled");
    const events = await auditEvents(fx);
    expect(events.filter((e) => e.code === "agent_cancelled")).toEqual([
      { code: "agent_cancelled" },
    ]);
    const log = (await auditLog(fx)).filter((r) => r.event === "agent_cancelled");
    expect(log).toEqual([
      expect.objectContaining({
        audit: true,
        event: "agent_cancelled",
        taskId: "au-cancel",
        caller: "parent",
        reason: "stop_intent_recorded",
      }),
    ]);
  });

  it("cancel の再送では増えない（受理は 1 回）", async () => {
    const fx = newFixture("au-cancel-twice", [call("gate"), report()], {
      cancelWaitMs: 300,
    });
    await fx.stub.start(makeSpec("au-cancel-twice"));
    await fx.gate.waitEntered();
    await fx.stub.cancel();
    await fx.stub.cancel();
    fx.gate.release();
    await waitForPhase(fx, "cancelled");
    expect((await auditEvents(fx)).filter((e) => e.code === "agent_cancelled")).toHaveLength(1);
    expect((await auditLog(fx)).filter((r) => r.event === "agent_cancelled")).toHaveLength(1);
  });

  it("start より先に cancel が届いた場合は、監査ログだけに残す（タスクが無いので events は無い）", async () => {
    const fx = newFixture("au-cancel-first", [report()]);
    await fx.stub.cancel();
    expect(await fx.stub.start(makeSpec("au-cancel-first"))).toEqual({ status: "cancelled" });
    expect(await auditEvents(fx)).toEqual([]);
    const log = await auditLog(fx);
    expect(log.find((r) => r.event === "agent_cancelled")).toMatchObject({
      reason: "not_started",
    });
    expect(log.find((r) => r.event === "start_cancelled_by_tombstone")).toMatchObject({
      taskId: "au-cancel-first",
      caller: "parent",
    });
  });
});

describe("agent の監査: リース相当の失効（監査ログだけ。events には積まない）", () => {
  it("tombstone の後に届いた start を start_cancelled_by_tombstone で残す（再送のたびに）", async () => {
    const fx = newFixture("au-tomb", [report()]);
    await fx.stub.cancel();
    await fx.stub.start(makeSpec("au-tomb"));
    await fx.stub.start(makeSpec("au-tomb"));
    const log = (await auditLog(fx)).filter((r) => r.event === "start_cancelled_by_tombstone");
    expect(log).toHaveLength(2);
    expect(await auditEvents(fx)).toEqual([]);
  });

  it("同じタスクの異なる spec の start が衝突して拒否されたら start_conflict を残す", async () => {
    const fx = newFixture("au-conflict", [call("gate"), report()]);
    const spec = makeSpec("au-conflict");
    await fx.stub.start(spec);
    expect(await fx.stub.start({ ...spec, instructions: "別の指示" })).toEqual({
      status: "conflict",
    });
    const log = (await auditLog(fx)).filter((r) => r.event === "start_conflict");
    expect(log).toEqual([
      expect.objectContaining({ taskId: "au-conflict", caller: "parent", reason: "spec_mismatch" }),
    ]);
    // 指示の本文は監査ログに入らない
    expect(JSON.stringify(log)).not.toContain("別の指示");
    expect((await auditEvents(fx)).filter((e) => e.code === "start_conflict")).toEqual([]);
    fx.gate.release();
    await waitForTerminal(fx);
  });

  it("同一の spec の再送（冪等）では start_conflict を出さない", async () => {
    const fx = newFixture("au-idem", [call("gate"), report()]);
    const spec = makeSpec("au-idem");
    await fx.stub.start(spec);
    await fx.stub.start(spec);
    expect((await auditLog(fx)).filter((r) => r.event === "start_conflict")).toEqual([]);
    fx.gate.release();
    await waitForTerminal(fx);
  });
});

describe("agent の監査: Sandbox の特権操作（events に audit として積む）", () => {
  it("終端の停止（terminate）を sandbox_privileged_op として events に積む", async () => {
    const fx = newFixture("au-term", [call("gate"), report()], { cancelWaitMs: 300 });
    await fx.stub.start(makeSpec("au-term"));
    await fx.gate.waitEntered();
    await fx.stub.cancel();
    fx.gate.release();
    await waitForPhase(fx, "cancelled");
    const ops = (await auditEvents(fx)).filter((e) => e.code === "sandbox_privileged_op");
    expect(ops).toEqual([{ code: "sandbox_privileged_op", op: "terminate" }]);
  });

  it("ask_parent の質問で期限を延ばし（extend_deadline）、回答で正確な値へ戻す（set_deadline）", async () => {
    const fx = newFixture("au-deadline", [ask("Q?"), report()]);
    await fx.stub.start(makeSpec("au-deadline"));
    await waitForPhase(fx, "input_required");
    await waitUntil(() => fx.sandbox.extended.length === 1);
    expect(await fx.stub.answer("q-1", "A")).toEqual({ ok: true });
    expect(await waitForTerminal(fx)).toBe("completed");
    const ops = (await auditEvents(fx))
      .filter((e) => e.code === "sandbox_privileged_op")
      .map((e) => e.op);
    expect(ops.slice(0, 2)).toEqual(["extend_deadline", "set_deadline"]);
  });

  it("Sandbox が拒否・失敗した期限の操作は events に積まない（受理された分だけ。再試行で増えない）", async () => {
    const fx = newFixture("au-deadline-fail", [ask("Q?"), ask("Q?"), report()]);
    fx.sandbox.extendError = new Error("sandbox gone"); // 1 回目の延長だけ失敗する
    await fx.stub.start(makeSpec("au-deadline-fail"));
    await waitForPhase(fx, "input_required");
    const ops = (await auditEvents(fx))
      .filter((e) => e.code === "sandbox_privileged_op")
      .map((e) => e.op);
    expect(ops).toEqual(["extend_deadline"]); // 失敗した 1 回目は積まれず、成功した 2 回目の 1 件だけ
  });

  it("タスクが始まっていない Sandbox の停止は events に積まない（タスクが無い）", async () => {
    const fx = newFixture("au-term-notstarted", [report()]);
    await fx.stub.cancel();
    expect(await auditEvents(fx)).toEqual([]);
  });
});

describe("agent の監査: test 用のシンク", () => {
  it("記録は DO のストレージに残り、DO を作り直しても読める", async () => {
    const fx = newFixture("au-persist", [call("gate"), report()], { cancelWaitMs: 300 });
    await fx.stub.start(makeSpec("au-persist"));
    await fx.gate.waitEntered();
    await fx.stub.cancel();
    fx.gate.release();
    await waitForPhase(fx, "cancelled");
    const before = await auditLog(fx);
    expect(before.length).toBeGreaterThan(0);
    await abortAllDurableObjects(); // DO を作り直す
    fx.stub = env.AGENT_DO.getByName(fx.name);
    expect(await auditLog(fx)).toEqual(before);
  });

  it("ENVIRONMENT が test 以外なら、記録も読み出しもしない（本番）", async () => {
    const fx = newFixture("au-prod", [report()]);
    await runInDO(fx.stub, async (inst: Inst) => {
      inst.env = { ...inst.env, ENVIRONMENT: "production" };
      const lines: string[] = [];
      const orig = console.log;
      console.log = (...a: unknown[]) => void lines.push(a.join(" "));
      try {
        await inst.cancel();
      } finally {
        console.log = orig;
      }
      expect(lines.some((l) => l.includes('"event":"agent_cancelled"'))).toBe(true); // ログは本番でも出る
      await expect(inst.testAudit()).rejects.toThrow(/test/);
      expect(inst.ctx.storage.kv.get("test_audit")).toBeUndefined();
    });
  });
});
