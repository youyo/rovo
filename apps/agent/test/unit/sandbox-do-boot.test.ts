import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

// vitest-plugin 上では ctx.container が無いので、SandboxDO の maybeContainer を fake に差し替えて
// 起動まわりの競合を決定的に確かめる（実コンテナでの検証は E2E）。

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const SHA = "a".repeat(40);

class FakeContainer {
  running: boolean;
  startCalls = 0;
  destroyCalls = 0;
  images = { workspace: "fake" };
  constructor(
    initiallyRunning: boolean,
    private readonly destroyMs: number | "never",
  ) {
    this.running = initiallyRunning;
  }
  startOptions: unknown[] = [];
  start(options?: unknown) {
    this.startOptions.push(options);
    this.startCalls += 1;
    this.running = true;
  }
  async destroy() {
    this.destroyCalls += 1;
    if (this.destroyMs === "never") return new Promise<void>(() => {});
    await sleep(this.destroyMs);
    this.running = false;
  }
  async setInactivityTimeout() {}
  async interceptOutboundHttps() {}
  async interceptAllOutboundHttp() {}
  /** true なら、exec が実際のコンテナのように振る舞う（readyOnStart 回目の start より前は応答しない） */
  scripted = false;
  readyOnStart = 1;
  async exec(argv?: string[]): Promise<unknown> {
    if (!this.scripted) throw new Error("not available in this fake");
    // 起動が止まったコンテナ: exec が返らない
    if (this.startCalls < this.readyOnStart) return new Promise<never>(() => {});
    const text = (t: string) =>
      new ReadableStream<Uint8Array>({
        start(c) {
          if (t) c.enqueue(new TextEncoder().encode(t));
          c.close();
        },
      });
    // prepareWorkspace が「既に作業ブランチにいる」と判断するよう、ブランチ名を返す
    const branch = argv?.includes("--abbrev-ref") ? "agent/task-x\n" : "";
    return { stdout: text(branch), stderr: text(""), exitCode: Promise.resolve(0) };
  }
}

// biome-ignore lint/suspicious/noExplicitAny: private メンバーを差し替えるテスト
type Inst = any;
// 型の再帰が深くなるので、スタブの型を畳む
const runInDO = runInDurableObject as unknown as (
  stub: unknown,
  fn: (inst: Inst) => Promise<void>,
) => Promise<void>;
const spec = () => ({
  repository: "acme/hello",
  baseSha: SHA,
  initialSha: SHA,
  branch: "agent/task-x",
  deadlineAt: Date.now() + 3_600_000,
});

describe("SandboxDO の起動と停止の競合", () => {
  it("terminate は進行中の boot を無効化する: destroy が終わっても start は呼ばれない", async () => {
    const stub = (env.SANDBOX_DO as DurableObjectNamespace).getByName("boot-race");
    await runInDO(stub, async (inst: Inst) => {
      // 起動済みだが基準プロセスの記録が無い → boot は先に destroy する
      const fake = new FakeContainer(true, 100);
      inst.maybeContainer = () => fake;
      const ensure = inst.ensureReady(spec()).then(
        () => "ok",
        (e: Error) => e.message,
      );
      await sleep(20); // boot が destroy を待っている
      const t = await inst.terminate();
      const outcome = await ensure;
      expect(fake.startCalls).toBe(0);
      expect(fake.running).toBe(false);
      expect(t).toEqual({ stopped: true });
      expect(outcome).not.toBe("ok");
    });
  });

  it("起動世代が変わった boot は start しない（terminate 以外の無効化も同じ検査を通る）", async () => {
    const stub = (env.SANDBOX_DO as DurableObjectNamespace).getByName("boot-gen");
    await runInDO(stub, async (inst: Inst) => {
      const fake = new FakeContainer(true, 100);
      inst.maybeContainer = () => fake;
      const ensure = inst.ensureReady(spec()).catch(() => "rejected");
      await sleep(20);
      inst.invalidateBoot();
      await ensure;
      await sleep(150);
      expect(fake.startCalls).toBe(0);
    });
  });

  it("terminate は boot が収束した後にもう一度停止を確かめる", async () => {
    const stub = (env.SANDBOX_DO as DurableObjectNamespace).getByName("boot-converge");
    await runInDO(stub, async (inst: Inst) => {
      const fake = new FakeContainer(false, 10);
      inst.maybeContainer = () => fake;
      // 空のコンテナを起動させ、起動待ちの途中で terminate する
      const ensure = inst.ensureReady(spec()).catch(() => "rejected");
      await sleep(20);
      const t = await inst.terminate();
      await ensure;
      expect(fake.running).toBe(false);
      expect(t).toEqual({ stopped: true });
    });
  });
});

describe("destroy の監視期限", () => {
  it("destroy() の Promise が返らなくても、期限が来たらエラーにする（Promise を待つ前から数える）", async () => {
    const stub = (env.SANDBOX_DO as DurableObjectNamespace).getByName("destroy-hang");
    await runInDO(stub, async (inst: Inst) => {
      const fake = new FakeContainer(true, "never");
      inst.maybeContainer = () => fake;
      inst.destroyWaitMs = 300;
      const started = Date.now();
      await expect(inst.destroyContainer()).rejects.toThrow(/did not stop/);
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(fake.destroyCalls).toBe(1);
    });
  });
});

describe("終端後の操作", () => {
  it("terminate の後の exec は例外ではなく terminated の結果で返る（呼び出され側の例外を Uncaught にしない）", async () => {
    const stub = (env.SANDBOX_DO as DurableObjectNamespace).getByName("exec-after-terminate");
    await runInDO(stub, async (inst: Inst) => {
      inst.maybeContainer = () => new FakeContainer(false, 0);
      await inst.terminate();
      const r = await inst.exec(["true"]);
      expect(r).toMatchObject({ exitCode: -1, terminated: true, timedOut: false });
      expect(r.stderr).toMatch(/terminated/i);
    });
  });
});

describe("起動が止まったコンテナの扱い", () => {
  it("1回目の起動が ready にならなければ、破棄して2回目で成功する", async () => {
    const stub = (env.SANDBOX_DO as DurableObjectNamespace).getByName("boot-stall-retry");
    await runInDO(stub, async (inst: Inst) => {
      const fake = new FakeContainer(false, 0);
      fake.scripted = true;
      fake.readyOnStart = 2; // 1回目の start では応答しない
      inst.maybeContainer = () => fake;
      inst.bootAttemptMs = 300;
      await inst.ensureReady(spec());
      expect(fake.startCalls).toBe(2);
      expect(fake.destroyCalls).toBe(1);
      expect(fake.running).toBe(true);
    });
  });

  it("3回とも ready にならなければ、container did not become ready で失敗し、コンテナは止めておく", async () => {
    const stub = (env.SANDBOX_DO as DurableObjectNamespace).getByName("boot-stall-fail");
    await runInDO(stub, async (inst: Inst) => {
      const fake = new FakeContainer(false, 0);
      fake.scripted = true;
      fake.readyOnStart = 99;
      inst.maybeContainer = () => fake;
      inst.bootAttemptMs = 200;
      const started = Date.now();
      await expect(inst.ensureReady(spec())).rejects.toThrow(/container did not become ready/);
      expect(fake.startCalls).toBe(3);
      expect(fake.destroyCalls).toBe(3);
      expect(fake.running).toBe(false);
      expect(Date.now() - started).toBeLessThan(3_000);
    });
  });

  it("破棄が遅くても、破棄の時間は起動の待ちから引かれず、3回目まで試される", async () => {
    const stub = (env.SANDBOX_DO as DurableObjectNamespace).getByName("boot-slow-destroy");
    await runInDO(stub, async (inst: Inst) => {
      const fake = new FakeContainer(false, 400); // 破棄に 400ms（1 回の待ち 300ms より長い）
      fake.scripted = true;
      fake.readyOnStart = 99;
      inst.maybeContainer = () => fake;
      inst.bootAttemptMs = 300;
      inst.bootDestroyMs = 1_000;
      await expect(inst.ensureReady(spec())).rejects.toThrow(/container did not become ready/);
      expect(fake.startCalls).toBe(3);
      expect(fake.destroyCalls).toBe(3);
      expect(fake.running).toBe(false);
    });
  });

  it("破棄が返らなくても、破棄の上限で打ち切られ、全体は (待ち + 破棄の上限) の範囲に収まる", async () => {
    const stub = (env.SANDBOX_DO as DurableObjectNamespace).getByName("boot-hung-destroy");
    await runInDO(stub, async (inst: Inst) => {
      const fake = new FakeContainer(false, "never");
      fake.scripted = true;
      fake.readyOnStart = 99;
      inst.maybeContainer = () => fake;
      inst.bootAttemptMs = 200;
      inst.bootDestroyMs = 300;
      const started = Date.now();
      await expect(inst.ensureReady(spec())).rejects.toThrow(/did not stop/);
      const elapsed = Date.now() - started;
      expect(elapsed).toBeLessThan(200 + 300 + 1_000);
      expect(fake.startCalls).toBe(1);
    });
  });

  it("最悪でも 試行数 x (待ち + 破棄の上限) 以内で失敗する（破棄が上限ぎりぎりに遅い場合）", async () => {
    const stub = (env.SANDBOX_DO as DurableObjectNamespace).getByName("boot-worst-case");
    await runInDO(stub, async (inst: Inst) => {
      const fake = new FakeContainer(false, 250);
      fake.scripted = true;
      fake.readyOnStart = 99;
      inst.maybeContainer = () => fake;
      inst.bootAttemptMs = 200;
      inst.bootDestroyMs = 300;
      const started = Date.now();
      await expect(inst.ensureReady(spec())).rejects.toThrow(/container did not become ready/);
      const elapsed = Date.now() - started;
      expect(fake.startCalls).toBe(3);
      expect(elapsed).toBeLessThan(3 * (200 + 300) + 500);
    });
  });

  it("ready を待っている間に terminate が来たら、すぐに止まり、再試行しない", async () => {
    const stub = (env.SANDBOX_DO as DurableObjectNamespace).getByName("boot-stall-terminate");
    await runInDO(stub, async (inst: Inst) => {
      const fake = new FakeContainer(false, 0);
      fake.scripted = true;
      fake.readyOnStart = 99;
      inst.maybeContainer = () => fake;
      inst.bootAttemptMs = 10_000;
      const ensure = inst.ensureReady(spec()).then(
        () => "ok",
        (e: Error) => e.message,
      );
      while (fake.startCalls < 1) await sleep(10); // start 済み = ready を待っている
      await sleep(50);
      const started = Date.now();
      const t = await inst.terminate();
      const outcome = await ensure;
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(t).toEqual({ stopped: true });
      expect(outcome).not.toBe("ok");
      expect(outcome).not.toMatch(/did not become ready/);
      expect(fake.startCalls).toBe(1);
      expect(fake.running).toBe(false);
    });
  });
});

describe("Sandbox のインスタンス（D13）", () => {
  const bootWith = async (
    name: string,
    instanceVar: string | undefined,
    specOver: Record<string, unknown> = {},
  ) => {
    const stub = (env.SANDBOX_DO as DurableObjectNamespace).getByName(name);
    let options: { instance?: unknown; enableInternet?: unknown } | undefined;
    let warned = "";
    let metrics: { instance?: string } | undefined;
    let metricsBefore: { instance?: string } | undefined;
    await runInDO(stub, async (inst: Inst) => {
      const fake = new FakeContainer(false, 10);
      fake.scripted = true;
      inst.maybeContainer = () => fake;
      if (instanceVar !== undefined) inst.env = { ...inst.env, SANDBOX_INSTANCE: instanceVar };
      const warn = console.warn;
      console.warn = (...a: unknown[]) => {
        warned += a.join(" ");
      };
      try {
        metricsBefore = await inst.metrics();
        await inst.ensureReady({ ...spec(), ...specOver });
      } finally {
        console.warn = warn;
      }
      options = fake.startOptions[0] as typeof options;
      metrics = await inst.metrics();
    });
    return { options, warned, metrics, metricsBefore };
  };

  it("start() に instance を渡す（SANDBOX_INSTANCE の値）。enableInternet は false のまま", async () => {
    const { options } = await bootWith("inst-std4", "standard-4");
    expect(options?.instance).toBe("standard-4");
    expect(options?.enableInternet).toBe(false);
  });

  it("未設定なら standard-2（lite の 256 MiB では足りない）", async () => {
    const { options } = await bootWith("inst-default", "");
    expect(options?.instance).toBe("standard-2");
  });

  it("不正な値は standard-2 に戻して起動する（エラーにしない）。無視した値は警告に残す", async () => {
    const { options, warned } = await bootWith("inst-bad", "huge");
    expect(options?.instance).toBe("standard-2");
    expect(warned).toContain("huge");
  });

  it("WorkspaceSpec.instance（タスクが明示した大きさ）は env の SANDBOX_INSTANCE より優先する", async () => {
    const { options } = await bootWith("inst-explicit", "standard-4", { instance: "standard-1" });
    expect(options?.instance).toBe("standard-1");
    // 明示があれば env の値は見ない（不正な env でも警告を出さない）
    const bad = await bootWith("inst-explicit-bad-env", "huge", { instance: "standard-3" });
    expect(bad.options?.instance).toBe("standard-3");
    expect(bad.warned).not.toContain("huge");
  });

  it("WorkspaceSpec.instance が無ければ env の既定のまま", async () => {
    const { options } = await bootWith("inst-env-only", "standard-3", {});
    expect(options?.instance).toBe("standard-3");
  });

  it("lite や未知の値の WorkspaceSpec.instance は拒否する（タスクが選べるのは standard-1〜4）", async () => {
    for (const [i, bad] of ["lite", "huge", 2].entries()) {
      await expect(bootWith(`inst-bad-spec-${i}`, "", { instance: bad })).rejects.toThrow(
        /invalid instance/,
      );
    }
  });

  it("metrics().instance は、実際に start() に渡した大きさ。起動する前は無い", async () => {
    const a = await bootWith("inst-metrics-explicit", "standard-4", { instance: "standard-1" });
    expect(a.metricsBefore).not.toHaveProperty("instance");
    expect(a.metrics?.instance).toBe("standard-1");
    const b = await bootWith("inst-metrics-default", "");
    expect(b.metrics?.instance).toBe("standard-2");
  });
});
