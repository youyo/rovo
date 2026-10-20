// pnpm / yarn の本体を、実行時のダウンロード（Node の fetch。大きな本体は外向き通信の中継越しに落ちる）に頼らず使えること。
// 本番の不具合: pnpm 12 の wrapper が native バイナリ（約 44MB）を初回の実行時に取りに行き、Node 24 の undici が
// `assert(!this.paused)` で落ちた。ここでは偽の registry（取りに来たら 404 / 取れたかは requests に残る）越しに確かめる。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { WorkspaceSpec } from "../../src/sandbox-port";
import {
  BAKED_PNPM_VERSION,
  BAKED_YARN_VERSION,
  FAKE_PNPM_VERSION,
  type FakeUpstream,
  startFakeUpstream,
} from "../support/fake-upstream";
import { sandboxClient } from "../support/sandbox-client";
import { E2E_TOKEN_ENC_KEY, type RunningWrangler, startWrangler } from "../support/wrangler";

let upstream: FakeUpstream;
let wrangler: RunningWrangler;
let persistDir: string;
let sb: ReturnType<typeof sandboxClient>;

/** pnpm の本体（wrapper・native バイナリ）を取りに来たリクエスト */
const pnpmDownloads = () =>
  upstream.requests.filter(
    (r) =>
      r.host === "registry.npmjs.org" &&
      (r.path.startsWith("/pnpm/") || r.path.toLowerCase().startsWith("/@pnpm")),
  );

beforeAll(async () => {
  upstream = await startFakeUpstream();
  persistDir = mkdtempSync(join(tmpdir(), "rovo-agent-pm-"));
  wrangler = await startWrangler({
    configs: ["apps/agent/wrangler.jsonc"],
    vars: { ENVIRONMENT: "test", TEST_UPSTREAM: upstream.url, TOKEN_ENC_KEY: E2E_TOKEN_ENC_KEY },
    readyPath: "/",
    persistDir,
  });
  sb = sandboxClient(wrangler.baseUrl, "pm");
  const spec: WorkspaceSpec = {
    repository: "acme/pnpm",
    baseSha: upstream.pnpmSha,
    branch: "agent/task-pm",
    initialSha: upstream.createTaskBranch("pnpm", "pm").initialSha,
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

describe("pnpm の本体", () => {
  it("イメージに焼き込んだ版は、registry に本体を取りに行かずに動く", async () => {
    expect(BAKED_PNPM_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    upstream.requests.length = 0;
    const r = await sb.exec(["corepack", "pnpm", "--version"], {
      cwd: "/workspace",
      timeoutMs: 120_000,
    });
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe(BAKED_PNPM_VERSION);
    expect(r.stderr).not.toContain("Downloading");
    expect(pnpmDownloads()).toEqual([]);
  }, 150_000);

  it("pnpm のリポジトリで corepack pnpm install --frozen-lockfile が通り、本体は取りに行かない", async () => {
    upstream.requests.length = 0;
    const r = await sb.exec(["corepack", "pnpm", "install", "--frozen-lockfile"], {
      cwd: "/workspace",
      timeoutMs: 120_000,
    });
    expect(r.exitCode, `${r.stdout}\n${r.stderr}`).toBe(0);
    const use = await sb.exec(["node", "-p", "require('tiny-pkg')"], { cwd: "/workspace" });
    expect(use.stdout.trim()).toBe("tiny");
    expect(pnpmDownloads()).toEqual([]);
    // 依存は偽 registry の tarball から入った
    expect(upstream.requests.some((q) => q.path === "/tiny-pkg/-/tiny-pkg-1.0.0.tgz")).toBe(true);
  }, 150_000);

  it("yarn（classic）も、焼き込んだ版は registry に本体を取りに行かずに動く", async () => {
    await sb.writeFile(
      "/workspace/yarnrepo/package.json",
      JSON.stringify({ name: "y", packageManager: `yarn@${BAKED_YARN_VERSION}` }),
    );
    upstream.requests.length = 0;
    const r = await sb.exec(["corepack", "yarn", "--version"], {
      cwd: "/workspace/yarnrepo",
      timeoutMs: 120_000,
    });
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe(BAKED_YARN_VERSION);
    expect(upstream.requests.filter((q) => q.path.startsWith("/yarn"))).toEqual([]);
  }, 150_000);

  it("焼き込んでいない版は、pm-prepare が npm の経路で本体を取って置き、そのあとの実行では取りに行かない", async () => {
    await sb.writeFile(
      "/workspace/other/package.json",
      JSON.stringify({ name: "other", packageManager: `pnpm@${FAKE_PNPM_VERSION}` }),
    );
    upstream.requests.length = 0;
    // 偽の registry は npm の署名を持たないので、corepack の署名の検証だけ外す（本番では外さない）
    const prepared = await sb.exec(
      ["node", "/usr/local/lib/rovo/pm-prepare.mjs", "/workspace/other"],
      { cwd: "/workspace", env: { COREPACK_INTEGRITY_KEYS: "0" }, timeoutMs: 120_000 },
    );
    expect(prepared.exitCode, prepared.stderr).toBe(0);
    // 本体（native バイナリ）は npm の取得（undici の fetch ではない）で来た
    const native = upstream.requests.filter((q) => q.path.includes("/@pnpm/exe.e2e/-/"));
    expect(native.length).toBeGreaterThan(0);
    expect(String(native[0]?.headers["user-agent"])).toMatch(/^npm\//);

    upstream.requests.length = 0;
    const run = await sb.exec(["corepack", "pnpm", "--version"], {
      cwd: "/workspace/other",
      env: { COREPACK_INTEGRITY_KEYS: "0" },
      timeoutMs: 120_000,
    });
    expect(run.exitCode, run.stderr).toBe(0);
    expect(run.stdout.trim()).toBe(`fake-pnpm ${FAKE_PNPM_VERSION}`);
    expect(run.stderr).not.toContain("Downloading");
    expect(pnpmDownloads()).toEqual([]);
  }, 300_000);
});
