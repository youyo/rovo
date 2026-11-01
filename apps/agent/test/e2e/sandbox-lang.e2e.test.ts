// Go・Python・mise をイメージに焼いてあること（版は Dockerfile の ARG と一致する）。docker が要るので手元で実行する。
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BASE_ENV } from "../../src/sandbox-env";
import type { WorkspaceSpec } from "../../src/sandbox-port";
import { type FakeUpstream, startFakeUpstream } from "../support/fake-upstream";
import { sandboxClient } from "../support/sandbox-client";
import { E2E_TOKEN_ENC_KEY, type RunningWrangler, startWrangler } from "../support/wrangler";

const dockerfile = readFileSync(new URL("../../Dockerfile", import.meta.url), "utf8");
const GO_VERSION = dockerfile.match(/^ARG GO_VERSION=(\S+)$/m)?.[1] as string;
const MISE_VERSION = dockerfile.match(/^ARG MISE_VERSION=(\S+)$/m)?.[1] as string;

let upstream: FakeUpstream;
let wrangler: RunningWrangler;
let persistDir: string;
let sb: ReturnType<typeof sandboxClient>;

beforeAll(async () => {
  upstream = await startFakeUpstream();
  persistDir = mkdtempSync(join(tmpdir(), "rovo-agent-lang-"));
  wrangler = await startWrangler({
    configs: ["apps/agent/wrangler.jsonc"],
    vars: { ENVIRONMENT: "test", TEST_UPSTREAM: upstream.url, TOKEN_ENC_KEY: E2E_TOKEN_ENC_KEY },
    readyPath: "/",
    persistDir,
  });
  sb = sandboxClient(wrangler.baseUrl, "lang");
  const spec: WorkspaceSpec = {
    repository: "acme/pnpm",
    baseSha: upstream.pnpmSha,
    branch: "agent/task-lang",
    initialSha: upstream.createTaskBranch("pnpm", "lang").initialSha,
    deadlineAt: Date.now() + 3_600_000,
  };
  await sb.ensureReady(spec);
}, 400_000);

afterAll(async () => {
  await sb?.terminate().catch(() => {});
  await wrangler?.stop();
  await upstream?.stop();
  if (persistDir) rmSync(persistDir, { recursive: true, force: true });
});

const run = (argv: string[]) => sb.exec(argv, { cwd: "/workspace", timeoutMs: 120_000 });

describe("Go / Python のイメージ", () => {
  it("Dockerfile の ARG GO_VERSION を読めている", () => {
    expect(GO_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("go version が GO_VERSION と一致する", async () => {
    const r = await run(["go", "version"]);
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdout).toContain(`go${GO_VERSION} `);
  }, 150_000);

  it("python3 / python は 3.13 を指す", async () => {
    for (const cmd of ["python3", "python"]) {
      const r = await run([cmd, "--version"]);
      expect(r.exitCode, r.stderr).toBe(0);
      expect(r.stdout.trim()).toMatch(/^Python 3\.13\.\d+$/);
    }
  }, 150_000);

  it("uv と pip が動く", async () => {
    const uv = await run(["uv", "--version"]);
    expect(uv.exitCode, uv.stderr).toBe(0);
    expect(uv.stdout).toMatch(/^uv \d+\.\d+\.\d+/);
    const pip = await run(["pip", "--version"]);
    expect(pip.exitCode, pip.stderr).toBe(0);
    expect(pip.stdout).toContain("(python 3.13)");
  }, 150_000);

  // bash ツールは port.exec(["bash", "-lc", command]) で流す。ログインシェルは /etc/profile を読み、root の PATH を上書きする
  // （本番で go・python3 が見つからなかった原因）。argv のままの exec では再現しないので、bash -lc で確かめる。
  it("bash -lc（bash ツールと同じ起動）でも go / python3 / pip が見つかり、PATH の先頭が BASE_ENV と同じ", async () => {
    const found = await run(["bash", "-lc", "command -v go python3 pip"]);
    expect(found.exitCode, found.stderr).toBe(0);
    expect(found.stdout.trim().split("\n")).toEqual([
      "/usr/local/go/bin/go",
      "/opt/venv/bin/python3",
      "/opt/venv/bin/pip",
    ]);
    const go = await run(["bash", "-lc", "go version"]);
    expect(go.exitCode, go.stderr).toBe(0);
    expect(go.stdout).toContain(`go${GO_VERSION} `);
    const py = await run(["bash", "-lc", "python3 -c 'import sys; print(sys.prefix)'"]);
    expect(py.exitCode, py.stderr).toBe(0);
    expect(py.stdout.trim()).toBe("/opt/venv");
    const path = await run(["bash", "-lc", "echo $PATH"]);
    expect(path.stdout.trim()).toBe(BASE_ENV.PATH);
  }, 150_000);

  it("Dockerfile の ARG MISE_VERSION を読めている", () => {
    expect(MISE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("mise --version が MISE_VERSION と一致する", async () => {
    const r = await run(["mise", "--version"]);
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdout.trim().split(/\s+/)[0]).toBe(MISE_VERSION);
  }, 150_000);

  it("焼いた版を指す mise.toml で mise run / mise exec が、ダウンロードなしで通る", async () => {
    const dir = "/workspace/.mise-e2e";
    const goMinor = GO_VERSION.split(".").slice(0, 2).join(".");
    const toml = (go: string) =>
      [
        "[tools]",
        'node = "24"',
        `go = "${go}"`,
        'python = "3.13"',
        "",
        "[tasks.hello]",
        'run = "go version && python --version && node --version"',
        "",
      ].join("\n");
    // 一時ディレクトリに置く。許可していないホストへ出ようとすると失敗するので、ダウンロードが起きれば落ちる。
    for (const go of [GO_VERSION, goMinor]) {
      const w = await run([
        "sh",
        "-c",
        `rm -rf ${dir} && mkdir -p ${dir} && printf '%s' '${toml(go)}' > ${dir}/mise.toml`,
      ]);
      expect(w.exitCode, w.stderr).toBe(0);
      const hello = await sb.exec(["mise", "run", "hello"], { cwd: dir, timeoutMs: 120_000 });
      expect(hello.exitCode, hello.stderr).toBe(0);
      expect(hello.stdout).toContain(`go${GO_VERSION} `);
      expect(hello.stdout).toMatch(/Python 3\.13\.\d+/);
      expect(hello.stdout).toMatch(/v24\.\d+\.\d+/);
      const ex = await sb.exec(["mise", "exec", "--", "go", "version"], {
        cwd: dir,
        timeoutMs: 120_000,
      });
      expect(ex.exitCode, ex.stderr).toBe(0);
      expect(ex.stdout).toContain(`go${GO_VERSION} `);
      expect(`${hello.stderr}${ex.stderr}`).not.toMatch(/download/i);
    }
    await run(["rm", "-rf", dir]);
  }, 300_000);

  it("mise 内の python が venv の実体を指し、venv に入れたモジュールを import できる", async () => {
    const dir = "/workspace/.mise-e2e-py";
    // mise は installs/python/<版> -> /opt/venv のリンク経由で起動するので、sys.prefix はリンクのパスになる。
    // 実体（realpath）で比べ、さらに venv の site-packages に置いたモジュールが見えることを確かめる。
    const probe = "rovo_mise_venv_probe";
    const w = await run([
      "sh",
      "-c",
      `rm -rf ${dir} && mkdir -p ${dir} && printf '[tools]\\npython = "3.13"\\n' > ${dir}/mise.toml` +
        ` && echo 'VALUE = 42' > "$(python -c 'import site; print(site.getsitepackages()[0])')/${probe}.py"`,
    ]);
    expect(w.exitCode, w.stderr).toBe(0);
    const code = `import os, sys, ${probe}; print(os.path.realpath(sys.prefix), ${probe}.VALUE)`;
    const inside = await sb.exec(["mise", "exec", "--", "python", "-c", code], {
      cwd: dir,
      timeoutMs: 120_000,
    });
    expect(inside.exitCode, inside.stderr).toBe(0);
    expect(inside.stdout.trim()).toBe("/opt/venv 42");
    const outside = await sb.exec(["python", "-c", code], { cwd: dir, timeoutMs: 120_000 });
    expect(outside.exitCode, outside.stderr).toBe(0);
    expect(outside.stdout.trim()).toBe(inside.stdout.trim());
    const pip = await sb.exec(["mise", "exec", "--", "python", "-m", "pip", "--version"], {
      cwd: dir,
      timeoutMs: 120_000,
    });
    expect(pip.exitCode, pip.stderr).toBe(0);
    await run([
      "sh",
      "-c",
      `rm -rf ${dir} "$(python -c 'import site; print(site.getsitepackages()[0])')/${probe}.py"`,
    ]);
  }, 300_000);

  it("焼いていない版（go 1.24）の mise exec は、待たずにすぐ失敗する", async () => {
    const dir = "/workspace/.mise-e2e-unbaked";
    const w = await run([
      "sh",
      "-c",
      `rm -rf ${dir} && mkdir -p ${dir} && printf '[tools]\\ngo = "1.24"\\n' > ${dir}/mise.toml`,
    ]);
    expect(w.exitCode, w.stderr).toBe(0);
    const started = Date.now();
    const r = await sb.exec(["mise", "exec", "--", "go", "version"], {
      cwd: dir,
      timeoutMs: 60_000,
    });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(r.exitCode).not.toBe(0);
    await run(["rm", "-rf", dir]);
  }, 120_000);
});
