// Go と Python をイメージに焼いてあること（版は Dockerfile の ARG と一致する）。docker が要るので手元で実行する。
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { WorkspaceSpec } from "../../src/sandbox-port";
import { type FakeUpstream, startFakeUpstream } from "../support/fake-upstream";
import { sandboxClient } from "../support/sandbox-client";
import { E2E_TOKEN_ENC_KEY, type RunningWrangler, startWrangler } from "../support/wrangler";

const dockerfile = readFileSync(new URL("../../Dockerfile", import.meta.url), "utf8");
const GO_VERSION = dockerfile.match(/^ARG GO_VERSION=(\S+)$/m)?.[1] as string;

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
});
