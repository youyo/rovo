import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sandboxClient } from "../support/sandbox-client";
import { type RunningWrangler, startWrangler } from "../support/wrangler";

// 実ネットワーク版。公開リポジトリの匿名 clone と npm の GET だけを行う（認証付きアクセス・push はしない）。
let wrangler: RunningWrangler;
let persistDir: string;
let sb: ReturnType<typeof sandboxClient>;

beforeAll(async () => {
  persistDir = mkdtempSync(join(tmpdir(), "rovo-agent-net-"));
  wrangler = await startWrangler({
    configs: ["apps/agent/wrangler.jsonc"],
    vars: { ENVIRONMENT: "test" }, // TEST_UPSTREAM なし = 許可した通信は本物の上流へ出る
    readyPath: "/",
    persistDir,
  });
  sb = sandboxClient(wrangler.baseUrl, "net");
  expect((await sb.exec(["true"])).exitCode).toBe(0);
});

afterAll(async () => {
  await sb?.stop().catch(() => {});
  await wrangler?.stop();
  if (persistDir) rmSync(persistDir, { recursive: true, force: true });
});

describe("実ネットワーク", () => {
  it("registry.npmjs.org への GET が通る", async () => {
    expect((await sb.curl("https://registry.npmjs.org/is-odd")).code).toBe("200");
  });

  it("github.com の公開リポジトリを匿名で clone できる", async () => {
    const r = await sb.exec([
      "git",
      "clone",
      "--depth",
      "1",
      "-q",
      "https://github.com/octocat/Hello-World.git",
      "/workspace/hw",
    ]);
    expect(r.exitCode, r.stderr).toBe(0);
    expect((await sb.exec(["test", "-f", "/workspace/hw/README"])).exitCode).toBe(0);
  });

  it("github.com の git-receive-pack は 403", async () => {
    expect(
      (
        await sb.curl(
          "https://github.com/octocat/Hello-World.git/info/refs?service=git-receive-pack",
        )
      ).code,
    ).toBe("403");
  });

  it("npm install（is-odd）が通る", async () => {
    const r = await sb.exec([
      "bash",
      "-c",
      "mkdir -p /workspace/n && cd /workspace/n && npm init -y >/dev/null && npm install --no-audit --no-fund is-odd && node -p \"require('is-odd')(3)\"",
    ]);
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdout.trim().endsWith("true")).toBe(true);
  });

  it("example.com・メタデータ・内部 IP には出られない", async () => {
    expect((await sb.curl("https://example.com/")).code).toBe("403");
    expect((await sb.curl("http://169.254.169.254/latest/meta-data/")).code).toBe("403");
    expect((await sb.curl("http://10.0.0.1/")).code).toBe("403");
    expect((await sb.curl("http://127.0.0.1:9999/")).code).toBe("000");
  });
});
