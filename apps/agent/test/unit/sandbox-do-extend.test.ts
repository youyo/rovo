import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

// biome-ignore lint/suspicious/noExplicitAny: private メンバーを観測するテスト
type Inst = any;
const runInDO = runInDurableObject as unknown as <T>(
  stub: unknown,
  fn: (inst: Inst) => Promise<T> | T,
) => Promise<T>;
const HOUR = 3_600_000;
const SHA = "a".repeat(40);

/** ensureReady 済みの状態を、保存済みの spec と created_at で直接作る（コンテナは使わない）。 */
function seed(inst: Inst, deadlineAt: number, createdAt: number) {
  inst.ctx.storage.kv.put("spec", {
    repository: "acme/hello",
    baseSha: SHA,
    branch: "agent/task-x",
    initialSha: SHA,
    deadlineAt,
  });
  inst.ctx.storage.kv.put("created_at", createdAt);
}

describe("SandboxDO.extendDeadline", () => {
  it("期限切れの Sandbox の期限を延ばすと、expired が解け、alarm が新しい期限の範囲で張り直される", async () => {
    const stub = (env.SANDBOX_DO as DurableObjectNamespace).getByName("ext-1");
    await runInDO(stub, async (inst) => {
      const now = Date.now();
      seed(inst, now - 1000, now - 3 * HOUR);
      expect(inst.status().expired).toBe(true);
      await inst.extendDeadline(now + 3 * HOUR);
      expect(inst.status().expired).toBe(false);
      expect(inst.spec().deadlineAt).toBe(now + 3 * HOUR);
      const alarm = await inst.ctx.storage.getAlarm();
      expect(alarm).not.toBeNull();
      expect(alarm).toBeLessThanOrEqual(now + 3 * HOUR);
      expect(alarm).toBeGreaterThan(now);
    });
  });

  it("単調増加だけ受け付ける: 古い（小さい）期限は無視する", async () => {
    const stub = (env.SANDBOX_DO as DurableObjectNamespace).getByName("ext-mono");
    await runInDO(stub, async (inst) => {
      const now = Date.now();
      seed(inst, now + 5 * HOUR, now);
      await inst.extendDeadline(now + 2 * HOUR);
      expect(inst.spec().deadlineAt).toBe(now + 5 * HOUR);
      await inst.extendDeadline(now + 5 * HOUR);
      expect(inst.spec().deadlineAt).toBe(now + 5 * HOUR);
    });
  });

  it("上限は created_at + 2h + 24h。超える期限は拒否し、期限は変わらない", async () => {
    const stub = (env.SANDBOX_DO as DurableObjectNamespace).getByName("ext-cap");
    await runInDO(stub, async (inst) => {
      const now = Date.now();
      seed(inst, now + HOUR, now);
      await expect(inst.extendDeadline(now + 26 * HOUR + 1)).rejects.toThrow(/exceeds/);
      expect(inst.spec().deadlineAt).toBe(now + HOUR);
      await inst.extendDeadline(now + 26 * HOUR);
      expect(inst.spec().deadlineAt).toBe(now + 26 * HOUR);
    });
  });

  it("不正な値・準備前・終端後は拒否する", async () => {
    const stub = (env.SANDBOX_DO as DurableObjectNamespace).getByName("ext-bad");
    await runInDO(stub, async (inst) => {
      await expect(inst.extendDeadline(Date.now() + HOUR)).rejects.toThrow(/not ready/);
      const now = Date.now();
      seed(inst, now + HOUR, now);
      await expect(inst.extendDeadline(Number.NaN)).rejects.toThrow(/invalid/);
      await expect(inst.extendDeadline("x" as never)).rejects.toThrow(/invalid/);
      inst.ctx.storage.kv.put("terminated", true);
      await expect(inst.extendDeadline(now + 2 * HOUR)).rejects.toThrow(/terminated/);
    });
  });

  it("ensureReady が created_at を記録する（最初の 1 回だけ）", async () => {
    const stub = (env.SANDBOX_DO as DurableObjectNamespace).getByName("ext-created");
    await runInDO(stub, async (inst) => {
      const now = Date.now();
      // コンテナを使わない: ensureReady の検証部分だけを通すため、booting に入る前に失敗させる
      inst.maybeContainer = () => undefined;
      await inst
        .ensureReady({
          repository: "acme/hello",
          baseSha: SHA,
          branch: "agent/task-x",
          initialSha: SHA,
          deadlineAt: now + HOUR,
        })
        .catch(() => undefined);
      const created = inst.ctx.storage.kv.get("created_at") as number;
      expect(created).toBeGreaterThanOrEqual(now);
      expect(created).toBeLessThanOrEqual(Date.now());
      await new Promise((r) => setTimeout(r, 20));
      await inst
        .ensureReady({
          repository: "acme/hello",
          baseSha: SHA,
          branch: "agent/task-x",
          initialSha: SHA,
          deadlineAt: now + HOUR,
        })
        .catch(() => undefined);
      expect(inst.ctx.storage.kv.get("created_at")).toBe(created);
    });
  });
});

describe("SandboxDO.setDeadline", () => {
  it("期限を短くもできる。alarm も新しい期限の範囲で張り直される", async () => {
    const stub = (env.SANDBOX_DO as DurableObjectNamespace).getByName("set-shrink");
    await runInDO(stub, async (inst) => {
      const now = Date.now();
      seed(inst, now + 26 * HOUR, now);
      await inst.setDeadline(now + 7 * HOUR);
      expect(inst.spec().deadlineAt).toBe(now + 7 * HOUR);
      await inst.setDeadline(now + 9 * HOUR);
      expect(inst.spec().deadlineAt).toBe(now + 9 * HOUR);
      const alarm = await inst.ctx.storage.getAlarm();
      expect(alarm).not.toBeNull();
      expect(alarm).toBeLessThanOrEqual(now + 9 * HOUR);
    });
  });

  it("上限は created_at + 2h + 24h。超える値・不正な値・準備前・終端後は拒否する", async () => {
    const stub = (env.SANDBOX_DO as DurableObjectNamespace).getByName("set-bad");
    await runInDO(stub, async (inst) => {
      await expect(inst.setDeadline(Date.now() + HOUR)).rejects.toThrow(/not ready/);
      const now = Date.now();
      seed(inst, now + HOUR, now);
      await expect(inst.setDeadline(now + 26 * HOUR + 1)).rejects.toThrow(/exceeds/);
      expect(inst.spec().deadlineAt).toBe(now + HOUR);
      await inst.setDeadline(now + 26 * HOUR);
      expect(inst.spec().deadlineAt).toBe(now + 26 * HOUR);
      await expect(inst.setDeadline(Number.NaN)).rejects.toThrow(/invalid/);
      inst.ctx.storage.kv.put("terminated", true);
      await expect(inst.setDeadline(now + 2 * HOUR)).rejects.toThrow(/terminated/);
    });
  });

  it("現在時刻より前の値は、即座に期限切れとして扱う", async () => {
    const stub = (env.SANDBOX_DO as DurableObjectNamespace).getByName("set-past");
    await runInDO(stub, async (inst) => {
      const now = Date.now();
      seed(inst, now + 5 * HOUR, now - HOUR);
      expect(inst.status().expired).toBe(false);
      await inst.setDeadline(now - 1000);
      expect(inst.status().expired).toBe(true);
      const alarm = await inst.ctx.storage.getAlarm();
      expect(alarm).not.toBeNull();
      expect(alarm).toBeLessThanOrEqual(Date.now() + 1000);
    });
  });
});
