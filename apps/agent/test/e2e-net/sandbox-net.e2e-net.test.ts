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
//   - mise が焼いていない node・python の版を、パスで絞った配布元（nodejs.org・python-build-standalone の releases）から取れる。
//     ほかのリポジトリの releases は拒否する。Takumi Guard（npm.flatt.tech）への GET は拒否しない
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

  it("mise は焼いていない node の版（24.21.0）を nodejs.org から取って、mise.toml の mise run で使える", async () => {
    const dir = "/workspace/.mise-net-node";
    const w = await sb.exec([
      "sh",
      "-c",
      `rm -rf ${dir} && mkdir -p ${dir} && printf '[tools]\\nnode = "24.21.0"\\n\\n[tasks.v]\\nrun = "node --version"\\n' > ${dir}/mise.toml`,
    ]);
    expect(w.exitCode, w.stderr).toBe(0);
    const install = await sb.exec(["mise", "install", "node@24.21.0"], {
      cwd: dir,
      timeoutMs: 300_000,
    });
    expect(install.exitCode, install.stderr).toBe(0);
    const r = await sb.exec(["mise", "run", "v"], { cwd: dir, timeoutMs: 120_000 });
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe("v24.21.0");
    await sb.exec(["rm", "-rf", dir]);
  }, 400_000);

  it("mise は焼いていない python の版（3.12）を python-build-standalone の releases から取って使える", async () => {
    const install = await sb.exec(["mise", "install", "python@3.12"], {
      cwd: "/workspace",
      timeoutMs: 300_000,
    });
    expect(install.exitCode, install.stderr).toBe(0);
    const r = await sb.exec(["mise", "exec", "python@3.12", "--", "python", "--version"], {
      cwd: "/workspace",
      timeoutMs: 120_000,
    });
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdout.trim()).toMatch(/^Python 3\.12\.\d+$/);
  }, 400_000);

  it("Takumi Guard（npm.flatt.tech）への GET は、rovo の拒否（outbound request denied）にならない", async () => {
    const r = await sb.exec(["curl", "-sS", "-m", "10", "https://npm.flatt.tech/is-odd"]);
    expect(r.stdout).not.toContain("rovo: outbound request denied");
    const post = await sb.exec([
      "curl",
      "-sS",
      "-m",
      "10",
      "-X",
      "POST",
      "https://npm.flatt.tech/-/npm/v1/security/advisories/bulk",
    ]);
    expect(post.stdout).toContain("rovo: outbound request denied (registry_method)");
  });

  it("許可していない GitHub のリポジトリの releases と、releases の転送先の別のリポジトリのパスは拒否する", async () => {
    const other = await sb.exec([
      "curl",
      "-sS",
      "-m",
      "10",
      "https://github.com/astral-sh/uv/releases/download/0.8.22/uv-x86_64-unknown-linux-gnu.tar.gz",
    ]);
    expect(other.stdout).toContain("rovo: outbound request denied (github_path)");
    expect(
      (
        await sb.curl(
          "https://github.com/astral-sh/uv/releases/download/0.8.22/uv-x86_64-unknown-linux-gnu.tar.gz",
        )
      ).code,
    ).toBe("403");
    expect(
      (
        await sb.curl(
          "https://release-assets.githubusercontent.com/github-production-release-asset/1/x",
        )
      ).code,
    ).toBe("403");
    expect((await sb.curl("https://objects.githubusercontent.com/")).code).toBe("403");
    // 許可した releases のパスは rovo の拒否にならない（存在しない資産なので GitHub 自身が 404 を返す）
    const pbs = await sb.exec([
      "curl",
      "-sS",
      "-m",
      "10",
      "https://github.com/astral-sh/python-build-standalone/releases/download/0/x.tar.gz",
    ]);
    expect(pbs.stdout).not.toContain("rovo: outbound request denied");
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
