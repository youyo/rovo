// Python の依存の導入（起動時の uv）が、実イメージの /opt/venv に入り、ワーカーの python3 から見えること。
// wrangler dev + 実コンテナ（sandbox-lang.e2e.test.ts と同じ起動）。外向き通信は偽サーバーだけ: pypi.org と
// files.pythonhosted.org は偽 PyPI（test/support/fake-pypi.ts）が答える。docker が要るので手元で実行する。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { WorkspaceSpec } from "../../src/sandbox-port";
import { FAKE_PYPI_LOCK, FAKE_PYPI_REQ } from "../support/fake-pypi";
import { type FakeUpstream, startFakeUpstream } from "../support/fake-upstream";
import { sandboxClient } from "../support/sandbox-client";
import { E2E_TOKEN_ENC_KEY, type RunningWrangler, startWrangler } from "../support/wrangler";

let upstream: FakeUpstream;
let wrangler: RunningWrangler;
let persistDir: string;
let sb: ReturnType<typeof sandboxClient>;

beforeAll(async () => {
  upstream = await startFakeUpstream();
  persistDir = mkdtempSync(join(tmpdir(), "rovo-agent-deps-lang-"));
  wrangler = await startWrangler({
    configs: ["apps/agent/wrangler.jsonc"],
    vars: { ENVIRONMENT: "test", TEST_UPSTREAM: upstream.url, TOKEN_ENC_KEY: E2E_TOKEN_ENC_KEY },
    readyPath: "/",
    persistDir,
  });
  sb = sandboxClient(wrangler.baseUrl, "deps-lang");
  const spec: WorkspaceSpec = {
    repository: "acme/py",
    baseSha: upstream.pySha,
    branch: "agent/task-deps-lang",
    initialSha: upstream.createTaskBranch("py", "deps-lang").initialSha,
    deadlineAt: Date.now() + 3_600_000,
  };
  // 起動の中で installLangDeps が requirements.txt の依存を /opt/venv に入れる
  await sb.ensureReady(spec);
}, 400_000);

afterAll(async () => {
  await sb?.terminate().catch(() => {});
  await wrangler?.stop();
  await upstream?.stop();
  if (persistDir) rmSync(persistDir, { recursive: true, force: true });
});

const run = (argv: string[]) => sb.exec(argv, { cwd: "/workspace", timeoutMs: 120_000 });

describe("Python の依存の導入（実コンテナ・偽 PyPI）", () => {
  it("起動時に requirements.txt の依存が /opt/venv に入り、python3 から import できる。.venv は作られない", async () => {
    const r = await run([
      "bash",
      "-c",
      `python3 -c 'import ${FAKE_PYPI_REQ.module}; print(${FAKE_PYPI_REQ.module}.VALUE)' && test ! -d .venv && echo no-venv`,
    ]);
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdout.trim().split("\n")).toEqual(["1", "no-venv"]);
    // 偽 PyPI まで届いた（外向きの許可の経路で入った）
    expect(upstream.requests.some((x) => x.host === "pypi.org")).toBe(true);
  }, 150_000);

  it("uv lock → uv sync --active --frozen（uv.lock の経路と同じ argv）で /opt/venv に入り、.venv は作られない", async () => {
    const project = [
      "[project]",
      'name = "demo"',
      'version = "0.0.0"',
      'requires-python = ">=3.13"',
      `dependencies = ["${FAKE_PYPI_LOCK.name}==${FAKE_PYPI_LOCK.version}"]`,
    ].join("\\n");
    const w = await run([
      "bash",
      "-c",
      `rm -rf lockdemo && mkdir lockdemo && printf '${project}\\n' > lockdemo/pyproject.toml`,
    ]);
    expect(w.exitCode, w.stderr).toBe(0);
    const inDir = (argv: string[]) =>
      sb.exec(argv, { cwd: "/workspace/lockdemo", timeoutMs: 120_000 });
    const lock = await inDir(["uv", "lock"]);
    expect(lock.exitCode, lock.stderr).toBe(0);
    const sync = await inDir(["uv", "sync", "--active", "--frozen"]);
    expect(sync.exitCode, sync.stderr).toBe(0);
    // 同じ呼び出しの中で import と .venv の不在を確かめる（import が失敗したら通らない）
    const r = await inDir([
      "bash",
      "-c",
      `python3 -c 'import ${FAKE_PYPI_LOCK.module}; print(${FAKE_PYPI_LOCK.module}.VALUE)' && test ! -d .venv && echo no-venv`,
    ]);
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdout.trim().split("\n")).toEqual(["2", "no-venv"]);
    await run(["rm", "-rf", "lockdemo"]);
  }, 300_000);
});
