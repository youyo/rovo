import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  DEPS_CACHE_DIR,
  type DepsEnsureRequest,
  type DepsEnsureResult,
  depsCacheKey,
  depsSnapshotName,
} from "../../src/deps-cache";
import { DEPS_FETCH_SCRIPT, DEPS_RESTORE_SCRIPT, DEPS_STASH_SCRIPT } from "../../src/deps-scripts";

// D14（依存関係のキャッシュ）の SandboxDO 側: タスクのコンテナの復元（hit）と、キャッシュを作るコンテナ（builder）。
// vitest 上では ctx.container が無いので maybeContainer を fake に差し替え、DepsCacheDO も fake にする。
// 実コンテナでの検証は E2E（キャッシュが効いたかの実機の確認は docs/specs/acceptance.md）。

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const SHA = "a".repeat(40);
const IMAGE = `registry.cloudflare.com/acct/rovo-agent-sandboxdo-workspace@sha256:${"b".repeat(64)}`;
const CA_CERT = "/etc/cloudflare/certs/cloudflare-containers-ca.crt";

// biome-ignore lint/suspicious/noExplicitAny: private メンバーを差し替えるテスト
type Inst = any;
const runInDO = runInDurableObject as unknown as (
  stub: unknown,
  fn: (inst: Inst) => Promise<void>,
) => Promise<void>;
const sandboxStub = (name: string) => (env.SANDBOX_DO as DurableObjectNamespace).getByName(name);

const deps = {
  repositoryId: 4242,
  lockfilePath: "package-lock.json",
  blobSha: SHA,
  installCommand: "npm ci",
  packageJsonSha: "d".repeat(40),
  workspaceSha: null,
  manifestsSha: null,
};
const NO_DEPS = Symbol("no deps");
const spec = (withDeps: unknown = deps) => ({
  repository: "acme/hello",
  baseSha: SHA,
  initialSha: SHA,
  branch: "agent/task-x",
  deadlineAt: Date.now() + 3_600_000,
  ...(withDeps !== NO_DEPS ? { deps: withDeps } : {}),
});

type Reply = { code?: number; out?: string; hang?: boolean } | undefined;

/** 実際のコンテナに近い fake（スナップショットの作成と、containerSnapshot での起動に対応） */
class FakeContainer {
  running = false;
  startCalls: Record<string, unknown>[] = [];
  destroyCalls = 0;
  images = { workspace: IMAGE };
  intercepts = 0;
  inactivityMs: number[] = [];
  execLog: string[][] = [];
  snapshotCalls: unknown[] = [];
  /** containerSnapshot で start すると同期的に投げる */
  restoreThrows = false;
  /** exec ["test","-r",CA_CERT] の結果 */
  certOk = true;
  /** 追加の応答。undefined なら既定（成功） */
  handler: (argv: string[]) => Reply = () => undefined;
  snapshotResult: { id: string; size: number; name?: string } | Error = {
    id: "snap-built",
    size: 4096,
  };
  /** undefined にすると、snapshotContainer が無いランタイム（wrangler dev など）を模せる */
  snapshotContainer: ((options?: { name?: string }) => Promise<unknown>) | undefined = (o) =>
    this.snap(o);

  start(options: Record<string, unknown>) {
    this.startCalls.push(options);
    if (options.containerSnapshot && this.restoreThrows) throw new Error("restore boom");
    if (options.containerSnapshot && options.image) throw new TypeError("both image and snapshot");
    this.running = true;
  }
  async destroy() {
    this.destroyCalls += 1;
    this.running = false;
  }
  async setInactivityTimeout(ms: number) {
    this.inactivityMs.push(ms);
  }
  async interceptOutboundHttps() {
    this.intercepts += 1;
  }
  async interceptAllOutboundHttp() {}
  async exec(argv: string[], opts?: { signal?: AbortSignal }) {
    this.execLog.push(argv);
    const stream = (t: string) =>
      new ReadableStream<Uint8Array>({
        start(c) {
          if (t) c.enqueue(new TextEncoder().encode(t));
          c.close();
        },
      });
    let reply: Reply = this.handler(argv);
    if (reply === undefined) {
      if (argv[0] === "test" && argv[2] === CA_CERT) reply = { code: this.certOk ? 0 : 1 };
      else if (argv[0] === "bash" && argv[3] === "rovo-baseline") reply = { out: "1:1\n" };
      else if (argv[0] === "git" && argv.includes("rev-parse") && argv.includes("--verify")) {
        reply = { code: 1 }; // 作業ツリーが無い → clone へ
      } else reply = {};
    }
    const exitCode = new Promise<number>((resolve, reject) => {
      if (reply?.hang) {
        opts?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        return;
      }
      resolve(reply?.code ?? 0);
    });
    return { stdout: stream(reply.out ?? ""), stderr: stream(""), exitCode };
  }
  private async snap(options?: { name?: string }) {
    if (options === undefined) throw new TypeError("options is required");
    this.snapshotCalls.push(options);
    if (!this.running) throw new Error("container is not running");
    if (this.snapshotResult instanceof Error) throw this.snapshotResult;
    return { ...this.snapshotResult, ...(options.name ? { name: options.name } : {}) };
  }
  /** 実行した exec の中で、script 定数を使ったもの（argv[2]）の位置 */
  indexOfScript(script: string): number {
    return this.execLog.findIndex((a) => a[0] === "bash" && a[2] === script);
  }
  execArgv(): string {
    return this.execLog.map((a) => a.join(" ")).join("\n");
  }
}

class FakeCache {
  ensureCalls: DepsEnsureRequest[] = [];
  invalidated: string[] = [];
  result: DepsEnsureResult | Error | "hang" = {
    ok: true,
    snapshotId: "snap-1",
    size: 5,
    built: false,
    buildMs: 0,
  };
  async ensure(req: DepsEnsureRequest): Promise<DepsEnsureResult> {
    this.ensureCalls.push(req);
    if (this.result === "hang") return new Promise<never>(() => {});
    if (this.result instanceof Error) throw this.result;
    return this.result;
  }
  async invalidate(id: string) {
    this.invalidated.push(id);
  }
}

function setup(inst: Inst, opts: { enabled?: boolean } = {}) {
  const fake = new FakeContainer();
  const cache = new FakeCache();
  inst.maybeContainer = () => fake;
  inst.depsCacheStub = () => cache;
  if (opts.enabled === false) inst.depsCacheEnabled = () => false;
  return { fake, cache };
}

/** console.warn に出た deps_cache_miss の理由を集める */
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

describe("SandboxDO: 依存関係のキャッシュからの復元", () => {
  it("hit: containerSnapshot で起動し（image は渡さない）、clone の後に node_modules を戻す", async () => {
    await runInDO(sandboxStub("deps-hit"), async (inst) => {
      const { fake, cache } = setup(inst);
      await inst.ensureReady(spec());
      expect(fake.startCalls).toHaveLength(1);
      const start = fake.startCalls[0] as Record<string, unknown>;
      expect(start.containerSnapshot).toEqual({ id: "snap-1" });
      expect(start).not.toHaveProperty("image");
      expect(start).toMatchObject({ enableInternet: false, instance: "standard-2" });
      // 鍵: repository_id + lockfile + blob SHA + 導入のコマンド + イメージの参照
      const key = await depsCacheKey(deps, IMAGE);
      expect(cache.ensureCalls).toEqual([
        {
          key,
          deps,
          repository: "acme/hello",
          baseSha: SHA,
          branch: "agent/task-x",
          taskId: inst.ctx.id.name,
        },
      ]);
      // clone（空の /workspace へ）→ node_modules を戻す の順
      const clone = fake.execLog.findIndex((a) => a[0] === "git" && a[1] === "clone");
      const restore = fake.indexOfScript(DEPS_RESTORE_SCRIPT);
      expect(clone).toBeGreaterThanOrEqual(0);
      expect(restore).toBeGreaterThan(clone);
      expect(fake.execLog[restore]?.slice(3)).toEqual([
        "rovo-deps-restore",
        "/workspace",
        DEPS_CACHE_DIR,
      ]);
      const m = await inst.metrics();
      expect(m).toMatchObject({ depsCache: "hit" });
      expect(m.cacheBuildMs ?? 0).toBe(0);
    });
  });

  it("復元したコンテナで CA 証明書が読めることを確かめてから、先へ進む", async () => {
    await runInDO(sandboxStub("deps-cert-ok"), async (inst) => {
      const { fake } = setup(inst);
      await inst.ensureReady(spec());
      const cert = fake.execLog.findIndex(
        (a) => a[0] === "test" && a[1] === "-r" && a[2] === CA_CERT,
      );
      const clone = fake.execLog.findIndex((a) => a[0] === "git" && a[1] === "clone");
      expect(cert).toBeGreaterThanOrEqual(0);
      expect(cert).toBeLessThan(clone);
    });
  });

  it("built: 作ったタスクは cache_build_ms を Sandbox の時間に足し、deps_cache は built", async () => {
    await runInDO(sandboxStub("deps-built"), async (inst) => {
      const { cache } = setup(inst);
      cache.result = { ok: true, snapshotId: "snap-1", size: 5, built: true, buildMs: 90_000 };
      await inst.ensureReady(spec());
      const m = await inst.metrics();
      expect(m.depsCache).toBe("built");
      expect(m.cacheBuildMs).toBe(90_000);
      expect(m.runtimeMs).toBeGreaterThanOrEqual(90_000);
    });
  });

  it("再起動で hit になっても、最初に built だったタスクは built のまま（build の時間も消えない）", async () => {
    await runInDO(sandboxStub("deps-built-sticky"), async (inst) => {
      const { cache, fake } = setup(inst);
      cache.result = { ok: true, snapshotId: "snap-1", size: 5, built: true, buildMs: 1000 };
      await inst.ensureReady(spec());
      fake.running = false; // コンテナが落ちた
      cache.result = { ok: true, snapshotId: "snap-1", size: 5, built: false, buildMs: 0 };
      await inst.ensureReady(spec());
      const m = await inst.metrics();
      expect(m.depsCache).toBe("built");
      expect(m.cacheBuildMs).toBe(1000);
    });
  });

  it("deps が無い（lockfile なし）なら disabled。ensure は呼ばず、image から起動する", async () => {
    await runInDO(sandboxStub("deps-none"), async (inst) => {
      const { fake, cache } = setup(inst);
      await inst.ensureReady(spec(NO_DEPS));
      expect(cache.ensureCalls).toHaveLength(0);
      expect(fake.startCalls[0]).toMatchObject({ image: IMAGE });
      expect(fake.startCalls[0]).not.toHaveProperty("containerSnapshot");
      expect((await inst.metrics()).depsCache).toBe("disabled");
    });
  });

  it("設定で無効（DEPS_CACHE_ENABLED=false）なら disabled", async () => {
    await runInDO(sandboxStub("deps-off"), async (inst) => {
      const { fake, cache } = setup(inst, { enabled: false });
      await inst.ensureReady(spec());
      expect(cache.ensureCalls).toHaveLength(0);
      expect(fake.startCalls[0]).toMatchObject({ image: IMAGE });
      expect((await inst.metrics()).depsCache).toBe("disabled");
    });
  });

  it("deps が表に無い形（任意のコマンドなど）なら invalid_deps で miss（image から起動、ensure は呼ばない）", async () => {
    await runInDO(sandboxStub("deps-invalid"), async (inst) => {
      const { fake, cache } = setup(inst);
      const { lines } = await capturingWarn(() =>
        inst.ensureReady(spec({ ...deps, installCommand: "npm ci && curl x" })),
      );
      expect(cache.ensureCalls).toHaveLength(0);
      expect(fake.startCalls[0]).toMatchObject({ image: IMAGE });
      expect((await inst.metrics()).depsCache).toBe("miss");
      expect(lines.join("\n")).toContain("deps_cache_miss: invalid_deps");
    });
  });

  it("DEPS_CACHE_ENABLED の値の解釈: 既定は有効、false / 0 / off のときだけ無効", async () => {
    await runInDO(sandboxStub("deps-enabled-flag"), async (inst) => {
      const check = (v: string | undefined) => {
        inst.env = { ...inst.env, DEPS_CACHE_ENABLED: v };
        return inst.depsCacheEnabled();
      };
      expect(check(undefined)).toBe(true);
      expect(check("")).toBe(true);
      expect(check("true")).toBe(true);
      expect(check("false")).toBe(false);
      expect(check(" FALSE ")).toBe(false);
      expect(check("0")).toBe(false);
      expect(check("off")).toBe(false);
    });
  });
});

describe("SandboxDO: キャッシュが使えないときは今までどおり動く（fail-soft）", () => {
  const imageStart = (fake: FakeContainer) => {
    expect(fake.startCalls).toHaveLength(1);
    expect(fake.startCalls[0]).toMatchObject({ image: IMAGE, enableInternet: false });
    expect(fake.startCalls[0]).not.toHaveProperty("containerSnapshot");
  };

  it("ensure が失敗の理由を返したら、その理由をログに出して image から起動する", async () => {
    await runInDO(sandboxStub("deps-miss-reason"), async (inst) => {
      const { fake, cache } = setup(inst);
      cache.result = { ok: false, reason: "build_failed" };
      const { lines } = await capturingWarn(() => inst.ensureReady(spec()));
      imageStart(fake);
      expect(fake.indexOfScript(DEPS_RESTORE_SCRIPT)).toBe(-1);
      expect((await inst.metrics()).depsCache).toBe("miss");
      expect(lines.join("\n")).toContain("deps_cache_miss: build_failed");
    });
  });

  it("ensure が例外を投げても、タスクは失敗せず ensure_failed で image から起動する", async () => {
    await runInDO(sandboxStub("deps-miss-throw"), async (inst) => {
      const { fake, cache } = setup(inst);
      cache.result = new Error("rpc broke");
      const { lines } = await capturingWarn(() => inst.ensureReady(spec()));
      imageStart(fake);
      expect(lines.join("\n")).toContain("deps_cache_miss: ensure_failed");
      expect(lines.join("\n")).not.toContain("rpc broke");
    });
  });

  it("ensure が時間内に返らなければ ensure_timeout で image から起動する", async () => {
    await runInDO(sandboxStub("deps-miss-timeout"), async (inst) => {
      const { fake, cache } = setup(inst);
      cache.result = "hang";
      inst.depsEnsureWaitMs = 200;
      const { lines } = await capturingWarn(() => inst.ensureReady(spec()));
      imageStart(fake);
      expect(lines.join("\n")).toContain("deps_cache_miss: ensure_timeout");
    });
  });

  it("復元の start が例外なら、スナップショットを無効にして image から起動し直す（restore_failed）", async () => {
    await runInDO(sandboxStub("deps-restore-throw"), async (inst) => {
      const { fake, cache } = setup(inst);
      fake.restoreThrows = true;
      const { lines } = await capturingWarn(() => inst.ensureReady(spec()));
      expect(fake.startCalls).toHaveLength(2);
      expect(fake.startCalls[0]).toHaveProperty("containerSnapshot");
      expect(fake.startCalls[1]).toMatchObject({ image: IMAGE });
      expect(fake.startCalls[1]).not.toHaveProperty("containerSnapshot");
      expect(cache.invalidated).toEqual(["snap-1"]);
      expect(lines.join("\n")).toContain("deps_cache_miss: restore_failed");
      expect((await inst.metrics()).depsCache).toBe("miss");
      expect(fake.indexOfScript(DEPS_RESTORE_SCRIPT)).toBe(-1);
    });
  });

  it("復元したコンテナが ready にならなければ、破棄して image から起動し直す（restore_failed）。スナップショットは無効にする", async () => {
    await runInDO(sandboxStub("deps-restore-stall"), async (inst) => {
      const { fake, cache } = setup(inst);
      inst.bootAttemptMs = 300;
      // スナップショットから起動したコンテナだけ、exec が成功しない
      fake.handler = (argv) =>
        argv[0] === "true" && fake.startCalls.at(-1)?.containerSnapshot ? { code: 1 } : undefined;
      const { lines } = await capturingWarn(() => inst.ensureReady(spec()));
      expect(fake.startCalls).toHaveLength(2);
      expect(fake.startCalls[0]).toHaveProperty("containerSnapshot");
      expect(fake.startCalls[1]).toMatchObject({ image: IMAGE });
      expect(fake.startCalls[1]).not.toHaveProperty("containerSnapshot");
      expect(fake.destroyCalls).toBe(1);
      expect(cache.invalidated).toEqual(["snap-1"]);
      expect(lines.join("\n")).toContain("deps_cache_miss: restore_failed");
      expect((await inst.metrics()).depsCache).toBe("miss");
      expect(fake.indexOfScript(DEPS_RESTORE_SCRIPT)).toBe(-1);
      expect(fake.running).toBe(true);
    });
  });

  it("復元の試行は通常の起動の試行（3 回）を消費しない: スナップショットが止まり、image の 2 回も止まっても、3 回目の image で起動できる", async () => {
    await runInDO(sandboxStub("deps-restore-stall-budget"), async (inst) => {
      const { fake } = setup(inst);
      inst.bootAttemptMs = 200;
      // 1 回目（スナップショット）と 2・3 回目（image）は応答しない。4 回目で応答する
      fake.handler = (argv) =>
        argv[0] === "true" && fake.startCalls.length <= 3 ? { code: 1 } : undefined;
      await capturingWarn(() => inst.ensureReady(spec()));
      expect(fake.startCalls).toHaveLength(4);
      expect(fake.running).toBe(true);
    });
  });

  it("CA 証明書が無いコンテナは破棄して image から起動し直す（cert_missing）。スナップショットも無効にする", async () => {
    await runInDO(sandboxStub("deps-cert-missing"), async (inst) => {
      const { fake, cache } = setup(inst);
      // 復元したコンテナ（1 回目）だけ証明書が無い
      let certChecks = 0;
      fake.handler = (argv) => {
        if (argv[0] === "test" && argv[2] === CA_CERT) {
          certChecks += 1;
          return { code: certChecks === 1 ? 1 : 0 };
        }
        return undefined;
      };
      const { lines } = await capturingWarn(() => inst.ensureReady(spec()));
      expect(fake.destroyCalls).toBe(1);
      expect(fake.startCalls).toHaveLength(2);
      expect(fake.startCalls[0]).toHaveProperty("containerSnapshot");
      expect(fake.startCalls[1]).toMatchObject({ image: IMAGE });
      expect(cache.invalidated).toEqual(["snap-1"]);
      expect(lines.join("\n")).toContain("deps_cache_miss: cert_missing");
      expect((await inst.metrics()).depsCache).toBe("miss");
      expect(fake.running).toBe(true);
    });
  });

  it("node_modules を戻すのに失敗しても、タスクは続ける（move_failed。miss として数える）", async () => {
    await runInDO(sandboxStub("deps-move-failed"), async (inst) => {
      const { fake } = setup(inst);
      fake.handler = (argv) =>
        argv[0] === "bash" && argv[2] === DEPS_RESTORE_SCRIPT ? { code: 1 } : undefined;
      const { lines } = await capturingWarn(() => inst.ensureReady(spec()));
      expect(fake.running).toBe(true);
      expect(lines.join("\n")).toContain("deps_cache_miss: move_failed");
      expect((await inst.metrics()).depsCache).toBe("miss");
    });
  });

  it("built だったのに復元できなかったら、built の表示は出さない（miss）が、作った時間は Sandbox の時間に残す", async () => {
    await runInDO(sandboxStub("deps-built-restore-failed"), async (inst) => {
      const { fake, cache } = setup(inst);
      cache.result = { ok: true, snapshotId: "snap-1", size: 5, built: true, buildMs: 5000 };
      fake.restoreThrows = true;
      await capturingWarn(() => inst.ensureReady(spec()));
      const m = await inst.metrics();
      expect(m.depsCache).toBe("miss");
      expect(m.cacheBuildMs).toBe(5000);
      expect(m.runtimeMs).toBeGreaterThanOrEqual(5000);
    });
  });

  it("ensure を待っている間に terminate されたら、start しない", async () => {
    await runInDO(sandboxStub("deps-terminate-during-ensure"), async (inst) => {
      const { fake, cache } = setup(inst);
      cache.result = "hang";
      const ensure = inst.ensureReady(spec()).then(
        () => "ok",
        (e: Error) => e.message,
      );
      await sleep(30);
      await inst.terminate();
      const outcome = await ensure;
      expect(outcome).not.toBe("ok");
      expect(fake.startCalls).toHaveLength(0);
    });
  });

  it("コンテナが既に動いている（DO だけの再起動）なら ensure も復元もしない", async () => {
    await runInDO(sandboxStub("deps-already-running"), async (inst) => {
      const { fake, cache } = setup(inst);
      fake.running = true;
      inst.ctx.storage.kv.put("baseline", ["1:1"]); // 基準プロセスを記録済みの、信用できるコンテナ
      await inst.ensureReady(spec());
      expect(fake.startCalls).toHaveLength(0);
      expect(cache.ensureCalls).toHaveLength(0);
    });
  });
});

describe("SandboxDO: キャッシュを作るコンテナ（buildDepsSnapshot）", () => {
  const buildReq = (over: Record<string, unknown> = {}) => ({
    key: "c".repeat(64),
    deps,
    repository: "acme/hello",
    baseSha: SHA,
    branch: "agent/task-x",
    taskId: "task-x",
    timeoutMs: 5_000,
    ...over,
  });

  it("image で起動し、clone → 導入 → node_modules の退避 → /workspace の削除 → スナップショット → 破棄 の順で行う", async () => {
    await runInDO(sandboxStub("deps-build-ok"), async (inst) => {
      const { fake } = setup(inst);
      const r = await inst.buildDepsSnapshot(buildReq());
      expect(r).toMatchObject({ ok: true, snapshotId: "snap-built", size: 4096 });
      expect(r.buildMs).toBeGreaterThanOrEqual(0);
      // 起動は image から（スナップショットからではない）。外向きは遮断し、傍受を登録する
      expect(fake.startCalls).toHaveLength(1);
      expect(fake.startCalls[0]).toMatchObject({ image: IMAGE, enableInternet: false });
      expect(fake.startCalls[0]).not.toHaveProperty("containerSnapshot");
      expect(fake.intercepts).toBeGreaterThan(0);
      const fetchAt = fake.indexOfScript(DEPS_FETCH_SCRIPT);
      const installAt = fake.execLog.findIndex((a) => a[0] === "npm" && a[1] === "ci");
      const stashAt = fake.indexOfScript(DEPS_STASH_SCRIPT);
      const wipeAt = fake.execLog.findIndex(
        (a) => a[0] === "find" && a[1] === "/workspace" && a.includes("-delete"),
      );
      expect(fetchAt).toBeGreaterThanOrEqual(0);
      expect(installAt).toBeGreaterThan(fetchAt);
      expect(stashAt).toBeGreaterThan(installAt);
      expect(wipeAt).toBeGreaterThan(stashAt);
      // fetch は --depth 1 で base_sha だけ（作業ブランチの内容は入らない）
      expect(fake.execLog[fetchAt]?.slice(3)).toEqual([
        "rovo-deps-fetch",
        "/workspace",
        "https://github.com/acme/hello.git",
        SHA,
      ]);
      expect(fake.execLog[stashAt]?.slice(3)).toEqual([
        "rovo-deps-stash",
        "/workspace",
        DEPS_CACHE_DIR,
      ]);
      // スナップショットは名前つき（オプション必須）で、/workspace を消した後に、実行中のコンテナから取る
      expect(fake.snapshotCalls).toEqual([{ name: depsSnapshotName("c".repeat(64)) }]);
      expect(fake.destroyCalls).toBe(1);
      expect(fake.running).toBe(false);
    });
  });

  it("導入のコマンドは lockfile の表の固定の argv（pnpm は corepack 経由）", async () => {
    await runInDO(sandboxStub("deps-build-pnpm"), async (inst) => {
      const { fake } = setup(inst);
      const pnpm = {
        ...deps,
        lockfilePath: "pnpm-lock.yaml",
        installCommand: "pnpm install --frozen-lockfile",
      };
      const r = await inst.buildDepsSnapshot(buildReq({ deps: pnpm }));
      expect(r.ok).toBe(true);
      expect(fake.execArgv()).toContain("corepack pnpm install --frozen-lockfile");
    });
  });

  it("表に無い deps は実行せず invalid_deps（コンテナも起動しない）", async () => {
    await runInDO(sandboxStub("deps-build-invalid"), async (inst) => {
      const { fake } = setup(inst);
      const r = await inst.buildDepsSnapshot(
        buildReq({ deps: { ...deps, installCommand: "npm ci && curl x" } }),
      );
      expect(r).toEqual({ ok: false, reason: "invalid_deps" });
      expect(fake.startCalls).toHaveLength(0);
    });
  });

  it("clone の段階の失敗は build_failed。スナップショットは取らず、コンテナは破棄する", async () => {
    await runInDO(sandboxStub("deps-build-fetch-fail"), async (inst) => {
      const { fake } = setup(inst);
      fake.handler = (argv) =>
        argv[0] === "bash" && argv[2] === DEPS_FETCH_SCRIPT ? { code: 128 } : undefined;
      const r = await inst.buildDepsSnapshot(buildReq());
      expect(r).toEqual({ ok: false, reason: "build_failed" });
      expect(fake.snapshotCalls).toHaveLength(0);
      expect(fake.destroyCalls).toBe(1);
      expect(fake.running).toBe(false);
    });
  });

  it("導入の失敗は build_failed（スナップショットを取らない）", async () => {
    await runInDO(sandboxStub("deps-build-install-fail"), async (inst) => {
      const { fake } = setup(inst);
      fake.handler = (argv) => (argv[0] === "npm" ? { code: 1 } : undefined);
      const r = await inst.buildDepsSnapshot(buildReq());
      expect(r).toEqual({ ok: false, reason: "build_failed" });
      expect(fake.snapshotCalls).toHaveLength(0);
      expect(fake.destroyCalls).toBe(1);
    });
  });

  it("退避の失敗も build_failed（node_modules を戻せないスナップショットは作らない）", async () => {
    await runInDO(sandboxStub("deps-build-stash-fail"), async (inst) => {
      const { fake } = setup(inst);
      fake.handler = (argv) =>
        argv[0] === "bash" && argv[2] === DEPS_STASH_SCRIPT ? { code: 1 } : undefined;
      expect(await inst.buildDepsSnapshot(buildReq())).toEqual({
        ok: false,
        reason: "build_failed",
      });
      expect(fake.snapshotCalls).toHaveLength(0);
    });
  });

  it("snapshotContainer が使えないランタイムでは、コンテナを起動せず snapshot_unsupported", async () => {
    await runInDO(sandboxStub("deps-build-unsupported"), async (inst) => {
      const { fake } = setup(inst);
      fake.snapshotContainer = undefined;
      expect(await inst.buildDepsSnapshot(buildReq())).toEqual({
        ok: false,
        reason: "snapshot_unsupported",
      });
      expect(fake.startCalls).toHaveLength(0);
    });
  });

  it("snapshotContainer が例外なら snapshot_failed。コンテナは破棄する", async () => {
    await runInDO(sandboxStub("deps-build-snapshot-throws"), async (inst) => {
      const { fake } = setup(inst);
      fake.snapshotResult = new Error("snapshot beta is not enabled");
      expect(await inst.buildDepsSnapshot(buildReq())).toEqual({
        ok: false,
        reason: "snapshot_failed",
      });
      expect(fake.destroyCalls).toBe(1);
      expect(fake.running).toBe(false);
    });
  });

  it("時間切れ: 導入が終わらなければ、残り時間で打ち切って build_timeout。コンテナは破棄する", async () => {
    await runInDO(sandboxStub("deps-build-timeout"), async (inst) => {
      const { fake } = setup(inst);
      fake.handler = (argv) => (argv[0] === "npm" ? { hang: true } : undefined);
      const started = Date.now();
      const r = await inst.buildDepsSnapshot(buildReq({ timeoutMs: 400 }));
      expect(r).toEqual({ ok: false, reason: "build_timeout" });
      expect(Date.now() - started).toBeLessThan(3_000);
      expect(fake.snapshotCalls).toHaveLength(0);
      expect(fake.destroyCalls).toBe(1);
    });
  });

  it("起動したコンテナが応答しなければ build_failed（破棄する）", async () => {
    await runInDO(sandboxStub("deps-build-not-ready"), async (inst) => {
      const { fake } = setup(inst);
      fake.handler = (argv) => (argv[0] === "true" ? { code: 1 } : undefined);
      inst.bootAttemptMs = 300;
      const r = await inst.buildDepsSnapshot(buildReq({ timeoutMs: 2_000 }));
      expect(r.ok).toBe(false);
      expect(fake.snapshotCalls).toHaveLength(0);
      expect(fake.destroyCalls).toBeGreaterThanOrEqual(1);
    });
  });

  it("同じ builder への同時の依頼は 1 回だけ作る", async () => {
    await runInDO(sandboxStub("deps-build-single"), async (inst) => {
      const { fake } = setup(inst);
      const [a, b] = await Promise.all([
        inst.buildDepsSnapshot(buildReq()),
        inst.buildDepsSnapshot(buildReq()),
      ]);
      expect(a).toEqual(b);
      expect(fake.startCalls).toHaveLength(1);
      expect(fake.snapshotCalls).toHaveLength(1);
    });
  });

  it("コンテナ内に渡す環境変数と引数に、トークンなどの資格は入らない（認証は外側の注入だけ）", async () => {
    await runInDO(sandboxStub("deps-build-no-secrets"), async (inst) => {
      const { fake } = setup(inst);
      await inst.buildDepsSnapshot(buildReq());
      const flat = JSON.stringify(fake.startCalls) + fake.execArgv();
      expect(flat).not.toMatch(/x-access-token|ghs_|Bearer|authorization/i);
    });
  });
});
