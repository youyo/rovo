import { abortAllDurableObjects, env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

// SandboxDO の実行時間・起動世代のカウンタ（runtimeMs / restarts / bootRetries）の永続化と、
// 特権操作・起動の破棄の監査（@rovo/audit 経由）を確かめる。ctx.container は vitest 上に無いので fake に差し替える。

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const SHA = "a".repeat(40);

class FakeContainer {
  running: boolean;
  startCalls = 0;
  destroyCalls = 0;
  images = { workspace: "fake" };
  /** この回数目の start から exec が応答する（それより前は返らない = 起動が止まる） */
  readyOnStart = 1;
  constructor(initiallyRunning = false) {
    this.running = initiallyRunning;
  }
  start() {
    this.startCalls += 1;
    this.running = true;
  }
  async destroy() {
    this.destroyCalls += 1;
    this.running = false;
  }
  async setInactivityTimeout() {}
  async interceptOutboundHttps() {}
  async interceptAllOutboundHttp() {}
  async exec(argv?: string[]): Promise<unknown> {
    if (this.startCalls < this.readyOnStart) return new Promise<never>(() => {});
    const text = (t: string) =>
      new ReadableStream<Uint8Array>({
        start(c) {
          if (t) c.enqueue(new TextEncoder().encode(t));
          c.close();
        },
      });
    const branch = argv?.includes("--abbrev-ref") ? "agent/task-x\n" : "";
    return { stdout: text(branch), stderr: text(""), exitCode: Promise.resolve(0) };
  }
}

// biome-ignore lint/suspicious/noExplicitAny: private メンバーを差し替えるテスト
type Inst = any;
const runInDO = runInDurableObject as unknown as <T>(
  stub: unknown,
  fn: (inst: Inst) => Promise<T> | T,
) => Promise<T>;
const sandbox = (name: string) => (env.SANDBOX_DO as DurableObjectNamespace).getByName(name);
const spec = () => ({
  repository: "acme/hello",
  baseSha: SHA,
  initialSha: SHA,
  branch: "agent/task-x",
  deadlineAt: Date.now() + 3_600_000,
});

describe("SandboxDO.metrics: runtimeMs / restarts / bootRetries", () => {
  it("何もしていなければすべて 0", async () => {
    await runInDO(sandbox("m-zero"), async (inst: Inst) => {
      expect(await inst.metrics()).toEqual({ runtimeMs: 0, restarts: 0, bootRetries: 0 });
    });
  });

  it("起動から停止までの時間を runtimeMs に累計する。実行中の分は現在までを足して返し、停止で閉じる", async () => {
    await runInDO(sandbox("m-runtime"), async (inst: Inst) => {
      const fake = new FakeContainer();
      inst.maybeContainer = () => fake;
      await inst.ensureReady(spec());
      await sleep(80);
      const running = (await inst.metrics()).runtimeMs;
      expect(running).toBeGreaterThanOrEqual(70);
      await sleep(60);
      expect((await inst.metrics()).runtimeMs).toBeGreaterThan(running); // 実行中は増え続ける
      await inst.terminate();
      const closed = (await inst.metrics()).runtimeMs;
      expect(closed).toBeGreaterThanOrEqual(130);
      await sleep(60);
      expect((await inst.metrics()).runtimeMs).toBe(closed); // 停止後は増えない
    });
  });

  it("再起動（作り直し）をまたいで累計する: 停止していた時間は数えない", async () => {
    await runInDO(sandbox("m-two-runs"), async (inst: Inst) => {
      const fake = new FakeContainer();
      inst.maybeContainer = () => fake;
      await inst.ensureReady(spec());
      await sleep(50);
      await inst.stop(); // reaper が失敗すればコンテナごと破棄する。ここでは破棄させる
      await inst.destroyContainer();
      const first = (await inst.metrics()).runtimeMs;
      expect(first).toBeGreaterThanOrEqual(40);
      await sleep(100); // 停止中
      expect((await inst.metrics()).runtimeMs).toBe(first);
      await inst.ensureReady(spec());
      await sleep(50);
      const second = (await inst.metrics()).runtimeMs;
      expect(second).toBeGreaterThanOrEqual(first + 40);
      expect(second).toBeLessThan(first + 90); // 停止中の 100ms は入らない
      await inst.terminate();
    });
  });

  it("DO が退避されても値が残る（メモリ上の値に依存しない）", async () => {
    await runInDO(sandbox("m-persist"), async (inst: Inst) => {
      const fake = new FakeContainer();
      inst.maybeContainer = () => fake;
      await inst.ensureReady(spec());
      await sleep(50);
      await inst.destroyContainer();
      await inst.ensureReady(spec()); // restarts = 1
      await inst.terminate();
    });
    const before = await runInDO(sandbox("m-persist"), (inst: Inst) => inst.metrics());
    expect(before.restarts).toBe(1);
    expect(before.runtimeMs).toBeGreaterThanOrEqual(40);
    await abortAllDurableObjects(); // DO を作り直す（メモリ上の gen などは 0 に戻る）
    const after = await runInDO(sandbox("m-persist"), (inst: Inst) => inst.metrics());
    expect(after).toEqual(before);
  });

  it("restarts は 2 回目以降のコンテナの起動の回数（最初の起動は数えない）", async () => {
    await runInDO(sandbox("m-restarts"), async (inst: Inst) => {
      const fake = new FakeContainer();
      inst.maybeContainer = () => fake;
      await inst.ensureReady(spec());
      expect((await inst.metrics()).restarts).toBe(0);
      await inst.ensureReady(spec()); // 動いているので起動しない
      expect((await inst.metrics()).restarts).toBe(0);
      fake.running = false; // コンテナが落ちた
      await inst.ensureReady(spec());
      expect((await inst.metrics()).restarts).toBe(1);
      fake.running = false;
      await inst.ensureReady(spec());
      expect((await inst.metrics()).restarts).toBe(2);
      await inst.terminate();
    });
  });

  it("bootRetries は起動の確認点で止まった試行の回数（成功した起動は数えない）", async () => {
    await runInDO(sandbox("m-retries"), async (inst: Inst) => {
      const fake = new FakeContainer();
      fake.readyOnStart = 2; // 1 回目の start では応答しない
      inst.maybeContainer = () => fake;
      inst.bootAttemptMs = 200;
      await inst.ensureReady(spec());
      const m = await inst.metrics();
      expect(m.bootRetries).toBe(1);
      expect(m.restarts).toBe(1); // 止まった起動を破棄してやり直したので、起動は 2 回
      await inst.terminate();
    });
  });

  it("bootRetries は破棄された（superseded）起動も数える", async () => {
    await runInDO(sandbox("m-superseded"), async (inst: Inst) => {
      const fake = new FakeContainer();
      fake.readyOnStart = 99;
      inst.maybeContainer = () => fake;
      inst.bootAttemptMs = 10_000;
      const ensure = inst.ensureReady(spec()).catch((e: Error) => e.message);
      while (fake.startCalls < 1) await sleep(10);
      inst.invalidateBoot();
      expect(await ensure).toMatch(/superseded/);
      expect((await inst.metrics()).bootRetries).toBe(1);
      await inst.terminate();
    });
  });

  it("alarm は動いているコンテナの最後に観測した時刻を更新し、落ちていたらそこまでで区間を閉じる", async () => {
    await runInDO(sandbox("m-alarm"), async (inst: Inst) => {
      const fake = new FakeContainer();
      inst.maybeContainer = () => fake;
      await inst.ensureReady(spec());
      await sleep(60);
      await inst.alarm(); // 動いている: 観測時刻を更新
      await sleep(80);
      fake.running = false; // DO が見ていない間にコンテナが落ちた
      await inst.alarm();
      const closed = (await inst.metrics()).runtimeMs;
      // 落ちた時刻は分からないので、最後に観測した時刻までを数える（過大に数えない）
      expect(closed).toBeGreaterThanOrEqual(55);
      expect(closed).toBeLessThan(60 + 80 - 15); // 落ちていた 80ms は数えない
      await sleep(60);
      expect((await inst.metrics()).runtimeMs).toBe(closed);
    });
  });
});

describe("SandboxDO の監査（@rovo/audit 経由。ENVIRONMENT=test のときだけ DO に記録する）", () => {
  const auditOf = async (inst: Inst) => (await inst.testAudit()) as Record<string, unknown>[];

  it("terminate / setDeadline / extendDeadline / 破棄（stop が破棄に至る）を sandbox_privileged_op で記録する", async () => {
    await runInDO(sandbox("a-ops"), async (inst: Inst) => {
      const fake = new FakeContainer();
      inst.maybeContainer = () => fake;
      const s = spec();
      await inst.ensureReady(s);
      await inst.extendDeadline(s.deadlineAt + 1000);
      await inst.setDeadline(s.deadlineAt + 500);
      inst.failNextReapFlag = true; // reaper が失敗 → コンテナごと破棄
      await inst.stop();
      await inst.terminate();
      const ops = (await auditOf(inst))
        .filter((r) => r.event === "sandbox_privileged_op")
        .map((r) => r.op);
      expect(ops).toEqual(["extend_deadline", "set_deadline", "destroy", "terminate"]);
    });
  });

  it("exec の後の片付け（reaper）が失敗してコンテナごと破棄したときも destroy として記録する（reason: reap_failed）", async () => {
    await runInDO(sandbox("a-reap"), async (inst: Inst) => {
      const fake = new FakeContainer();
      inst.maybeContainer = () => fake;
      await inst.ensureReady(spec());
      inst.failNextReapFlag = true;
      await inst.reapOrDestroy();
      const destroys = (await auditOf(inst)).filter(
        (r) => r.event === "sandbox_privileged_op" && r.op === "destroy",
      );
      expect(destroys).toHaveLength(1);
      expect(destroys[0]).toMatchObject({ reason: "reap_failed" });
      expect(fake.destroyCalls).toBe(1);
      await inst.terminate();
    });
  });

  it("記録は固定のフィールドだけ: taskId（DO の名前）・caller・op。トークンも URL も入らない", async () => {
    await runInDO(sandbox("a-fields"), async (inst: Inst) => {
      inst.maybeContainer = () => new FakeContainer();
      await inst.terminate();
      const [rec] = (await auditOf(inst)).filter((r) => r.event === "sandbox_privileged_op");
      expect(rec).toMatchObject({
        audit: true,
        event: "sandbox_privileged_op",
        taskId: "a-fields",
        caller: "child",
        op: "terminate",
      });
      expect(Object.keys(rec ?? {}).sort()).toEqual(
        ["audit", "caller", "event", "op", "taskId", "ts"].sort(),
      );
    });
  });

  it("世代が変わって破棄された boot を boot_superseded で記録する（events には積まない）", async () => {
    await runInDO(sandbox("a-superseded"), async (inst: Inst) => {
      const fake = new FakeContainer();
      fake.readyOnStart = 99;
      inst.maybeContainer = () => fake;
      inst.bootAttemptMs = 10_000;
      const ensure = inst.ensureReady(spec()).catch(() => undefined);
      while (fake.startCalls < 1) await sleep(10);
      inst.invalidateBoot();
      await ensure;
      const rec = (await auditOf(inst)).filter((r) => r.event === "boot_superseded");
      expect(rec).toHaveLength(1);
      expect(rec[0]).toMatchObject({ taskId: "a-superseded", reason: "generation_changed" });
      await inst.terminate();
    });
  });

  it("ENVIRONMENT が test 以外なら、記録も読み出しもしない（本番）", async () => {
    await runInDO(sandbox("a-prod"), async (inst: Inst) => {
      inst.env = { ...inst.env, ENVIRONMENT: "production" };
      inst.maybeContainer = () => new FakeContainer();
      const lines: string[] = [];
      const orig = console.log;
      console.log = (...a: unknown[]) => void lines.push(a.join(" "));
      try {
        await inst.terminate();
      } finally {
        console.log = orig;
      }
      // 監査ログ自体（console.log の JSON）は本番でも出る
      expect(lines.some((l) => l.includes('"event":"sandbox_privileged_op"'))).toBe(true);
      await expect(inst.testAudit()).rejects.toThrow(/test/);
      expect(inst.ctx.storage.kv.get("test_audit")).toBeUndefined();
    });
  });
});
