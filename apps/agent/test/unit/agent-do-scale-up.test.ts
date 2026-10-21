import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { clearAgentTestOverrides } from "../../src/agent/deps";
import { sameUsage, ZERO_USAGE } from "../../src/agent/store";
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

describe("AgentDO: usage の昇格の履歴（不明な規則名・的中・失敗の内訳）", () => {
  it("表に無い規則名の要素は捨てずに残し、rule_match だけ落とす（要素が欠けると按分の区間がずれる）", async () => {
    const fx = newFixture("up-usage-rule", [boot(), report()]);
    fx.sandbox.metricsValue = {
      runtimeMs: 90_000,
      restarts: 0,
      bootRetries: 0,
      instance: "standard-2",
      promotedTo: "standard-4",
      promotedAt: 1,
      runtimeMsBeforePromotion: 10_000,
      promotions: [
        {
          to: "standard-3",
          at: 1,
          trigger: "rule",
          runtimeMsBefore: 10_000,
          ruleMatch: "rm -rf /",
        },
        { to: "standard-4", at: 2, trigger: "agent", runtimeMsBefore: 60_000 },
      ] as never,
    };
    expect(await start(fx, "up-usage-rule")).toBe("completed");
    const sb = done(await fx.stub.getResult()).usage.sandbox;
    expect(sb?.promotions).toEqual([
      { to: "standard-3", at: 1, trigger: "rule", runtimeMsBefore: 10_000 },
      { to: "standard-4", at: 2, trigger: "agent", runtimeMsBefore: 60_000 },
    ]);
    expect(JSON.stringify(sb)).not.toContain("rm -rf");
  });

  it("子の見立ての的中の本数と、昇格の失敗の内訳が usage.sandbox に載る。固定の値以外の要素は捨て、8 件を超える分も捨てる", async () => {
    const fx = newFixture("up-usage-fail", [boot(), report()]);
    const good = { trigger: "rule", reason: "snapshot_failed" };
    fx.sandbox.metricsValue = {
      runtimeMs: 10,
      restarts: 0,
      bootRetries: 0,
      instance: "standard-2",
      heavyCommandsAfterAgentScaleUp: 3,
      heavyCommandsCoveredByAgent: 2,
      promotionFailures: [
        good,
        { trigger: "agent", reason: "start_failed", text: SECRET },
        { trigger: "me", reason: "start_failed" },
        { trigger: "rule", reason: `rm -rf / ${SECRET}` },
        { trigger: "verification" },
        "x",
        ...Array.from({ length: 10 }, () => ({ trigger: "agent", reason: "fallback_failed" })),
      ] as never,
    };
    expect(await start(fx, "up-usage-fail")).toBe("completed");
    const sb = done(await fx.stub.getResult()).usage.sandbox;
    expect(sb?.heavyCommandsCoveredByAgent).toBe(2);
    expect(sb?.promotionFailures).toHaveLength(8);
    expect(sb?.promotionFailures?.slice(0, 2)).toEqual([
      good,
      { trigger: "agent", reason: "start_failed" },
    ]);
    expect(JSON.stringify(sb)).not.toContain(SECRET);
  });

  it("的中も失敗も無ければ付かない", async () => {
    const fx = newFixture("up-usage-nofail", [boot(), report()]);
    fx.sandbox.metricsValue = {
      runtimeMs: 10,
      restarts: 0,
      bootRetries: 0,
      instance: "standard-2",
    };
    expect(await start(fx, "up-usage-nofail")).toBe("completed");
    const sb = done(await fx.stub.getResult()).usage.sandbox;
    expect(sb).not.toHaveProperty("promotionFailures");
    expect(sb).not.toHaveProperty("heavyCommandsCoveredByAgent");
  });
});

describe("AgentDO: sandbox_scale_up の登録（task_start で大きさを固定したタスクと選べる名前）", () => {
  it("task_start で sandbox_instance を明示したタスクでは、ツールを登録しない（呼んでも Sandbox に届かない）", async () => {
    const fx = newFixture("up-fixed-tool", [boot(), scale(), report()]);
    expect(
      await start(
        fx,
        "up-fixed-tool",
        { SANDBOX_AGENT_MAX_INSTANCE: "standard-4" },
        {
          sandboxInstance: "standard-1",
        },
      ),
    ).toBe("completed");
    expect(fx.sandbox.scaleUpCalls).toEqual([]);
    expect((fx.modelCalls.toolResults[2] ?? []).join("\n")).toMatch(
      /not found|unknown tool|not available/i,
    );
    const enabled = await runInDO(fx.stub, (inst) => inst.piHooks().sandboxScaleUpEnabled());
    expect(enabled).toBe(false);
  });

  it("instance 引数の説明には、上限までの名前だけを並べる（上限より大きい名前を書かない）", async () => {
    const { createAgentExtension } = await import("../../src/pi/extension");
    const base = {
      beforeTool: async () => undefined,
      afterTool: async () => {},
      afterTools: async () => {},
      onYield: async () => undefined,
      reportCompletion: async () => ({ text: "", isError: false, terminate: false }),
      askParent: async () => ({ text: "", isError: false, terminate: false }),
      webSearch: async () => ({ text: "", isError: false }),
      webFetch: async () => ({ text: "", isError: false }),
      webBrowse: async () => ({ text: "", isError: false }),
      webBrowseEnabled: () => false,
      sandboxScaleUpEnabled: () => true,
      sections: () => [],
    };
    const descOf = (choices: string[]) => {
      const ext = createAgentExtension([], { ...base, sandboxScaleUpChoices: () => choices });
      const tool = (
        ext as unknown as {
          tools: {
            name: string;
            parameters: { properties: { instance: { description: string } } };
          }[];
        }
      ).tools.find((t) => t.name === "sandbox_scale_up");
      return tool?.parameters.properties.instance.description ?? "";
    };
    const d3 = descOf(["standard-1", "standard-2", "standard-3"]);
    expect(d3).toContain("standard-3");
    expect(d3).not.toContain("standard-4");
    const d1 = descOf(["standard-1"]);
    expect(d1).toContain("standard-1");
    expect(d1).not.toContain("standard-2");
  });

  it("AgentDO が渡す選べる名前は SANDBOX_AGENT_MAX_INSTANCE までで作る", async () => {
    for (const [max, expected] of [
      ["standard-3", ["standard-1", "standard-2", "standard-3"]],
      ["standard-2", ["standard-1", "standard-2"]],
      ["standard-4", ["standard-1", "standard-2", "standard-3", "standard-4"]],
    ] as const) {
      const fx = newFixture(`up-choices-${max}`, [boot(), report()]);
      expect(await start(fx, `up-choices-${max}`, { SANDBOX_AGENT_MAX_INSTANCE: max })).toBe(
        "completed",
      );
      const choices = await runInDO(fx.stub, (inst) => inst.piHooks().sandboxScaleUpChoices());
      expect(choices).toEqual(expected);
    }
  });

  it("上限に収まらない名前を頼まれたときの拒否の文も、上限までの名前だけを並べる", async () => {
    const fx = newFixture("up-reject-text", [boot(), scale("standard-9"), report()]);
    fx.sandbox.scaleUpResults = [
      { outcome: "rejected", code: "invalid_instance", instance: "standard-2", max: "standard-3" },
    ];
    expect(await start(fx, "up-reject-text")).toBe("completed");
    const seen = (fx.modelCalls.toolResults[2] ?? []).join("\n");
    expect(seen).toContain("standard-1, standard-2, standard-3");
    expect(seen).not.toContain("standard-4");
  });
});

describe("sameUsage: 的中の本数・失敗の内訳の違いも別の usage として扱う（usage イベントを出し直す）", () => {
  const base = { ...ZERO_USAGE, sandbox: { runtimeMs: 1, restarts: 0, bootRetries: 0 } };
  it("本数が違う・内訳が違うと同じではない。同じなら同じ", () => {
    const a = { ...base, sandbox: { ...base.sandbox, heavyCommandsCoveredByAgent: 1 } };
    expect(
      sameUsage(a, { ...base, sandbox: { ...base.sandbox, heavyCommandsCoveredByAgent: 1 } }),
    ).toBe(true);
    expect(
      sameUsage(a, { ...base, sandbox: { ...base.sandbox, heavyCommandsCoveredByAgent: 2 } }),
    ).toBe(false);
    const f = { trigger: "rule", reason: "snapshot_failed" } as const;
    const b = { ...base, sandbox: { ...base.sandbox, promotionFailures: [f] } };
    expect(sameUsage(b, { ...base, sandbox: { ...base.sandbox, promotionFailures: [f] } })).toBe(
      true,
    );
    expect(sameUsage(b, base)).toBe(false);
  });
});
