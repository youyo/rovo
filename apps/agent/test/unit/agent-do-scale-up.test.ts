import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { clearAgentTestOverrides } from "../../src/agent/deps";
import type { SandboxScaleUpResult } from "../../src/sandbox-port";
import {
  allEvents,
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

// 子が自分で Sandbox を大きくするツール（sandbox_scale_up）の AgentDO 側。
// ツールは env の SANDBOX_AGENT_MAX_INSTANCE が有効なときだけ子に見せる（fail-soft）。reason（子の自由文）は Sandbox にも
// events（tool_start / tool_end）にも usage にも残さない（非信頼データを増やさない）。本体は SandboxDO.scaleUp（sandbox-do-scale-up.test.ts）。

// biome-ignore lint/suspicious/noExplicitAny: private メンバーの観測
type Inst = any;
const runInDO = runInDurableObject as unknown as <T>(
  stub: unknown,
  fn: (inst: Inst) => Promise<T> | T,
) => Promise<T>;

const SECRET = "reason-SECRET-TEXT-xyz";
const scale = (instance = "standard-3", reason = SECRET) =>
  call("sandbox_scale_up", { instance, reason });
const noVerify = (name: string, over: Record<string, unknown> = {}) =>
  makeSpec(name, { verificationCommands: [], ...over });

/** env を書き換えてから start する（ツールの登録は start 時に env で決まる） */
async function start(
  fx: Fixture,
  name: string,
  vars: Record<string, string> = {},
  over: Record<string, unknown> = {},
) {
  if (Object.keys(vars).length > 0) {
    await runInDO(fx.stub, (inst) => {
      inst.env = { ...inst.env, ...vars };
    });
  }
  await fx.stub.start(noVerify(name, over));
  return waitForTerminal(fx);
}

const results = (fx: Fixture) => (fx.modelCalls.toolResults[1] ?? []).join("\n");

describe("AgentDO: sandbox_scale_up", () => {
  it("Sandbox の scaleUp に大きさだけ渡す（reason は渡さない）。結果は固定の文でモデルに返る", async () => {
    const fx = newFixture("up-1", [boot(), scale("standard-3"), report()]);
    expect(await start(fx, "up-1")).toBe("completed");
    expect(fx.sandbox.scaleUpCalls).toEqual(["standard-3"]);
    // 呼び出しの前に Sandbox は起動している（lazy boot）
    expect(fx.sandbox.order.indexOf("ready")).toBeLessThan(fx.sandbox.order.indexOf("scale_up"));
    const seen = (fx.modelCalls.toolResults[2] ?? []).join("\n");
    expect(seen).toContain("standard-3");
    expect(seen).toContain("standard-2");
    expect(seen).not.toContain(SECRET);
  });

  it("結果の文: scaled / unchanged / rejected / fixed / failed / unavailable。どれも今の大きさと次の行動が分かる", async () => {
    const cases: [SandboxScaleUpResult, RegExp[]][] = [
      [
        { outcome: "scaled", from: "standard-2", to: "standard-4" },
        [/now standard-4/, /was standard-2/, /background/],
      ],
      [{ outcome: "unchanged", instance: "standard-3" }, [/No change/, /already standard-3/]],
      [
        { outcome: "rejected", code: "above_limit", instance: "standard-2", max: "standard-3" },
        [/Rejected/, /standard-3/, /stays standard-2/],
      ],
      [
        {
          outcome: "rejected",
          code: "invalid_instance",
          instance: "standard-2",
          max: "standard-4",
        },
        [/Rejected/, /standard-1, standard-2, standard-3, standard-4/],
      ],
      [{ outcome: "fixed", instance: "standard-1" }, [/fixed/, /standard-1/]],
      [
        { outcome: "failed", code: "snapshot_failed", instance: "standard-2" },
        [/did not happen/, /snapshot_failed/, /stays standard-2/, /do not retry/i],
      ],
      [{ outcome: "unavailable", code: "disabled" }, [/not available/]],
    ];
    for (const [i, [result, patterns]] of cases.entries()) {
      const fx = newFixture(`up-text-${i}`, [boot(), scale("standard-4"), report()]);
      fx.sandbox.scaleUpResults = [result];
      expect(await start(fx, `up-text-${i}`), JSON.stringify(result)).toBe("completed");
      const seen = (fx.modelCalls.toolResults[2] ?? []).join("\n");
      for (const p of patterns) expect(seen, JSON.stringify(result)).toMatch(p);
      expect(seen).not.toContain(SECRET);
    }
  });

  it("Sandbox の例外（再起動した・期限切れなど）はツールのエラー結果にする。タスクは続く", async () => {
    const fx = newFixture("up-throw", [boot(), scale(), report()]);
    fx.sandbox.scaleUpResults = [new Error("sandbox was restarted: workspace was recreated")];
    expect(await start(fx, "up-throw")).toBe("completed");
    const ends = (await allEvents(fx)).filter((e) => e.type === "tool_end");
    const end = ends.find((e) => e.data.name === "sandbox_scale_up");
    expect(end?.data.isError).toBe(true);
    expect(String(end?.data.summary)).toContain("restarted");
  });

  it("reason（子の自由文）は events・結果・usage のどこにも残らない。tool_start の summary は大きさだけ", async () => {
    const fx = newFixture("up-secret", [boot(), scale("standard-3"), report()]);
    fx.sandbox.metricsValue = {
      runtimeMs: 1,
      restarts: 0,
      bootRetries: 0,
      instance: "standard-2",
      promotedTo: "standard-3",
      promotedAt: 1,
      runtimeMsBeforePromotion: 1,
      promotions: [{ to: "standard-3", at: 1, trigger: "agent", runtimeMsBefore: 1 }],
      heavyCommandsAfterAgentScaleUp: 0,
    };
    expect(await start(fx, "up-secret")).toBe("completed");
    const events = await allEvents(fx);
    const start1 = events.find(
      (e) => e.type === "tool_start" && e.data.name === "sandbox_scale_up",
    );
    expect(start1?.data.summary).toBe("instance=standard-3");
    expect(JSON.stringify(events)).not.toContain(SECRET);
    expect(JSON.stringify(done(await fx.stub.getResult()))).not.toContain(SECRET);
    expect(JSON.stringify(fx.sandbox.scaleUpCalls)).not.toContain(SECRET);
  });

  it("tool_start の summary に載るのは大きさだけ。不正な引数でも reason をそのまま載せない", async () => {
    const fx = newFixture("up-badargs", [
      boot(),
      call("sandbox_scale_up", { instance: { evil: SECRET }, reason: SECRET }),
      report(),
    ]);
    await start(fx, "up-badargs");
    const events = await allEvents(fx);
    expect(JSON.stringify(events)).not.toContain(SECRET);
  });
});

describe("AgentDO: sandbox_scale_up は設定が無いと子に見せない（fail-soft）", () => {
  for (const raw of ["", "off", "none", "lite", "bogus"]) {
    it(`SANDBOX_AGENT_MAX_INSTANCE=${JSON.stringify(raw)}: ツールは登録されず、Sandbox にも届かない。プロンプトにも書かない`, async () => {
      const name = `up-off-${raw || "empty"}`;
      const fx = newFixture(name, [boot(), scale(), report()]);
      expect(await start(fx, name, { SANDBOX_AGENT_MAX_INSTANCE: raw })).toBe("completed");
      expect(fx.sandbox.scaleUpCalls).toEqual([]);
      const seen = (fx.modelCalls.toolResults[2] ?? []).join("\n");
      expect(seen).toMatch(/not found|unknown tool|not available/i);
      expect(fx.modelCalls.systemTexts.join("\n")).not.toContain("sandbox_scale_up");
    });
  }

  it("設定が有効なら、システムプロンプトにツールの説明が出る", async () => {
    const fx = newFixture("up-on", [boot(), report()]);
    expect(await start(fx, "up-on")).toBe("completed");
    expect(fx.modelCalls.systemTexts.join("\n")).toContain("sandbox_scale_up");
  });
});

describe("AgentDO: sandbox_scale_up のプロンプト", () => {
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

  it("ツールがあるとき: いつ呼ぶか・上限・上げるだけ・数十秒かかり背景のプロセスが止まる・中断しない・保険", async () => {
    const t = await testing("up-prompt-on", {
      SANDBOX_AGENT_MAX_INSTANCE: "standard-4",
      SANDBOX_HEAVY_INSTANCE: "standard-3",
    });
    expect(t).toContain("sandbox_scale_up");
    expect(t).toMatch(/before (you )?(run|start)/i);
    expect(t).toMatch(/tests|build|type check|install/);
    expect(t).toMatch(/Makefile|custom script/i);
    expect(t).toContain("standard-4");
    expect(t).toMatch(/only scale up|cannot scale down/i);
    expect(t).toContain("tens of seconds");
    expect(t).toContain("background");
    expect(t).toContain("stopped");
    expect(t).toMatch(/do not (retry|cancel)/i);
    // 呼ばなくても、重いコマンドでは自動で上がる（保険）
    expect(t).toContain("scaled up");
    expect(t).toMatch(/safety net|automatically/i);
  });

  it("ツールだけ（自動の昇格が無効）: 保険の文は書かない", async () => {
    const t = await testing("up-prompt-tool-only", {
      SANDBOX_AGENT_MAX_INSTANCE: "standard-3",
      SANDBOX_HEAVY_INSTANCE: "",
    });
    expect(t).toContain("sandbox_scale_up");
    expect(t).toContain("standard-3");
    expect(t).not.toMatch(/safety net/i);
    expect(t).not.toContain("scaled up");
  });

  it("ツールが無く自動の昇格だけ: 従来の説明のまま（ツールには触れない）", async () => {
    const t = await testing("up-prompt-auto-only", {
      SANDBOX_AGENT_MAX_INSTANCE: "",
      SANDBOX_HEAVY_INSTANCE: "standard-3",
    });
    expect(t).not.toContain("sandbox_scale_up");
    expect(t).toContain("scaled up");
    expect(t).toContain("tens of seconds");
  });

  it("task_start で大きさを明示したタスク: 大きさは固定なので何も書かない", async () => {
    const t = await testing(
      "up-prompt-fixed",
      { SANDBOX_AGENT_MAX_INSTANCE: "standard-4", SANDBOX_HEAVY_INSTANCE: "standard-3" },
      { sandboxInstance: "standard-1" },
    );
    expect(t).not.toContain("sandbox_scale_up");
    expect(t).not.toContain("scaled up");
  });
});

describe("AgentDO: usage の昇格の履歴", () => {
  it("Sandbox が報告した promotions と、子が上げたあとの重いコマンドの本数が usage.sandbox に載る。不正な要素は捨てる", async () => {
    const fx = newFixture("up-usage", [boot(), report()]);
    fx.sandbox.metricsValue = {
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
        { to: "standard-4", at: 1_700_000_050_000, trigger: "agent", runtimeMsBefore: 60_000 },
        // 不正（表に無い大きさ・引き金・表に無い規則名）は捨てる
        { to: "standard-9", at: 1, trigger: "agent", runtimeMsBefore: 1 },
        { to: "standard-4", at: 1, trigger: "me", runtimeMsBefore: 1 },
        { to: "standard-4", at: 1, trigger: "rule", runtimeMsBefore: 1, ruleMatch: "rm -rf /" },
      ] as never,
      heavyCommandsAfterAgentScaleUp: 3,
    };
    expect(await start(fx, "up-usage")).toBe("completed");
    const sb = done(await fx.stub.getResult()).usage.sandbox;
    expect(sb?.promotedTo).toBe("standard-4");
    expect(sb?.promotions).toEqual([
      {
        to: "standard-3",
        at: 1_700_000_000_000,
        trigger: "rule",
        runtimeMsBefore: 30_000,
        ruleMatch: "vitest",
      },
      { to: "standard-4", at: 1_700_000_050_000, trigger: "agent", runtimeMsBefore: 60_000 },
    ]);
    expect(sb?.heavyCommandsAfterAgentScaleUp).toBe(3);
  });

  it("昇格していないタスクには付かない", async () => {
    const fx = newFixture("up-usage-none", [boot(), report()]);
    fx.sandbox.metricsValue = {
      runtimeMs: 10,
      restarts: 0,
      bootRetries: 0,
      instance: "standard-2",
    };
    expect(await start(fx, "up-usage-none")).toBe("completed");
    const sb = done(await fx.stub.getResult()).usage.sandbox;
    expect(sb).not.toHaveProperty("promotions");
    expect(sb).not.toHaveProperty("heavyCommandsAfterAgentScaleUp");
  });
});
