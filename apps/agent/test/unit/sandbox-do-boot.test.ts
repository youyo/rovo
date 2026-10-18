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
  start() {
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
  async exec(): Promise<never> {
    throw new Error("not available in this fake");
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
