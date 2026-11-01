import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sandboxClient } from "../support/sandbox-client";
import { E2E_TOKEN_ENC_KEY, type RunningWrangler, startWrangler } from "../support/wrangler";

// 実ネットワーク版。Phase 3 では github.com への通信にトークンの注入が必須になったので、このテストで確かめるのは
// 「実際のインターネットに対する許可・拒否」だけにする:
//   - registry.npmjs.org への GET / npm install が通る
//   - 許可外のホスト・メタデータ・内部 IP には出られない
//   - github.com への通信は、トークンが無ければ OutboundGateway が 401 で落とす（認証なしの clone は通らない）
// git の clone / push の検証（トークン注入・receive-pack の判定）は偽 git の E2E（e2e/git-push.e2e.test.ts）が担う。
// 実 GitHub への認証付きアクセスと push はしない（トークンを持たない）。
let wrangler: RunningWrangler;
let persistDir: string;
let sb: ReturnType<typeof sandboxClient>;
let sbNoAuth: ReturnType<typeof sandboxClient>;

const SPEC = {
  repository: "octocat/Hello-World",
  baseSha: "7fd1a60b01f91b314f59955a4e4d4e80d8edf11d",
  branch: "agent/task-net",
  initialSha: "7fd1a60b01f91b314f59955a4e4d4e80d8edf11d",
  deadlineAt: Date.now() + 3_600_000,
};

beforeAll(async () => {
  persistDir = mkdtempSync(join(tmpdir(), "rovo-agent-net-"));
  wrangler = await startWrangler({
    configs: ["apps/agent/wrangler.jsonc"],
    // TEST_UPSTREAM なし = 許可した通信は本物の上流へ出る
    vars: { ENVIRONMENT: "test", TOKEN_ENC_KEY: E2E_TOKEN_ENC_KEY },
    readyPath: "/",
    persistDir,
  });
  // 認証なしの clone は失敗するので、ensureReady は作業ツリーの用意で止まる（コンテナは起動し、傍受も登録される）。
  // SandboxDO の ENVIRONMENT=test 限定の経路で空の作業ブランチを仕込み、以降の各テストが exec だけで独立に動けるようにする。
  sb = sandboxClient(wrangler.baseUrl, "net");
  await expect(sb.ensureReady(SPEC, { credential: null })).rejects.toThrow(/git clone failed/);
  await sb.seedWorkspace();
}, 600_000);

afterAll(async () => {
  await sb?.terminate().catch(() => {});
  await sbNoAuth?.terminate().catch(() => {});
  await wrangler?.stop();
  if (persistDir) rmSync(persistDir, { recursive: true, force: true });
});

describe("実ネットワーク", () => {
  it("トークンが無いと、作業ブランチの clone は 401 で失敗する（ensureReady が失敗する）", async () => {
    // 他のテストと独立させるため、専用のサンドボックスで確かめる
    sbNoAuth = sandboxClient(wrangler.baseUrl, "net-noauth");
    await expect(sbNoAuth.ensureReady(SPEC, { credential: null })).rejects.toThrow(
      /git clone failed/,
    );
  });

  it("github.com への認証なしの clone は 401 で落ちる", async () => {
    const r = await sb.exec([
      "git",
      "clone",
      "--depth",
      "1",
      "-q",
      "https://github.com/octocat/Hello-World.git",
      "/workspace/hw",
    ]);
    expect(r.exitCode).not.toBe(0);
    // 401 を受けた git は、資格情報を求めて（対話は無効なので）失敗する
    expect(r.stderr).toMatch(/401|Username|Authentication/i);
    expect((await sb.exec(["test", "-e", "/workspace/hw/README"])).exitCode).not.toBe(0);
  });

  it("github.com の info/refs は、対象リポジトリでもトークンが無ければ 401（upload-pack も receive-pack も）", async () => {
    for (const service of ["git-upload-pack", "git-receive-pack"]) {
      expect(
        (await sb.curl(`https://github.com/octocat/Hello-World.git/info/refs?service=${service}`))
          .code,
        service,
      ).toBe("401");
    }
  });

  it("registry.npmjs.org への GET が通る", async () => {
    expect((await sb.curl("https://registry.npmjs.org/is-odd")).code).toBe("200");
  });

  it("npm install（is-odd）が通る", async () => {
    const r = await sb.exec([
      "bash",
      "-c",
      "mkdir -p /tmp/n && cd /tmp/n && npm init -y >/dev/null && npm install --no-audit --no-fund is-odd && node -p \"require('is-odd')(3)\"",
    ]);
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdout.trim().endsWith("true")).toBe(true);
  });

  it("Go のモジュールを取れる（zip は proxy.golang.org から storage.googleapis.com の限定バケットへ 302 で転送される）", async () => {
    const r = await sb.exec([
      "bash",
      "-c",
      "mkdir -p /tmp/g && cd /tmp/g && go mod init example.com/m && go get golang.org/x/text@v0.14.0 && go mod download -x golang.org/x/text && ls $(go env GOMODCACHE)/golang.org/x/text@v0.14.0/go.mod",
    ]);
    expect(r.exitCode, r.stderr).toBe(0);
  }, 300_000);

  it("storage.googleapis.com の Go のバケットへの GET は、rovo の拒否（outbound request denied）にならない", async () => {
    // 存在しないオブジェクトなので Google 自身が 403 / 404 を返す。区別は本文で行う
    const r = await sb.exec([
      "curl",
      "-sS",
      "-m",
      "10",
      "https://storage.googleapis.com/proxy-golang-org-prod/x.zip",
    ]);
    expect(r.stdout).not.toContain("rovo: outbound request denied");
    const other = await sb.exec([
      "curl",
      "-sS",
      "-m",
      "10",
      "https://storage.googleapis.com/other-bucket/x.zip",
    ]);
    expect(other.stdout).toContain("rovo: outbound request denied (host_not_allowed)");
  });

  it("storage.googleapis.com は Go のモジュールのバケット以外へは出られない", async () => {
    expect((await sb.curl("https://storage.googleapis.com/other-bucket/x.zip")).code).toBe("403");
    expect((await sb.curl("https://storage.googleapis.com/")).code).toBe("403");
  });

  it("許可外のホスト・別リポジトリ・メタデータ・内部 IP には出られない", async () => {
    expect((await sb.curl("https://example.com/")).code).toBe("403");
    expect(
      (await sb.curl("https://github.com/torvalds/linux.git/info/refs?service=git-upload-pack"))
        .code,
    ).toBe("403");
    expect((await sb.curl("http://169.254.169.254/latest/meta-data/")).code).toBe("403");
    expect((await sb.curl("http://10.0.0.1/")).code).toBe("403");
    expect((await sb.curl("http://127.0.0.1:9999/")).code).toBe("000");
  });
});
