import { describe, expect, it } from "vitest";

// Sandbox の中断（予算の延長の承認を待つ間、コンテナを止めて費用を止める）の SandboxDO 側。
// 中断: 作業ツリーのスナップショットを取ってからコンテナを止める。次の操作（exec など）で、同じスナップショットから起動し直し、
// 作業ツリーが元のまま残っていることを確かめてから続ける（昇格と同じ仕組みの再利用）。
// vitest 上では ctx.container が無いので maybeContainer を fake に差し替える。実コンテナでの確認は docs/specs/acceptance.md。
import { CA_CERT, IMAGE, runInDO, sandboxStub, setup, spec } from "./support/sandbox-promote-fake";

const LS = ["ls", "-la"];

describe("SandboxDO.suspend: スナップショットを取ってコンテナを止め、次の操作で同じ作業ツリーに戻る", () => {
  it("スナップショット → 破棄の順に進み、コンテナは止まる。次の exec はスナップショットから起動し、clone し直さず、「再起動した」例外も出さない", async () => {
    await runInDO(sandboxStub("suspend-ok"), async (inst) => {
      const fake = setup(inst);
      await inst.ensureReady(spec());
      expect(fake.startCalls).toHaveLength(1);

      const r = await inst.suspend({ allowReclone: false });
      expect(r).toEqual({ mode: "snapshot" });
      expect(fake.running).toBe(false);
      expect(fake.snapshotCalls).toHaveLength(1);
      expect((fake.snapshotCalls[0] as { name: string }).name).toMatch(/^suspend-/);
      const ev = fake.events;
      expect(ev.indexOf("destroy")).toBeGreaterThan(ev.indexOf("snapshot"));

      // 次の操作で起動し直す: スナップショットから（image は渡さない）
      const out = await inst.exec(LS);
      expect(out.exitCode).toBe(0);
      expect(fake.startCalls).toHaveLength(2);
      const second = fake.startCalls[1] as Record<string, unknown>;
      expect(second.containerSnapshot).toEqual({ id: "snap-promote" });
      expect(second).not.toHaveProperty("image");
      expect(second).toMatchObject({ enableInternet: false, instance: "standard-2" });
      // CA 証明書と作業ツリーの状態を確かめ、傍受・基準プロセス・無操作の期限もやり直す
      expect(fake.execLog.some((a) => a[0] === "test" && a[2] === CA_CERT)).toBe(true);
      expect(fake.intercepts).toBe(2);
      expect(fake.inactivityMs).toHaveLength(2);
      // 作業ツリーを作り直さない（clone は最初の 1 回だけ）
      expect(fake.execLog.filter((a) => a[0] === "git" && a[1] === "clone")).toHaveLength(1);
      // コンテナの作り直し（restarts）には数えない
      expect((await inst.metrics()).restarts).toBe(0);
      // 戻ったあとは通常どおり（もう一度 exec しても起動し直さない）
      await inst.exec(LS);
      expect(fake.startCalls).toHaveLength(2);
    });
  });

  it("中断している間にコンテナは動かない（status は running:false）。terminate した後は戻さない", async () => {
    await runInDO(sandboxStub("suspend-status"), async (inst) => {
      const fake = setup(inst);
      await inst.ensureReady(spec());
      await inst.suspend({ allowReclone: false });
      expect(inst.status().running).toBe(false);
      expect(fake.running).toBe(false);
      await inst.terminate();
      // terminate 後は戻さない（スナップショットから起動しない）
      const r = await inst.exec(LS);
      expect(r.terminated).toBe(true);
      expect(fake.startCalls).toHaveLength(1);
    });
  });

  it("スナップショットに失敗し allowReclone が false: コンテナを止めず running を返す（fail-soft。作業ツリーを失わない）", async () => {
    await runInDO(sandboxStub("suspend-snap-fail-keep"), async (inst) => {
      const fake = setup(inst);
      fake.snapshotResult = new Error("snapshot boom");
      await inst.ensureReady(spec());
      const r = await inst.suspend({ allowReclone: false });
      expect(r).toEqual({ mode: "running" });
      expect(fake.running).toBe(true);
      expect(fake.destroyCalls).toBe(0);
      // そのまま使える
      const out = await inst.exec(LS);
      expect(out.exitCode).toBe(0);
      expect(fake.startCalls).toHaveLength(1);
    });
  });

  it("スナップショットが使えない環境でも同じ（running を返す）", async () => {
    await runInDO(sandboxStub("suspend-unsupported-keep"), async (inst) => {
      const fake = setup(inst);
      fake.snapshotContainer = undefined;
      await inst.ensureReady(spec());
      expect(await inst.suspend({ allowReclone: false })).toEqual({ mode: "running" });
      expect(fake.running).toBe(true);
      expect(fake.snapshotCalls).toHaveLength(0);
    });
  });

  it("スナップショットに失敗しても allowReclone が true（作業ツリーは push 済み）なら止める。次の操作は image から起動して再 clone し、「再起動した」例外で知らせる", async () => {
    await runInDO(sandboxStub("suspend-snap-fail-reclone"), async (inst) => {
      const fake = setup(inst);
      fake.snapshotResult = new Error("snapshot boom");
      await inst.ensureReady(spec());
      expect(await inst.suspend({ allowReclone: true })).toEqual({ mode: "destroyed" });
      expect(fake.running).toBe(false);
      await expect(inst.exec(LS)).rejects.toThrow(/restarted/);
      const second = fake.startCalls[1] as Record<string, unknown>;
      expect(second).toMatchObject({ image: IMAGE });
      expect(second).not.toHaveProperty("containerSnapshot");
    });
  });

  it("戻すときに起動に失敗したら、image から起動して再 clone する（スナップショットは捨てる。次からは使わない）", async () => {
    await runInDO(sandboxStub("suspend-restore-fail"), async (inst) => {
      const fake = setup(inst);
      fake.failStartFor.add("standard-2");
      await inst.ensureReady(spec());
      expect(await inst.suspend({ allowReclone: false })).toEqual({ mode: "snapshot" });
      await expect(inst.exec(LS)).rejects.toThrow(/restarted/);
      // snapshot での起動は 1 回試して失敗 → image で起動
      const snapshots = fake.startCalls.filter((c) => "containerSnapshot" in c);
      expect(snapshots).toHaveLength(1);
      expect(fake.startCalls.at(-1)).toMatchObject({ image: IMAGE });
      // 2 回目の操作はもう中断から戻らない（普通に動く）
      const out = await inst.exec(LS);
      expect(out.exitCode).toBe(0);
      expect(fake.startCalls.filter((c) => "containerSnapshot" in c)).toHaveLength(1);
    });
  });

  it("戻したコンテナの作業ツリーが元と違えば、image から起動し直す", async () => {
    await runInDO(sandboxStub("suspend-mismatch"), async (inst) => {
      const fake = setup(inst);
      await inst.ensureReady(spec());
      expect(await inst.suspend({ allowReclone: false })).toEqual({ mode: "snapshot" });
      // 戻した直後の作業ツリーだけ違う状態にする（mismatchFor は大きさ単位）
      fake.mismatchFor.add("standard-2");
      await expect(inst.exec(LS)).rejects.toThrow(/restarted/);
      expect(fake.startCalls.at(-1)).toMatchObject({ image: IMAGE });
    });
  });

  it("コンテナが起動していないときの suspend は何もしない（スナップショットを取らない）", async () => {
    await runInDO(sandboxStub("suspend-not-running"), async (inst) => {
      const fake = setup(inst);
      await inst.ensureReady(spec());
      fake.running = false;
      const r = await inst.suspend({ allowReclone: false });
      expect(r.mode).toBe("destroyed");
      expect(fake.snapshotCalls).toHaveLength(0);
    });
  });

  it("昇格した後の中断も、昇格先の大きさで戻す", async () => {
    await runInDO(sandboxStub("suspend-promoted"), async (inst) => {
      const fake = setup(inst);
      await inst.ensureReady(spec());
      inst.ctx.storage.kv.put("promoted_to", "standard-3");
      await inst.suspend({ allowReclone: false });
      await inst.exec(LS);
      expect(fake.startCalls.at(-1)).toMatchObject({ instance: "standard-3" });
    });
  });
});
