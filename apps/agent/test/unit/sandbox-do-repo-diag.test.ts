import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

// 起動時の作業ツリーの診断（.npmrc の registry と mise.toml の go の版）。偽のコンテナでファイルの中身を返す。
// リポジトリ由来の値は、検証したホスト名と固定コードのほかは metrics（= task_result）に出さない。

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
  contents: Record<string, string> = {};
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
      } else if (
        (argv[0] === "cat" || argv[0] === "head") &&
        argv.at(-1)?.startsWith("/workspace/")
      ) {
        const name = (argv.at(-1) ?? "").slice("/workspace/".length);
        reply = name in this.contents ? { out: this.contents[name] } : { code: 1 };
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

function setup(inst: Inst, contents: Record<string, string>) {
  const fake = new FakeContainer();
  fake.rootFiles = Object.keys(contents);
  fake.contents = contents;
  inst.maybeContainer = () => fake;
  return fake;
}

const boot = async (name: string, contents: Record<string, string>) => {
  let m: Inst;
  await runInDO(sandboxStub(name), async (inst) => {
    setup(inst, contents);
    await inst.ensureReady(spec());
    m = await inst.metrics();
  });
  return m;
};

describe("SandboxDO: 作業ツリーの診断（.npmrc / mise.toml）", () => {
  it(".npmrc の許可されていない registry: 警告コード・ホスト名・ワーカーへの文。トークンは出さない", async () => {
    const m = await boot("diag-npmrc", {
      ".npmrc": [
        "registry=https://npm.internal.example.com/",
        "@acme:registry=https://npm.pkg.github.com",
        "//npm.internal.example.com/:_authToken=npm_SUPERSECRETTOKEN",
      ].join("\n"),
      "package.json": "{}",
    });
    expect(m.repoWarnings).toEqual(["npmrc_registry_not_allowed"]);
    expect(m.npmrcRegistryHosts).toEqual(["npm.internal.example.com", "npm.pkg.github.com"]);
    expect(m.repoNote).toMatch(/denied/);
    expect(JSON.stringify(m)).not.toContain("SUPERSECRET");
  });

  it("npm.flatt.tech と registry.npmjs.org は警告しない", async () => {
    const m = await boot("diag-npmrc-ok", {
      ".npmrc": "registry=https://npm.flatt.tech/\n@x:registry=https://registry.npmjs.org/\n",
    });
    expect(m.repoWarnings).toBeUndefined();
    expect(m.npmrcRegistryHosts).toBeUndefined();
    expect(m.repoNote).toBeUndefined();
  });

  it("mise.toml（.mise.toml も）の go が焼いた版と違えば mise_go_version_unavailable", async () => {
    const a = await boot("diag-mise", { "mise.toml": '[tools]\ngo = "1.22.0"\n' });
    expect(a.repoWarnings).toEqual(["mise_go_version_unavailable"]);
    expect(a.repoNote).toMatch(/go version/);
    const b = await boot("diag-mise-dot", { ".mise.toml": "[tools]\ngo = '1.21'\n" });
    expect(b.repoWarnings).toEqual(["mise_go_version_unavailable"]);
  });

  it("mise.toml（.mise.toml も）に取れない backend（asdf: / cargo:）があれば mise_tool_unavailable とツール名", async () => {
    const a = await boot("diag-tool", {
      "mise.toml":
        '[tools]\n"asdf:foo" = "1"\n"cargo:ripgrep" = "14"\nterraform = "1.15.8"\nnode = "24"\n',
    });
    expect(a.repoWarnings).toEqual(["mise_tool_unavailable"]);
    expect(a.miseUnavailableTools).toEqual(["asdf:foo", "cargo:ripgrep"]);
    expect(a.repoNote).toMatch(/command -v/);
    const b = await boot("diag-tool-dot", { ".mise.toml": '[tools]\n"vfox:a/b" = "1"\n' });
    expect(b.repoWarnings).toEqual(["mise_tool_unavailable"]);
    expect(b.miseUnavailableTools).toEqual(["vfox:a/b"]);
  });

  it("go の版違いと asdf: が同時なら両方のコードが順に出る", async () => {
    const m = await boot("diag-both", { "mise.toml": '[tools]\ngo = "1.22"\n"asdf:foo" = "1"\n' });
    expect(m.repoWarnings).toEqual(["mise_go_version_unavailable", "mise_tool_unavailable"]);
  });

  it("node / go / npm: / pipx: と terraform / tflint / aqua: だけなら mise_tool_unavailable は付かない", async () => {
    const m = await boot("diag-tool-ok", {
      "mise.toml":
        '[tools]\nnode = "24"\ngo = "1.26"\n"npm:x" = "1"\n"pipx:y" = "1"\nterraform = "1.15.8"\ntflint = "0.64.0"\n"aqua:a/b" = "1"\n',
    });
    expect(m.repoWarnings).toBeUndefined();
    expect(m.miseUnavailableTools).toBeUndefined();
  });

  it("mise.toml の go が焼いた版（前方一致）なら警告しない", async () => {
    const m = await boot("diag-mise-ok", { "mise.toml": '[tools]\ngo = "1.26"\nnode = "24"\n' });
    expect(m.repoWarnings).toBeUndefined();
  });

  it("不正な値（ホスト名でないもの・巨大な値）は metrics に出ない", async () => {
    const m = await boot("diag-junk", {
      ".npmrc": `registry=https://ok.example.com/\n@a:registry=\${EVIL_TOKEN_VALUE}\n@b:registry=https://${"x".repeat(300)}.example.com/\n`,
      "mise.toml": '[tools]\ngo = "<img src=x> ghp_AAAA"\n',
    });
    expect(m.repoWarnings).toEqual(["npmrc_registry_not_allowed", "mise_go_version_unavailable"]);
    expect(m.npmrcRegistryHosts).toEqual(["ok.example.com"]);
    const json = JSON.stringify({ w: m.repoWarnings, h: m.npmrcRegistryHosts });
    expect(json).not.toContain("EVIL_TOKEN");
    expect(json).not.toContain("ghp_");
    expect(m.repoNote).not.toContain("ghp_");
  });

  it("どちらも無ければ何も付かない", async () => {
    const m = await boot("diag-none", { "package.json": "{}" });
    expect(m.repoWarnings).toBeUndefined();
    expect(m.npmrcRegistryHosts).toBeUndefined();
    expect(m.repoNote).toBeUndefined();
  });
});
