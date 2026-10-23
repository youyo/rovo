import { describe, expect, it } from "vitest";
import { SandboxDO } from "../../src/sandbox-do";
import {
  capturingWarn,
  FakeContainer,
  type Inst,
  runInDO,
  sandboxStub,
  setup,
  spec,
} from "./support/sandbox-promote-fake";

// コンテナの無操作の期限（setInactivityTimeout）と、停止の診断（monitor）。
// 期限を設定しないと、DO が inactive になった直後にコンテナが止まり、push していない作業が消える。
// 期限は DO の再起動で消えるので、constructor で設定し直す。keepalive の alarm（60 秒）より十分長い 10 分。

const TEN_MINUTES = 10 * 60_000;
const LS = ["ls", "-la"];
const HEAVY = ["pnpm", "test"];
const AGENT = { origin: "agent_command" } as const;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** console.warn に出た構造化ログ（JSON）のうち、event が name のもの */
function events(lines: string[], name: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const l of lines) {
    try {
      const o = JSON.parse(l) as Record<string, unknown>;
      if (o.event === name) out.push(o);
    } catch {
      // 構造化ログではない行
    }
  }
  return out;
}

describe("SandboxDO: start の直後に無操作の期限（10 分）を設定する", () => {
  it("通常の boot: start の直後（最初の exec より前）に 10 分で設定し、monitor も始める", async () => {
    await runInDO(sandboxStub("inactivity-boot"), async (inst) => {
      const fake = setup(inst);
      await inst.ensureReady(spec());
      expect(fake.inactivityMs).toEqual([TEN_MINUTES]);
      const ev = fake.events;
      const start = ev.findIndex((e) => e.startsWith("start:"));
      const inactivity = ev.indexOf(`inactivity:${TEN_MINUTES}`);
      const firstExec = ev.findIndex((e) => e.startsWith("exec:"));
      expect(inactivity).toBeGreaterThan(start);
      expect(inactivity).toBeLessThan(firstExec);
      expect(fake.monitors).toHaveLength(1);
      expect(ev.indexOf("monitor")).toBeGreaterThan(start);
      expect(ev.indexOf("monitor")).toBeLessThan(firstExec);
    });
  });

  it("昇格: 昇格先のコンテナを start した直後に 10 分で設定する", async () => {
    await runInDO(sandboxStub("inactivity-promote"), async (inst) => {
      const fake = setup(inst);
      await inst.ensureReady(spec());
      await inst.exec(HEAVY, AGENT);
      expect(fake.startCalls).toHaveLength(2);
      expect(fake.inactivityMs).toEqual([TEN_MINUTES, TEN_MINUTES]);
      const ev = fake.events;
      const second = ev.findIndex((e, i) => i > 0 && e.startsWith("start:snapshot"));
      const inactivity = ev.findIndex((e, i) => i > second && e.startsWith("inactivity:"));
      const cert = ev.findIndex((e, i) => i > second && e.startsWith("exec:test -r"));
      expect(inactivity).toBeGreaterThan(second);
      expect(inactivity).toBeLessThan(cert);
      expect(fake.monitors).toHaveLength(2);
    });
  });

  it("suspend からの復元: スナップショットから start した直後に 10 分で設定する", async () => {
    await runInDO(sandboxStub("inactivity-resume"), async (inst) => {
      const fake = setup(inst);
      await inst.ensureReady(spec());
      await inst.suspend({ allowReclone: false });
      await inst.exec(LS);
      expect(fake.startCalls).toHaveLength(2);
      expect(fake.inactivityMs).toEqual([TEN_MINUTES, TEN_MINUTES]);
      const ev = fake.events;
      const second = ev.findIndex((e, i) => i > 0 && e.startsWith("start:snapshot"));
      const inactivity = ev.findIndex((e, i) => i > second && e.startsWith("inactivity:"));
      const cert = ev.findIndex((e, i) => i > second && e.startsWith("exec:test -r"));
      expect(inactivity).toBeGreaterThan(second);
      expect(inactivity).toBeLessThan(cert);
      expect(fake.monitors).toHaveLength(2);
    });
  });

  it("setInactivityTimeout が投げても、起動は成功する（警告だけ）", async () => {
    await runInDO(sandboxStub("inactivity-throws"), async (inst) => {
      const fake = setup(inst);
      fake.inactivityError = new Error("inactivity boom");
      const { lines } = await capturingWarn(async () => {
        await inst.ensureReady(spec());
        const out = await inst.exec(LS);
        expect(out.exitCode).toBe(0);
      });
      expect(fake.startCalls).toHaveLength(1);
      expect(fake.inactivityMs).toEqual([TEN_MINUTES]);
      expect(lines.some((l) => l.includes("inactivity boom"))).toBe(true);
    });
  });
});

describe("SandboxDO の constructor: DO の再起動で消えた期限を設定し直す", () => {
  /**
   * 本物の ctx（DurableObjectState でないと DurableObject の constructor が受け付けない）に、container と blockConcurrencyWhile だけ
   * 差し込んで SandboxDO を作る。blockConcurrencyWhile に渡された処理を記録して返す。
   */
  function construct(inst: Inst, fake: FakeContainer) {
    const blocked: Promise<unknown>[] = [];
    const ctx = inst.ctx;
    const real = ctx.blockConcurrencyWhile.bind(ctx);
    Object.defineProperty(ctx, "container", { value: fake, configurable: true });
    Object.defineProperty(ctx, "blockConcurrencyWhile", {
      value: (fn: () => Promise<unknown>) => {
        const p = real(fn);
        blocked.push(p);
        return p;
      },
      configurable: true,
    });
    try {
      new SandboxDO(ctx, inst.env);
    } finally {
      // 差し込んだ own property を外して元に戻す
      delete ctx.container;
      delete ctx.blockConcurrencyWhile;
    }
    return blocked;
  }

  it("コンテナが動いていれば、blockConcurrencyWhile の中で 10 分に設定する", async () => {
    await runInDO(sandboxStub("inactivity-ctor-running"), async (inst) => {
      const fake = new FakeContainer();
      fake.running = true;
      const blocked = construct(inst, fake);
      await Promise.all(blocked);
      expect(blocked).toHaveLength(1);
      expect(fake.inactivityMs).toEqual([TEN_MINUTES]);
    });
  });

  it("コンテナが動いていなければ設定しない", async () => {
    await runInDO(sandboxStub("inactivity-ctor-stopped"), async (inst) => {
      const fake = new FakeContainer();
      fake.running = false;
      const blocked = construct(inst, fake);
      await Promise.all(blocked);
      expect(fake.inactivityMs).toEqual([]);
    });
  });

  it("terminated のときは設定しない（止めたいコンテナを延命しない）", async () => {
    await runInDO(sandboxStub("inactivity-ctor-terminated"), async (inst) => {
      setup(inst);
      await inst.ensureReady(spec());
      await inst.terminate();
      const again = new FakeContainer();
      again.running = true;
      await Promise.all(construct(inst, again));
      expect(again.inactivityMs).toEqual([]);
    });
  });

  it("タスクの期限を過ぎているときは設定しない", async () => {
    await runInDO(sandboxStub("inactivity-ctor-expired"), async (inst) => {
      setup(inst);
      await inst.ensureReady(spec());
      inst.ctx.storage.kv.put("spec", { ...spec(), deadlineAt: Date.now() - 1 });
      const again = new FakeContainer();
      again.running = true;
      await Promise.all(construct(inst, again));
      expect(again.inactivityMs).toEqual([]);
    });
  });

  it("設定に失敗しても constructor は投げない", async () => {
    await runInDO(sandboxStub("inactivity-ctor-throws"), async (inst) => {
      const fake = new FakeContainer();
      fake.running = true;
      fake.inactivityError = new Error("inactivity boom");
      const { value } = await capturingWarn(async () => {
        const blocked = construct(inst, fake);
        return await Promise.allSettled(blocked);
      });
      expect(value).toHaveLength(1);
      expect(value.every((r) => r.status === "fulfilled")).toBe(true);
    });
  });
});

describe("SandboxDO: コンテナの停止の診断（console のみ）", () => {
  it("monitor が reject したら sandbox_container_exited を出す（時刻・exit code・gen・rovo が destroy したか）", async () => {
    await runInDO(sandboxStub("inactivity-monitor-reject"), async (inst) => {
      const fake = setup(inst);
      await inst.ensureReady(spec());
      const { lines } = await capturingWarn(async () => {
        fake.monitors[0]?.reject(new Error("Container exited with unexpected exit code: 137"));
        await sleep(20);
      });
      const exited = events(lines, "sandbox_container_exited");
      expect(exited).toHaveLength(1);
      expect(exited[0]).toMatchObject({
        outcome: "rejected",
        exit_code: 137,
        gen: 1,
        destroyed_by_rovo: false,
      });
      expect(typeof exited[0]?.at).toBe("number");
      expect(String(exited[0]?.error)).toContain("137");
    });
  });

  it("monitor が resolve したときも出す。rovo 自身の destroy の後なら destroyed_by_rovo は true", async () => {
    await runInDO(sandboxStub("inactivity-monitor-resolve"), async (inst) => {
      const fake = setup(inst);
      await inst.ensureReady(spec());
      await inst.destroyContainer();
      const { lines } = await capturingWarn(async () => {
        fake.monitors[0]?.resolve();
        await sleep(20);
      });
      const exited = events(lines, "sandbox_container_exited");
      expect(exited).toHaveLength(1);
      expect(exited[0]).toMatchObject({ outcome: "resolved", destroyed_by_rovo: true });
    });
  });

  it("止まっていたので起動した（started: true）とき、sandbox_restart_detected に rt_seen と monitor で停止を観測したかを出す", async () => {
    await runInDO(sandboxStub("inactivity-restart-detected"), async (inst) => {
      const fake = setup(inst);
      await inst.ensureReady(spec());
      const seen = inst.ctx.storage.kv.get("rt_seen") as number;
      // rovo の destroy ではなくコンテナが落ちた
      fake.running = false;
      fake.monitors[0]?.reject(new Error("exit code 137"));
      await sleep(20);
      const { lines } = await capturingWarn(async () => {
        await expect(inst.exec(LS)).rejects.toThrow(/restarted/);
      });
      const detected = events(lines, "sandbox_restart_detected");
      expect(detected).toHaveLength(1);
      expect(detected[0]).toMatchObject({ rt_seen: seen, monitor_observed_exit: true });
    });
  });

  it("最初の起動では sandbox_restart_detected を出さない", async () => {
    await runInDO(sandboxStub("inactivity-first-boot"), async (inst) => {
      setup(inst);
      const { lines } = await capturingWarn(async () => {
        await inst.ensureReady(spec());
      });
      expect(events(lines, "sandbox_restart_detected")).toHaveLength(0);
    });
  });
});
