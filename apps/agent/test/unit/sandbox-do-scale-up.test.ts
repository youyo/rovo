import { describe, expect, it } from "vitest";
import {
  capturingWarn,
  HEAVY,
  IMAGE,
  LIGHT,
  runInDO,
  sandboxStub,
  setup,
  spec,
} from "./support/sandbox-promote-fake";

// 子が自分で Sandbox を大きくするツール（sandbox_scale_up）の SandboxDO 側（scaleUp）。
// 上げる方向だけ。上限は運用者の設定（SANDBOX_AGENT_MAX_INSTANCE）。規則（重いコマンド）の昇格は保険として最多 1 回残る。
// 昇格の手順（スナップショット → 停止 → 起動 → 確認）と fail-soft は maybePromote と同じものを使う（sandbox-do-promote.test.ts）。
// ここでは scaleUp の入口の判定、2 回目の昇格（スナップショットの名前）、規則との関係、serial、usage の形を確かめる。

const AGENT_MAX = { SANDBOX_AGENT_MAX_INSTANCE: "standard-4" };

/** console.log の行を集める（sandbox_promoted のログ） */
async function capturingLog<T>(fn: () => Promise<T>): Promise<{ value: T; lines: string[] }> {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => {
    lines.push(a.map(String).join(" "));
  };
  try {
    return { value: await fn(), lines };
  } finally {
    console.log = orig;
  }
}

describe("SandboxDO.scaleUp: 子の要求で上がる", () => {
  it("standard-2 → standard-3: スナップショット → 停止 → 起動 → 確認。usage の promotions に trigger agent が残り、ログに 1 行出る", async () => {
    await runInDO(sandboxStub("scale-ok"), async (inst) => {
      const fake = setup(inst, AGENT_MAX);
      await inst.ensureReady(spec());
      const { value: r, lines } = await capturingLog(() => inst.scaleUp("standard-3"));
      expect(r).toEqual({ outcome: "scaled", from: "standard-2", to: "standard-3" });
      expect(fake.currentInstance).toBe("standard-3");
      expect(fake.snapshotCalls).toHaveLength(1);
      expect(fake.startCalls).toHaveLength(2);
      expect(fake.startCalls[1]).toMatchObject({
        containerSnapshot: { id: "snap-promote" },
        instance: "standard-3",
      });
      expect(lines).toContain(
        "[sandbox-promote] sandbox_promoted: standard-2 -> standard-3 (agent)",
      );

      const m = await inst.metrics();
      expect(m.instance).toBe("standard-2");
      expect(m.promotedTo).toBe("standard-3");
      expect(typeof m.promotedAt).toBe("number");
      expect(m.promotions).toHaveLength(1);
      expect(m.promotions[0]).toMatchObject({ to: "standard-3", trigger: "agent" });
      expect(m.promotions[0]).not.toHaveProperty("ruleMatch");
      expect(typeof m.promotions[0].at).toBe("number");
      expect(m.promotions[0].runtimeMsBefore).toBeGreaterThanOrEqual(0);
      expect(m.promotionReason).toBeUndefined();
      expect(m.restarts).toBe(0);
    });
  });

  it("ヒープ上限: 子が選べるのは SANDBOX_AGENT_MAX_INSTANCE まで。standard-4 を一度に頼める（2 → 4）", async () => {
    await runInDO(sandboxStub("scale-direct-4"), async (inst) => {
      const fake = setup(inst, AGENT_MAX);
      await inst.ensureReady(spec());
      expect(await inst.scaleUp("standard-4")).toEqual({
        outcome: "scaled",
        from: "standard-2",
        to: "standard-4",
      });
      expect(fake.currentInstance).toBe("standard-4");
    });
  });

  it("今の大きさと同じか小さい指定は何もしない（エラーにしない）。今の大きさを返す", async () => {
    await runInDO(sandboxStub("scale-noop"), async (inst) => {
      const fake = setup(inst, AGENT_MAX);
      await inst.ensureReady(spec());
      expect(await inst.scaleUp("standard-2")).toEqual({
        outcome: "unchanged",
        instance: "standard-2",
      });
      expect(await inst.scaleUp("standard-1")).toEqual({
        outcome: "unchanged",
        instance: "standard-2",
      });
      expect(fake.snapshotCalls).toHaveLength(0);
      expect(fake.startCalls).toHaveLength(1);
      // 上げたあとも、下げる指定は何もしない。今の大きさ（standard-3）を返す
      await inst.scaleUp("standard-3");
      expect(await inst.scaleUp("standard-2")).toEqual({
        outcome: "unchanged",
        instance: "standard-3",
      });
      expect(await inst.scaleUp("standard-3")).toEqual({
        outcome: "unchanged",
        instance: "standard-3",
      });
      expect(fake.snapshotCalls).toHaveLength(1);
      expect(fake.currentInstance).toBe("standard-3");
    });
  });

  it("上限を超える指定は拒否して理由を返す。上限と今の大きさも返す。何もしない", async () => {
    await runInDO(sandboxStub("scale-limit"), async (inst) => {
      const fake = setup(inst, { SANDBOX_AGENT_MAX_INSTANCE: "standard-3" });
      await inst.ensureReady(spec());
      expect(await inst.scaleUp("standard-4")).toEqual({
        outcome: "rejected",
        code: "above_limit",
        instance: "standard-2",
        max: "standard-3",
      });
      expect(fake.snapshotCalls).toHaveLength(0);
      // 上限ちょうどは通る
      expect((await inst.scaleUp("standard-3")).outcome).toBe("scaled");
    });
  });

  it("選べない大きさ（lite・未知の名前・文字列でない値）は invalid_instance で拒否する", async () => {
    await runInDO(sandboxStub("scale-invalid"), async (inst) => {
      const fake = setup(inst, AGENT_MAX);
      await inst.ensureReady(spec());
      for (const bad of ["lite", "standard-9", "toString", "", 3, null, undefined]) {
        expect(await inst.scaleUp(bad), String(bad)).toMatchObject({
          outcome: "rejected",
          code: "invalid_instance",
          instance: "standard-2",
        });
      }
      expect(fake.snapshotCalls).toHaveLength(0);
    });
  });

  it("task_start で大きさを明示したタスク（fixed_instance）は、固定されていると返して何もしない", async () => {
    await runInDO(sandboxStub("scale-fixed"), async (inst) => {
      const fake = setup(inst, AGENT_MAX);
      await inst.ensureReady(spec({ instance: "standard-1" }));
      expect(await inst.scaleUp("standard-4")).toEqual({
        outcome: "fixed",
        instance: "standard-1",
      });
      expect(fake.snapshotCalls).toHaveLength(0);
      expect(fake.startCalls).toHaveLength(1);
      const m = await inst.metrics();
      expect(m.promotions ?? []).toEqual([]);
    });
  });

  it("設定が無い・無効・不正（SANDBOX_AGENT_MAX_INSTANCE）なら unavailable。何もしない", async () => {
    for (const raw of [undefined, "", "off", "none", "lite", "bogus"]) {
      await runInDO(sandboxStub(`scale-off-${raw ?? "unset"}`), async (inst) => {
        const fake = setup(inst, raw === undefined ? {} : { SANDBOX_AGENT_MAX_INSTANCE: raw });
        if (raw === undefined) {
          // wrangler.jsonc の値を外して、未設定にする
          const { SANDBOX_AGENT_MAX_INSTANCE: _x, ...rest } = inst.env;
          inst.env = rest;
        }
        await inst.ensureReady(spec());
        expect(await inst.scaleUp("standard-3"), String(raw)).toMatchObject({
          outcome: "unavailable",
          code: "disabled",
        });
        expect(fake.snapshotCalls).toHaveLength(0);
      });
    }
  });
});

describe("SandboxDO.scaleUp: 2 回目の昇格（3 → 4）", () => {
  it("スナップショットの名前を回数で変える（同じ名前だと失敗するランタイムでも 2 回目が動く）。2 回目は 1 回目の後のコンテナから取る", async () => {
    await runInDO(sandboxStub("scale-twice"), async (inst) => {
      const fake = setup(inst, AGENT_MAX);
      fake.rejectDuplicateSnapshotNames = true;
      fake.numberedSnapshotIds = true;
      await inst.ensureReady(spec());
      expect((await inst.scaleUp("standard-3")).outcome).toBe("scaled");
      const { value: second, lines } = await capturingLog(() => inst.scaleUp("standard-4"));
      expect(second).toEqual({ outcome: "scaled", from: "standard-3", to: "standard-4" });
      expect(lines).toContain(
        "[sandbox-promote] sandbox_promoted: standard-3 -> standard-4 (agent)",
      );

      const names = fake.snapshotCalls.map((c) => (c as { name: string }).name);
      expect(names).toHaveLength(2);
      expect(new Set(names).size).toBe(2);
      for (const n of names) expect(n).toMatch(/^promote-[A-Za-z0-9_-]+-[0-9]+$/);
      // 2 回目の起動は 2 回目のスナップショットから
      expect(fake.startCalls[2]).toMatchObject({
        containerSnapshot: { id: "snap-promote-2" },
        instance: "standard-4",
      });
      expect(fake.currentInstance).toBe("standard-4");

      const m = await inst.metrics();
      // 最終の大きさ、最初の昇格の時刻
      expect(m.instance).toBe("standard-2");
      expect(m.promotedTo).toBe("standard-4");
      expect(m.promotions.map((p: { to: string; trigger: string }) => [p.to, p.trigger])).toEqual([
        ["standard-3", "agent"],
        ["standard-4", "agent"],
      ]);
      expect(m.promotedAt).toBe(m.promotions[0].at);
      expect(m.runtimeMsBeforePromotion).toBe(m.promotions[0].runtimeMsBefore);
      expect(m.promotions[1].runtimeMsBefore).toBeGreaterThanOrEqual(
        m.promotions[0].runtimeMsBefore,
      );
      expect(m.promotions[1].at).toBeGreaterThanOrEqual(m.promotions[0].at);
      expect(m.restarts).toBe(0);
    });
  });

  it("4 への昇格に失敗したら、同じスナップショットで今の大きさ（standard-3）に起動し直す。standard-2 には戻らない", async () => {
    await runInDO(sandboxStub("scale-twice-fail"), async (inst) => {
      const fake = setup(inst, AGENT_MAX);
      fake.numberedSnapshotIds = true;
      await inst.ensureReady(spec());
      await inst.scaleUp("standard-3");
      fake.failStartFor.add("standard-4");
      const r = await inst.scaleUp("standard-4");
      expect(r).toEqual({ outcome: "failed", code: "start_failed", instance: "standard-3" });
      const starts = fake.startCalls as Record<string, unknown>[];
      expect(starts.at(-1)).toMatchObject({
        containerSnapshot: { id: "snap-promote-2" },
        instance: "standard-3",
      });
      expect(fake.currentInstance).toBe("standard-3");
      const m = await inst.metrics();
      expect(m.promotedTo).toBe("standard-3");
      expect(m.promotions).toHaveLength(1);
      expect(m.promotionReason).toBe("start_failed");
    });
  });

  it("昇格のあとコンテナが落ちて作り直されても、最終の大きさ（standard-4）で起動する", async () => {
    await runInDO(sandboxStub("scale-restart"), async (inst) => {
      const fake = setup(inst, AGENT_MAX);
      await inst.ensureReady(spec());
      await inst.scaleUp("standard-3");
      await inst.scaleUp("standard-4");
      fake.running = false;
      await expect(inst.exec(LIGHT)).rejects.toThrow(/restarted/);
      expect(fake.startCalls.at(-1)).toMatchObject({ image: IMAGE, instance: "standard-4" });
      const m = await inst.metrics();
      expect(m.instance).toBe("standard-2");
      expect(m.promotedTo).toBe("standard-4");
    });
  });
});

describe("SandboxDO.scaleUp: 規則（重いコマンド）との関係", () => {
  it("規則の昇格は最多 1 回。規則で standard-3 に上がった後に、子が standard-4 を頼むのは受ける", async () => {
    await runInDO(sandboxStub("scale-after-rule"), async (inst) => {
      const fake = setup(inst, AGENT_MAX);
      await inst.ensureReady(spec());
      await inst.exec(HEAVY);
      expect(fake.currentInstance).toBe("standard-3");
      expect(await inst.scaleUp("standard-4")).toEqual({
        outcome: "scaled",
        from: "standard-3",
        to: "standard-4",
      });
      // 以降の重いコマンドでは、規則はもう何もしない
      await inst.exec(HEAVY);
      await inst.exec(["vitest", "run"]);
      expect(fake.snapshotCalls).toHaveLength(2);
      const m = await inst.metrics();
      expect(m.promotions.map((p: { trigger: string }) => p.trigger)).toEqual(["rule", "agent"]);
      expect(m.promotions[0].ruleMatch).toBe("pnpm test");
      expect(m.promotions[1]).not.toHaveProperty("ruleMatch");
      expect(m.promotedTo).toBe("standard-4");
    });
  });

  it("子がすでに規則の昇格先以上に上げていれば、規則は何もしない（理由も残さない）", async () => {
    await runInDO(sandboxStub("scale-before-rule"), async (inst) => {
      const fake = setup(inst, AGENT_MAX);
      await inst.ensureReady(spec());
      await inst.scaleUp("standard-3");
      const { lines } = await capturingWarn(async () => {
        const r = await inst.exec(HEAVY);
        expect(r.exitCode).toBe(0);
      });
      expect(lines.join("\n")).not.toContain("sandbox_promotion");
      expect(fake.snapshotCalls).toHaveLength(1);
      const m = await inst.metrics();
      expect(m.promotions).toHaveLength(1);
      expect(m.promotions[0].trigger).toBe("agent");
      expect(m.promotionReason).toBeUndefined();

      // standard-4 に上げた子でも同じ
      await runInDO(sandboxStub("scale-before-rule-4"), async (inst2) => {
        const fake2 = setup(inst2, AGENT_MAX);
        await inst2.ensureReady(spec());
        await inst2.scaleUp("standard-4");
        await inst2.exec(HEAVY);
        expect(fake2.snapshotCalls).toHaveLength(1);
        expect((await inst2.metrics()).promotionReason).toBeUndefined();
      });
    });
  });

  it("子が standard-2 のまま（下の指定）だった場合は、重いコマンドで規則が拾う。trigger は rule、rule_match は表の名前", async () => {
    await runInDO(sandboxStub("scale-rule-fallback"), async (inst) => {
      const fake = setup(inst, AGENT_MAX);
      await inst.ensureReady(spec());
      await inst.scaleUp("standard-1"); // 何もしない
      await inst.exec(["bash", "-lc", "cd app && vitest run secret-file-name"]);
      expect(fake.currentInstance).toBe("standard-3");
      const m = await inst.metrics();
      expect(m.promotions).toHaveLength(1);
      expect(m.promotions[0]).toMatchObject({
        to: "standard-3",
        trigger: "rule",
        ruleMatch: "vitest",
      });
      // argv の文字列そのものは usage に入らない
      expect(JSON.stringify(m)).not.toContain("secret-file-name");
    });
  });

  it("検証コマンド（heavy: true）で上がったときは trigger verification。rule_match は付かない", async () => {
    await runInDO(sandboxStub("scale-verification"), async (inst) => {
      setup(inst, AGENT_MAX);
      await inst.ensureReady(spec());
      await inst.exec(["./scripts/check.sh", "--private-arg"], { heavy: true });
      const m = await inst.metrics();
      expect(m.promotions).toHaveLength(1);
      expect(m.promotions[0]).toMatchObject({ to: "standard-3", trigger: "verification" });
      expect(m.promotions[0]).not.toHaveProperty("ruleMatch");
      expect(JSON.stringify(m)).not.toContain("private-arg");
    });
  });

  it("規則の昇格が失敗しても、子の要求は別に試せる。規則は再試行しない", async () => {
    await runInDO(sandboxStub("scale-rule-failed"), async (inst) => {
      const fake = setup(inst, AGENT_MAX);
      fake.snapshotResult = new Error("snapshot boom");
      await inst.ensureReady(spec());
      await inst.exec(HEAVY);
      expect((await inst.metrics()).promotionReason).toBe("snapshot_failed");
      await inst.exec(HEAVY); // 規則は再試行しない
      expect(fake.snapshotCalls).toHaveLength(1);
      fake.snapshotResult = { id: "snap-promote", size: 1 };
      expect((await inst.scaleUp("standard-3")).outcome).toBe("scaled");
      const m = await inst.metrics();
      expect(m.promotions).toHaveLength(1);
      expect(m.promotions[0].trigger).toBe("agent");
      expect(m.promotedTo).toBe("standard-3");
    });
  });
});

describe("SandboxDO.scaleUp: 子が上げたあとの重いコマンドの本数（保険がどのくらい要ったかの振り返り用）", () => {
  it("子が上げたあとに規則で重いと判定されたコマンドを数える。軽いコマンド・上げる前・検証の heavy フラグだけのものは数えない", async () => {
    await runInDO(sandboxStub("scale-count"), async (inst) => {
      setup(inst, AGENT_MAX);
      await inst.ensureReady(spec());
      await inst.exec(LIGHT);
      expect((await inst.metrics()).heavyCommandsAfterAgentScaleUp ?? 0).toBe(0);
      await inst.scaleUp("standard-4");
      await inst.exec(LIGHT);
      await inst.exec(["vitest", "run"]);
      await inst.exec(["pnpm", "test"]);
      await inst.exec(["./scripts/check.sh"], { heavy: true }); // argv は規則に一致しない
      expect((await inst.metrics()).heavyCommandsAfterAgentScaleUp).toBe(2);
    });
  });

  it("子が上げていないタスク（規則で上がった・上がらない）では 0。数えない", async () => {
    await runInDO(sandboxStub("scale-count-none"), async (inst) => {
      setup(inst, AGENT_MAX);
      await inst.ensureReady(spec());
      await inst.exec(HEAVY);
      await inst.exec(HEAVY);
      expect((await inst.metrics()).heavyCommandsAfterAgentScaleUp ?? 0).toBe(0);
    });
  });

  it("失敗した要求や何もしなかった要求の後は数えない", async () => {
    await runInDO(sandboxStub("scale-count-failed"), async (inst) => {
      const fake = setup(inst, AGENT_MAX);
      fake.snapshotResult = new Error("boom");
      await inst.ensureReady(spec());
      await inst.scaleUp("standard-3");
      await inst.scaleUp("standard-2");
      await inst.exec(["vitest"]);
      expect((await inst.metrics()).heavyCommandsAfterAgentScaleUp ?? 0).toBe(0);
    });
  });
});

describe("SandboxDO.scaleUp: fail-soft", () => {
  it("スナップショットに失敗: 今の大きさのまま続ける。理由コードを返す。何度でも頼める", async () => {
    await runInDO(sandboxStub("scale-snap-fail"), async (inst) => {
      const fake = setup(inst, AGENT_MAX);
      fake.snapshotResult = new Error("snapshot boom");
      await inst.ensureReady(spec());
      const { value: r, lines } = await capturingWarn(() => inst.scaleUp("standard-3"));
      expect(r).toEqual({ outcome: "failed", code: "snapshot_failed", instance: "standard-2" });
      expect(lines.join("\n")).toContain("sandbox_promotion_skipped: snapshot_failed");
      expect(fake.destroyCalls).toBe(0);
      expect(fake.running).toBe(true);
      const m = await inst.metrics();
      expect(m.promotionReason).toBe("snapshot_failed");
      expect(m.promotedTo).toBeUndefined();
      expect(m.promotions ?? []).toEqual([]);
      // 次の要求は試みる
      fake.snapshotResult = { id: "snap-promote", size: 1 };
      expect((await inst.scaleUp("standard-3")).outcome).toBe("scaled");
    });
  });

  it("snapshotContainer が無いランタイム: failed(snapshot_unsupported)。コンテナには触らない", async () => {
    await runInDO(sandboxStub("scale-unsupported"), async (inst) => {
      const fake = setup(inst, AGENT_MAX);
      fake.snapshotContainer = undefined;
      await inst.ensureReady(spec());
      expect(await inst.scaleUp("standard-3")).toEqual({
        outcome: "failed",
        code: "snapshot_unsupported",
        instance: "standard-2",
      });
      expect(fake.destroyCalls).toBe(0);
      expect(fake.startCalls).toHaveLength(1);
    });
  });

  it("作業ツリーの状態を読めない: スナップショットを取らずに failed(state_unreadable)", async () => {
    await runInDO(sandboxStub("scale-unreadable"), async (inst) => {
      const fake = setup(inst, AGENT_MAX);
      await inst.ensureReady(spec());
      fake.stateUnreadable = true;
      expect(await inst.scaleUp("standard-3")).toEqual({
        outcome: "failed",
        code: "state_unreadable",
        instance: "standard-2",
      });
      expect(fake.snapshotCalls).toHaveLength(0);
    });
  });

  it("昇格先の起動に失敗: 同じスナップショットで元の大きさに起動し直す。failed(start_failed)", async () => {
    await runInDO(sandboxStub("scale-start-fail"), async (inst) => {
      const fake = setup(inst, AGENT_MAX);
      fake.failStartFor.add("standard-3");
      await inst.ensureReady(spec());
      expect(await inst.scaleUp("standard-3")).toEqual({
        outcome: "failed",
        code: "start_failed",
        instance: "standard-2",
      });
      expect(fake.currentInstance).toBe("standard-2");
      expect(fake.execLog.filter((a) => a[0] === "git" && a[1] === "clone")).toHaveLength(1);
    });
  });

  it("元の大きさでも起動し直せない: 「再起動した」例外（exec と同じ。image からの起動に乗せる）", async () => {
    await runInDO(sandboxStub("scale-fallback-fail"), async (inst) => {
      const fake = setup(inst, AGENT_MAX);
      fake.failStartFor.add("standard-3");
      fake.failStartFor.add("standard-2");
      await inst.ensureReady(spec());
      await expect(inst.scaleUp("standard-3")).rejects.toThrow(/restarted/);
      expect(fake.startCalls.at(-1)).toMatchObject({ image: IMAGE });
      expect((await inst.metrics()).promotionReason).toBe("fallback_failed");
    });
  });

  it("昇格の途中で terminate されたら terminated を返し、コンテナを残さない", async () => {
    await runInDO(sandboxStub("scale-terminate"), async (inst) => {
      const fake = setup(inst, AGENT_MAX);
      await inst.ensureReady(spec());
      fake.onSnapshot = async () => {
        await inst.terminate();
      };
      expect(await inst.scaleUp("standard-3")).toEqual({ outcome: "terminated" });
      expect(fake.running).toBe(false);
    });
  });

  it("terminate 済みなら terminated を返す（例外にしない）", async () => {
    await runInDO(sandboxStub("scale-terminated"), async (inst) => {
      const fake = setup(inst, AGENT_MAX);
      await inst.ensureReady(spec());
      await inst.terminate();
      expect(await inst.scaleUp("standard-3")).toEqual({ outcome: "terminated" });
      expect(fake.snapshotCalls).toHaveLength(0);
    });
  });
});

describe("SandboxDO.scaleUp: serial（実行中のコマンドと競合させない）", () => {
  it("実行中のコマンドが終わるまで、スナップショットを始めない", async () => {
    await runInDO(sandboxStub("scale-serial"), async (inst) => {
      const fake = setup(inst, AGENT_MAX);
      await inst.ensureReady(spec());
      let release: () => void = () => {};
      const gate = new Promise<void>((r) => {
        release = r;
      });
      let inExec: () => void = () => {};
      const entered = new Promise<void>((r) => {
        inExec = r;
      });
      fake.onExec = async (argv) => {
        if (argv[0] === "sleep") {
          inExec();
          await gate;
        }
      };
      const running = inst.exec(["sleep", "5"]);
      await entered;
      const scaling = inst.scaleUp("standard-3");
      await new Promise((r) => setTimeout(r, 50));
      expect(fake.snapshotCalls).toHaveLength(0);
      release();
      const [r1, r2] = await Promise.all([running, scaling]);
      expect(r1.exitCode).toBe(0);
      expect(r2.outcome).toBe("scaled");
      const ev = fake.events;
      expect(ev.findIndex((e) => e === "snapshot")).toBeGreaterThan(
        ev.findIndex((e) => e.startsWith("exec:sleep 5")),
      );
    });
  });

  it("昇格の最中に来た exec は待たされ、昇格後のコンテナ（standard-4）で走る", async () => {
    await runInDO(sandboxStub("scale-serial-exec"), async (inst) => {
      const fake = setup(inst, AGENT_MAX);
      await inst.ensureReady(spec());
      let release: () => void = () => {};
      const gate = new Promise<void>((r) => {
        release = r;
      });
      let inSnapshot: () => void = () => {};
      const entered = new Promise<void>((r) => {
        inSnapshot = r;
      });
      fake.onSnapshot = async () => {
        inSnapshot();
        await gate;
      };
      const scaling = inst.scaleUp("standard-4");
      await entered;
      const light = inst.exec(["echo", "concurrent"]);
      await new Promise((r) => setTimeout(r, 50));
      expect(fake.events.some((e) => e.startsWith("exec:echo concurrent"))).toBe(false);
      release();
      await Promise.all([scaling, light]);
      const ev = fake.events;
      expect(ev.findIndex((e) => e.startsWith("exec:echo concurrent"))).toBeGreaterThan(
        ev.findIndex((e) => e.startsWith("start:snapshot:standard-4")),
      );
    });
  });
});

describe("SandboxDO: 子の見立ての的中（heavyCommandsCoveredByAgent）", () => {
  it("子が規則の昇格先以上に上げたあと、規則で重いと判定されたコマンドは的中として数える。軽いコマンド・検証の heavy フラグだけのものは数えない", async () => {
    await runInDO(sandboxStub("covered-hit"), async (inst) => {
      setup(inst, AGENT_MAX);
      await inst.ensureReady(spec());
      await inst.scaleUp("standard-4");
      await inst.exec(LIGHT);
      await inst.exec(["vitest", "run"]);
      await inst.exec(["pnpm", "test"]);
      await inst.exec(["./scripts/check.sh"], { heavy: true });
      const m = await inst.metrics();
      expect(m.heavyCommandsAfterAgentScaleUp).toBe(2);
      expect(m.heavyCommandsCoveredByAgent).toBe(2);
    });
  });

  it("子が上げたが規則の昇格先に届かなかったときは的中ではない。規則が拾い、promotions は agent → rule の順になる", async () => {
    await runInDO(sandboxStub("covered-short"), async (inst) => {
      const fake = setup(inst, { ...AGENT_MAX, SANDBOX_HEAVY_INSTANCE: "standard-4" });
      await inst.ensureReady(spec());
      await inst.scaleUp("standard-3");
      await inst.exec(HEAVY);
      expect(fake.currentInstance).toBe("standard-4");
      const m = await inst.metrics();
      expect(m.promotions.map((p: { trigger: string }) => p.trigger)).toEqual(["agent", "rule"]);
      expect(m.heavyCommandsAfterAgentScaleUp).toBe(1);
      expect(m.heavyCommandsCoveredByAgent).toBe(0);
      expect(m.promotionFailures).toBeUndefined();
    });
  });

  it("子が上げていなければ付かない（規則だけで上がったタスク）", async () => {
    await runInDO(sandboxStub("covered-none"), async (inst) => {
      setup(inst, AGENT_MAX);
      await inst.ensureReady(spec());
      await inst.exec(HEAVY);
      await inst.exec(HEAVY);
      const m = await inst.metrics();
      expect(m).not.toHaveProperty("heavyCommandsCoveredByAgent");
      expect(m).not.toHaveProperty("heavyCommandsAfterAgentScaleUp");
    });
  });

  it("規則の昇格を無効にしているデプロイでは、的中として数えない（防ぐ対象が無い）", async () => {
    await runInDO(sandboxStub("covered-disabled"), async (inst) => {
      setup(inst, { ...AGENT_MAX, SANDBOX_HEAVY_INSTANCE: "off" });
      await inst.ensureReady(spec());
      await inst.scaleUp("standard-4");
      await inst.exec(HEAVY);
      const m = await inst.metrics();
      expect(m.heavyCommandsAfterAgentScaleUp).toBe(1);
      expect(m.heavyCommandsCoveredByAgent).toBe(0);
    });
  });

  it("規則がすでに昇格したあとで子が上げた場合は、以降のコマンドを的中として数えない（規則が昇格しなくて済んだわけではない）", async () => {
    await runInDO(sandboxStub("covered-after-rule"), async (inst) => {
      setup(inst, AGENT_MAX);
      await inst.ensureReady(spec());
      await inst.exec(HEAVY); // 規則で standard-3
      await inst.scaleUp("standard-4");
      await inst.exec(HEAVY);
      const m = await inst.metrics();
      expect(m.heavyCommandsAfterAgentScaleUp).toBe(1);
      expect(m.heavyCommandsCoveredByAgent).toBe(0);
    });
  });
});

describe("SandboxDO: 的中は規則の試行が残っていたときだけ数える", () => {
  it("規則の昇格が失敗して試行を使い切ったあとで子が上げても、以降の重いコマンドは的中として数えない", async () => {
    await runInDO(sandboxStub("covered-after-rule-failed"), async (inst) => {
      const fake = setup(inst, AGENT_MAX);
      fake.snapshotResult = new Error("boom");
      await inst.ensureReady(spec());
      await inst.exec(HEAVY); // 規則の昇格が snapshot_failed で見送り（試行を使い切る）
      fake.snapshotResult = { id: "snap-ok", size: 1 };
      await inst.scaleUp("standard-4");
      await inst.exec(HEAVY);
      await inst.exec(HEAVY);
      const m = await inst.metrics();
      expect(m.heavyCommandsAfterAgentScaleUp).toBe(2);
      expect(m.heavyCommandsCoveredByAgent).toBe(0);
    });
  });

  it("検証コマンドの昇格が失敗して試行を使い切ったあとで子が上げた場合も、的中として数えない", async () => {
    await runInDO(sandboxStub("covered-after-verification-failed"), async (inst) => {
      const fake = setup(inst, AGENT_MAX);
      fake.snapshotResult = new Error("boom");
      await inst.ensureReady(spec());
      await inst.exec(["./scripts/check.sh"], { heavy: true });
      fake.snapshotResult = { id: "snap-ok", size: 1 };
      await inst.scaleUp("standard-4");
      await inst.exec(HEAVY);
      const m = await inst.metrics();
      expect(m.heavyCommandsCoveredByAgent).toBe(0);
    });
  });

  it("子が先に上げていて規則が見送った（試行を使った）あとの重いコマンドも、的中として数え続ける", async () => {
    await runInDO(sandboxStub("covered-keeps-counting"), async (inst) => {
      setup(inst, AGENT_MAX);
      await inst.ensureReady(spec());
      await inst.scaleUp("standard-4");
      await inst.exec(HEAVY);
      await inst.exec(HEAVY);
      await inst.exec(["./scripts/check.sh"], { heavy: true });
      await inst.exec(HEAVY);
      const m = await inst.metrics();
      expect(m.heavyCommandsAfterAgentScaleUp).toBe(3);
      expect(m.heavyCommandsCoveredByAgent).toBe(3);
    });
  });
});

describe("SandboxDO: 昇格の失敗の内訳（promotionFailures）", () => {
  it("規則の昇格がスナップショットの失敗で見送られたら { trigger: rule, reason: snapshot_failed } を 1 件足す。promotionReason は最後の理由のまま", async () => {
    await runInDO(sandboxStub("fail-rule-snap"), async (inst) => {
      const fake = setup(inst, AGENT_MAX);
      fake.snapshotResult = new Error("boom");
      await inst.ensureReady(spec());
      await inst.exec(HEAVY);
      const m = await inst.metrics();
      expect(m.promotionFailures).toEqual([{ trigger: "rule", reason: "snapshot_failed" }]);
      expect(m.promotionReason).toBe("snapshot_failed");
    });
  });

  it("子の要求の失敗は trigger agent で足す。何度失敗しても 1 回ごとに 1 件、最大 8 件で、超えた分は捨てる", async () => {
    await runInDO(sandboxStub("fail-agent-max"), async (inst) => {
      const fake = setup(inst, AGENT_MAX);
      fake.snapshotResult = new Error("boom");
      await inst.ensureReady(spec());
      await inst.scaleUp("standard-3");
      expect((await inst.metrics()).promotionFailures).toEqual([
        { trigger: "agent", reason: "snapshot_failed" },
      ]);
      for (let i = 0; i < 11; i++) await inst.scaleUp("standard-3");
      const m = await inst.metrics();
      expect(m.promotionFailures).toHaveLength(8);
      expect(m.promotionFailures.every((f: { trigger: string }) => f.trigger === "agent")).toBe(
        true,
      );
    });
  });

  it("検証コマンド（heavy）の見送りは trigger verification。task_start で大きさを固定したタスクは fixed_instance", async () => {
    await runInDO(sandboxStub("fail-verification-fixed"), async (inst) => {
      setup(inst, AGENT_MAX);
      await inst.ensureReady(spec({ instance: "standard-1" }));
      await inst.exec(["./scripts/check.sh"], { heavy: true });
      expect((await inst.metrics()).promotionFailures).toEqual([
        { trigger: "verification", reason: "fixed_instance" },
      ]);
    });
  });

  it("昇格先の起動の失敗と、元の大きさでの起動し直しの失敗は、それぞれ 1 件ずつ足す", async () => {
    await runInDO(sandboxStub("fail-start-fallback"), async (inst) => {
      const fake = setup(inst, AGENT_MAX);
      fake.failStartFor.add("standard-3");
      fake.failStartFor.add("standard-2");
      await inst.ensureReady(spec());
      await expect(inst.scaleUp("standard-3")).rejects.toThrow(/restarted/);
      expect((await inst.metrics()).promotionFailures).toEqual([
        { trigger: "agent", reason: "start_failed" },
        { trigger: "agent", reason: "fallback_failed" },
      ]);
    });
  });

  it("子が先に昇格先以上へ上げていて規則が見送るのは失敗ではない。足さない", async () => {
    await runInDO(sandboxStub("fail-not-for-covered"), async (inst) => {
      setup(inst, AGENT_MAX);
      await inst.ensureReady(spec());
      await inst.scaleUp("standard-3");
      await inst.exec(HEAVY);
      const m = await inst.metrics();
      expect(m).not.toHaveProperty("promotionFailures");
      expect(m.heavyCommandsCoveredByAgent).toBe(1);
    });
  });

  it("失敗が無ければ付かない。拒否（上限超え・不正な名前）や何もしない要求も足さない", async () => {
    await runInDO(sandboxStub("fail-none"), async (inst) => {
      setup(inst, { SANDBOX_AGENT_MAX_INSTANCE: "standard-3" });
      await inst.ensureReady(spec());
      await inst.scaleUp("standard-4");
      await inst.scaleUp("lite");
      await inst.scaleUp("standard-2");
      expect(await inst.metrics()).not.toHaveProperty("promotionFailures");
    });
  });
});
