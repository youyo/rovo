import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

// Sandbox の昇格（小さく始めて、重いコマンドの初回に大きい Sandbox へ）の SandboxDO 側。
// vitest 上では ctx.container が無いので maybeContainer を fake に差し替える（snapshotContainer と containerSnapshot での起動に対応）。
// 昇格が成功する通常の経路は Docker の E2E（sandbox-do.e2e.test.ts。ローカルの wrangler dev も snapshotContainer に対応している）でも確かめる。
// ここでは container の API を差し替えて、順序と fail-soft の各経路（見送り・昇格先の起動の失敗・元の大きさでの起動し直し・terminate）を確かめる。
// 本番の確認は docs/specs/acceptance.md。

const SHA = "a".repeat(40);
const CA_CERT = "/etc/cloudflare/certs/cloudflare-containers-ca.crt";
const IMAGE = `registry.cloudflare.com/acct/rovo-agent-sandboxdo-workspace@sha256:${"b".repeat(64)}`;
const HEAVY = ["pnpm", "test"];
const LIGHT = ["ls", "-la"];

// biome-ignore lint/suspicious/noExplicitAny: private メンバーを差し替えるテスト
type Inst = any;
const runInDO = runInDurableObject as unknown as (
  stub: unknown,
  fn: (inst: Inst) => Promise<void>,
) => Promise<void>;
const sandboxStub = (name: string) => (env.SANDBOX_DO as DurableObjectNamespace).getByName(name);

const spec = (extra: Record<string, unknown> = {}) => ({
  repository: "acme/hello",
  baseSha: SHA,
  initialSha: SHA,
  branch: "agent/task-x",
  deadlineAt: Date.now() + 3_600_000,
  ...extra,
});

type Reply = { code?: number; out?: string } | undefined;

/** コンテナの fake。操作の順序を events に残す（start / snapshot / destroy / exec） */
class FakeContainer {
  running = false;
  images = { workspace: IMAGE };
  startCalls: Record<string, unknown>[] = [];
  snapshotCalls: unknown[] = [];
  destroyCalls = 0;
  intercepts = 0;
  inactivityMs: number[] = [];
  execLog: string[][] = [];
  events: string[] = [];
  /** 今動いているコンテナの大きさ */
  currentInstance = "";
  /** この大きさの containerSnapshot 起動は同期的に投げる */
  failStartFor = new Set<string>();
  /** この大きさのコンテナでは CA 証明書が読めない */
  noCertFor = new Set<string>();
  /** この大きさのコンテナでは、作業ツリーの状態が元と違う */
  mismatchFor = new Set<string>();
  /** 作業ツリーの状態の読み取りを失敗させる */
  stateUnreadable = false;
  /** snapshotContainer の結果 */
  snapshotResult: { id: string; size: number } | Error | "hang" = { id: "snap-promote", size: 1 };
  /** undefined にすると、snapshotContainer が無いランタイムを模せる */
  snapshotContainer: ((options?: { name?: string }) => Promise<unknown>) | undefined = (o) =>
    this.snap(o);
  /** 追加の応答 */
  handler: (argv: string[]) => Reply = () => undefined;
  /** snapshotContainer の途中で呼ばれる */
  onSnapshot: (() => Promise<void>) | undefined;
  /** destroy の途中で呼ばれる（止まる前） */
  onDestroy: (() => Promise<void>) | undefined;
  /** exec の応答の前に呼ばれる */
  onExec: ((argv: string[]) => Promise<void>) | undefined;

  start(options: Record<string, unknown>) {
    this.startCalls.push(options);
    const instance = String(options.instance);
    this.events.push(
      `start:${options.containerSnapshot ? "snapshot" : "image"}:${instance}${
        options.containerSnapshot ? `:${(options.containerSnapshot as { id: string }).id}` : ""
      }`,
    );
    if (options.containerSnapshot && options.image) throw new TypeError("both image and snapshot");
    if (options.containerSnapshot && this.failStartFor.has(instance)) {
      throw new Error("start boom");
    }
    this.running = true;
    this.currentInstance = instance;
  }
  async destroy() {
    this.destroyCalls += 1;
    this.events.push("destroy");
    await this.onDestroy?.();
    this.running = false;
  }
  async setInactivityTimeout(ms: number) {
    this.inactivityMs.push(ms);
  }
  async interceptOutboundHttps() {
    this.intercepts += 1;
  }
  async interceptAllOutboundHttp() {}
  async exec(argv: string[]) {
    this.execLog.push(argv);
    this.events.push(`exec:${argv.join(" ")}`);
    await this.onExec?.(argv);
    const stream = (t: string) =>
      new ReadableStream<Uint8Array>({
        start(c) {
          if (t) c.enqueue(new TextEncoder().encode(t));
          c.close();
        },
      });
    let reply: Reply = this.handler(argv);
    if (reply === undefined) {
      if (argv[0] === "test" && argv[2] === CA_CERT) {
        reply = { code: this.noCertFor.has(this.currentInstance) ? 1 : 0 };
      } else if (argv[0] === "bash" && argv[3] === "rovo-baseline") reply = { out: "1:1\n" };
      else if (argv[0] === "bash" && argv[3] === "rovo-reaper") reply = { out: "clean\n" };
      else if (argv[0] === "bash" && argv[3] === "rovo-promote-state") {
        if (this.stateUnreadable) reply = { code: 1 };
        else {
          const dirty = this.mismatchFor.has(this.currentInstance) ? "?? other.txt" : " M a.ts";
          reply = { out: `${"c".repeat(40)}\n${dirty}\nhash-of-diff  -\n` };
        }
      } else if (argv[0] === "git" && argv.includes("rev-parse") && argv.includes("--verify")) {
        reply = { code: 1 }; // 最初の起動: 作業ツリーが無い → clone へ
      } else reply = {};
    }
    return {
      stdout: stream(reply.out ?? ""),
      stderr: stream(""),
      exitCode: Promise.resolve(reply.code ?? 0),
    };
  }
  private async snap(options?: { name?: string }) {
    if (options === undefined) throw new TypeError("options is required");
    this.snapshotCalls.push(options);
    this.events.push("snapshot");
    if (!this.running) throw new Error("container is not running");
    await this.onSnapshot?.();
    if (this.snapshotResult === "hang") return new Promise<never>(() => {});
    if (this.snapshotResult instanceof Error) throw this.snapshotResult;
    return { ...this.snapshotResult, ...(options.name ? { name: options.name } : {}) };
  }
  /** 元のコマンド（重い・軽い）を実行した位置。ユーザーのコマンドは cwd を持つ（内部の exec と見分ける） */
  indexOfEvent(prefix: string): number {
    return this.events.findIndex((e) => e.startsWith(prefix));
  }
}

function setup(inst: Inst, vars: Record<string, string> = {}) {
  const fake = new FakeContainer();
  inst.maybeContainer = () => fake;
  inst.depsCacheEnabled = () => false;
  inst.env = { ...inst.env, SANDBOX_HEAVY_INSTANCE: "standard-3", ...vars };
  return fake;
}

/** console.warn の行を集める（理由コードのログ） */
async function capturingWarn<T>(fn: () => Promise<T>): Promise<{ value: T; lines: string[] }> {
  const lines: string[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => {
    lines.push(a.map(String).join(" "));
  };
  try {
    return { value: await fn(), lines };
  } finally {
    console.warn = orig;
  }
}

describe("SandboxDO: 重いコマンドの初回に大きい Sandbox へ昇格する", () => {
  it("スナップショット → 停止 → containerSnapshot で昇格先を起動 → 確認 → 元のコマンド、の順に進む", async () => {
    await runInDO(sandboxStub("promote-ok"), async (inst) => {
      const fake = setup(inst);
      await inst.ensureReady(spec());
      expect(fake.startCalls).toHaveLength(1);
      expect(fake.startCalls[0]).toMatchObject({ image: IMAGE, instance: "standard-2" });

      const r = await inst.exec(HEAVY);
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
      expect(typeof m.promotedAt).toBe("number");
      expect(m.runtimeMsBeforePromotion).toBeGreaterThanOrEqual(0);
      expect(m.runtimeMsBeforePromotion).toBeLessThanOrEqual(m.runtimeMs);
      expect(m.promotionReason).toBeUndefined();
      // 昇格はコンテナの作り直し（restarts）に数えない
      expect(m.restarts).toBe(0);
    });
  });

  it("軽いコマンドでは昇格しない", async () => {
    await runInDO(sandboxStub("promote-light"), async (inst) => {
      const fake = setup(inst);
      await inst.ensureReady(spec());
      await inst.exec(LIGHT);
      expect(fake.snapshotCalls).toHaveLength(0);
      expect(fake.startCalls).toHaveLength(1);
      const m = await inst.metrics();
      expect(m.promotedTo).toBeUndefined();
      expect(m.promotionReason).toBeUndefined();
    });
  });

  it("2 本目の重いコマンドでは昇格しない（一度だけ。戻さない）", async () => {
    await runInDO(sandboxStub("promote-once"), async (inst) => {
      const fake = setup(inst);
      await inst.ensureReady(spec());
      await inst.exec(HEAVY);
      await inst.exec(["vitest", "run"]);
      await inst.exec(["tsc", "--noEmit"]);
      expect(fake.snapshotCalls).toHaveLength(1);
      expect(fake.startCalls).toHaveLength(2);
      expect(fake.currentInstance).toBe("standard-3");
    });
  });

  it("検証コマンドなど、呼び出し側が heavy: true を付けたときは argv が軽くても昇格する", async () => {
    await runInDO(sandboxStub("promote-hint"), async (inst) => {
      const fake = setup(inst);
      await inst.ensureReady(spec());
      await inst.exec(["./scripts/check.sh"], { heavy: true });
      expect(fake.snapshotCalls).toHaveLength(1);
      expect(fake.currentInstance).toBe("standard-3");
    });
  });

  it("昇格後にコンテナが落ちて作り直されても、昇格先の大きさで起動する（小さく戻さない）。instance は最初の大きさのまま", async () => {
    await runInDO(sandboxStub("promote-restart"), async (inst) => {
      const fake = setup(inst);
      await inst.ensureReady(spec());
      await inst.exec(HEAVY);
      fake.running = false; // 落ちた
      await expect(inst.exec(LIGHT)).rejects.toThrow(/restarted/);
      const last = fake.startCalls.at(-1) as Record<string, unknown>;
      expect(last).toMatchObject({ image: IMAGE, instance: "standard-3" });
      const m = await inst.metrics();
      expect(m.instance).toBe("standard-2");
      expect(m.promotedTo).toBe("standard-3");
      expect(m.restarts).toBe(1);
      // 再起動後の重いコマンドでは、もう昇格を試みない
      await inst.exec(HEAVY);
      expect(fake.snapshotCalls).toHaveLength(1);
    });
  });

  it("昇格のあと、reaper（基準プロセスの掃除）が新しいコンテナの基準で動く", async () => {
    await runInDO(sandboxStub("promote-baseline"), async (inst) => {
      const fake = setup(inst);
      await inst.ensureReady(spec());
      await inst.exec(HEAVY);
      const destroyedBefore = fake.destroyCalls;
      await inst.exec(LIGHT); // 終了後の掃除が baseline を使う
      expect(fake.execLog.some((a) => a[3] === "rovo-reaper")).toBe(true);
      expect(fake.destroyCalls).toBe(destroyedBefore); // baseline が無くて破棄、にはならない
      expect(inst.ctx.storage.kv.get("baseline")).toEqual(["1:1"]);
    });
  });
});

describe("SandboxDO: 昇格しない場合", () => {
  it("task_start で大きさを明示したタスク（spec.instance）は固定。理由は fixed_instance", async () => {
    await runInDO(sandboxStub("promote-fixed"), async (inst) => {
      const fake = setup(inst);
      await inst.ensureReady(spec({ instance: "standard-1" }));
      const r = await inst.exec(HEAVY);
      expect(r.exitCode).toBe(0);
      expect(fake.snapshotCalls).toHaveLength(0);
      expect(fake.startCalls).toHaveLength(1);
      expect(fake.startCalls[0]).toMatchObject({ instance: "standard-1" });
      const m = await inst.metrics();
      expect(m.promotionReason).toBe("fixed_instance");
      expect(m.promotedTo).toBeUndefined();
    });
  });

  it("明示した大きさが昇格先と同じでも、固定として扱う", async () => {
    await runInDO(sandboxStub("promote-fixed-same"), async (inst) => {
      const fake = setup(inst);
      await inst.ensureReady(spec({ instance: "standard-3" }));
      await inst.exec(HEAVY);
      expect(fake.snapshotCalls).toHaveLength(0);
      expect((await inst.metrics()).promotionReason).toBe("fixed_instance");
    });
  });

  it("設定で無効（SANDBOX_HEAVY_INSTANCE が空・未設定・off）なら昇格しない。理由も残さない", async () => {
    for (const raw of ["", "off", "none"]) {
      await runInDO(sandboxStub(`promote-off-${raw || "empty"}`), async (inst) => {
        const fake = setup(inst, { SANDBOX_HEAVY_INSTANCE: raw });
        await inst.ensureReady(spec());
        await inst.exec(HEAVY);
        expect(fake.snapshotCalls, raw).toHaveLength(0);
        const m = await inst.metrics();
        expect(m.promotedTo).toBeUndefined();
        expect(m.promotionReason).toBeUndefined();
      });
    }
    await runInDO(sandboxStub("promote-off-unset"), async (inst) => {
      const fake = setup(inst);
      const { SANDBOX_HEAVY_INSTANCE: _x, ...rest } = inst.env;
      inst.env = rest;
      await inst.ensureReady(spec());
      await inst.exec(HEAVY);
      expect(fake.snapshotCalls).toHaveLength(0);
    });
  });

  it("不正な値（lite など）は無効として扱う", async () => {
    await runInDO(sandboxStub("promote-invalid"), async (inst) => {
      const fake = setup(inst, { SANDBOX_HEAVY_INSTANCE: "lite" });
      await inst.ensureReady(spec());
      await inst.exec(HEAVY);
      expect(fake.snapshotCalls).toHaveLength(0);
    });
  });

  it("すでに昇格先以上の大きさ（既定が standard-4 / 昇格先と同じ）なら昇格しない。理由は already_large", async () => {
    for (const [defaultInstance, heavy] of [
      ["standard-4", "standard-3"],
      ["standard-3", "standard-3"],
    ] as const) {
      await runInDO(sandboxStub(`promote-large-${defaultInstance}`), async (inst) => {
        const fake = setup(inst, {
          SANDBOX_INSTANCE: defaultInstance,
          SANDBOX_HEAVY_INSTANCE: heavy,
        });
        await inst.ensureReady(spec());
        await inst.exec(HEAVY);
        expect(fake.snapshotCalls).toHaveLength(0);
        expect(fake.startCalls).toHaveLength(1);
        expect((await inst.metrics()).promotionReason).toBe("already_large");
      });
    }
  });
});

describe("SandboxDO: 昇格の fail-soft", () => {
  it("snapshotContainer が無いランタイム: 見送って小さいまま続ける。snapshot_unsupported。再試行しない", async () => {
    await runInDO(sandboxStub("promote-unsupported"), async (inst) => {
      const fake = setup(inst);
      fake.snapshotContainer = undefined;
      await inst.ensureReady(spec());
      const { lines } = await capturingWarn(async () => {
        const r = await inst.exec(HEAVY);
        expect(r.exitCode).toBe(0);
      });
      expect(fake.startCalls).toHaveLength(1);
      expect(fake.destroyCalls).toBe(0);
      expect(fake.running).toBe(true);
      const m = await inst.metrics();
      expect(m.promotionReason).toBe("snapshot_unsupported");
      expect(m.promotedTo).toBeUndefined();
      expect(lines.join("\n")).toContain("sandbox_promotion_skipped: snapshot_unsupported");
      // 2 回目の重いコマンドでも試みない
      await inst.exec(HEAVY);
      expect(fake.execLog.filter((a) => a[3] === "rovo-promote-state")).toHaveLength(0);
    });
  });

  it("スナップショットに失敗: 破棄せず小さいまま続ける。snapshot_failed", async () => {
    await runInDO(sandboxStub("promote-snap-fail"), async (inst) => {
      const fake = setup(inst);
      fake.snapshotResult = new Error("snapshot boom");
      await inst.ensureReady(spec());
      const r = await inst.exec(HEAVY);
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
      const r = await inst.exec(HEAVY);
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
      await inst.exec(HEAVY);
      expect(fake.destroyCalls).toBe(0);
      expect((await inst.metrics()).promotionReason).toBe("snapshot_failed");
    });
  });

  it("作業ツリーの状態を読めない: スナップショットを取らずに見送る。state_unreadable", async () => {
    await runInDO(sandboxStub("promote-unreadable"), async (inst) => {
      const fake = setup(inst);
      await inst.ensureReady(spec());
      fake.stateUnreadable = true;
      const r = await inst.exec(HEAVY);
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
      const r = await inst.exec(HEAVY);
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
      // 以降の重いコマンドでも再試行しない
      await inst.exec(HEAVY);
      expect(fake.snapshotCalls).toHaveLength(1);
    });
  });

  it("昇格先で CA 証明書が読めない: 元の大きさで起動し直す。cert_missing", async () => {
    await runInDO(sandboxStub("promote-cert"), async (inst) => {
      const fake = setup(inst);
      fake.noCertFor.add("standard-3");
      await inst.ensureReady(spec());
      const r = await inst.exec(HEAVY);
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
      const r = await inst.exec(HEAVY);
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
      await expect(inst.exec(HEAVY)).rejects.toThrow(/restarted/);
      const last = fake.startCalls.at(-1) as Record<string, unknown>;
      expect(last).toMatchObject({ image: IMAGE });
      expect(last).not.toHaveProperty("containerSnapshot");
      const m = await inst.metrics();
      expect(m.promotionReason).toBe("fallback_failed");
      expect(m.promotedTo).toBeUndefined();
      // 次の操作は普通に動く
      const r = await inst.exec(LIGHT);
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
      const r = await inst.exec(HEAVY);
      expect(r.terminated).toBe(true);
      expect(fake.running).toBe(false);
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
      const heavy = inst.exec(HEAVY);
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
      const r = await inst.exec(HEAVY);
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
      const r = await inst.exec(HEAVY);
      expect(r.terminated).toBe(true);
      expect(fake.running).toBe(false);
      expect(fake.startCalls.filter((c) => c.containerSnapshot)).toHaveLength(1);
      // 元の大きさへの起動し直しもしない
      expect(fake.startCalls.filter((c) => c.instance === "standard-2")).toHaveLength(1);
      expect(inst.status().terminated).toBe(true);
    });
  });
});
