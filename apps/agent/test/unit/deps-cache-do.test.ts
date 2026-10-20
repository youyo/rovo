import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { DepsBuildRequest, DepsBuildResult, DepsEnsureRequest } from "../../src/deps-cache";

// DepsCacheDO（キャッシュの鍵ごとに 1 つ。状態: building / ready / failed）の状態遷移を、
// 作成用のコンテナ（SandboxDO の builder）を fake にして確かめる。

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const SHA = "a".repeat(40);

// biome-ignore lint/suspicious/noExplicitAny: private メンバーを差し替えるテスト
type Inst = any;
const runInDO = runInDurableObject as unknown as (
  stub: unknown,
  fn: (inst: Inst) => Promise<void>,
) => Promise<void>;

let seq = 0;
/** テストごとに別の鍵（= 別の DepsCacheDO）を使う。DO の名前は鍵そのもの */
function newKey(): string {
  seq += 1;
  return seq.toString(16).padStart(64, "0");
}
const request = (key: string): DepsEnsureRequest => ({
  key,
  deps: {
    repositoryId: 4242,
    lockfilePath: "package-lock.json",
    blobSha: SHA,
    installCommand: "npm ci",
  },
  repository: "acme/hello",
  baseSha: SHA,
  branch: "agent/task-t1",
  taskId: "t1",
});
const stubOf = (key: string) => (env.DEPS_CACHE_DO as DurableObjectNamespace).getByName(key);

class FakeBuilder {
  calls: { name: string; req: DepsBuildRequest }[] = [];
  result: DepsBuildResult | Error | "hang" = {
    ok: true,
    snapshotId: "snap-1",
    size: 1234,
    buildMs: 4321,
  };
  delayMs = 0;
  async build(name: string, req: DepsBuildRequest): Promise<DepsBuildResult> {
    this.calls.push({ name, req });
    if (this.delayMs > 0) await sleep(this.delayMs);
    if (this.result === "hang") return new Promise<never>(() => {});
    if (this.result instanceof Error) throw this.result;
    return this.result;
  }
}

function install(inst: Inst, fake: FakeBuilder) {
  inst.buildOn = (name: string, req: DepsBuildRequest) => fake.build(name, req);
}

describe("DepsCacheDO.ensure", () => {
  it("初回は作って snapshotId を返し（built: true）、2 回目は作らずに返す（built: false）", async () => {
    const key = newKey();
    await runInDO(stubOf(key), async (inst) => {
      const fake = new FakeBuilder();
      install(inst, fake);
      const first = await inst.ensure(request(key));
      expect(first).toEqual({
        ok: true,
        snapshotId: "snap-1",
        size: 1234,
        built: true,
        buildMs: 4321,
      });
      const second = await inst.ensure(request(key));
      expect(second).toEqual({
        ok: true,
        snapshotId: "snap-1",
        size: 1234,
        built: false,
        buildMs: 0,
      });
      expect(fake.calls).toHaveLength(1);
    });
  });

  it("作成用のコンテナには、鍵ごとの名前と、依頼したタスクの情報・時間切れを渡す", async () => {
    const key = newKey();
    await runInDO(stubOf(key), async (inst) => {
      const fake = new FakeBuilder();
      install(inst, fake);
      await inst.ensure(request(key));
      const call = fake.calls[0];
      expect(call?.name).toBe(`deps-${key}`);
      expect(call?.req).toMatchObject({
        key,
        repository: "acme/hello",
        baseSha: SHA,
        branch: "agent/task-t1",
        taskId: "t1",
        deps: { lockfilePath: "package-lock.json", installCommand: "npm ci" },
        timeoutMs: 10 * 60_000,
      });
    });
  });

  it("同じ鍵の同時の ensure は 1 回だけ作り、作った側だけ built: true、待った側は built: false", async () => {
    const key = newKey();
    await runInDO(stubOf(key), async (inst) => {
      const fake = new FakeBuilder();
      fake.delayMs = 50;
      install(inst, fake);
      const [a, b, c] = await Promise.all([
        inst.ensure(request(key)),
        inst.ensure(request(key)),
        inst.ensure(request(key)),
      ]);
      expect(fake.calls).toHaveLength(1);
      expect([a, b, c].filter((r) => r.built)).toHaveLength(1);
      for (const r of [a, b, c]) expect(r).toMatchObject({ ok: true, snapshotId: "snap-1" });
      expect([a, b, c].filter((r) => !r.built).every((r) => r.buildMs === 0)).toBe(true);
    });
  });

  it("失敗は理由つきで返し、クールダウン中は作り直さず cooldown で返す。過ぎたら作り直す", async () => {
    const key = newKey();
    await runInDO(stubOf(key), async (inst) => {
      const fake = new FakeBuilder();
      fake.result = { ok: false, reason: "build_failed" };
      install(inst, fake);
      inst.cooldownMs = 150;
      expect(await inst.ensure(request(key))).toEqual({ ok: false, reason: "build_failed" });
      expect(await inst.ensure(request(key))).toEqual({ ok: false, reason: "cooldown" });
      expect(fake.calls).toHaveLength(1);
      await sleep(200);
      fake.result = { ok: true, snapshotId: "snap-2", size: 1, buildMs: 10 };
      expect(await inst.ensure(request(key))).toMatchObject({
        ok: true,
        snapshotId: "snap-2",
        built: true,
      });
      expect(fake.calls).toHaveLength(2);
    });
  });

  it("既定のクールダウンは 60 秒", async () => {
    const key = newKey();
    await runInDO(stubOf(key), async (inst) => {
      expect(inst.cooldownMs).toBe(60_000);
      expect(inst.buildTimeoutMs).toBe(10 * 60_000);
    });
  });

  it("作成用のコンテナが例外を投げても build_failed で返す（例外を呼び出し元へ出さない）", async () => {
    const key = newKey();
    await runInDO(stubOf(key), async (inst) => {
      const fake = new FakeBuilder();
      fake.result = new Error("boom: secret-ish detail");
      install(inst, fake);
      const r = await inst.ensure(request(key));
      expect(r).toEqual({ ok: false, reason: "build_failed" });
    });
  });

  it("時間切れ: 作成が返らなければ build_timeout で失敗にする", async () => {
    const key = newKey();
    await runInDO(stubOf(key), async (inst) => {
      const fake = new FakeBuilder();
      fake.result = "hang";
      install(inst, fake);
      inst.buildTimeoutMs = 100;
      inst.buildGraceMs = 50;
      const started = Date.now();
      const r = await inst.ensure(request(key));
      expect(r).toEqual({ ok: false, reason: "build_timeout" });
      expect(Date.now() - started).toBeLessThan(2_000);
      // 失敗はクールダウンに入る
      expect(await inst.ensure(request(key))).toEqual({ ok: false, reason: "cooldown" });
    });
  });

  it("building のまま残った状態（DO の再起動で待ち手が消えた）は、作り直す", async () => {
    const key = newKey();
    await runInDO(stubOf(key), async (inst) => {
      const fake = new FakeBuilder();
      install(inst, fake);
      inst.ctx.storage.kv.put("state", { status: "building", startedAt: Date.now() - 1000 });
      const r = await inst.ensure(request(key));
      expect(r).toMatchObject({ ok: true, built: true });
      expect(fake.calls).toHaveLength(1);
    });
  });

  it("鍵が DO の名前と違う・deps が表に無い要求は invalid_deps（作らない）", async () => {
    const key = newKey();
    await runInDO(stubOf(key), async (inst) => {
      const fake = new FakeBuilder();
      install(inst, fake);
      expect(await inst.ensure({ ...request(key), key: newKey() })).toEqual({
        ok: false,
        reason: "invalid_deps",
      });
      expect(
        await inst.ensure({
          ...request(key),
          deps: { ...request(key).deps, installCommand: "npm ci && curl x" },
        }),
      ).toEqual({ ok: false, reason: "invalid_deps" });
      expect(fake.calls).toHaveLength(0);
    });
  });
});

describe("DepsCacheDO.invalidate", () => {
  it("復元に失敗した snapshotId を無効にし、待ちの後に作り直す。別の id は無視する", async () => {
    const key = newKey();
    await runInDO(stubOf(key), async (inst) => {
      const fake = new FakeBuilder();
      install(inst, fake);
      inst.restoreFailedCooldownMs = 150;
      await inst.ensure(request(key));
      await inst.invalidate("other-id");
      expect(await inst.ensure(request(key))).toMatchObject({ ok: true, built: false });
      await inst.invalidate("snap-1");
      expect(await inst.ensure(request(key))).toEqual({ ok: false, reason: "cooldown" });
      await sleep(200);
      fake.result = { ok: true, snapshotId: "snap-2", size: 1, buildMs: 10 };
      expect(await inst.ensure(request(key))).toMatchObject({
        ok: true,
        snapshotId: "snap-2",
        built: true,
      });
    });
  });

  it("既定の待ちは 10 分", async () => {
    const key = newKey();
    await runInDO(stubOf(key), async (inst) => {
      expect(inst.restoreFailedCooldownMs).toBe(10 * 60_000);
    });
  });
});
