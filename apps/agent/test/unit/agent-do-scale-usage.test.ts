import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { clearAgentTestOverrides } from "../../src/agent/deps";
import { sameUsage, ZERO_USAGE } from "../../src/agent/store";
import {
  boot,
  call,
  done,
  type Fixture,
  makeSpec,
  newFixture,
  report,
  waitForTerminal,
} from "./support/agent-fixture";

afterEach(() => clearAgentTestOverrides());

// Sandbox の昇格を Clef に一本化したあとの AgentDO 側: 子にツールは無い（sandbox_scale_up は削除）。システムプロンプトの説明、
// usage（昇格の履歴・Clef の判断の集計と記録）の載せ方。判断そのものは SandboxDO（sandbox-do-clef-scale.test.ts）。

// biome-ignore lint/suspicious/noExplicitAny: private メンバーの観測
type Inst = any;
const runInDO = runInDurableObject as unknown as <T>(
  stub: unknown,
  fn: (inst: Inst) => Promise<T> | T,
) => Promise<T>;

const noVerify = (name: string, over: Record<string, unknown> = {}) =>
  makeSpec(name, { verificationCommands: [], ...over });

async function start(fx: Fixture, name: string, over: Record<string, unknown> = {}) {
  await fx.stub.start(noVerify(name, over));
  return waitForTerminal(fx);
}

describe("AgentDO: sandbox_scale_up は無い", () => {
  it("子に sandbox_scale_up は見えない（呼んでも未知のツール）。システムプロンプトにも出ない", async () => {
    const fx = newFixture("clef-no-tool", [
      boot(),
      call("sandbox_scale_up", { instance: "standard-3" }),
      report(),
    ]);
    expect(await start(fx, "clef-no-tool")).toBe("completed");
    const seen = (fx.modelCalls.toolResults[2] ?? []).join("\n");
    expect(seen).toMatch(/not found|unknown tool|not available/i);
    expect(fx.modelCalls.systemTexts.join("\n")).not.toContain("sandbox_scale_up");
  });
});

describe("AgentDO: Sandbox の大きさのプロンプト（testing の節）", () => {
  const testing = async (name: string, vars: Record<string, string>, over = {}) => {
    const fx = newFixture(name, [call("gate")]);
    await runInDO(fx.stub, (inst) => {
      inst.env = { ...inst.env, ...vars };
    });
    await fx.stub.start(noVerify(name, over));
    await fx.gate.waitEntered();
    const s = await runInDO<{ key: string; text: string | undefined }[]>(fx.stub, (inst) =>
      inst.promptSections(),
    );
    fx.gate.release();
    await waitForTerminal(fx);
    return s.find((x) => x.key === "testing")?.text ?? "";
  };

  it("有効なとき: 小さく始まり、必要なら自動で大きくなる・頼まなくてよい・数十秒かかる・背景のプロセスは止まる・中断しない", async () => {
    const t = await testing("clef-prompt-on", { SANDBOX_MAX_INSTANCE: "standard-4" });
    expect(t).toContain("scaled up");
    expect(t).toContain("automatically");
    expect(t).toMatch(/do not have to ask|no need to ask/i);
    expect(t).toContain("tens of seconds");
    expect(t).toContain("background");
    expect(t).toContain("stopped");
    expect(t).toMatch(/do not (retry|cancel)/i);
    expect(t).not.toContain("sandbox_scale_up");
    expect(t).not.toMatch(/safety net/i);
  });

  it("無効（空・off・不正）: 何も書かない", async () => {
    for (const raw of ["", "off", "none", "lite"]) {
      const t = await testing(`clef-prompt-off-${raw || "empty"}`, { SANDBOX_MAX_INSTANCE: raw });
      expect(t, raw).not.toContain("scaled up");
    }
  });

  it("task_start で大きさを明示したタスク: 大きさは固定なので何も書かない", async () => {
    const t = await testing(
      "clef-prompt-fixed",
      { SANDBOX_MAX_INSTANCE: "standard-4" },
      { sandboxInstance: "standard-1" },
    );
    expect(t).not.toContain("scaled up");
  });
});

describe("AgentDO: usage の昇格の履歴", () => {
  it("Sandbox が報告した promotions が usage.sandbox に載る。表に無い大きさ・引き金の要素は捨てる。古い記録の rule_match は載せない", async () => {
    const fx = newFixture("clef-usage", [boot(), report()]);
    fx.sandbox.metricsValue = {
      runtimeMs: 90_000,
      restarts: 0,
      bootRetries: 0,
      instance: "standard-2",
      promotedTo: "standard-4",
      promotedAt: 1_700_000_000_000,
      runtimeMsBeforePromotion: 30_000,
      promotions: [
        { to: "standard-3", at: 1_700_000_000_000, trigger: "clef", runtimeMsBefore: 30_000 },
        { to: "standard-4", at: 1_700_000_050_000, trigger: "clef", runtimeMsBefore: 60_000 },
        { to: "standard-9", at: 1, trigger: "clef", runtimeMsBefore: 1 },
        { to: "standard-4", at: 1, trigger: "me", runtimeMsBefore: 1 },
        { to: "standard-3", at: 2, trigger: "rule", runtimeMsBefore: 2, ruleMatch: "vitest" },
      ] as never,
    };
    expect(await start(fx, "clef-usage")).toBe("completed");
    const sb = done(await fx.stub.getResult()).usage.sandbox;
    expect(sb?.promotedTo).toBe("standard-4");
    expect(sb?.promotions).toEqual([
      { to: "standard-3", at: 1_700_000_000_000, trigger: "clef", runtimeMsBefore: 30_000 },
      { to: "standard-4", at: 1_700_000_050_000, trigger: "clef", runtimeMsBefore: 60_000 },
      { to: "standard-3", at: 2, trigger: "rule", runtimeMsBefore: 2 },
    ]);
  });

  it("昇格の失敗の内訳は固定の値（trigger と理由コード）だけ。表に無い要素は捨て、8 件までにする", async () => {
    const fx = newFixture("clef-usage-failures", [boot(), report()]);
    fx.sandbox.metricsValue = {
      runtimeMs: 10,
      restarts: 0,
      bootRetries: 0,
      promotionFailures: [
        { trigger: "clef", reason: "snapshot_failed" },
        { trigger: "clef", reason: "start_failed", text: "secret-text" },
        { trigger: "evil", reason: "start_failed" },
        { trigger: "clef", reason: "free text" },
        ...Array.from({ length: 12 }, () => ({ trigger: "clef", reason: "fallback_failed" })),
      ] as never,
    };
    expect(await start(fx, "clef-usage-failures")).toBe("completed");
    const f = done(await fx.stub.getResult()).usage.sandbox?.promotionFailures ?? [];
    expect(f).toHaveLength(8);
    expect(f.slice(0, 2)).toEqual([
      { trigger: "clef", reason: "snapshot_failed" },
      { trigger: "clef", reason: "start_failed" },
    ]);
    expect(JSON.stringify(f)).not.toContain("secret-text");
  });

  it("昇格していないタスクには付かない", async () => {
    const fx = newFixture("clef-usage-none", [boot(), report()]);
    fx.sandbox.metricsValue = {
      runtimeMs: 10,
      restarts: 0,
      bootRetries: 0,
      instance: "standard-2",
    };
    expect(await start(fx, "clef-usage-none")).toBe("completed");
    const sb = done(await fx.stub.getResult()).usage.sandbox;
    for (const k of ["promotions", "promotionFailures", "scaleStats", "scaleDecisions"]) {
      expect(sb, k).not.toHaveProperty(k);
    }
  });
});

describe("AgentDO: usage の Clef の判断の集計と記録", () => {
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

  it("終端の確定のときに、Sandbox が報告した集計と判断ごとの記録が usage.sandbox に載る。不正な要素は捨て、argv や自由文は載らない", async () => {
    const fx = newFixture("clef-scale-usage", [boot(), report()]);
    fx.sandbox.metricsValue = {
      runtimeMs: 90_000,
      restarts: 0,
      bootRetries: 0,
      instance: "standard-2",
      scaleStats: { decisions: 3, raised: 1, clefFailures: 1, slowNotRaised: 0, skippedLight: 0 },
      scaleDecisions: [
        decision(),
        { at: 2, from: "standard-3", to: null, failed: true, clefMs: 15_000, cmd: "ls" },
        decision({ from: "evil" }),
        decision({ to: "evil", heavy: 9, argv: ["secret-argv"], cmd: "rm -rf /" }),
      ] as never,
    };
    expect(await start(fx, "clef-scale-usage")).toBe("completed");
    const sb = done(await fx.stub.getResult()).usage.sandbox;
    expect(sb?.scaleStats).toEqual({
      decisions: 3,
      raised: 1,
      clefFailures: 1,
      slowNotRaised: 0,
      skippedLight: 0,
    });
    expect(sb?.scaleDecisions).toHaveLength(3);
    expect(sb?.scaleDecisions?.[0]).toMatchObject({
      from: "standard-2",
      to: "standard-3",
      heavy: 0.95,
      model: "flash",
      cmd: "pnpm",
    });
    expect(sb?.scaleDecisions?.[1]).toMatchObject({ to: null, failed: true, cmd: "ls" });
    expect(sb?.scaleDecisions?.[2]).toMatchObject({ to: null, cmd: "rm" });
    expect(sb?.scaleDecisions?.[2]).not.toHaveProperty("heavy");
    expect(JSON.stringify(sb)).not.toContain("secret-argv");
  });

  it("Clef の判断が無い（0 回・無い）なら付かない", async () => {
    const fx = newFixture("clef-scale-zero", [boot(), report()]);
    fx.sandbox.metricsValue = {
      runtimeMs: 10,
      restarts: 0,
      bootRetries: 0,
      scaleStats: { decisions: 0, raised: 0, clefFailures: 0, slowNotRaised: 0, skippedLight: 0 },
      scaleDecisions: [],
    };
    expect(await start(fx, "clef-scale-zero")).toBe("completed");
    const sb = done(await fx.stub.getResult()).usage.sandbox;
    expect(sb).not.toHaveProperty("scaleStats");
    expect(sb).not.toHaveProperty("scaleDecisions");
  });
});

describe("sameUsage: Clef の判断の集計の違いも別の usage として扱う（usage イベントを出し直す）", () => {
  const u = (sandbox: Record<string, unknown>) =>
    ({
      ...ZERO_USAGE,
      sandbox: { runtimeMs: 1, restarts: 0, bootRetries: 0, ...sandbox },
    }) as never;

  it("集計や記録の件数が違うと同じではない。同じなら同じ", () => {
    const a = {
      scaleStats: { decisions: 1, raised: 0, clefFailures: 0, slowNotRaised: 0, skippedLight: 0 },
    };
    expect(sameUsage(u(a), u(a))).toBe(true);
    expect(
      sameUsage(
        u(a),
        u({
          scaleStats: {
            decisions: 2,
            raised: 0,
            clefFailures: 0,
            slowNotRaised: 0,
            skippedLight: 0,
          },
        }),
      ),
    ).toBe(false);
    expect(sameUsage(u({}), u({ scaleDecisions: [{}] }))).toBe(false);
  });
});
