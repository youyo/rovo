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

type Reply = { code?: number; out?: string; err?: string; hang?: boolean } | undefined;

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
});
