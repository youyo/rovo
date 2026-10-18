import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { WorkspaceSpec } from "../../src/sandbox-port";
import { type FakeUpstream, startFakeUpstream } from "../support/fake-upstream";
import { sandboxClient } from "../support/sandbox-client";
import { E2E_TOKEN_ENC_KEY, type RunningWrangler, startWrangler } from "../support/wrangler";

let upstream: FakeUpstream;
let wrangler: RunningWrangler;
let persistDir: string;
const clients: ReturnType<typeof sandboxClient>[] = [];

/** 作業ブランチはリモートにあらかじめ用意されている（Phase 3 では TaskDO が作る）。偽 GitHub に作ってから spec を返す。 */
const specFor = (task: string, over: Partial<WorkspaceSpec> = {}): WorkspaceSpec => {
  const hasBranch = over.branch === undefined && (over.repository ?? "acme/hello") === "acme/hello";
  return {
    repository: "acme/hello",
    baseSha: upstream.helloSha,
    branch: `agent/task-${task}`,
    initialSha: hasBranch ? upstream.createTaskBranch("hello", task).initialSha : upstream.helloSha,
    deadlineAt: Date.now() + 3_600_000,
    ...over,
  };
};

function client(name: string) {
  const c = sandboxClient(wrangler.baseUrl, name);
  clients.push(c);
  return c;
}

/** 「sleep 7」で始まる名前のプロセスがコンテナに残っていないか（ゾンビは cmdline が空なので数えない）。 */
const leftovers = async (c: ReturnType<typeof sandboxClient>, prefix: string) =>
  (
    await c.exec([
      "bash",
      "-c",
      `for p in /proc/[0-9]*; do c=$(tr '\\0' ' ' < $p/cmdline 2>/dev/null); case "$c" in "${prefix}"*) echo "$c";; esac; done`,
    ])
  ).stdout.trim();

beforeAll(async () => {
  upstream = await startFakeUpstream();
  persistDir = mkdtempSync(join(tmpdir(), "rovo-agent-sbx-"));
  wrangler = await startWrangler({
    configs: ["apps/agent/wrangler.jsonc"],
    vars: { ENVIRONMENT: "test", TEST_UPSTREAM: upstream.url, TOKEN_ENC_KEY: E2E_TOKEN_ENC_KEY },
    readyPath: "/",
    persistDir,
  });
});

afterAll(async () => {
  await Promise.all(clients.map((c) => c.terminate().catch(() => {})));
  await wrangler?.stop();
  await upstream?.stop();
  if (persistDir) rmSync(persistDir, { recursive: true, force: true });
});

describe("ensureReady", () => {
  it("ensureReady より前の exec / readFile / writeFile は拒否される", async () => {
    const c = client("pre");
    await expect(c.exec(["true"])).rejects.toThrow(/not ready|ensureReady/i);
    await expect(c.readFile("/workspace/x")).rejects.toThrow(/not ready|ensureReady/i);
    await expect(c.writeFile("/workspace/x", "y")).rejects.toThrow(/not ready|ensureReady/i);
  });

  it("clone → checkout → 作業ブランチ作成まで行い、2 回目は冪等（コミットも壊さない）", async () => {
    const c = client("ready");
    const spec = specFor("ready");
    await c.ensureReady(spec);
    const head = await c.exec(["git", "rev-parse", "HEAD"], { cwd: "/workspace" });
    expect(head.stdout.trim()).toBe(upstream.helloSha);
    const branch = await c.exec(["git", "rev-parse", "--abbrev-ref", "HEAD"]);
    expect(branch.stdout.trim()).toBe("agent/task-ready");
    expect((await c.readFile("/workspace/README.md")).content).toBe("hello from fake github\n");
    expect(upstream.requests.some((r) => r.host === "github.com")).toBe(true);

    // 作業して commit する
    await c.writeFile("/workspace/new.txt", "work\n");
    await c.exec(["git", "add", "-A"]);
    const ok = await c.exec([
      "git",
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@e",
      "commit",
      "-q",
      "-m",
      "work",
    ]);
    expect(ok.exitCode, ok.stderr).toBe(0);
    const committed = (await c.exec(["git", "rev-parse", "HEAD"])).stdout.trim();

    const githubBefore = upstream.requests.filter((r) => r.host === "github.com").length;
    await c.ensureReady(spec);
    await c.ensureReady(spec);
    expect((await c.exec(["git", "rev-parse", "HEAD"])).stdout.trim()).toBe(committed);
    expect((await c.exec(["git", "rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim()).toBe(
      "agent/task-ready",
    );
    expect(upstream.requests.filter((r) => r.host === "github.com").length).toBe(githubBefore);
  });

  it("別のリポジトリ・不正な SHA・不正なブランチ名の ensureReady は拒否される", async () => {
    const c = client("conflict");
    await c.ensureReady(specFor("conflict"));
    await expect(c.ensureReady(specFor("conflict", { repository: "acme/other" }))).rejects.toThrow(
      /conflict|different/i,
    );
    await expect(c.ensureReady(specFor("conflict", { baseSha: "main" }))).rejects.toThrow(
      /baseSha/,
    );
    const d = client("badbranch");
    await expect(d.ensureReady(specFor("x", { branch: "--upload-pack=x" }))).rejects.toThrow(
      /branch/,
    );
  });

  it("コンテナが落ちた後の最初の操作は、再 clone したことを伝えるエラーになり、その後は使える", async () => {
    const c = client("restart");
    await c.ensureReady(specFor("restart"));
    await c.destroy();
    await expect(c.exec(["true"])).rejects.toThrow(/restart/i);
    expect((await c.exec(["git", "rev-parse", "HEAD"])).stdout.trim()).toBe(upstream.helloSha);
  });
});

describe("外向き通信の制限（clone 対象リポジトリだけ）", () => {
  it("対象以外のリポジトリの clone・info/refs・upload-pack は拒否され、上流に届かない", async () => {
    const c = client("clone-only");
    await c.ensureReady(specFor("clone-only"));
    const before = upstream.requests.length;
    const clone = await c.exec([
      "git",
      "clone",
      "-q",
      "https://github.com/acme/other.git",
      "/tmp/other",
    ]);
    expect(clone.exitCode).not.toBe(0);
    expect(
      (await c.curl("https://github.com/acme/other.git/info/refs?service=git-upload-pack")).code,
    ).toBe("403");
    expect(
      (await c.curl("https://github.com/acme/other.git/git-upload-pack", "-X", "POST", "-d", "x"))
        .code,
    ).toBe("403");
    expect(upstream.requests.slice(before).some((r) => r.path.includes("other"))).toBe(false);
    // 対象リポジトリは通る
    expect(
      (await c.curl("https://github.com/acme/hello.git/info/refs?service=git-upload-pack")).code,
    ).toBe("200");
  });
});

describe("exec", () => {
  it("タイムアウトで子孫プロセス（setsid で抜けたものを含む）まで止まる", async () => {
    const c = client("timeout");
    await c.ensureReady(specFor("timeout"));
    const r = await c.exec(["bash", "-c", "sleep 777 & setsid sleep 778 & wait"], {
      timeoutMs: 3_000,
    });
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).toBe(137);
    // 停止の保証はコンテナの破棄だけ: タイムアウトでコンテナ自体が止まっている
    expect((await c.status()).running).toBe(false);
    // 次の操作は再 clone したことを伝えるエラーになり、その後は新しいコンテナで使える（子孫は残っていない）
    await expect(c.exec(["true"])).rejects.toThrow(/restart/i);
    expect(await leftovers(c, "sleep 77")).toBe("");
  });

  it("タイムアウトで未 commit の変更は失われ、再 clone した作業ツリーで続けられる", async () => {
    const c = client("timeout-lost");
    await c.ensureReady(specFor("timeout-lost"));
    await c.writeFile("/workspace/uncommitted.txt", "work in progress\n");
    const r = await c.exec(["bash", "-c", "sleep 600"], { timeoutMs: 2_000 });
    expect(r.timedOut).toBe(true);
    await expect(c.exec(["true"])).rejects.toThrow(/uncommitted/i);
    expect((await c.exec(["test", "-e", "/workspace/uncommitted.txt"])).exitCode).not.toBe(0);
    expect((await c.exec(["git", "rev-parse", "HEAD"])).stdout.trim()).toBe(upstream.helloSha);
  });

  it("& で残した通常の背景プロセスも、呼び出しが終わると消える", async () => {
    const c = client("bg");
    await c.ensureReady(specFor("bg"));
    const r = await c.exec(["bash", "-c", "sleep 300 & sleep 301 & echo started"]);
    expect(r.stdout.trim()).toBe("started");
    expect(await leftovers(c, "sleep 30")).toBe("");
  });

  it("setsid / nohup で切り離した背景プロセスも消える", async () => {
    const c = client("setsid");
    await c.ensureReady(specFor("setsid"));
    await c.exec([
      "bash",
      "-c",
      "setsid sleep 777 >/dev/null 2>&1 < /dev/null & nohup sleep 778 >/dev/null 2>&1 & echo ok",
    ]);
    expect(await leftovers(c, "sleep 77")).toBe("");
  });

  it("comm に改行と ') Z' を仕込んだプロセスをゾンビ扱いせず、呼び出しが終わると止める（reaper の fail-closed）", async () => {
    const c = client("comm-forge");
    await c.ensureReady(specFor("comm-forge"));
    // サブシェルが自分の comm を "x) Z\nfoo" に書き換える（/proc/<pid>/stat の 1 行目が "N (x) Z" になる）
    // node は 1 回の write で comm を書く（bash の printf は改行で書き込みを分けてしまい、"foo" だけが残る）
    const js = `require("fs").writeFileSync("/proc/self/comm","x) Z\\nfoo");setInterval(()=>{},1000)`;
    const r = await c.exec([
      "bash",
      "-c",
      `node -e '${js}' >/dev/null 2>&1 & sleep 1.5; echo started`,
    ]);
    expect(r.stdout.trim()).toBe("started");
    // 呼び出しの後の reaper が、偽装したプロセスを残さない
    // comm が "x) Z\nfoo" のプロセス（stat に "foo) " を含む）が残っていないこと
    const survivors = await c.exec([
      "bash",
      "-c",
      "grep -l 'foo) ' /proc/[0-9]*/stat 2>/dev/null; true",
    ]);
    expect(survivors.stdout.trim()).toBe("");
  });

  it("偽装の前提の確認: comm に改行と ') Z' を書くと、stat の 1 行目が \"N (x) Z\" で終わる", async () => {
    const c = client("comm-forge-premise");
    await c.ensureReady(specFor("comm-forge-premise"));
    const js = `const fs=require("fs");fs.writeFileSync("/proc/self/comm","x) Z\\nfoo");process.stdout.write(fs.readFileSync("/proc/self/stat","utf8"))`;
    const r = await c.exec(["node", "-e", js]);
    expect(r.stdout.split("\n")[0]).toMatch(/^\d+ \(x\) Z$/);
  });

  it("出力は上限で末尾だけ残し、truncated を立てる", async () => {
    const c = client("output");
    await c.ensureReady(specFor("output"));
    const r = await c.exec(["bash", "-c", "seq 1 200000"], { maxOutputBytes: 1024 });
    expect(r.truncated).toBe(true);
    expect(r.stdout.length).toBeLessThanOrEqual(1024);
    expect(r.stdout.trim().endsWith("200000")).toBe(true);
  });

  it("資格情報らしき文字列はマスクされる", async () => {
    const c = client("mask");
    await c.ensureReady(specFor("mask"));
    const secret = `ghp_${"a".repeat(36)}`;
    const r = await c.exec(["bash", "-c", `echo ${secret}; echo ${secret} >&2`]);
    expect(r.stdout).not.toContain(secret);
    expect(r.stderr).not.toContain(secret);
    expect(r.stdout).toContain("[REDACTED]");
  });

  it("cwd は /workspace 配下だけ", async () => {
    const c = client("cwd");
    await c.ensureReady(specFor("cwd"));
    await expect(c.exec(["pwd"], { cwd: "/etc" })).rejects.toThrow(/outside/);
    await expect(c.exec(["pwd"], { cwd: "/workspace/../etc" })).rejects.toThrow(/outside/);
    expect((await c.exec(["pwd"], { cwd: "/workspace/.git" })).stdout.trim()).toBe(
      "/workspace/.git",
    );
  });

  it("並行して呼んでも exec は 1 つずつ直列に実行される", async () => {
    const c = client("serial");
    await c.ensureReady(specFor("serial"));
    const script = "date +%s%N; sleep 1.5; date +%s%N";
    const [a, b] = await Promise.all([
      c.exec(["bash", "-c", script]),
      c.exec(["bash", "-c", script]),
    ]);
    const span = (r: { stdout: string }) =>
      r.stdout
        .trim()
        .split("\n")
        .map((x) => BigInt(x));
    const [a0, a1] = span(a) as [bigint, bigint];
    const [b0, b1] = span(b) as [bigint, bigint];
    const overlap = a0 < b1 && b0 < a1;
    expect(overlap).toBe(false);
  });

  it("reaper が失敗したらコンテナごと止め、その後は ensureReady で復旧できる", async () => {
    const c = client("reaper-fail");
    const spec = specFor("reaper-fail");
    await c.ensureReady(spec);
    await c.failNextReap();
    await c.exec(["bash", "-c", "echo hi"]);
    expect((await c.status()).running).toBe(false);
    await c.ensureReady(spec);
    expect((await c.status()).running).toBe(true);
    expect((await c.exec(["git", "rev-parse", "HEAD"])).stdout.trim()).toBe(upstream.helloSha);
  });
});

describe("readFile / writeFile のパス検査", () => {
  it("/workspace 配下は読み書きでき、親ディレクトリも作られる", async () => {
    const c = client("files");
    await c.ensureReady(specFor("files"));
    await c.writeFile("/workspace/deep/dir/a.txt", "こんにちは\n");
    expect((await c.readFile("/workspace/deep/dir/a.txt")).content).toBe("こんにちは\n");
    expect((await c.readFile("deep/dir/a.txt")).content).toBe("こんにちは\n");
  });

  it("外に出るパス（絶対・.. ・シンボリックリンク）は拒否される", async () => {
    const c = client("escape");
    await c.ensureReady(specFor("escape"));
    await expect(c.readFile("/etc/passwd")).rejects.toThrow(/outside/);
    await expect(c.readFile("/workspace/../etc/passwd")).rejects.toThrow(/outside/);
    await expect(c.writeFile("/etc/evil", "x")).rejects.toThrow(/outside/);
    await c.exec(["ln", "-s", "/etc", "/workspace/etclink"]);
    await c.exec(["ln", "-s", "/etc/passwd", "/workspace/pwlink"]);
    await expect(c.readFile("/workspace/etclink/passwd")).rejects.toThrow(/outside|symlink/);
    await expect(c.readFile("/workspace/pwlink")).rejects.toThrow(/outside|symlink/);
    await expect(c.writeFile("/workspace/etclink/evil", "x")).rejects.toThrow(/outside|symlink/);
    expect((await c.exec(["test", "-e", "/etc/evil"])).exitCode).not.toBe(0);
  });
});

describe("stop / terminate", () => {
  it("stop は実行中のプロセスを止め、止まったことを確かめて戻る。その後も使える", async () => {
    const c = client("stop");
    await c.ensureReady(specFor("stop"));
    const running = c.exec(["bash", "-c", "sleep 600 & sleep 601 & wait"], { timeoutMs: 600_000 });
    await new Promise((r) => setTimeout(r, 3_000));
    const t0 = Date.now();
    expect(await c.stop()).toEqual({ stopped: true });
    const r = await running;
    expect(Date.now() - t0).toBeLessThan(30_000);
    expect(r.exitCode).not.toBe(0);
    expect(await leftovers(c, "sleep 60")).toBe("");
  });

  it("terminate は永続的に止める。遅れて届いた exec / ensureReady は拒否される", async () => {
    const c = client("terminate");
    const spec = specFor("terminate");
    await c.ensureReady(spec);
    expect(await c.terminate()).toEqual({ stopped: true });
    const st = await c.status();
    expect(st.running).toBe(false);
    expect(st.terminated).toBe(true);
    expect(await c.exec(["true"])).toMatchObject({ exitCode: -1, terminated: true });
    await expect(c.ensureReady(spec)).rejects.toThrow(/terminated/i);
    expect((await c.status()).running).toBe(false);
  });
});

describe("terminate と進行中の boot", () => {
  it("ensureReady の最中に terminate しても、収束した後にコンテナは動いていない", async () => {
    const c = client("boot-terminate");
    const ensure = c.ensureReady(specFor("boot-terminate")).then(
      () => "ok",
      (e: Error) => e.message,
    );
    await new Promise((r) => setTimeout(r, 300));
    expect(await c.terminate()).toEqual({ stopped: true });
    await ensure;
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 1_000));
      const st = await c.status();
      expect(st.running).toBe(false);
      expect(st.terminated).toBe(true);
    }
  });
});

describe("期限", () => {
  it("deadline を過ぎるとコンテナを自分で止め、以後の操作は拒否される", async () => {
    const c = client("deadline");
    const spec = specFor("deadline", { deadlineAt: Date.now() + 40_000 });
    await c.ensureReady(spec);
    expect((await c.status()).running).toBe(true);
    const until = Date.now() + 150_000;
    let st = await c.status();
    while (st.running && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 2_000));
      st = await c.status();
    }
    expect(st.running).toBe(false);
    expect(st.expired).toBe(true);
    await expect(c.exec(["true"])).rejects.toThrow(/deadline/i);
  });

  it("すでに期限を過ぎた spec は ensureReady で拒否される", async () => {
    const c = client("expired");
    await expect(c.ensureReady(specFor("expired", { deadlineAt: Date.now() - 1 }))).rejects.toThrow(
      /deadline/i,
    );
  });
});
