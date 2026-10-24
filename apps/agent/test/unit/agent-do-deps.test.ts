import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { clearAgentTestOverrides } from "../../src/agent/deps";
import type { SandboxMetrics } from "../../src/agent/types";
import {
  allEvents,
  boot,
  call,
  done,
  makeSpec,
  newFixture,
  report,
  waitForTerminal,
} from "./support/agent-fixture";

// D14（依存関係のキャッシュ）の AgentDO 側: deps を SandboxDO へ渡す・結果を usage に載せる・ワーカーのシステムプロンプトに書く

afterEach(() => clearAgentTestOverrides());

// biome-ignore lint/suspicious/noExplicitAny: private メンバーの観測
type Inst = any;
const runInDO = runInDurableObject as unknown as <T>(
  stub: unknown,
  fn: (inst: Inst) => Promise<T> | T,
) => Promise<T>;

const deps = {
  repositoryId: 4242,
  lockfilePath: "pnpm-lock.yaml",
  blobSha: "a".repeat(40),
  installCommand: "pnpm install --frozen-lockfile",
  packageJsonSha: "d".repeat(40),
  workspaceSha: null,
  manifestsSha: null,
};
const base: SandboxMetrics = { runtimeMs: 5_000, restarts: 0, bootRetries: 0 };

const depsSection = (stub: unknown) =>
  runInDO(stub, (inst) =>
    inst.promptSections().find((s: { key: string }) => s.key === "dependencies"),
  );

describe("TaskSpec.deps を Sandbox へ渡す", () => {
  it("deps は WorkspaceSpec にそのまま載る", async () => {
    const fx = newFixture("deps-pass", [report()]);
    await fx.stub.start(makeSpec("deps-pass", { deps }));
    await waitForTerminal(fx);
    expect(fx.sandbox.readySpecs[0]?.deps).toEqual(deps);
  });

  it("deps が無い・null なら、Sandbox にも null（キャッシュなし）で渡す", async () => {
    const a = newFixture("deps-none", [report()]);
    await a.stub.start(makeSpec("deps-none"));
    await waitForTerminal(a);
    expect(a.sandbox.readySpecs[0]?.deps ?? null).toBeNull();

    const b = newFixture("deps-null", [report()]);
    await b.stub.start(makeSpec("deps-null", { deps: null }));
    await waitForTerminal(b);
    expect(b.sandbox.readySpecs[0]?.deps ?? null).toBeNull();
  });

  it("deps が違う start の再送は conflict（同じ spec の再送は受理）", async () => {
    const fx = newFixture("deps-fp", [call("gate")]);
    const spec = makeSpec("deps-fp", { deps });
    expect(await fx.stub.start(spec)).toMatchObject({ status: "accepted", alreadyAccepted: false });
    expect(await fx.stub.start(spec)).toMatchObject({ status: "accepted", alreadyAccepted: true });
    expect(await fx.stub.start({ ...spec, deps: null })).toEqual({ status: "conflict" });
    fx.gate.release();
    await waitForTerminal(fx);
  });
});

describe("usage の sandbox に depsCache / cacheBuildMs を載せる", () => {
  it("built: depsCache と cacheBuildMs が usage イベントと結果に載る", async () => {
    const fx = newFixture("deps-usage", [
      { ...call("write_note", { text: "x" }), usage: { input: 10 } },
      report(),
    ]);
    const m: SandboxMetrics = { ...base, depsCache: "built", cacheBuildMs: 42_000 };
    fx.sandbox.metricsValue = m;
    await fx.stub.start(makeSpec("deps-usage", { deps }));
    expect(await waitForTerminal(fx)).toBe("completed");
    expect(done(await fx.stub.getResult()).usage.sandbox).toEqual(m);
    const usages = (await allEvents(fx)).filter((e) => e.type === "usage");
    expect(usages.at(-1)?.data.sandbox).toEqual(m);
  });

  it("hit は cacheBuildMs を持たない。disabled / miss もそのまま載る", async () => {
    for (const status of ["hit", "miss", "disabled"] as const) {
      const fx = newFixture(`deps-usage-${status}`, [report()]);
      fx.sandbox.metricsValue = { ...base, depsCache: status };
      await fx.stub.start(makeSpec(`deps-usage-${status}`, { deps }));
      expect(await waitForTerminal(fx)).toBe("completed");
      const sb = done(await fx.stub.getResult()).usage.sandbox;
      expect(sb).toEqual({ ...base, depsCache: status });
      expect(sb).not.toHaveProperty("cacheBuildMs");
    }
  });

  it("miss の理由（depsMissReason）が usage イベントと結果に載る。miss 以外には載せない", async () => {
    const fx = newFixture("deps-reason", [call("write_note", { text: "x" }), report()]);
    const m: SandboxMetrics = { ...base, depsCache: "miss", depsMissReason: "build_failed" };
    fx.sandbox.metricsValue = m;
    await fx.stub.start(makeSpec("deps-reason", { deps }));
    expect(await waitForTerminal(fx)).toBe("completed");
    expect(done(await fx.stub.getResult()).usage.sandbox).toEqual(m);
    const usages = (await allEvents(fx)).filter((e) => e.type === "usage");
    expect(usages.at(-1)?.data.sandbox).toEqual(m);

    const hit = newFixture("deps-reason-hit", [report()]);
    hit.sandbox.metricsValue = { ...base, depsCache: "hit", depsMissReason: "build_failed" };
    await hit.stub.start(makeSpec("deps-reason-hit", { deps }));
    expect(await waitForTerminal(hit)).toBe("completed");
    expect(done(await hit.stub.getResult()).usage.sandbox).not.toHaveProperty("depsMissReason");
  });

  it("cacheBuildMs は巻き戻さない", async () => {
    const fx = newFixture("deps-mono", [call("gate"), report()]);
    fx.sandbox.metricsValue = { ...base, depsCache: "built", cacheBuildMs: 9_000 };
    await fx.stub.start(makeSpec("deps-mono", { deps }));
    await fx.gate.waitEntered();
    fx.sandbox.metricsValue = { ...base, depsCache: "built", cacheBuildMs: 100 };
    fx.gate.release();
    expect(await waitForTerminal(fx)).toBe("completed");
    expect(done(await fx.stub.getResult()).usage.sandbox).toMatchObject({ cacheBuildMs: 9_000 });
  });

  it("カウンタに depsCache が無い実装でも従来どおり（キーを足さない）", async () => {
    const fx = newFixture("deps-absent", [report()]);
    fx.sandbox.metricsValue = base;
    await fx.stub.start(makeSpec("deps-absent"));
    expect(await waitForTerminal(fx)).toBe("completed");
    expect(done(await fx.stub.getResult()).usage.sandbox).toEqual(base);
  });
});

describe("ワーカーのシステムプロンプト", () => {
  it("hit / built: 依存関係は導入済みで、npm ci は不要。lockfile を変えたときだけ入れ直すと書く", async () => {
    for (const status of ["hit", "built"] as const) {
      const fx = newFixture(`deps-prompt-${status}`, [boot(), call("gate")]);
      fx.sandbox.metricsValue = { ...base, depsCache: status };
      await fx.stub.start(makeSpec(`deps-prompt-${status}`, { deps }));
      await fx.gate.waitEntered();
      const section = await depsSection(fx.stub);
      expect(section?.text, status).toMatch(/already installed/i);
      expect(section?.text).toMatch(/do not run (npm ci|an install)|not need to run/i);
      expect(section?.text).toMatch(/lockfile/i);
      fx.gate.release();
      await waitForTerminal(fx);
    }
  });

  it("miss / disabled / 不明: 節を出さない（導入済みと誤解させない）", async () => {
    for (const status of ["miss", "disabled", undefined] as const) {
      const fx = newFixture(`deps-prompt-no-${status ?? "unknown"}`, [boot(), call("gate")]);
      fx.sandbox.metricsValue = status ? { ...base, depsCache: status } : base;
      await fx.stub.start(makeSpec(`deps-prompt-no-${status ?? "unknown"}`, { deps }));
      await fx.gate.waitEntered();
      expect((await depsSection(fx.stub))?.text, String(status)).toBeUndefined();
      fx.gate.release();
      await waitForTerminal(fx);
    }
  });
});
