import { describe, expect, it } from "vitest";

// Sandbox の昇格（小さく始めて、コマンドの前に Clef が上げると判断したら大きい Sandbox へ）の SandboxDO 側。
// vitest 上では ctx.container が無いので maybeContainer を fake に差し替える（snapshotContainer と containerSnapshot での起動に対応）。
// Clef（env.AI）も fake。判断そのもの（確率 → 大きさ）は sandbox-scale-decision.test.ts、複数回の昇格・記録は sandbox-do-clef-scale.test.ts で確かめる。
// 昇格が成功する通常の経路は Docker の E2E（sandbox-do.e2e.test.ts。ローカルの wrangler dev も snapshotContainer に対応している）でも確かめる。
// ここでは container の API を差し替えて、順序と fail-soft の各経路（見送り・昇格先の起動の失敗・元の大きさでの起動し直し・terminate）を確かめる。
// 本番の確認は docs/specs/acceptance.md。
import {
  AGENT,
  CA_CERT,
  capturingWarn,
  HEAVY,
  IMAGE,
  LIGHT,
  runInDO,
  sandboxStub,
  setup,
  spec,
} from "./support/sandbox-promote-fake";

describe("SandboxDO: Clef が上げると判断したら、コマンドの前に大きい Sandbox へ昇格する", () => {
  it("スナップショット → 停止 → containerSnapshot で昇格先を起動 → 確認 → 元のコマンド、の順に進む", async () => {
    await runInDO(sandboxStub("promote-ok"), async (inst) => {
      const fake = setup(inst);
      await inst.ensureReady(spec());
      expect(fake.startCalls).toHaveLength(1);
      expect(fake.startCalls[0]).toMatchObject({ image: IMAGE, instance: "standard-2" });

      const r = await inst.exec(HEAVY, AGENT);
      expect(r.exitCode).toBe(0);

      // 昇格先の起動: スナップショットから（image は渡さない）、傍受を有効にして standard-3
      expect(fake.startCalls).toHaveLength(2);
      const second = fake.startCalls[1] as Record<string, unknown>;
      expect(second.containerSnapshot).toEqual({ id: "snap-promote" });
      expect(second).not.toHaveProperty("image");
      expect(second).toMatchObject({ enableInternet: false, instance: "standard-3" });
      expect(fake.snapshotCalls).toHaveLength(1);
      expect((fake.snapshotCalls[0] as { name: string }).name).toMatch(/^promote-/);

      // 順序: 状態の読み取り → スナップショット → 破棄 → 起動 → CA 確認 → 状態の再確認 → 元のコマンド
      const ev = fake.events;
      const idx = (p: string, from = 0) => ev.findIndex((e, i) => i >= from && e.startsWith(p));
      const snap = idx("snapshot");
      const destroy = idx("destroy", snap);
      const start = idx("start:snapshot:standard-3", destroy);
      const cert = idx(`exec:test -r ${CA_CERT}`, start);
      const stateIdx = (from: number) =>
        ev.findIndex((e, i) => i >= from && e.includes("rovo-promote-state"));
      const stateAfter = stateIdx(cert);
      const heavy = idx("exec:pnpm test");
      // 昇格前の状態の読み取り（スナップショットより前）
      expect(stateIdx(0)).toBeGreaterThan(-1);
      expect(stateIdx(0)).toBeLessThan(snap);
      expect(snap).toBeGreaterThan(-1);
      expect(destroy).toBeGreaterThan(snap);
      expect(start).toBeGreaterThan(destroy);
      expect(cert).toBeGreaterThan(start);
      expect(stateAfter).toBeGreaterThan(cert);
      expect(heavy).toBeGreaterThan(stateAfter);
      // 新しいコンテナの傍受・基準プロセス・無操作の期限もやり直す
      expect(fake.intercepts).toBe(2);
      expect(fake.inactivityMs).toHaveLength(2);
      expect(fake.execLog.filter((a) => a[3] === "rovo-baseline")).toHaveLength(2);
      // 作業ツリーを作り直さない（clone は最初の 1 回だけ）
      expect(fake.execLog.filter((a) => a[0] === "git" && a[1] === "clone")).toHaveLength(1);

      const m = await inst.metrics();
      expect(m.instance).toBe("standard-2");
      expect(m.promotedTo).toBe("standard-3");
      expect(m.promotions).toMatchObject([{ to: "standard-3", trigger: "clef" }]);
      expect(typeof m.promotedAt).toBe("number");
      expect(m.runtimeMsBeforePromotion).toBeGreaterThanOrEqual(0);
      expect(m.runtimeMsBeforePromotion).toBeLessThanOrEqual(m.runtimeMs);
      expect(m.promotionReason).toBeUndefined();
      // 昇格はコンテナの作り直し（restarts）に数えない
      expect(m.restarts).toBe(0);
    });
  });

  it("Clef が軽いと判断したコマンドでは昇格しない", async () => {
    await runInDO(sandboxStub("promote-light"), async (inst) => {
      const fake = setup(inst);
      await inst.ensureReady(spec());
      await inst.exec(LIGHT, AGENT);
      expect(fake.clef.calls).toHaveLength(1);
      expect(fake.snapshotCalls).toHaveLength(0);
      expect(fake.startCalls).toHaveLength(1);
      const m = await inst.metrics();
      expect(m.promotedTo).toBeUndefined();
      expect(m.promotionReason).toBeUndefined();
    });
  });

  it("子のコマンドと検証コマンド（origin 付き）だけを Clef に聞く。Sandbox 自身の内部の exec（origin なし）は聞かない", async () => {
    await runInDO(sandboxStub("promote-origin"), async (inst) => {
      const fake = setup(inst);
      await inst.ensureReady(spec());
      // origin が無い exec は、argv が重く見えても Clef を呼ばず、昇格しない
      await inst.exec(HEAVY);
      await inst.exec(["git", "status"]);
      expect(fake.clef.calls).toHaveLength(0);
      expect(fake.snapshotCalls).toHaveLength(0);
      await inst.exec(LIGHT, { origin: "verification" });
      expect(fake.clef.calls).toHaveLength(1);
    });
  });

  it("検証コマンド（origin: verification）も Clef が重いと判断すれば昇格する。引き金は clef", async () => {
    await runInDO(sandboxStub("promote-verification"), async (inst) => {
      const fake = setup(inst);
      await inst.ensureReady(spec());
      await inst.exec(HEAVY, { origin: "verification" });
      expect(fake.snapshotCalls).toHaveLength(1);
      expect(fake.currentInstance).toBe("standard-3");
      expect((await inst.metrics()).promotions).toMatchObject([{ trigger: "clef" }]);
    });
  });

  it("コマンドは state に入り、Clef には gateway と metadata（caller・taskId）を付けて聞く", async () => {
    await runInDO(sandboxStub("promote-call"), async (inst) => {
      const fake = setup(inst);
      await inst.ensureReady(spec());
      await inst.exec(["bash", "-lc", "pnpm test --run"], { ...AGENT, cwd: "/workspace" });
      const call = fake.clef.calls[0];
      expect(call?.model).toBe("@cf/cloudflare/clef-flash");
      expect(call?.state.command).toBe("pnpm test --run");
      expect(call?.state.cwd).toBe("/workspace");
      expect(call?.state.current_sandbox).toBe("standard-2 (1 vCPU, 6 GiB)");
      expect(call?.options).toEqual({
        gateway: { id: "gw", metadata: { caller: "sandbox_scale", taskId: "promote-call" } },
      });
    });
  });

  it("昇格後にコンテナが落ちて作り直されても、昇格先の大きさで起動する（小さく戻さない）。instance は最初の大きさのまま", async () => {
    await runInDO(sandboxStub("promote-restart"), async (inst) => {
      const fake = setup(inst);
      await inst.ensureReady(spec());
      await inst.exec(HEAVY, AGENT);
      fake.running = false; // 落ちた
      await expect(inst.exec(LIGHT, AGENT)).rejects.toThrow(/restarted/);
      const last = fake.startCalls.at(-1) as Record<string, unknown>;
      expect(last).toMatchObject({ image: IMAGE, instance: "standard-3" });
      const m = await inst.metrics();
      expect(m.instance).toBe("standard-2");
      expect(m.promotedTo).toBe("standard-3");
      expect(m.restarts).toBe(1);
    });
  });

  it("昇格のあと、reaper（基準プロセスの掃除）が新しいコンテナの基準で動く", async () => {
    await runInDO(sandboxStub("promote-baseline"), async (inst) => {
      const fake = setup(inst);
      await inst.ensureReady(spec());
      await inst.exec(HEAVY, AGENT);
      const destroyedBefore = fake.destroyCalls;
      await inst.exec(LIGHT); // 終了後の掃除が baseline を使う
      expect(fake.execLog.some((a) => a[3] === "rovo-reaper")).toBe(true);
      expect(fake.destroyCalls).toBe(destroyedBefore); // baseline が無くて破棄、にはならない
      expect(inst.ctx.storage.kv.get("baseline")).toEqual(["1:1"]);
    });
  });
});

describe("SandboxDO: Clef を呼ばない・昇格しない場合", () => {
  it("task_start で大きさを明示したタスク（spec.instance）は固定。Clef を呼ばない。理由は fixed_instance（1 回だけ残す）", async () => {
    await runInDO(sandboxStub("promote-fixed"), async (inst) => {
      const fake = setup(inst);
      await inst.ensureReady(spec({ instance: "standard-1" }));
      const r = await inst.exec(HEAVY, AGENT);
      expect(r.exitCode).toBe(0);
      await inst.exec(HEAVY, AGENT);
      expect(fake.clef.calls).toHaveLength(0);
      expect(fake.snapshotCalls).toHaveLength(0);
      expect(fake.startCalls).toHaveLength(1);
      expect(fake.startCalls[0]).toMatchObject({ instance: "standard-1" });
      const m = await inst.metrics();
      expect(m.promotionReason).toBe("fixed_instance");
      expect(m.promotionFailures).toHaveLength(1);
      expect(m.promotedTo).toBeUndefined();
    });
  });

  it("明示した大きさが standard-4 でも、固定として扱う", async () => {
    await runInDO(sandboxStub("promote-fixed-same"), async (inst) => {
      const fake = setup(inst);
      await inst.ensureReady(spec({ instance: "standard-3" }));
      await inst.exec(HEAVY, AGENT);
      expect(fake.clef.calls).toHaveLength(0);
      expect(fake.snapshotCalls).toHaveLength(0);
      expect((await inst.metrics()).promotionReason).toBe("fixed_instance");
    });
  });

  it("設定で無効（SANDBOX_MAX_INSTANCE が空・off・none・未設定・不正）なら Clef を呼ばず昇格しない。理由も残さない", async () => {
    for (const raw of ["", "off", "none", "lite", "bogus"]) {
      await runInDO(sandboxStub(`promote-off-${raw || "empty"}`), async (inst) => {
        const fake = setup(inst, { SANDBOX_MAX_INSTANCE: raw });
        await inst.ensureReady(spec());
        await inst.exec(HEAVY, AGENT);
        expect(fake.clef.calls, raw).toHaveLength(0);
        expect(fake.snapshotCalls, raw).toHaveLength(0);
        const m = await inst.metrics();
        expect(m.promotedTo).toBeUndefined();
        expect(m.promotionReason).toBeUndefined();
        expect(m.scaleDecisions).toBeUndefined();
      });
    }
    await runInDO(sandboxStub("promote-off-unset"), async (inst) => {
      const fake = setup(inst);
      const { SANDBOX_MAX_INSTANCE: _x, ...rest } = inst.env;
      inst.env = rest;
      await inst.ensureReady(spec());
      await inst.exec(HEAVY, AGENT);
      expect(fake.clef.calls).toHaveLength(0);
    });
  });

  it("AI_GATEWAY_ID が空・AI バインディングが無いときは Clef を呼べないので、今の大きさのまま実行する（fail-soft）", async () => {
    await runInDO(sandboxStub("promote-no-gateway"), async (inst) => {
      const fake = setup(inst, { AI_GATEWAY_ID: "" });
      await inst.ensureReady(spec());
      const { value: r } = await capturingWarn(
        async () => (await inst.exec(HEAVY, AGENT)) as { exitCode: number },
      );
      expect(r.exitCode).toBe(0);
      expect(fake.clef.calls).toHaveLength(0);
      expect(fake.snapshotCalls).toHaveLength(0);
    });
    await runInDO(sandboxStub("promote-no-ai"), async (inst) => {
      const fake = setup(inst, { AI: undefined });
      await inst.ensureReady(spec());
      const r = await inst.exec(HEAVY, AGENT);
      expect(r.exitCode).toBe(0);
      expect(fake.snapshotCalls).toHaveLength(0);
    });
  });

  it("今の大きさがすでに上限なら、Clef を呼ばない（既定が上限 / 上限が既定と同じ）", async () => {
    for (const [defaultInstance, max] of [
      ["standard-4", "standard-4"],
      ["standard-2", "standard-2"],
      ["standard-3", "standard-3"],
    ] as const) {
      await runInDO(sandboxStub(`promote-large-${defaultInstance}-${max}`), async (inst) => {
        const fake = setup(inst, { SANDBOX_INSTANCE: defaultInstance, SANDBOX_MAX_INSTANCE: max });
        await inst.ensureReady(spec());
        await inst.exec(HEAVY, AGENT);
        expect(fake.clef.calls).toHaveLength(0);
        expect(fake.snapshotCalls).toHaveLength(0);
        expect(fake.startCalls).toHaveLength(1);
        expect((await inst.metrics()).promotionReason).toBeUndefined();
      });
    }
  });
});

describe("SandboxDO: 昇格の fail-soft", () => {
  it("snapshotContainer が無いランタイム: 見送って小さいまま続ける。snapshot_unsupported。引き金は clef", async () => {
    await runInDO(sandboxStub("promote-unsupported"), async (inst) => {
      const fake = setup(inst);
      fake.snapshotContainer = undefined;
      await inst.ensureReady(spec());
      const { lines } = await capturingWarn(async () => {
        const r = await inst.exec(HEAVY, AGENT);
        expect(r.exitCode).toBe(0);
      });
      expect(fake.startCalls).toHaveLength(1);
      expect(fake.destroyCalls).toBe(0);
      expect(fake.running).toBe(true);
      const m = await inst.metrics();
      expect(m.promotionReason).toBe("snapshot_unsupported");
      expect(m.promotionFailures).toEqual([{ trigger: "clef", reason: "snapshot_unsupported" }]);
      expect(m.promotedTo).toBeUndefined();
      expect(lines.join("\n")).toContain("sandbox_promotion_skipped: snapshot_unsupported");
    });
  });

  it("スナップショットに失敗: 破棄せず小さいまま続ける。snapshot_failed", async () => {
    await runInDO(sandboxStub("promote-snap-fail"), async (inst) => {
      const fake = setup(inst);
      fake.snapshotResult = new Error("snapshot boom");
      await inst.ensureReady(spec());
      const r = await inst.exec(HEAVY, AGENT);
      expect(r.exitCode).toBe(0);
      expect(fake.destroyCalls).toBe(0);
      expect(fake.startCalls).toHaveLength(1);
      expect((await inst.metrics()).promotionReason).toBe("snapshot_failed");
    });
  });

  it("スナップショットが返らない（時間切れ）: 小さいまま続ける。snapshot_failed", async () => {
    await runInDO(sandboxStub("promote-snap-hang"), async (inst) => {
      const fake = setup(inst);
      fake.snapshotResult = "hang";
      inst.promoteSnapshotMs = 50;
      await inst.ensureReady(spec());
      const r = await inst.exec(HEAVY, AGENT);
      expect(r.exitCode).toBe(0);
      expect(fake.destroyCalls).toBe(0);
      expect((await inst.metrics()).promotionReason).toBe("snapshot_failed");
    });
  });

  it("スナップショットが id を返さない: 小さいまま続ける。snapshot_failed", async () => {
    await runInDO(sandboxStub("promote-snap-noid"), async (inst) => {
      const fake = setup(inst);
      fake.snapshotResult = { id: "", size: 0 };
      await inst.ensureReady(spec());
      await inst.exec(HEAVY, AGENT);
      expect(fake.destroyCalls).toBe(0);
      expect((await inst.metrics()).promotionReason).toBe("snapshot_failed");
    });
  });

  it("作業ツリーの状態を読めない: スナップショットを取らずに見送る。state_unreadable", async () => {
    await runInDO(sandboxStub("promote-unreadable"), async (inst) => {
      const fake = setup(inst);
      await inst.ensureReady(spec());
      fake.stateUnreadable = true;
      const r = await inst.exec(HEAVY, AGENT);
      expect(r.exitCode).toBe(0);
      expect(fake.snapshotCalls).toHaveLength(0);
      expect((await inst.metrics()).promotionReason).toBe("state_unreadable");
    });
  });

  it("昇格先の起動に失敗: 同じスナップショットで元の大きさ（standard-2）に起動し直す。作業ツリーは失わない。start_failed", async () => {
    await runInDO(sandboxStub("promote-start-fail"), async (inst) => {
      const fake = setup(inst);
      fake.failStartFor.add("standard-3");
      await inst.ensureReady(spec());
      const r = await inst.exec(HEAVY, AGENT);
      expect(r.exitCode).toBe(0); // 「再起動した」エラーにならない
      const starts = fake.startCalls as Record<string, unknown>[];
      expect(starts).toHaveLength(3);
      expect(starts[1]).toMatchObject({
        containerSnapshot: { id: "snap-promote" },
        instance: "standard-3",
      });
      expect(starts[2]).toMatchObject({
        containerSnapshot: { id: "snap-promote" },
        instance: "standard-2",
      });
      expect(starts[2]).not.toHaveProperty("image");
      expect(fake.currentInstance).toBe("standard-2");
      // 作業ツリーを作り直していない
      expect(fake.execLog.filter((a) => a[0] === "git" && a[1] === "clone")).toHaveLength(1);
      const m = await inst.metrics();
      expect(m.promotionReason).toBe("start_failed");
      expect(m.promotedTo).toBeUndefined();
      expect(m.instance).toBe("standard-2");
      // 新しいコンテナで掃除が動く（baseline を取り直している）
      expect(inst.ctx.storage.kv.get("baseline")).toEqual(["1:1"]);
    });
  });

  it("昇格に失敗した判断は、上げなかった判断として記録する（to は null。上げた回数に数えない）", async () => {
    await runInDO(sandboxStub("promote-start-fail-record"), async (inst) => {
      const fake = setup(inst);
      fake.failStartFor.add("standard-3");
      await inst.ensureReady(spec());
      await inst.exec(HEAVY, AGENT);
      const m = await inst.metrics();
      expect(m.scaleStats).toMatchObject({ decisions: 1, raised: 0 });
      expect(m.scaleDecisions?.[0]).toMatchObject({ from: "standard-2", to: null });
    });
  });

  it("昇格先で CA 証明書が読めない: 元の大きさで起動し直す。cert_missing", async () => {
    await runInDO(sandboxStub("promote-cert"), async (inst) => {
      const fake = setup(inst);
      fake.noCertFor.add("standard-3");
      await inst.ensureReady(spec());
      const r = await inst.exec(HEAVY, AGENT);
      expect(r.exitCode).toBe(0);
      expect(fake.startCalls).toHaveLength(3);
      expect(fake.currentInstance).toBe("standard-2");
      const m = await inst.metrics();
      expect(m.promotionReason).toBe("cert_missing");
      expect(m.promotedTo).toBeUndefined();
    });
  });

  it("昇格先で作業ツリー（HEAD・未 commit の変更）が元と違う: 元の大きさで起動し直す。workspace_mismatch", async () => {
    await runInDO(sandboxStub("promote-mismatch"), async (inst) => {
      const fake = setup(inst);
      fake.mismatchFor.add("standard-3");
      await inst.ensureReady(spec());
      const r = await inst.exec(HEAVY, AGENT);
      expect(r.exitCode).toBe(0);
      expect(fake.currentInstance).toBe("standard-2");
      const m = await inst.metrics();
      expect(m.promotionReason).toBe("workspace_mismatch");
      expect(m.promotedTo).toBeUndefined();
    });
  });

  it("元の大きさでの起動し直しも失敗: image からの起動（作業ツリーの作り直し）に乗せる。fallback_failed", async () => {
    await runInDO(sandboxStub("promote-fallback-fail"), async (inst) => {
      const fake = setup(inst);
      fake.failStartFor.add("standard-3");
      fake.failStartFor.add("standard-2");
      await inst.ensureReady(spec());
      await expect(inst.exec(HEAVY, AGENT)).rejects.toThrow(/restarted/);
      const last = fake.startCalls.at(-1) as Record<string, unknown>;
      expect(last).toMatchObject({ image: IMAGE });
      expect(last).not.toHaveProperty("containerSnapshot");
      const m = await inst.metrics();
      expect(m.promotionReason).toBe("fallback_failed");
      expect(m.promotedTo).toBeUndefined();
      // 判断は上げられなかったものとして記録に残る（例外で落ちて記録が抜けない）
      expect(m.scaleStats).toMatchObject({ decisions: 1, raised: 0 });
      expect(m.scaleDecisions?.[0]).toMatchObject({ from: "standard-2", to: null });
      // 次の操作は普通に動く
      const r = await inst.exec(LIGHT, AGENT);
      expect(r.exitCode).toBe(0);
    });
  });

  it("昇格の途中で terminate されたら、起動したコンテナを残さず terminated の結果を返す", async () => {
    await runInDO(sandboxStub("promote-terminate"), async (inst) => {
      const fake = setup(inst);
      await inst.ensureReady(spec());
      fake.onSnapshot = async () => {
        await inst.terminate();
      };
      const r = await inst.exec(HEAVY, AGENT);
      expect(r.terminated).toBe(true);
      expect(fake.running).toBe(false);
    });
  });

  it("Clef の判断の最中に terminate されたら、昇格もコマンドの実行もせず terminated の結果を返す", async () => {
    await runInDO(sandboxStub("promote-terminate-clef"), async (inst) => {
      const fake = setup(inst);
      await inst.ensureReady(spec());
      fake.clef.answer = () => {
        void inst.terminate();
        return { heavy: 0.95, fast4: 0.1 };
      };
      const r = await inst.exec(HEAVY, AGENT);
      expect(r.terminated).toBe(true);
      expect(fake.snapshotCalls).toHaveLength(0);
      expect(fake.events.some((e) => e.startsWith("exec:pnpm test"))).toBe(false);
    });
  });

  it("昇格の最中に別の exec が来ても、serial で待たされ、昇格後のコンテナ（standard-3）で走る", async () => {
    await runInDO(sandboxStub("promote-concurrent"), async (inst) => {
      const fake = setup(inst);
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
      const heavy = inst.exec(HEAVY, AGENT);
      await entered;
      const light = inst.exec(["echo", "concurrent"]);
      // 昇格の途中（スナップショット待ち）の間は、2 本目は走らない
      await new Promise((r) => setTimeout(r, 50));
      expect(fake.events.some((e) => e.startsWith("exec:echo concurrent"))).toBe(false);
      release();
      const [r1, r2] = await Promise.all([heavy, light]);
      expect(r1.exitCode).toBe(0);
      expect(r2.exitCode).toBe(0);
      const ev = fake.events;
      const started = ev.findIndex((e) => e.startsWith("start:snapshot:standard-3"));
      const echo = ev.findIndex((e) => e.startsWith("exec:echo concurrent"));
      const pnpm = ev.findIndex((e) => e.startsWith("exec:pnpm test"));
      expect(started).toBeGreaterThan(-1);
      expect(pnpm).toBeGreaterThan(started);
      expect(echo).toBeGreaterThan(pnpm);
      expect(fake.currentInstance).toBe("standard-3");
    });
  });

  it("元のコンテナの destroy の最中に terminate されたら、昇格先を起動せず、コンテナを残さず terminated で終わる", async () => {
    await runInDO(sandboxStub("promote-terminate-destroy"), async (inst) => {
      const fake = setup(inst);
      await inst.ensureReady(spec());
      let terminating: Promise<unknown> | undefined;
      fake.onDestroy = async () => {
        // 昇格の destroy の最初の 1 回だけ、その最中に terminate を呼ぶ
        fake.onDestroy = undefined;
        terminating = inst.terminate();
        await new Promise((r) => setTimeout(r, 20));
      };
      const r = await inst.exec(HEAVY, AGENT);
      await terminating;
      expect(r.terminated).toBe(true);
      expect(fake.running).toBe(false);
      expect(fake.startCalls.filter((c) => c.containerSnapshot)).toHaveLength(0);
      expect(inst.status().terminated).toBe(true);
    });
  });

  it("昇格先の起動待ちの最中に terminate されたら、起動したコンテナを残さず terminated で終わる", async () => {
    await runInDO(sandboxStub("promote-terminate-starting"), async (inst) => {
      const fake = setup(inst);
      await inst.ensureReady(spec());
      fake.onExec = async (argv) => {
        // 昇格先の exec の応答待ち（waitContainerReady の probe）の最中に terminate
        if (argv.length === 1 && argv[0] === "true" && fake.currentInstance === "standard-3") {
          fake.onExec = undefined;
          await inst.terminate();
        }
      };
      const r = await inst.exec(HEAVY, AGENT);
      expect(r.terminated).toBe(true);
      expect(fake.running).toBe(false);
      expect(fake.startCalls.filter((c) => c.containerSnapshot)).toHaveLength(1);
      // 元の大きさへの起動し直しもしない
      expect(fake.startCalls.filter((c) => c.instance === "standard-2")).toHaveLength(1);
      expect(inst.status().terminated).toBe(true);
    });
  });
});
