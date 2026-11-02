import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { clearAgentTestOverrides } from "../../src/agent/deps";
import type { SandboxMetrics } from "../../src/agent/types";
import {
  boot,
  call,
  done,
  makeSpec,
  newFixture,
  report,
  waitForTerminal,
} from "./support/agent-fixture";

// 作業ツリーの診断（.npmrc / mise.toml）と、拒否した外向き通信の集計を、AgentDO がワーカーと task_result に伝える。

afterEach(() => clearAgentTestOverrides());

// biome-ignore lint/suspicious/noExplicitAny: private メンバーの観測
type Inst = any;
const runInDO = runInDurableObject as unknown as <T>(
  stub: unknown,
  fn: (inst: Inst) => Promise<T> | T,
) => Promise<T>;

const base: SandboxMetrics = { runtimeMs: 5_000, restarts: 0, bootRetries: 0 };
const NOTE =
  "The repository .npmrc points to a registry that is not allowed (npm.internal.example.com); installs from it will be denied.";

describe("AgentDO: 作業ツリーの診断を伝える", () => {
  it("warnings に固定コード、usage.sandbox にホスト名、ワーカーの依存の節に英語の文", async () => {
    const fx = newFixture("diag-agent", [boot(), call("gate"), report()]);
    fx.sandbox.metricsValue = {
      ...base,
      repoWarnings: ["npmrc_registry_not_allowed", "mise_go_version_unavailable"],
      npmrcRegistryHosts: ["npm.internal.example.com"],
      repoNote: NOTE,
    };
    await fx.stub.start(makeSpec("diag-agent"));
    await fx.gate.waitEntered();
    const section = await runInDO(fx.stub, (inst) =>
      inst.promptSections().find((s: { key: string }) => s.key === "dependencies"),
    );
    expect(section?.text).toContain(NOTE);
    fx.gate.release();
    expect(await waitForTerminal(fx)).toBe("completed");
    const r = done(await fx.stub.getResult());
    expect(r.warnings).toContain("npmrc_registry_not_allowed");
    expect(r.warnings).toContain("mise_go_version_unavailable");
    expect(r.usage.sandbox?.npmrcRegistryHosts).toEqual(["npm.internal.example.com"]);
    // ワーカー向けの文は gateway へ送らない
    expect(r.usage.sandbox).not.toHaveProperty("repoNote");
  });

  it("表に無い警告・検証できないホスト名は出さない", async () => {
    const fx = newFixture("diag-agent-junk", [boot(), report()]);
    fx.sandbox.metricsValue = {
      ...base,
      repoWarnings: ["npmrc_registry_not_allowed", "evil <b>text</b> ghp_X"] as never,
      npmrcRegistryHosts: ["ok.example.com", "bad host", "x/y", 3 as never, "a", "b", "c", "d"],
    };
    await fx.stub.start(makeSpec("diag-agent-junk"));
    expect(await waitForTerminal(fx)).toBe("completed");
    const r = done(await fx.stub.getResult());
    expect(r.warnings.filter((w: string) => w.includes("ghp_") || w.includes("<b>"))).toEqual([]);
    expect(r.warnings).toContain("npmrc_registry_not_allowed");
    expect(r.usage.sandbox?.npmrcRegistryHosts).toEqual(["ok.example.com", "a", "b", "c", "d"]);
  });

  it("拒否した外向き通信の集計（outboundDenied / outboundDeniedTotal）を usage.sandbox に載せる。壊れた要素は捨てる", async () => {
    const fx = newFixture("diag-agent-denied", [boot(), report()]);
    fx.sandbox.metricsValue = {
      ...base,
      outboundDenied: [
        { host: "evil.example", reason: "host_not_allowed", count: 3 },
        { host: "bad host", reason: "host_not_allowed", count: 1 },
        { host: "x.example", reason: "made_up", count: 1 },
      ],
      outboundDeniedTotal: 5,
    } as SandboxMetrics;
    await fx.stub.start(makeSpec("diag-agent-denied"));
    expect(await waitForTerminal(fx)).toBe("completed");
    const sb = done(await fx.stub.getResult()).usage.sandbox;
    expect(sb?.outboundDenied).toEqual([
      { host: "evil.example", reason: "host_not_allowed", count: 3 },
    ]);
    expect(sb?.outboundDeniedTotal).toBe(5);
  });

  it("途中の更新（final でない）でも、拒否の集計が増えれば新しい値に替える", async () => {
    const fx = newFixture("diag-agent-denied-mid", [boot(), call("gate"), report()]);
    fx.sandbox.metricsValue = base;
    await fx.stub.start(makeSpec("diag-agent-denied-mid"));
    await fx.gate.waitEntered();
    const prev = {
      ...base,
      outboundDenied: [{ host: "evil.example", reason: "host_not_allowed", count: 1 }],
      outboundDeniedTotal: 1,
    };
    fx.sandbox.metricsValue = {
      ...base,
      outboundDenied: [{ host: "evil.example", reason: "host_not_allowed", count: 4 }],
      outboundDeniedTotal: 4,
    } as SandboxMetrics;
    const next = await runInDO(fx.stub, (inst) => inst.sandboxUsage(prev, false));
    expect(next?.outboundDeniedTotal).toBe(4);
    expect(next?.outboundDenied).toEqual([
      { host: "evil.example", reason: "host_not_allowed", count: 4 },
    ]);
    fx.gate.release();
    expect(await waitForTerminal(fx)).toBe("completed");
  });

  it("診断が無ければ何も足さない", async () => {
    const fx = newFixture("diag-agent-none", [boot(), report()]);
    fx.sandbox.metricsValue = base;
    await fx.stub.start(makeSpec("diag-agent-none"));
    expect(await waitForTerminal(fx)).toBe("completed");
    const r = done(await fx.stub.getResult());
    expect(r.warnings).not.toContain("npmrc_registry_not_allowed");
    expect(r.usage.sandbox).toEqual(base);
  });
});
