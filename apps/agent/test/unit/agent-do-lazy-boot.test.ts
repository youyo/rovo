import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { clearAgentTestOverrides } from "../../src/agent/deps";
import type { WebPort } from "../../src/tools/web";
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

// Sandbox は、最初に Sandbox を使うツール（ファイルの読み書き・コマンド・git など）が呼ばれたときに起動する。
// web_search / web_fetch や質問だけで進むタスクでは起動しない。
const noVerify = (name: string, over: Record<string, unknown> = {}) =>
  makeSpec(name, { verificationCommands: [], ...over });

const webPort = (): WebPort => ({
  async search() {
    return {
      results: [],
      metadata: { requestId: "r", latencyMs: 1, provider: "ceramic", dropped_urls: 0 },
    };
  },
  async fetchUrl() {
    throw new Error("unused");
  },
  async browse() {
    throw new Error("unused");
  },
});

describe("lazy boot: Sandbox は必要になるまで起動しない", () => {
  it("Sandbox を使わないタスク（web_search だけ）では ensureReady を呼ばず、exec もせずに完了する", async () => {
    const fx = newFixture(
      "lazy-web",
      [call("web_search", { query: "rovo" }), call("echo", { text: "x" }), report("調べた")],
      { web: webPort() },
    );
    const res = await fx.stub.start(noVerify("lazy-web"));
    expect(res).toMatchObject({ status: "accepted" });
    expect(await waitForTerminal(fx)).toBe("completed");
    expect(fx.sandbox.readySpecs).toHaveLength(0);
    expect(fx.sandbox.calls).toHaveLength(0);
    // 作業ブランチはリモートに作成済みの出発点のまま。push も同期もしない
    expect(fx.pushCalls).toHaveLength(0);
    // 終端の片付け（terminate）は従来どおり
    expect(fx.sandbox.terminateCount).toBe(1);
    const r = done(await fx.stub.getResult());
    expect(r.status).toBe("completed");
    // 変更は無い: patch は空、検証は未実施
    expect(r.patch ?? "").toBe("");
    expect(r.verification?.verified).toBe(false);
  });

  it("起動する前に cancel しても、Sandbox を起動せずに止まる（terminate は呼ぶ）", async () => {
    const fx = newFixture("lazy-cancel", [call("gate"), report()], { cancelWaitMs: 300 });
    await fx.stub.start(noVerify("lazy-cancel"));
    await fx.gate.waitEntered();
    await fx.stub.cancel();
    fx.gate.release();
    expect(await waitForTerminal(fx)).toBe("cancelled");
    expect(fx.sandbox.readySpecs).toHaveLength(0);
    expect(fx.sandbox.calls).toHaveLength(0);
    expect(fx.sandbox.terminateCount).toBeGreaterThanOrEqual(1);
    fx.gate.release();
  });

  it("最初の Sandbox ツールで 1 回だけ起動し、そのあとのツールでは起動し直さない（トークンを預けた後）", async () => {
    const fx = newFixture("lazy-first", [
      call("echo", { text: "sandbox は要らない" }),
      call("write_note", { text: "a" }),
      call("write_note", { text: "b" }),
      report(),
    ]);
    await fx.stub.start(noVerify("lazy-first"));
    expect(await waitForTerminal(fx)).toBe("completed");
    expect(fx.sandbox.readySpecs).toHaveLength(1);
    // 起動はトークンの後（clone にもトークンが要る）。ensureReady の後にファイルを書いている
    expect(fx.sandbox.order.slice(0, 2)).toEqual(["credential", "ready"]);
    expect(fx.sandbox.files.get("/workspace/note.txt")).toBe("b");
    expect(fx.sandbox.readySpecs[0]).toMatchObject({
      repository: "octo/repo",
      branch: "agent/task-lazy-first",
    });
  });

  it("最初のツールの前（echo だけの間）は起動していない", async () => {
    const fx = newFixture("lazy-gate", [call("gate"), call("write_note", { text: "a" }), report()]);
    await fx.stub.start(noVerify("lazy-gate"));
    await fx.gate.waitEntered();
    expect(fx.sandbox.readySpecs).toHaveLength(0);
    fx.gate.release();
    expect(await waitForTerminal(fx)).toBe("completed");
    expect(fx.sandbox.readySpecs).toHaveLength(1);
  });

  it("同時の起動要求は 1 つの ensureReady を共有する", async () => {
    const fx = newFixture("lazy-shared", [call("gate")]);
    let release: () => void = () => {};
    const hold = new Promise<void>((r) => {
      release = r;
    });
    const orig = fx.sandbox.ensureReady.bind(fx.sandbox);
    fx.sandbox.ensureReady = async (spec) => {
      await hold;
      return orig(spec);
    };
    await fx.stub.start(noVerify("lazy-shared"));
    await fx.gate.waitEntered();
    const both = runInDO(fx.stub, (inst) =>
      Promise.all([inst.ensureSandboxReady(), inst.ensureSandboxReady()]),
    );
    release();
    await both;
    expect(fx.sandbox.readySpecs).toHaveLength(1);
    fx.gate.release();
    await waitForTerminal(fx);
  });

  it("起動に失敗しても rovo の側で再試行する: 1〜2 回失敗して 3 回目で成功すれば、ツールは成功し、モデルの呼び出しは増えない", async () => {
    const fx = newFixture("lazy-retry", [
      call("write_note", { text: "1" }),
      call("write_note", { text: "2" }),
      report(),
    ]);
    const orig = fx.sandbox.ensureReady.bind(fx.sandbox);
    let n = 0;
    fx.sandbox.ensureReady = async (spec) => {
      n += 1;
      if (n <= 2) throw new Error("transient");
      return orig(spec);
    };
    await fx.stub.start(noVerify("lazy-retry"));
    expect(await waitForTerminal(fx)).toBe("completed");
    expect(n).toBe(3);
    expect(fx.sandbox.files.get("/workspace/note.txt")).toBe("2");
    const ends = (await allEvents(fx)).filter((e) => e.type === "tool_end");
    expect(ends.some((e) => e.data.isError === true)).toBe(false);
    // write_note x2 + report の 3 回だけ（失敗の判断をモデルに任せない）
    expect(fx.modelCalls.count).toBe(3);
  });

  it("3 回とも失敗したら、モデルを介さずに sandbox_setup_failed で終える", async () => {
    const fx = newFixture("lazy-fail", [
      call("write_note", { text: "1" }),
      call("write_note", { text: "2" }),
      report(),
    ]);
    let attempts = 0;
    fx.sandbox.ensureReady = async (spec) => {
      attempts += 1;
      fx.sandbox.readySpecs.push(spec);
      throw new Error("boot failed");
    };
    await fx.stub.start(noVerify("lazy-fail"));
    expect(await waitForTerminal(fx)).toBe("failed");
    expect(attempts).toBe(3);
    const events = await allEvents(fx);
    expect(
      events.some(
        (e) => e.type === "error" && String(e.data.message).includes("sandbox setup failed"),
      ),
    ).toBe(true);
    const phase = events.filter((e) => e.type === "phase").at(-1);
    expect(phase?.data).toMatchObject({ phase: "failed", reason: "sandbox_setup_failed" });
    expect(fx.sandbox.files.size).toBe(0);
    // 失敗はモデルに返さない: 最初の 1 回のあと、モデルは呼ばれない
    expect(fx.modelCalls.count).toBe(1);
  });

  it("終端になった後に来た起動の要求は、ensureReady を呼ばず、失敗として数えない", async () => {
    const fx = newFixture("lazy-after-terminal", [call("gate"), report()], { cancelWaitMs: 300 });
    await fx.stub.start(noVerify("lazy-after-terminal"));
    await fx.gate.waitEntered();
    await fx.stub.cancel();
    fx.gate.release();
    expect(await waitForTerminal(fx)).toBe("cancelled");
    await expect(runInDO(fx.stub, (inst) => inst.ensureSandboxReady())).rejects.toThrow(
      /terminal|stopped|ended/i,
    );
    expect(fx.sandbox.readySpecs).toHaveLength(0);
    expect(await runInDO(fx.stub, (inst) => inst.store.meta("setup_attempts"))).toBeUndefined();
  });

  it("再試行の待ちの最中に cancel が来たら、それ以上再試行せずに終わる", async () => {
    const fx = newFixture("lazy-cancel-in-wait", [call("write_note", { text: "1" }), report()], {
      cancelWaitMs: 300,
    });
    let attempts = 0;
    fx.sandbox.ensureReady = async () => {
      attempts += 1;
      throw new Error("boot failed");
    };
    await runInDO(fx.stub, (inst) => {
      const orig = inst.overrides.bind(inst);
      inst.overrides = () => ({ ...orig(), setupRetryDelayMs: 1500 });
    });
    await fx.stub.start(noVerify("lazy-cancel-in-wait"));
    await waitUntil(() => attempts === 1);
    await fx.stub.cancel();
    expect(await waitForTerminal(fx)).toBe("cancelled");
    await new Promise((r) => setTimeout(r, 2200));
    expect(attempts).toBe(1);
  });

  it("起動を試みて失敗したタスクは、report_completion の近道（起動せずに完了）で成功にならない", async () => {
    const fx = newFixture("lazy-failed-noshortcut", [call("gate"), report()]);
    await fx.stub.start(noVerify("lazy-failed-noshortcut"));
    await fx.gate.waitEntered();
    await runInDO(fx.stub, (inst) => inst.store.setMeta("setup_attempts", 1));
    fx.gate.release();
    expect(await waitForTerminal(fx)).toBe("completed");
    // 近道を使わず、確かめるために起動した
    expect(fx.sandbox.readySpecs).toHaveLength(1);
  });

  it("依存キャッシュの結果は起動のときに読む（ワーカーのプロンプトの「依存は導入済み」の判断に使う）", async () => {
    const fx = newFixture("lazy-deps", [call("gate"), call("write_note", { text: "a" }), report()]);
    fx.sandbox.metricsValue = { runtimeMs: 0, restarts: 0, bootRetries: 0, depsCache: "hit" };
    await fx.stub.start(noVerify("lazy-deps"));
    await fx.gate.waitEntered();
    // 起動前は未確定（導入済みと書かない側）
    expect(await runInDO(fx.stub, (inst) => inst.depsInstalled())).toBe(false);
    fx.gate.release();
    expect(await waitForTerminal(fx)).toBe("completed");
    expect(await runInDO(fx.stub, (inst) => inst.depsInstalled())).toBe(true);
  });

  it("質問のためには起動しない: 起動前の ask_parent は git status も期限の延長もせず、回答の後も期限を設定しない", async () => {
    const fx = newFixture("lazy-ask", [ask("どちら？"), report()]);
    await fx.stub.start(noVerify("lazy-ask"));
    await waitForPhase(fx, "input_required");
    expect(fx.sandbox.readySpecs).toHaveLength(0);
    expect(fx.sandbox.calls).toHaveLength(0);
    expect(fx.sandbox.extended).toEqual([]);
    const res = await fx.stub.answer("q-1", "A");
    expect(res).toMatchObject({ ok: true });
    expect(fx.sandbox.deadlines).toEqual([]);
    expect(await waitForTerminal(fx)).toBe("completed");
    expect(fx.sandbox.readySpecs).toHaveLength(0);
  });

  it("検証コマンドがあるタスクは、完了の申告のとき（検証のために）起動する", async () => {
    const fx = newFixture("lazy-verify", [call("echo", { text: "x" }), report()]);
    await fx.stub.start(makeSpec("lazy-verify"));
    expect(await waitForTerminal(fx)).toBe("completed");
    expect(fx.sandbox.readySpecs).toHaveLength(1);
    expect(fx.verifyCalls).toEqual([["npm", "test"]]);
  });

  it("lazy boot の前に始まったタスク（lazy_boot の印が無く、投入済み）は、起動済みとして扱う", async () => {
    const fx = newFixture("lazy-legacy", [call("gate"), report()]);
    await fx.stub.start(noVerify("lazy-legacy"));
    await fx.gate.waitEntered();
    const booted = await runInDO(fx.stub, (inst) => {
      const before = inst.sandboxBooted();
      inst.store.setMeta("lazy_boot", false);
      return { before, legacy: inst.sandboxBooted() };
    });
    expect(booted).toEqual({ before: false, legacy: true });
    fx.gate.release();
    await waitForTerminal(fx);
  });
});

describe("sandbox_instance（明示した大きさ）", () => {
  it("spec.sandboxInstance は WorkspaceSpec.instance として SandboxDO へ渡る。省略時は instance を付けない", async () => {
    const a = newFixture("size-a", [call("write_note", { text: "a" }), report()]);
    await a.stub.start(noVerify("size-a", { sandboxInstance: "standard-4" }));
    expect(await waitForTerminal(a)).toBe("completed");
    expect(a.sandbox.readySpecs[0]).toMatchObject({ instance: "standard-4" });

    const b = newFixture("size-b", [call("write_note", { text: "a" }), report()]);
    await b.stub.start(noVerify("size-b"));
    expect(await waitForTerminal(b)).toBe("completed");
    expect(b.sandbox.readySpecs[0]).not.toHaveProperty("instance");
  });

  it("lite・未知の値は start を拒否する（Sandbox も起動しない）", async () => {
    for (const [i, bad] of ["lite", "standard-9", ""].entries()) {
      const fx = newFixture(`size-bad-${i}`, []);
      const res = await fx.stub.start(noVerify(`size-bad-${i}`, { sandboxInstance: bad }));
      expect(res, bad).toMatchObject({ status: "rejected" });
      expect((res as { reason: string }).reason).toContain("sandboxInstance");
      expect(fx.sandbox.readySpecs).toHaveLength(0);
    }
  });

  it("実際に起動した大きさ（metrics.instance）が usage.sandbox.instance に載る。起動しなければ載らない", async () => {
    const a = newFixture("size-usage-a", [call("write_note", { text: "a" }), report()]);
    a.sandbox.metricsValue = {
      runtimeMs: 10,
      restarts: 0,
      bootRetries: 0,
      instance: "standard-3",
    };
    await a.stub.start(noVerify("size-usage-a", { sandboxInstance: "standard-3" }));
    expect(await waitForTerminal(a)).toBe("completed");
    expect(done(await a.stub.getResult()).usage.sandbox?.instance).toBe("standard-3");

    const b = newFixture("size-usage-b", [report()]);
    b.sandbox.metricsValue = { runtimeMs: 0, restarts: 0, bootRetries: 0 };
    await b.stub.start(noVerify("size-usage-b"));
    expect(await waitForTerminal(b)).toBe("completed");
    expect(done(await b.stub.getResult()).usage.sandbox).not.toHaveProperty("instance");
  });
});

describe("sandbox の昇格（usage とプロンプト）", () => {
  it("昇格した大きさ・時刻・昇格までの時間・見送りの理由が usage.sandbox に載る。起動した大きさ（instance）は最初のまま", async () => {
    const a = newFixture("promo-usage-a", [call("write_note", { text: "a" }), report()]);
    a.sandbox.metricsValue = {
      runtimeMs: 90_000,
      restarts: 0,
      bootRetries: 0,
      instance: "standard-2",
      promotedTo: "standard-3",
      promotedAt: 1_700_000_000_000,
      runtimeMsBeforePromotion: 30_000,
    };
    await a.stub.start(noVerify("promo-usage-a"));
    expect(await waitForTerminal(a)).toBe("completed");
    expect(done(await a.stub.getResult()).usage.sandbox).toMatchObject({
      instance: "standard-2",
      promotedTo: "standard-3",
      promotedAt: 1_700_000_000_000,
      runtimeMsBeforePromotion: 30_000,
    });

    const b = newFixture("promo-usage-b", [call("write_note", { text: "a" }), report()]);
    b.sandbox.metricsValue = {
      runtimeMs: 10,
      restarts: 0,
      bootRetries: 0,
      instance: "standard-2",
      promotionReason: "snapshot_unsupported",
    };
    await b.stub.start(noVerify("promo-usage-b"));
    expect(await waitForTerminal(b)).toBe("completed");
    const sb = done(await b.stub.getResult()).usage.sandbox;
    expect(sb?.promotionReason).toBe("snapshot_unsupported");
    expect(sb).not.toHaveProperty("promotedTo");
  });

  const testing = async (name: string, vars: Record<string, string>, over = {}) => {
    const fx = newFixture(name, [call("gate")]);
    await fx.stub.start(noVerify(name, over));
    await fx.gate.waitEntered();
    const s = await runInDO<{ key: string; text: string | undefined }[]>(fx.stub, (inst) => {
      inst.env = { ...inst.env, ...vars };
      return inst.promptSections();
    });
    fx.gate.release();
    await waitForTerminal(fx); // テストの終了後にタスクが動き続けて、ログが環境の破棄と競合しないようにする
    return s.find((x) => x.key === "testing")?.text ?? "";
  };

  it("プロンプト: 昇格が有効なら、必要なときに Sandbox が自動で大きくなり数十秒かかることを伝える", async () => {
    const t = await testing("promo-prompt-on", { SANDBOX_MAX_INSTANCE: "standard-3" });
    expect(t).toContain("scaled up");
    expect(t).toContain("tens of seconds");
    // 昇格するとプロセスは引き継がれない（dev server などは止まる）
    expect(t).toContain("background");
    expect(t).toContain("stopped");
  });

  it("プロンプト: 昇格しない（無効・大きさを明示した）なら書かない", async () => {
    expect(await testing("promo-prompt-off", { SANDBOX_MAX_INSTANCE: "" })).not.toContain(
      "scaled up",
    );
    expect(
      await testing(
        "promo-prompt-fixed",
        { SANDBOX_MAX_INSTANCE: "standard-3" },
        { sandboxInstance: "standard-1" },
      ),
    ).not.toContain("scaled up");
  });
});

describe("ワーカーのシステムプロンプト", () => {
  const sections = async (name: string) => {
    const fx = newFixture(name, [call("gate")]);
    await fx.stub.start(noVerify(name));
    await fx.gate.waitEntered();
    const s = await runInDO<{ key: string; text: string | undefined }[]>(fx.stub, (inst) =>
      inst.promptSections(),
    );
    fx.gate.release();
    return s;
  };

  it("TDD の途中は変更したファイルに関係するテストだけを流し、全体は完了報告の前に 1 回だけ。末尾の改行を保つ", async () => {
    const s = await sections("prompt-1");
    const text = s.find((x) => x.key === "testing")?.text ?? "";
    expect(text).toContain("only the tests related to the files you changed");
    expect(text).toContain("vitest run <file>");
    expect(text).toContain("once, right before report_completion");
    expect(text).toContain("trailing newline");
  });
});

describe("ワーカーのシステムプロンプト（Pi が実際に組み立てたもの）", () => {
  it("dependencies の節が実際のプロンプトに出る。起動前でも正しい文（最初のコマンドの前に導入される）", async () => {
    const fx = newFixture("prompt-deps", [call("echo", { text: "x" }), report()]);
    await fx.stub.start(noVerify("prompt-deps", { deps: DEPS }));
    expect(await waitForTerminal(fx)).toBe("completed");
    const sys = fx.modelCalls.systemTexts[0] ?? "";
    expect(sys).toContain("installed before your first command");
    expect(sys).toContain("only the tests related to the files you changed");
  });
});

const DEPS = {
  repositoryId: 4242,
  lockfilePath: "pnpm-lock.yaml",
  blobSha: "a".repeat(40),
  installCommand: "pnpm install --frozen-lockfile",
  packageJsonSha: "d".repeat(40),
  workspaceSha: null,
  manifestsSha: null,
};
