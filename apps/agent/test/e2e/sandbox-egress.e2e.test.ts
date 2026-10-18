import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { WorkspaceSpec } from "../../src/sandbox-port";
import { type FakeUpstream, startFakeUpstream } from "../support/fake-upstream";
import { sandboxClient } from "../support/sandbox-client";
import { type RunningWrangler, startWrangler } from "../support/wrangler";

let upstream: FakeUpstream;
let wrangler: RunningWrangler;
let persistDir: string;
let sb: ReturnType<typeof sandboxClient>;
let spec: WorkspaceSpec;

beforeAll(async () => {
  upstream = await startFakeUpstream();
  persistDir = mkdtempSync(join(tmpdir(), "rovo-agent-e2e-"));
  wrangler = await startWrangler({
    configs: ["apps/agent/wrangler.jsonc"],
    vars: { ENVIRONMENT: "test", TEST_UPSTREAM: upstream.url },
    readyPath: "/",
    persistDir,
  });
  sb = sandboxClient(wrangler.baseUrl, "egress");
  spec = {
    repository: "acme/hello",
    baseSha: upstream.helloSha,
    branch: "agent/task-egress",
    deadlineAt: Date.now() + 3_600_000,
  };
  // ensureReady でコンテナを起動し、傍受の設定完了と clone まで待つ
  await sb.ensureReady(spec);
  const r = await sb.exec(["true"]);
  expect(r.exitCode).toBe(0);
});

afterAll(async () => {
  await sb?.terminate().catch(() => {});
  await wrangler?.stop();
  await upstream?.stop();
  if (persistDir) rmSync(persistDir, { recursive: true, force: true });
});

const reachedUpstream = (host: string) => upstream.requests.filter((r) => r.host === host);

describe("許可される通信", () => {
  it("registry.npmjs.org への HTTPS GET が通る", async () => {
    const r = await sb.curl("https://registry.npmjs.org/tiny-pkg");
    expect(r.code).toBe("200");
    expect(reachedUpstream("registry.npmjs.org").length).toBeGreaterThan(0);
  });

  it("github.com の git clone（git-upload-pack）が通り、ファイルが取れる", async () => {
    const clone = await sb.exec([
      "git",
      "clone",
      "-q",
      "https://github.com/acme/hello.git",
      "/workspace/hello",
    ]);
    expect(clone.exitCode, clone.stderr).toBe(0);
    const cat = await sb.exec(["cat", "/workspace/hello/README.md"]);
    expect(cat.stdout).toBe("hello from fake github\n");
  });

  it("npm install（小さな依存 1 つ）が通る", async () => {
    const r = await sb.exec([
      "bash",
      "-c",
      "mkdir -p /workspace/app && cd /workspace/app && npm init -y >/dev/null && npm install --no-audit --no-fund tiny-pkg && node -p \"require('tiny-pkg')\"",
    ]);
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdout.trim().endsWith("tiny")).toBe(true);
  });
});

describe("拒否される通信（上流に届かない）", () => {
  it("非許可ホスト example.com は HTTPS / HTTP とも 403", async () => {
    const before = upstream.requests.length;
    expect((await sb.curl("https://example.com/")).code).toBe("403");
    expect((await sb.curl("http://example.com/")).code).toBe("403");
    expect(upstream.requests.length).toBe(before);
  });

  it("github.com の git-receive-pack（push）は 403。git push も失敗する", async () => {
    expect(
      (await sb.curl("https://github.com/acme/hello.git/info/refs?service=git-receive-pack")).code,
    ).toBe("403");
    const push = await sb.exec([
      "bash",
      "-c",
      "cd /workspace/hello && git -c user.name=t -c user.email=t@e commit -q --allow-empty -m x && git push origin HEAD:refs/heads/x",
    ]);
    expect(push.exitCode).not.toBe(0);
    expect(reachedUpstream("github.com").some((r) => r.path.includes("receive-pack"))).toBe(false);
  });

  it("メタデータ・内部 IP（HTTP）は 403、HTTPS の裸 IP は接続できない", async () => {
    expect((await sb.curl("http://169.254.169.254/latest/meta-data/")).code).toBe("403");
    expect((await sb.curl("http://10.0.0.1/")).code).toBe("403");
    for (const url of ["https://169.254.169.254/", "https://10.0.0.1/"]) {
      const r = await sb.curl(url);
      expect(r.code).toBe("000");
      expect(r.exitCode).not.toBe(0);
    }
  });

  it("コンテナ自身の 127.0.0.1 の別ポート、80/443 以外のポートには出られない", async () => {
    for (const url of [
      "http://127.0.0.1:9999/",
      "http://registry.npmjs.org:8080/",
      "https://registry.npmjs.org:8443/",
      "http://1.1.1.1:81/",
    ]) {
      const r = await sb.curl(url);
      expect(r.code, url).toBe("000");
      expect(r.exitCode, url).not.toBe(0);
    }
  });

  it("IPv6（裸のアドレス）には出られない", async () => {
    for (const url of ["http://[2606:4700:4700::1111]/", "https://[2606:4700:4700::1111]/"]) {
      const r = await sb.curl(url);
      expect(r.code, url).toBe("000");
      expect(r.exitCode, url).not.toBe(0);
    }
  });

  it("許可ホストでも HTTP（平文）は 403", async () => {
    expect((await sb.curl("http://registry.npmjs.org/tiny-pkg")).code).toBe("403");
  });

  it("レジストリへの POST は 403", async () => {
    expect(
      (await sb.curl("https://registry.npmjs.org/tiny-pkg", "-X", "POST", "-d", "x=1")).code,
    ).toBe("403");
  });

  it("CONNECT トンネルは張れない", async () => {
    const r = await sb.curl("https://example.com/", "-x", "http://registry.npmjs.org:80");
    expect(r.code).toBe("000");
    expect(r.exitCode).not.toBe(0);
  });

  it("許可ホストへの WebSocket（Upgrade）は 403", async () => {
    const before = upstream.requests.length;
    const r = await sb.curl(
      "https://registry.npmjs.org/tiny-pkg",
      "-H",
      "Connection: Upgrade",
      "-H",
      "Upgrade: websocket",
    );
    expect(r.code).toBe("403");
    expect(upstream.requests.length).toBe(before);
  });

  it("Host ヘッダを偽装しても、判定と宛先は同じ値（Host 由来の URL）で決まる", async () => {
    // Host: example.com で許可ホストを騙ろうとしても拒否される
    const before = upstream.requests.length;
    const r = await sb.curl("https://registry.npmjs.org/tiny-pkg", "-H", "Host: example.com");
    expect(r.code).toBe("403");
    expect(upstream.requests.length).toBe(before);
  });

  it("--connect-to / --resolve で宛先 IP を変えても、gateway は URL のホストで接続する", async () => {
    const r = await sb.curl(
      "https://example.com/tiny-pkg",
      "--connect-to",
      "example.com:443:registry.npmjs.org:443",
    );
    expect(r.code).toBe("403");
  });
});

describe("OutboundGateway の転送", () => {
  it("Authorization / Cookie は上流に渡さない", async () => {
    upstream.requests.length = 0;
    const r = await sb.curl(
      "https://registry.npmjs.org/tiny-pkg",
      "-H",
      "Authorization: Bearer topsecret",
      "-H",
      "Cookie: sid=abc",
      "-H",
      "X-Custom: leak",
    );
    expect(r.code).toBe("200");
    const req = reachedUpstream("registry.npmjs.org").at(-1);
    expect(req).toBeDefined();
    expect(req?.headers.authorization).toBeUndefined();
    expect(req?.headers.cookie).toBeUndefined();
    expect(req?.headers["x-custom"]).toBeUndefined();
  });

  it("上流の 3xx は gateway が追わず、コンテナへ返す。追従先も判定を通る", async () => {
    const noFollow = await sb.curl("https://registry.npmjs.org/redirect-me");
    expect(noFollow.code).toBe("302");
    const before = upstream.requests.length;
    const follow = await sb.curl("https://registry.npmjs.org/redirect-me", "-L");
    expect(follow.code).toBe("403"); // example.com への追従は拒否
    expect(upstream.requests.slice(before).every((r) => r.host !== "example.com")).toBe(true);
  });
});

describe("プロセス管理", () => {
  it("タイムアウトで子孫プロセスまで止まる", async () => {
    const r = await sb.exec(["bash", "-c", "sleep 777 & sleep 778 & wait"], { timeoutMs: 3_000 });
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).toBe(137);
    const left = await sb.exec([
      "bash",
      "-c",
      `for p in /proc/[0-9]*; do c=$(tr '\\0' ' ' < $p/cmdline 2>/dev/null); case "$c" in "sleep 77"*) echo "$c";; esac; done`,
    ]);
    expect(left.stdout.trim()).toBe("");
  });

  it("出力は上限で末尾だけ残し、truncated を立てる", async () => {
    const r = await sb.exec(["bash", "-c", "seq 1 20000"], { maxOutputBytes: 1024 });
    expect(r.truncated).toBe(true);
    expect(r.stdout.length).toBeLessThanOrEqual(1024);
    expect(r.stdout.trim().endsWith("20000")).toBe(true);
  });

  it("終了コードを返す", async () => {
    expect((await sb.exec(["bash", "-c", "exit 7"])).exitCode).toBe(7);
  });
});

describe("コンテナ再起動後も傍受が効く", () => {
  it("destroy → 再起動後も example.com は 403、許可ホストは通る", async () => {
    await sb.restart(spec);
    expect((await sb.curl("https://example.com/")).code).toBe("403");
    expect((await sb.curl("http://169.254.169.254/")).code).toBe("403");
    expect((await sb.curl("https://registry.npmjs.org/tiny-pkg")).code).toBe("200");
  });

  it("起動直後の並行 exec でも、傍受の設定前に外へ出るものがない", async () => {
    await sb.destroy();
    // コンテナが落ちた状態で並行して操作する。最初の 1 件は「再起動した」エラーになりうるが、
    // 結果が返ったものはすべて 403（傍受の設定前に外へ出るものがない）。
    const results = await Promise.allSettled(
      Array.from({ length: 4 }, () => sb.curl("https://example.com/")),
    );
    const done = results.filter((r) => r.status === "fulfilled");
    expect(done.length).toBeGreaterThan(0);
    expect(done.map((r) => r.value.code).every((c) => c === "403")).toBe(true);
  });
});
