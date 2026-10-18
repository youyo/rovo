import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TaskSpec } from "../../src/agent/types";
import type { ScriptStep } from "../../src/pi/scripted-provider";
import { agentClient } from "../support/agent-client";
import { type FakeUpstream, startFakeUpstream, TEST_GIT_TOKEN } from "../support/fake-upstream";
import { sandboxClient } from "../support/sandbox-client";
import { E2E_TOKEN_ENC_KEY, type RunningWrangler, startWrangler } from "../support/wrangler";

// Phase 3 の push（M2）。偽 GitHub（git http-backend + receive-pack 有効 + トークン検証）と実コンテナで確かめる。
let upstream: FakeUpstream;
let wrangler: RunningWrangler;
let persistDir: string;
const sandboxes: ReturnType<typeof sandboxClient>[] = [];

beforeAll(async () => {
  upstream = await startFakeUpstream();
  persistDir = mkdtempSync(join(tmpdir(), "rovo-agent-push-"));
  wrangler = await startWrangler({
    configs: ["apps/agent/wrangler.jsonc"],
    vars: { ENVIRONMENT: "test", TEST_UPSTREAM: upstream.url, TOKEN_ENC_KEY: E2E_TOKEN_ENC_KEY },
    readyPath: "/",
    persistDir,
  });
});

afterAll(async () => {
  upstream.expectedToken = TEST_GIT_TOKEN;
  await Promise.all(sandboxes.map((c) => c.terminate().catch(() => {})));
  await wrangler?.stop();
  await upstream?.stop();
  if (persistDir) rmSync(persistDir, { recursive: true, force: true });
});

const tool = (name: string, args: Record<string, string | number | boolean>): ScriptStep => ({
  toolCall: { name, arguments: args },
});
const FIX = tool("edit_file", { path: "calc.js", old_string: "a - b", new_string: "a + b" });
const ref = (task: string) => `refs/heads/agent/task-${task}`;
const receivePackPosts = () =>
  upstream.requests.filter((r) => r.method === "POST" && r.path.includes("git-receive-pack"));
const GIT_ID = ["-c", "user.name=t", "-c", "user.email=t@e"];
const bash = (c: ReturnType<typeof sandboxClient>, script: string) =>
  c.exec(["bash", "-c", script], { timeoutMs: 120_000 });

// ---- Sandbox 単体（bash から見える git の振る舞い。proxy の保証の範囲）----

/** 偽 GitHub に作業ブランチを用意し、トークン付きで ensureReady したコンテナを返す。 */
async function sandboxTask(task: string) {
  const c = sandboxClient(wrangler.baseUrl, task);
  sandboxes.push(c);
  const { branch, initialSha } = upstream.createTaskBranch("hello", task);
  const spec = {
    repository: "acme/hello",
    baseSha: upstream.helloSha,
    branch,
    initialSha,
    deadlineAt: Date.now() + 3_600_000,
  };
  await c.ensureReady(spec);
  return { c, spec, branch };
}

describe("作業ブランチへの push（proxy の許可と拒否）", () => {
  it("作業ブランチの先頭から clone され、bash からの git push が通り、トークン付きで上流に届く", async () => {
    const { c } = await sandboxTask("pg");
    const head = (await c.exec(["git", "rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
    expect(head).toBe("agent/task-pg");
    upstream.requests.length = 0;
    await c.writeFile("/workspace/a.txt", "a\n");
    const r = await bash(
      c,
      `cd /workspace && git add -A && git ${GIT_ID.join(" ")} commit -q -m a && git push origin HEAD:${ref("pg")}`,
    );
    expect(r.exitCode, r.stderr).toBe(0);
    const local = (await c.exec(["git", "rev-parse", "HEAD"])).stdout.trim();
    expect(upstream.refSha("hello", ref("pg"))).toBe(local);
    // 上流に届いた receive-pack の通信は、すべて Worker が付けたトークンを持つ
    const expected = `Basic ${Buffer.from(`x-access-token:${TEST_GIT_TOKEN}`).toString("base64")}`;
    const rp = upstream.requests.filter((q) => q.path.includes("git-receive-pack"));
    expect(rp.length).toBeGreaterThanOrEqual(2); // info/refs の GET と本文の POST
    expect(rp.every((q) => q.headers.authorization === expected)).toBe(true);
    expect(rp.some((q) => q.method === "POST")).toBe(true);
    // gzip と protocol v2 のヘッダは receive-pack では転送されない
    expect(rp.every((q) => q.headers["git-protocol"] === undefined)).toBe(true);
    expect(rp.every((q) => q.headers["content-encoding"] === undefined)).toBe(true);
  });

  it("トークンはコンテナに入らない（環境変数・設定ファイル・作業ツリーのどこにも無い）", async () => {
    const { c } = await sandboxTask("tok-hidden");
    await bash(c, "cd /workspace && git ls-remote origin >/dev/null");
    const env = await c.exec([
      "bash",
      "-c",
      "env; cat /root/.gitconfig /workspace/.git/config 2>/dev/null; true",
    ]);
    expect(env.stdout).not.toContain(TEST_GIT_TOKEN);
    const grep = await c.exec([
      "bash",
      "-c",
      `grep -rIlF -- '${TEST_GIT_TOKEN}' /workspace /root /etc /tmp /home 2>/dev/null; true`,
    ]);
    expect(grep.stdout.trim()).toBe("");
  });

  it("別ブランチ・別タスクのブランチ・タグ・削除・複数 ref・push-options・別リポジトリへの push は拒否される", async () => {
    const { c } = await sandboxTask("deny");
    await c.writeFile("/workspace/b.txt", "b\n");
    await bash(c, `cd /workspace && git add -A && git ${GIT_ID.join(" ")} commit -q -m b`);
    const before = receivePackPosts().length;
    const mine = upstream.refSha("hello", ref("deny"));
    const attempts: [string, string][] = [
      ["別ブランチ", "git push origin HEAD:refs/heads/other"],
      ["main", "git push origin HEAD:refs/heads/main"],
      ["別タスクのブランチ", `git push origin HEAD:${ref("someone-else")}`],
      ["タグ", "git push origin HEAD:refs/tags/v1"],
      ["削除", `git push origin :${ref("deny")}`],
      ["複数 ref", `git push origin HEAD:${ref("deny")} HEAD:refs/heads/foo`],
      ["push-options", `git push --push-option=x origin HEAD:${ref("deny")}`],
      ["別リポジトリ", `git push https://github.com/acme/calc.git HEAD:${ref("deny")}`],
    ];
    for (const [name, cmd] of attempts) {
      const r = await bash(c, `cd /workspace && ${cmd}`);
      expect(r.exitCode, `${name}: ${r.stderr}`).not.toBe(0);
    }
    // 上流には receive-pack の本文が 1 つも届いていない。ref は動いていない
    expect(receivePackPosts().length).toBe(before);
    expect(upstream.refSha("hello", ref("deny"))).toBe(mine);
    for (const r of [
      "refs/heads/other",
      "refs/heads/main",
      ref("someone-else"),
      "refs/tags/v1",
      "refs/heads/foo",
    ]) {
      if (r === "refs/heads/main") expect(upstream.refSha("hello", r)).toBe(upstream.helloSha);
      else expect(upstream.refSha("hello", r), r).toBeUndefined();
    }
    expect(upstream.refSha("calc", ref("deny"))).toBeUndefined();
  });

  it("【保証の範囲外】履歴を書き換えた force push は proxy では止められない（完了時に信頼できる側が正す）", async () => {
    const { c } = await sandboxTask("force");
    const git = (s: string) => bash(c, `cd /workspace && ${s}`);
    await c.writeFile("/workspace/one.txt", "1\n");
    await git(
      `git add -A && git ${GIT_ID.join(" ")} commit -q -m one && git push origin HEAD:${ref("force")}`,
    );
    const one = upstream.refSha("hello", ref("force"));
    await git("git reset -q --hard HEAD~1");
    await c.writeFile("/workspace/two.txt", "2\n");
    const r = await git(
      `git add -A && git ${GIT_ID.join(" ")} commit -q -m two && git push --force origin HEAD:${ref("force")}`,
    );
    expect(r.exitCode, r.stderr).toBe(0);
    const two = (await c.exec(["git", "rev-parse", "HEAD"])).stdout.trim();
    expect(upstream.refSha("hello", ref("force"))).toBe(two);
    expect(two).not.toBe(one);
  });

  it("コンテナを作り直しても、最後に push した commit から再開できる（push していない commit は失われる）", async () => {
    const { c } = await sandboxTask("resume");
    const git = (s: string) => bash(c, `cd /workspace && ${s}`);
    await c.writeFile("/workspace/pushed.txt", "p\n");
    await git(
      `git add -A && git ${GIT_ID.join(" ")} commit -q -m pushed && git push origin HEAD:${ref("resume")}`,
    );
    const pushed = upstream.refSha("hello", ref("resume")) ?? "";
    expect(pushed).toMatch(/^[0-9a-f]{40}$/);
    await c.writeFile("/workspace/local.txt", "l\n");
    await git(`git add -A && git ${GIT_ID.join(" ")} commit -q -m local-only`);
    await c.destroy();
    const first = await c.exec(["true"]).then(
      () => "ok",
      (e: Error) => e.message,
    );
    expect(first).toMatch(/restart/i);
    expect(first).toMatch(/last pushed checkpoint/);
    expect((await c.exec(["git", "rev-parse", "HEAD"])).stdout.trim()).toBe(pushed);
    expect((await c.exec(["test", "-e", "/workspace/pushed.txt"])).exitCode).toBe(0);
    expect((await c.exec(["test", "-e", "/workspace/local.txt"])).exitCode).not.toBe(0);
    expect((await c.exec(["git", "rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim()).toBe(
      "agent/task-resume",
    );
  });

  it("作業ブランチが base_sha を含まないときは ensureReady が失敗する（fail-closed）", async () => {
    const task = "no-base";
    const c = sandboxClient(wrangler.baseUrl, task);
    sandboxes.push(c);
    const { branch, initialSha } = upstream.createTaskBranch("hello", task);
    // base_sha を、ブランチの祖先ではない別の commit にする（calc の先頭は hello の履歴に無い）
    await expect(
      c.ensureReady({
        repository: "acme/hello",
        baseSha: upstream.calcSha,
        branch,
        initialSha,
        deadlineAt: Date.now() + 3_600_000,
      }),
    ).rejects.toThrow(/base/i);
  });
});

describe("認証（トークンの注入と失敗）", () => {
  const specOf = (task: string) => {
    const { branch, initialSha } = upstream.createTaskBranch("hello", task);
    return {
      repository: "acme/hello",
      baseSha: upstream.helloSha,
      branch,
      initialSha,
      deadlineAt: Date.now() + 3_600_000,
    };
  };

  it("トークンが無ければ 401 で、clone は上流に届かず失敗する", async () => {
    const c = sandboxClient(wrangler.baseUrl, "no-token");
    sandboxes.push(c);
    const before = upstream.requests.length;
    await expect(c.ensureReady(specOf("no-token"), { credential: null })).rejects.toThrow(
      /401|clone/i,
    );
    expect(upstream.requests.length).toBe(before);
  });

  it("期限切れのトークンも 401。上流には届かない", async () => {
    const c = sandboxClient(wrangler.baseUrl, "expired-token");
    sandboxes.push(c);
    const before = upstream.requests.length;
    await expect(
      c.ensureReady(specOf("expired-token"), {
        credential: { token: TEST_GIT_TOKEN, expiresAt: Date.now() - 1000 },
      }),
    ).rejects.toThrow(/401|clone/i);
    expect(upstream.requests.length).toBe(before);
  });

  it("上流が受け付けないトークンなら、上流の 401 がそのまま返って失敗する", async () => {
    const c = sandboxClient(wrangler.baseUrl, "wrong-token");
    sandboxes.push(c);
    await expect(
      c.ensureReady(specOf("wrong-token"), {
        credential: { token: "ghs_wrong", expiresAt: Date.now() + 3_600_000 },
      }),
    ).rejects.toThrow(/401|clone/i);
    expect(
      upstream.requests.some(
        (r) => r.host === "github.com" && r.headers.authorization !== undefined,
      ),
    ).toBe(true);
  });

  it("トークンを更新（setGitCredential）すると、コンテナの再起動なしで以後の通信に使われる", async () => {
    const { c } = await sandboxTask("rotate");
    expect(
      (await c.curl("https://github.com/acme/hello.git/info/refs?service=git-upload-pack")).code,
    ).toBe("200");
    upstream.expectedToken = "ghs_rotated";
    try {
      expect(
        (await c.curl("https://github.com/acme/hello.git/info/refs?service=git-upload-pack")).code,
      ).toBe("401");
      await c.setGitCredential({ token: "ghs_rotated", expiresAt: Date.now() + 2 * 3_600_000 });
      expect(
        (await c.curl("https://github.com/acme/hello.git/info/refs?service=git-upload-pack")).code,
      ).toBe("200");
      // 古い期限のトークンの再送は無視される
      await c.setGitCredential({ token: TEST_GIT_TOKEN, expiresAt: Date.now() + 1000 });
      expect(
        (await c.curl("https://github.com/acme/hello.git/info/refs?service=git-upload-pack")).code,
      ).toBe("200");
    } finally {
      upstream.expectedToken = TEST_GIT_TOKEN;
    }
  });

  it("terminate するとトークンが消え、以後の通信は 401 になる", async () => {
    const { c } = await sandboxTask("revoke");
    expect(
      (await c.curl("https://github.com/acme/hello.git/info/refs?service=git-upload-pack")).code,
    ).toBe("200");
    await c.terminate();
    await expect(
      c.setGitCredential({ token: "x", expiresAt: Date.now() + 9_999_999 }),
    ).rejects.toThrow(/terminated/);
  });
});

// ---- AgentDO を通した通し（git_commit の push・完了時の同期）----

function spec(task: string, over: Partial<TaskSpec> = {}): TaskSpec {
  const { branch, initialSha } = upstream.createTaskBranch("calc", task, { initialCommit: true });
  return {
    taskId: task,
    userId: "user-e2e",
    repository: "acme/calc",
    baseSha: upstream.calcSha,
    branch,
    initialSha,
    gitCredential: { token: TEST_GIT_TOKEN, expiresAt: Date.now() + 60 * 60 * 1000 },
    instructions: `scenario:${task}`,
    acceptanceCriteria: ["npm test が通る"],
    verificationCommands: [{ argv: ["npm", "test"], timeoutSeconds: 120 }],
    constraints: [],
    budgetUsd: 10,
    deadlineAt: Date.now() + 60 * 60 * 1000,
    ...over,
  };
}

async function runTask(task: string, script: ScriptStep[], over: Partial<TaskSpec> = {}) {
  const agent = agentClient(wrangler.baseUrl, task);
  const sandbox = sandboxClient(wrangler.baseUrl, task);
  sandboxes.push(sandbox);
  const s = spec(task, over);
  await agent.setScript(s.instructions, script);
  expect(await agent.start(s)).toMatchObject({ status: "accepted" });
  return { agent, sandbox, spec: s };
}

describe("AgentDO: git_commit のたびの push と、完了時の同期", () => {
  it("commit が作業ブランチに push され、完了でブランチが検証済みの SHA になる", async () => {
    const { agent, spec: s } = await runTask("flow", [
      FIX,
      tool("git_commit", { message: "fix: correct add" }),
      tool("report_completion", { summary: "done" }),
    ]);
    expect(await agent.waitForTerminal()).toBe("completed");
    const r = await agent.getResult();
    if (r.status === "not_ready" || r.status !== "completed")
      throw new Error(`unexpected ${r.status}`);
    const sha = r.verification.commitSha;
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(r.pushedSha).toBe(sha);
    expect(upstream.refSha("calc", ref("flow"))).toBe(sha);
    expect(upstream.hasObject("calc", sha ?? "")).toBe(true);
    expect(r.warnings.filter((w) => /push/i.test(w))).toEqual([]);
    const events = await agent.allEvents();
    const pushed = events.filter((e) => e.type === "pushed");
    expect(pushed.map((e) => [e.data.sha, e.data.final === true])).toEqual([
      [sha, false],
      [sha, true],
    ]);
    expect(events.filter((e) => e.type === "push_failed")).toEqual([]);
    expect(s.initialSha).not.toBe(sha);
    // 完了の phase イベントは最後
    expect(events[events.length - 1]).toMatchObject({
      type: "phase",
      data: { phase: "completed" },
    });
  });

  it("bash で履歴を差し替えて force push しても、完了時に検証済みの SHA へ揃う", async () => {
    const task = "force-fix";
    const s0 = spec(task);
    const evil = [
      `git checkout -q --detach ${s0.initialSha}`,
      "echo evil > evil.txt",
      "git add -A",
      `git ${GIT_ID.join(" ")} commit -q -m evil`,
      `git push -q --force origin HEAD:${ref(task)}`,
      `git checkout -q agent/task-${task}`,
    ].join(" && ");
    const agent = agentClient(wrangler.baseUrl, task);
    const sandbox = sandboxClient(wrangler.baseUrl, task);
    sandboxes.push(sandbox);
    await agent.setScript(s0.instructions, [
      FIX,
      tool("git_commit", { message: "fix: correct add" }),
      tool("bash", { command: evil }),
      tool("report_completion", { summary: "done" }),
    ]);
    await agent.start(s0);
    expect(await agent.waitForTerminal()).toBe("completed");
    const r = await agent.getResult();
    if (r.status !== "completed") throw new Error(`unexpected ${r.status}`);
    const sha = r.verification.commitSha;
    // 途中でリモートは別の履歴（evil）になったが、完了時に検証済みの SHA へ戻っている
    const bashEnd = (await agent.allEvents()).find(
      (e) => e.type === "tool_end" && e.data.name === "bash",
    );
    expect(bashEnd?.data.isError, JSON.stringify(bashEnd)).toBe(false);
    expect(upstream.refSha("calc", ref(task))).toBe(sha);
    expect(r.pushedSha).toBe(sha);
  });

  it("push が拒否されても git_commit は成功のまま（push_failed イベント）。完了時の同期も失敗なら警告つきで completed", async () => {
    const task = "push-denied";
    // 偽 GitHub 側で作業ブランチを消しておく: 作業ブランチが無いので clone 自体ができない → 代わりにトークンを途中で無効にする
    const s0 = spec(task);
    const agent = agentClient(wrangler.baseUrl, task);
    const sandbox = sandboxClient(wrangler.baseUrl, task);
    sandboxes.push(sandbox);
    await agent.setScript(s0.instructions, [
      FIX,
      // clone と最初の準備が済んだ後で、上流が受け付けるトークンを変える（= 以後の push は 401）
      tool("bash", { command: "git ls-remote origin >/dev/null" }),
      tool("git_commit", { message: "fix: correct add" }),
      tool("report_completion", { summary: "done" }),
    ]);
    await agent.start(s0);
    // ツール実行が始まる（= clone 済み）まで待ってから、トークンを変える
    await expect
      .poll(async () => (await agent.allEvents()).some((e) => e.type === "tool_start"), {
        timeout: 120_000,
      })
      .toBe(true);
    upstream.expectedToken = "ghs_changed_upstream";
    try {
      expect(await agent.waitForTerminal()).toBe("completed");
    } finally {
      upstream.expectedToken = TEST_GIT_TOKEN;
    }
    const r = await agent.getResult();
    if (r.status !== "completed") throw new Error(`unexpected ${r.status}`);
    const events = await agent.allEvents();
    const end = events.find((e) => e.type === "tool_end" && e.data.name === "git_commit");
    expect(end?.data.isError).toBe(false);
    expect(events.some((e) => e.type === "push_failed" && e.data.final !== true)).toBe(true);
    expect(events.some((e) => e.type === "push_failed" && e.data.final === true)).toBe(true);
    expect(r.pushedSha).toBeUndefined();
    expect(r.warnings.some((w) => /push_failed/.test(w))).toBe(true);
    // 検証は通っているので completed のまま、patch は結果に残る
    expect(r.patch).toContain("a + b");
  });
});
