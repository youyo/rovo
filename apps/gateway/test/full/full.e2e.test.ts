import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type FakeUpstream, startFakeUpstream } from "../../../agent/test/support/fake-upstream";
import { type RunningWrangler, startWrangler } from "../../../agent/test/support/wrangler";
import { fakeGitHubAdmin } from "../e2e/fake-admin";
import { connectAuthenticated } from "../e2e/oauth-client";
import { type FakeGitHub, startFakeGitHub } from "../fake-github/server";
import { generateAppKeyPair } from "../support/app-keys";

// Phase 2 のゴールの通し検証: MCP クライアント → Gateway（OAuth・TaskDO・UserDO）→ AgentDO → SandboxDO（実コンテナ）。
// 偽なのは GitHub（OAuth・API）、git / npm の上流（acme/calc）、モデル（台本付き）だけ。
let github: FakeGitHub;
let upstream: FakeUpstream;
let wrangler: RunningWrangler;
let persistDir: string;
const clients: Client[] = [];
const admin = () => fakeGitHubAdmin(github.url);

const ORG = "acme";
const TEAM = "core";
const REPO = { id: 4343, fullName: "acme/calc", push: true };
const INSTALLATION_ID = 78;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

beforeAll(async () => {
  // GitHub App の鍵は実行のたびに生成する（リポジトリに秘密鍵は置かない）
  const appKeys = await generateAppKeyPair();
  github = await startFakeGitHub({ app: { appId: "424242", publicKeyPem: appKeys.publicPem } });
  upstream = await startFakeUpstream();
  persistDir = mkdtempSync(join(tmpdir(), "rovo-full-e2e-"));
  const port = await freePort();
  wrangler = await startWrangler({
    configs: ["apps/gateway/wrangler.jsonc", "apps/agent/wrangler.jsonc"],
    port,
    vars: {
      ENVIRONMENT: "test",
      PUBLIC_BASE_URL: `http://127.0.0.1:${port}`,
      GITHUB_OAUTH_BASE: github.url,
      GITHUB_API_BASE: github.url,
      GITHUB_APP_CLIENT_ID: github.clientId,
      GITHUB_APP_CLIENT_SECRET: github.clientSecret,
      ALLOWED_ORG: ORG,
      ALLOWED_TEAM: TEAM,
      TOKEN_ENC_KEY: Buffer.alloc(32, 7).toString("base64"),
      GITHUB_APP_ID: "424242",
      GITHUB_APP_PRIVATE_KEY: appKeys.privatePem
        .replace(/-----[^-]+-----/g, "")
        .replace(/\s+/g, ""),
      // 1 タスクの予約は $10。月額 $10 なら、$10 の予約が通るのは累計の費用が 0 のときだけ
      MONTHLY_BUDGET_USD: "10",
    },
    // --var は primary（gateway）にしか効かないので、agent 側は .dev.vars で渡す
    configVars: {
      "apps/agent/wrangler.jsonc": { ENVIRONMENT: "test", TEST_UPSTREAM: upstream.url },
    },
    readyPath: "/.well-known/oauth-authorization-server",
    persistDir,
  });
  await admin().setInstallation(INSTALLATION_ID, [REPO]);
}, 600_000);

afterAll(async () => {
  await Promise.all(clients.map((c) => c.close().catch(() => {})));
  await wrangler?.stop();
  await upstream?.stop();
  await github?.stop();
  if (persistDir) rmSync(persistDir, { recursive: true, force: true });
});

// ---- ヘルパー ----

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let userSeq = (Date.now() % 1_000_000) * 100;

/** 新しいユーザー（team の active メンバー）でログインした MCP クライアント。 */
async function newClient(prefix: string): Promise<Client> {
  const user = { id: ++userSeq, login: `${prefix}-${userSeq}` };
  await admin().addUser(user);
  await admin().setTeam(ORG, TEAM, user.login, "active");
  await admin().setCurrentUser(user.login);
  const client = await connectAuthenticated(wrangler.baseUrl);
  clients.push(client);
  return client;
}

type Body = Record<string, unknown>;
async function call(
  client: Client,
  name: string,
  args: Body,
): Promise<{ isError: boolean; body: Body }> {
  if (process.env.E2E_DEBUG === "1") {
    process.stderr.write(`CALL ${name} ${JSON.stringify(args).slice(0, 80)} ${Date.now()}\n`);
  }
  const r = await client.callTool({ name, arguments: args });
  const text = (r.content as { text: string }[])[0]?.text ?? "{}";
  return { isError: r.isError === true, body: JSON.parse(text) as Body };
}

interface ScriptStep {
  text?: string;
  toolCall?: { name: string; arguments: Record<string, string | number | boolean> };
  usage?: { input?: number; output?: number };
}
const tool = (name: string, args: Record<string, string | number | boolean>): ScriptStep => ({
  toolCall: { name, arguments: args },
});
const report = (summary: string, usage?: ScriptStep["usage"]): ScriptStep => ({
  ...tool("report_completion", { summary }),
  ...(usage ? { usage } : {}),
});
const FIX = tool("edit_file", { path: "calc.js", old_string: "a - b", new_string: "a + b" });
const WRONG_FIX = tool("edit_file", { path: "calc.js", old_string: "a - b", new_string: "a * b" });
const FIX_AGAIN = tool("edit_file", { path: "calc.js", old_string: "a * b", new_string: "a + b" });
const HAPPY = (summary: string, usage?: ScriptStep["usage"]): ScriptStep[] => [
  tool("read_file", { path: "calc.js" }),
  FIX,
  tool("bash", { command: "npm test" }),
  tool("git_commit", { message: "fix: correct add" }),
  report(summary, usage),
];

const startArgs = (title: string, instructions: string, extra: Body = {}): Body => ({
  repository: REPO.fullName,
  base_ref: "main",
  base_sha: upstream.calcSha,
  title,
  instructions,
  verification_commands: [{ argv: ["npm", "test"], timeout_seconds: 120 }],
  ...extra,
});

/**
 * 台本を預けてから task_start する（Gateway が AgentDO.start の直前に setScript で渡す）。
 * task_id は task_start の応答で初めて決まるので、台本の key は instructions にする。
 */
async function startTask(client: Client, title: string, script: ScriptStep[], extra: Body = {}) {
  const instructions = `scenario:${title}`;
  const res = await fetch(`${wrangler.baseUrl}/__test/agent/set-script`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key: instructions, script }),
  });
  expect(res.status).toBe(200);
  const r = await call(client, "task_start", startArgs(title, instructions, extra));
  expect(r.isError, JSON.stringify(r.body)).toBe(false);
  return { taskId: r.body.task_id as string, started: r.body };
}

interface Ev {
  seq: number;
  type: string;
  payload: Record<string, unknown>;
}
const TERMINAL = new Set(["COMPLETED", "FAILED", "BUDGET_EXCEEDED", "CANCELLED"]);

/** task_wait を cursor でつないで、条件が満たされる（既定: 終端になる）までイベントを集める。 */
async function collect(
  client: Client,
  taskId: string,
  until: (status: string, events: Ev[]) => boolean = (s) => TERMINAL.has(s),
  timeoutMs = 240_000,
) {
  const events: Ev[] = [];
  let cursor: string | undefined;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const w = await call(client, "task_wait", {
      task_id: taskId,
      ...(cursor !== undefined ? { cursor } : {}),
      timeout_seconds: 20,
    });
    expect(w.isError, JSON.stringify(w.body)).toBe(false);
    events.push(...(w.body.events as Ev[]));
    cursor = w.body.cursor as string;
    if (until(w.body.status as string, events)) return { status: w.body.status as string, events };
    if (Date.now() > deadline) throw new Error(`timeout; status=${w.body.status}`);
  }
}

const statusSeq = (events: Ev[]) =>
  events.filter((e) => e.type === "status_changed").map((e) => e.payload.status as string);

/** task_result は停止確認まで not_ready を返す。取れるまで待つ。 */
async function resultOf(client: Client, taskId: string, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = await call(client, "task_result", { task_id: taskId });
    if (!r.isError) return r.body;
    if (r.body.code !== "not_ready" || Date.now() > deadline) {
      throw new Error(`task_result: ${JSON.stringify(r.body)}`);
    }
    await sleep(1_000);
  }
}

/** 同時実行枠が解放されるまで task_start を繰り返す。concurrency_limit の間は待つ。 */
async function startWhenFree(client: Client, args: Body, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = await call(client, "task_start", args);
    if (r.body.code !== "concurrency_limit" || Date.now() > deadline) return r;
    await sleep(1_000);
  }
}

/** 実行中のタスクをキャンセルして、停止が確認される（task_result が取れる）まで待つ。 */
async function cancelAndSettle(client: Client, taskId: string) {
  const c = await call(client, "task_cancel", { task_id: taskId });
  expect(c.body).toEqual({ task_id: taskId, status: "CANCELLED" });
  await resultOf(client, taskId);
}

// ---- シナリオ ----

describe("Gateway → Agent → 実コンテナ の通し", () => {
  let aClient: Client;
  let aTaskId: string;

  it("a. task_start → RUNNING → VERIFYING → COMPLETED。patch と検証結果が取れ、枠が解放される", async () => {
    aClient = await newClient("alice");
    const { taskId, started } = await startTask(aClient, "a-happy", HAPPY("add を修正した"));
    aTaskId = taskId;
    expect(started).toMatchObject({ status: "RUNNING", draft_pr_url: null });

    const { status, events } = await collect(aClient, taskId);
    expect(status, JSON.stringify(events)).toBe("COMPLETED");
    expect(statusSeq(events)).toEqual(["RUNNING", "VERIFYING", "COMPLETED"]);
    const toolEnds = events
      .filter((e) => e.type === "tool_end")
      .map((e) => [e.payload.name, e.payload.is_error]);
    expect(toolEnds).toEqual([
      ["read_file", false],
      ["edit_file", false],
      ["bash", false],
      ["git_commit", false],
    ]);
    expect(events.some((e) => e.type === "tool_start")).toBe(true);
    expect(events.find((e) => e.type === "completion_report")?.payload.summary).toBe(
      "add を修正した",
    );
    expect(events.find((e) => e.type === "verification")?.payload).toMatchObject({ passed: true });

    const r = await resultOf(aClient, taskId);
    expect(r).toMatchObject({ task_id: taskId, status: "COMPLETED", summary: "add を修正した" });
    const v = r.verification as {
      verified: boolean;
      attempts: number;
      results: Body[];
      commit_sha?: string;
    };
    expect(v.verified).toBe(true);
    expect(v.attempts).toBe(1);
    expect(v.results[0]).toMatchObject({ argv: ["npm", "test"], exit_code: 0, timed_out: false });
    expect(v.commit_sha).toMatch(/^[0-9a-f]{40}$/);
    expect(r.patch).toContain("-exports.add = (a, b) => a - b;");
    expect(r.patch).toContain("+exports.add = (a, b) => a + b;");

    // 枠が解放され、次の task_start ができる（停止確認後）
    const next = await startWhenFree(aClient, startArgs("a-next", "scenario:a-next"));
    expect(next.isError, JSON.stringify(next.body)).toBe(false);
    await cancelAndSettle(aClient, next.body.task_id as string);
  });

  it("b. 検証失敗 → 修正 → 成功", async () => {
    const client = await newClient("bob");
    const { taskId } = await startTask(client, "b-retry", [
      WRONG_FIX,
      tool("git_commit", { message: "wip: 間違った修正" }),
      report("直した（つもり）"),
      FIX_AGAIN,
      tool("git_commit", { message: "fix: 正しい修正" }),
      report("直した"),
    ]);
    const { status, events } = await collect(client, taskId);
    expect(status, JSON.stringify(events)).toBe("COMPLETED");
    expect(statusSeq(events)).toEqual([
      "RUNNING",
      "VERIFYING",
      "RUNNING",
      "VERIFYING",
      "COMPLETED",
    ]);
    expect(events.filter((e) => e.type === "verification").map((e) => e.payload.passed)).toEqual([
      false,
      true,
    ]);
    const r = await resultOf(client, taskId);
    const v = r.verification as { verified: boolean; attempts: number };
    expect(r.status).toBe("COMPLETED");
    expect(v).toMatchObject({ verified: true, attempts: 2 });
    expect(r.patch).toContain("+exports.add = (a, b) => a + b;");
  });

  it("c. 実行中に task_cancel → CANCELLED。task_result が取れ、停止確認後に次の task_start ができる", async () => {
    const client = await newClient("carol");
    const { taskId } = await startTask(client, "c-cancel", [
      tool("bash", { command: "sleep 120" }),
      report("到達しない"),
    ]);
    // 長時間のツールが始まるまで待つ
    await collect(client, taskId, (_s, evs) => evs.some((e) => e.type === "tool_start"));
    const c = await call(client, "task_cancel", { task_id: taskId });
    expect(c.body).toEqual({ task_id: taskId, status: "CANCELLED" });

    const { status, events } = await collect(client, taskId);
    expect(status).toBe("CANCELLED");
    expect(events.some((e) => e.type === "cancelled")).toBe(true);

    const r = await resultOf(client, taskId);
    expect(r).toMatchObject({ task_id: taskId, status: "CANCELLED" });
    // 停止後でも usage が取れる（最終 usage を含めて確定済み）
    expect((r.usage as { cost_usd: number }).cost_usd).toBeGreaterThanOrEqual(0);

    // 停止確認の後は同時実行の枠が解放され、同じユーザーが次の task_start できる
    const next = await startWhenFree(client, startArgs("c-next", "scenario:c-next"));
    expect(next.isError, JSON.stringify(next.body)).toBe(false);
    await cancelAndSettle(client, next.body.task_id as string);
  });

  it("d. 月額予算が足りないと task_start は budget_exceeded", async () => {
    const client = await newClient("dave");
    // 1 タスク目は $2 を使う（scripted モデルは $1 / 100 万トークン）。月額 $10 では次の $10 の予約が通らない
    const { taskId } = await startTask(client, "d-spend", HAPPY("done", { input: 2_000_000 }));
    const { status, events } = await collect(client, taskId);
    expect(status, JSON.stringify(events)).toBe("COMPLETED");
    const r = await resultOf(client, taskId);
    expect((r.usage as { cost_usd: number }).cost_usd).toBeCloseTo(2, 5);

    const next = await startWhenFree(client, startArgs("d-next", "scenario:d-next"));
    expect(next.isError).toBe(true);
    expect(next.body.code).toBe("budget_exceeded");
  });

  it("e. 別ユーザーは他人のタスクの task_result / task_status / task_cancel が not_found", async () => {
    expect(aTaskId).toBeTruthy();
    const eve = await newClient("eve");
    for (const name of ["task_result", "task_status", "task_cancel"]) {
      const r = await call(eve, name, { task_id: aTaskId });
      expect(r.isError, name).toBe(true);
      expect(r.body.code, name).toBe("not_found");
    }
    // 持ち主は引き続き読める
    const own = await call(aClient, "task_result", { task_id: aTaskId });
    expect(own.isError).toBe(false);
  });
});
