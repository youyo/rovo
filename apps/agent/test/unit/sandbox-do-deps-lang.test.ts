import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

// Python / Go の依存の導入（起動時。作業ツリーの準備と Node の依存の後）。偽のコンテナで exec の argv を記録する。

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

const spec = () => ({
  repository: "acme/hello",
  baseSha: SHA,
  initialSha: SHA,
  branch: "agent/task-x",
  deadlineAt: Date.now() + 3_600_000,
});

type Reply =
  | {
      code?: number;
      out?: string;
      err?: string;
      hang?: boolean;
      /** abort されると、例外ではなくこの終了コードで終わる（SIGKILL された 137 など） */
      abortExit?: number;
    }
  | undefined;

class FakeContainer {
  running = false;
  images = { workspace: IMAGE };
  execLog: string[][] = [];
  rootFiles: string[] = [];
  pyproject = "";
  handler: (argv: string[]) => Reply = () => undefined;
  start() {
    this.running = true;
  }
  async destroy() {
    this.running = false;
  }
  async setInactivityTimeout() {}
  async interceptOutboundHttps() {}
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
      if (argv[0] === "test" && argv[2] === CA_CERT) reply = { code: 0 };
      else if (argv[0] === "bash" && argv[3] === "rovo-baseline") reply = { out: "1:1\n" };
      else if (argv[0] === "git" && argv.includes("rev-parse") && argv.includes("--verify")) {
        reply = { code: 1 };
      } else if (argv[0] === "find" && argv.includes("-printf")) {
        reply = { out: this.rootFiles.map((f) => `${f}\n`).join("") };
      } else if (argv[0] === "cat" && argv[1]?.endsWith("pyproject.toml")) {
        reply = { out: this.pyproject };
      } else reply = {};
    }
    const exitCode = new Promise<number>((resolve, reject) => {
      if (reply?.hang) {
        opts?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        return;
      }
      if (reply?.abortExit !== undefined) {
        const code = reply.abortExit;
        opts?.signal?.addEventListener("abort", () => resolve(code));
        return;
      }
      resolve(reply?.code ?? 0);
    });
    return { stdout: stream(reply.out ?? ""), stderr: stream(reply.err ?? ""), exitCode };
  }
  /** 言語の導入の exec（uv / go） */
  langCalls(): string[][] {
    return this.execLog.filter((a) => a[0] === "uv" || a[0] === "go");
  }
}

function setup(inst: Inst, files: string[], pyproject = "") {
  const fake = new FakeContainer();
  fake.rootFiles = files;
  fake.pyproject = pyproject;
  inst.maybeContainer = () => fake;
  return fake;
}

const boot = async (name: string, files: string[], pyproject = "") => {
  let out: { argv: string[][]; metrics: Inst; fake: FakeContainer } | undefined;
  await runInDO(sandboxStub(name), async (inst) => {
    const fake = setup(inst, files, pyproject);
    await inst.ensureReady(spec());
    out = { argv: fake.langCalls(), metrics: await inst.metrics(), fake };
  });
  if (!out) throw new Error("no result");
  return out;
};

describe("SandboxDO: Python / Go の依存の導入", () => {
  it("uv.lock があれば uv sync --active --frozen（requirements があっても 1 つだけ）", async () => {
    const r = await boot("lang-uvlock", ["uv.lock", "requirements.txt", "pyproject.toml"]);
    expect(r.argv).toEqual([["uv", "sync", "--active", "--frozen"]]);
    expect(r.metrics.depsLang).toEqual([
      {
        kind: "python",
        command: "uv sync --active",
        status: "ok",
        duration_ms: expect.any(Number),
      },
    ]);
  });

  it("requirements: requirements.txt を優先し、dev / test も一緒に。ほかの名前は入れない", async () => {
    const r = await boot("lang-req", [
      "requirements-test.txt",
      "requirements.txt",
      "requirements-dev.txt",
      "requirements-docs.txt",
    ]);
    expect(r.argv).toEqual([
      [
        "uv",
        "pip",
        "install",
        "-r",
        "requirements.txt",
        "-r",
        "requirements-dev.txt",
        "-r",
        "requirements-test.txt",
      ],
    ]);
  });

  it("requirements-docs.txt だけなら何も入れない", async () => {
    const r = await boot("lang-req-other", ["requirements-docs.txt"]);
    expect(r.argv).toEqual([]);
    expect(r.metrics.depsLang).toBeUndefined();
  });

  it("pyproject.toml だけで [project] があれば uv pip install -e .（dev / test の extras つき）", async () => {
    const plain = await boot("lang-pyproj", ["pyproject.toml"], '[project]\nname = "x"\n');
    expect(plain.argv).toEqual([["uv", "pip", "install", "-e", "."]]);
    const extras = await boot(
      "lang-pyproj-extras",
      ["pyproject.toml"],
      '[project]\nname = "x"\n[project.optional-dependencies]\ndev = ["pytest"]\ndocs = ["m"]\ntest = ["t"]\n',
    );
    expect(extras.argv).toEqual([["uv", "pip", "install", "-e", ".[dev,test]"]]);
  });

  it("pyproject.toml に [project] が無ければ入れない（skipped）", async () => {
    const r = await boot("lang-pyproj-tool", ["pyproject.toml"], "[tool.ruff]\nx = 1\n");
    expect(r.argv).toEqual([]);
    expect(r.metrics.depsLang).toMatchObject([{ kind: "python", status: "skipped" }]);
  });

  it("go.mod があれば go mod download（Python と両方あれば両方）", async () => {
    const r = await boot("lang-go", ["go.mod", "uv.lock"]);
    expect(r.argv).toEqual([
      ["uv", "sync", "--active", "--frozen"],
      ["go", "mod", "download"],
    ]);
    expect(r.metrics.depsLang.map((x: { kind: string }) => x.kind)).toEqual(["python", "go"]);
  });

  it("導入は作業ツリーの準備（clone）の後で、ワーカーの前", async () => {
    const r = await boot("lang-order", ["go.mod"]);
    const clone = r.fake.execLog.findIndex((a) => a[0] === "git" && a[1] === "clone");
    const go = r.fake.execLog.findIndex((a) => a[0] === "go");
    expect(clone).toBeGreaterThanOrEqual(0);
    expect(go).toBeGreaterThan(clone);
  });

  it("何も無ければ何もしない", async () => {
    const r = await boot("lang-none", ["README.md", "package.json"]);
    expect(r.argv).toEqual([]);
    expect(r.metrics.depsLang).toBeUndefined();
    expect(r.metrics.depsLangNote).toBeUndefined();
  });

  it("失敗してもタスクは続く: failed と、秘密を伏せた出力の末尾を残す", async () => {
    await runInDO(sandboxStub("lang-fail"), async (inst) => {
      const fake = setup(inst, ["uv.lock"]);
      fake.handler = (argv) =>
        argv[0] === "uv"
          ? { code: 2, err: `${"x".repeat(900)} token ghp_${"A".repeat(36)} no solution found` }
          : undefined;
      await inst.ensureReady(spec()); // 投げない
      const m = await inst.metrics();
      expect(m.depsLang).toMatchObject([{ kind: "python", status: "failed" }]);
      expect(m.depsLangNote).toContain("no solution found");
      expect(m.depsLangNote).toContain("ask_parent");
      expect(m.depsLangNote).not.toContain("ghp_");
      expect(m.depsLangNote.length).toBeLessThan(900);
    });
  });

  it("時間切れ: timeout。タスクは続く", async () => {
    await runInDO(sandboxStub("lang-timeout"), async (inst) => {
      const fake = setup(inst, ["go.mod"]);
      inst.depsLangTimeoutMs = 80;
      fake.handler = (argv) => (argv[0] === "go" ? { hang: true } : undefined);
      await inst.ensureReady(spec());
      const m = await inst.metrics();
      expect(m.depsLang).toMatchObject([
        { kind: "go", command: "go mod download", status: "timeout" },
      ]);
    });
  });

  it("コンテナが生きたまま DO だけ再起動しても入れ直さない。コンテナを作り直したら入れ直す", async () => {
    await runInDO(sandboxStub("lang-restart"), async (inst) => {
      const fake = setup(inst, ["go.mod"]);
      await inst.ensureReady(spec());
      expect(fake.langCalls()).toHaveLength(1);
      inst.readyGen = -1; // DO の再起動を模す（コンテナは生きている）
      await inst.ensureReady(spec());
      expect(fake.langCalls()).toHaveLength(1);
      fake.running = false; // コンテナが落ちて image から作り直し（/opt/venv は空）
      inst.readyGen = -1;
      await inst.ensureReady(spec());
      expect(fake.langCalls()).toHaveLength(2);
    });
  });
  it("Python と Go は 1 つの枠を分け合う: Python が枠を使い切ると、Go は実行せずに timeout にする", async () => {
    await runInDO(sandboxStub("lang-frame"), async (inst) => {
      const fake = setup(inst, ["uv.lock", "go.mod"]);
      inst.depsLangTotalMs = 300; // 枠。各言語の上限（既定 5 分）より短い
      fake.handler = (argv) => (argv[0] === "uv" ? { hang: true } : undefined);
      const t0 = Date.now();
      await inst.ensureReady(spec());
      expect(Date.now() - t0).toBeLessThan(5_000);
      expect(fake.langCalls().map((a) => a[0])).toEqual(["uv"]);
      const m = await inst.metrics();
      expect(m.depsLang).toMatchObject([
        { kind: "python", status: "timeout" },
        { kind: "go", status: "timeout", duration_ms: 0 },
      ]);
    });
  });

  it("各言語の上限は、枠の残りに縮む: Python が速く終わっても、Go の上限は枠の残り", async () => {
    await runInDO(sandboxStub("lang-frame-rest"), async (inst) => {
      const fake = setup(inst, ["uv.lock", "go.mod"]);
      inst.depsLangTotalMs = 600;
      fake.handler = (argv) => (argv[0] === "go" ? { hang: true } : undefined);
      const t0 = Date.now();
      await inst.ensureReady(spec());
      expect(Date.now() - t0).toBeLessThan(5_000);
      const m = await inst.metrics();
      expect(m.depsLang).toMatchObject([
        { kind: "python", status: "ok" },
        { kind: "go", status: "timeout" },
      ]);
      // 上限は枠（600ms）より長くならない
      expect(m.depsLang[1].duration_ms).toBeLessThan(1_500);
    });
  });

  it("タスクの期限 spec.deadlineAt までの残りより長くは待たない（上限は期限までの残りに縮む）", async () => {
    await runInDO(sandboxStub("lang-deadline"), async (inst) => {
      setup(inst, ["uv.lock"]);
      const limits: number[] = [];
      const raw = inst.rawExec.bind(inst);
      inst.rawExec = (argv: string[], opts: { timeoutMs: number }) => {
        if (argv[0] === "uv") limits.push(opts.timeoutMs);
        return raw(argv, opts);
      };
      await inst.ensureReady({ ...spec(), deadlineAt: Date.now() + 90_000 });
      // 既定の上限（5 分）ではなく、期限までの残り（約 90 秒）
      expect(limits).toHaveLength(1);
      expect(limits[0]).toBeLessThanOrEqual(90_000);
      expect(limits[0]).toBeGreaterThan(80_000);
    });
  });

  it("時間切れは abort した事実で判定する: abort されたプロセスが 137 で終わっても timeout", async () => {
    await runInDO(sandboxStub("lang-abort-137"), async (inst) => {
      const fake = setup(inst, ["go.mod"]);
      inst.depsLangTimeoutMs = 80;
      fake.handler = (argv) => (argv[0] === "go" ? { abortExit: 137 } : undefined);
      await inst.ensureReady(spec());
      expect((await inst.metrics()).depsLang).toMatchObject([{ kind: "go", status: "timeout" }]);
    });
  });

  it("自分で 137 や -1 で終わった失敗は failed のまま", async () => {
    await runInDO(sandboxStub("lang-exit-137"), async (inst) => {
      const fake = setup(inst, ["uv.lock", "go.mod"]);
      fake.handler = (argv) =>
        argv[0] === "uv" ? { code: 137 } : argv[0] === "go" ? { code: -1 } : undefined;
      await inst.ensureReady(spec());
      expect((await inst.metrics()).depsLang).toMatchObject([
        { kind: "python", status: "failed" },
        { kind: "go", status: "failed" },
      ]);
    });
  });

  it("失敗の出力の末尾は言語ごとに残す（Python も Go も）。秘密は伏せる", async () => {
    await runInDO(sandboxStub("lang-tails"), async (inst) => {
      const fake = setup(inst, ["uv.lock", "go.mod"]);
      fake.handler = (argv) =>
        argv[0] === "uv"
          ? { code: 2, err: `python-failure token ghp_${"B".repeat(36)}` }
          : argv[0] === "go"
            ? { code: 1, err: "go-failure: module not found" }
            : undefined;
      await inst.ensureReady(spec());
      const note = (await inst.metrics()).depsLangNote as string;
      expect(note).toContain("python-failure");
      expect(note).toContain("go-failure");
      expect(note).not.toContain("ghp_");
    });
  });
});
