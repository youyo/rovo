import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type FakeUpstream, startFakeUpstream } from "../../../agent/test/support/fake-upstream";
import {
  E2E_TOKEN_ENC_KEY,
  type RunningWrangler,
  startWrangler,
} from "../../../agent/test/support/wrangler";
import { fakeGitHubAdmin } from "../e2e/fake-admin";
import { connectAuthenticated } from "../e2e/oauth-client";
import { type FakeGitHub, startFakeGitHub } from "../fake-github/server";
import { generateAppKeyPair } from "../support/app-keys";
import { gitRepoStore } from "../support/git-store";

// Phase 3 のゴールの通し検証: MCP クライアント → Gateway（OAuth・TaskDO・UserDO・GitHub App）→ AgentDO → SandboxDO（実コンテナ）。
// 偽なのは GitHub（OAuth・API）、git / npm の上流（acme/calc）、モデル（台本付き）だけ。
//
// 偽 GitHub（App API）と偽 git の整合: 偽 git（git http-backend）の bare リポジトリを「正」とする。
// 偽 GitHub の Git Data / refs / compare API は、その bare リポジトリへの実 git 操作で実装する（test/support/git-store.ts）。
// TaskDO が API で作る初期コミット・作業ブランチと、Sandbox が clone / push するものは同じリポジトリの同じ SHA になる。
// 偽 git は、偽 GitHub が発行して失効していない Installation Token だけを受け付ける。
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
  upstream = await startFakeUpstream();
  github = await startFakeGitHub({
    app: {
      appId: "424242",
      publicKeyPem: appKeys.publicPem,
      storeFor: (fullName) =>
        fullName.toLowerCase() === REPO.fullName
          ? gitRepoStore(upstream.repoDir("calc"))
          : undefined,
    },
  });
  upstream.acceptToken = (token) => github.app?.isTokenValid(token, REPO.fullName) ?? false;
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
      "apps/agent/wrangler.jsonc": {
        ENVIRONMENT: "test",
        TEST_UPSTREAM: upstream.url,
        TOKEN_ENC_KEY: E2E_TOKEN_ENC_KEY,
      },
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

// ---- GitHub / git 側の確認 ----

const app = () => {
  if (!github.app) throw new Error("fake github app is not enabled");
  return github.app;
};
const branchOf = (taskId: string) => `agent/task-${taskId}`;
const refOf = (taskId: string) => `refs/heads/${branchOf(taskId)}`;
const pullOf = (taskId: string) =>
  app()
    .pulls(REPO.fullName)
    .find((p) => p.head === branchOf(taskId));
/** この時点で発行済みのトークン（以後に発行されたものを「このタスクのトークン」とみなす。シナリオは直列に流す）。 */
const tokensNow = () =>
  new Set(
    app()
      .tokenList()
      .map((t) => t.token),
  );
const tokensSince = (before: Set<string>) =>
  app()
    .tokenList()
    .filter((t) => !before.has(t.token));

async function waitFor<T>(
  what: string,
  fn: () => T | undefined | false | Promise<T | undefined | false>,
  timeoutMs = 60_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timeout waiting for: ${what}`);
    await sleep(500);
  }
}

/** 終端の後処理（PR 本文の更新・head の読み取り・トークンの失効）まで済んだ task_result を取る。 */
async function settledResult(client: Client, taskId: string, opts: { pushed?: boolean } = {}) {
  return waitFor(`finalize of ${taskId}`, async () => {
    const r = await resultOf(client, taskId);
    const pr = r.pr as { head_sha: string | null } | null;
    if (pr === null) return undefined;
    // push した（pushedSha がある）タスクは、終端で読んだ head が入るまで。push していない（キャンセルなど）
    // タスクは head を比べず記録もしない（null）ので、PR 本文が終端の内容に更新されるまで待つ。
    if (opts.pushed === false) {
      const body = pullOf(taskId)?.body ?? "";
      return body.includes("Status: **") && !body.includes("Status: **RUNNING**") ? r : undefined;
    }
    return pr.head_sha !== null ? r : undefined;
  });
}

const allRevoked = (tokens: { revoked: boolean }[]) =>
  tokens.length > 0 && tokens.every((t) => t.revoked);

/** 偽 git の receive-pack に届いた通信が、すべて Gateway が発行したトークンを持っていること。 */
function expectPushesUsedIssuedTokens(from: number) {
  const issued = new Set(
    app()
      .tokenList()
      .map((t) => t.token),
  );
  const pushes = upstream.requests
    .slice(from)
    .filter((r) => r.host === "github.com" && r.path.includes("git-receive-pack"));
  expect(pushes.length).toBeGreaterThan(0);
  for (const r of pushes) {
    const m = /^Basic (.+)$/.exec(String(r.headers.authorization ?? ""));
    const decoded = Buffer.from(m?.[1] ?? "", "base64").toString();
    expect(decoded.startsWith("x-access-token:ghs_fake")).toBe(true);
    expect(issued.has(decoded.slice("x-access-token:".length))).toBe(true);
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

describe("Gateway → Agent → 実コンテナ の通し（Phase 3）", () => {
  let aClient: Client;
  let aTaskId: string;

  it("a. task_start → Draft PR → RUNNING → commit が push → 検証済み SHA に揃う → COMPLETED → PR 本文の更新とトークンの失効", async () => {
    aClient = await newClient("alice");
    const tokensBefore = tokensNow();
    const reqFrom = upstream.requests.length;
    const { taskId, started } = await startTask(aClient, "a-happy", HAPPY("add を修正した"));
    aTaskId = taskId;
    // 作成前は null（URL は task_status・task_result・イベントで返る）
    expect(started).toMatchObject({ draft_pr_url: null });

    const { status, events } = await collect(aClient, taskId);
    expect(status, JSON.stringify(events)).toBe("COMPLETED");
    expect(statusSeq(events)).toEqual(["RUNNING", "VERIFYING", "COMPLETED"]);
    // Draft PR は作業ブランチ・初期コミットとともに、エージェントの開始より前に作られる
    const created = events.find((e) => e.type === "draft_pr_created");
    expect(created?.payload).toMatchObject({ draft: true, branch: branchOf(taskId) });
    expect(events.findIndex((e) => e.type === "draft_pr_created")).toBeLessThan(
      events.findIndex((e) => e.type === "status_changed" && e.payload.status === "RUNNING"),
    );
    // git_commit のたびに push される（pushed イベント）
    expect(events.some((e) => e.type === "pushed")).toBe(true);
    expect(events.some((e) => e.type === "push_failed")).toBe(false);
    const toolEnds = events
      .filter((e) => e.type === "tool_end")
      .map((e) => [e.payload.name, e.payload.is_error]);
    expect(toolEnds).toEqual([
      ["read_file", false],
      ["edit_file", false],
      ["bash", false],
      ["git_commit", false],
    ]);
    expect(events.find((e) => e.type === "completion_report")?.payload.summary).toBe(
      "add を修正した",
    );
    expect(events.find((e) => e.type === "verification")?.payload).toMatchObject({ passed: true });

    const r = await settledResult(aClient, taskId);
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

    // 偽 git の作業ブランチが検証済みの SHA に揃っている。履歴の根元は TaskDO が API で作った初期コミット
    expect(upstream.refSha("calc", refOf(taskId))).toBe(v.commit_sha);
    const commit = app().commit(REPO.fullName, v.commit_sha as string);
    const initial = app().commit(REPO.fullName, commit?.parents[0] as string);
    expect(initial?.message).toBe(`rovo: start task ${taskId}`);
    expect(created?.payload.initial_sha).toBe(initial?.sha);
    expect(initial?.parents).toEqual([upstream.calcSha]);
    // main には触っていない
    expect(upstream.refSha("calc", "refs/heads/main")).toBe(upstream.calcSha);

    // task_result の pr（head は検証済みの SHA と一致）。PR は Draft のまま
    const pr = pullOf(taskId);
    expect(pr).toMatchObject({ draft: true, state: "open", base: "main" });
    expect(r.pr).toEqual({
      number: pr?.number,
      url: `https://github.test/${REPO.fullName}/pull/${pr?.number}`,
      head_sha: v.commit_sha,
      head_matches_verified: true,
    });
    // PR 本文の管理範囲が終端の内容に更新されている
    expect(pr?.body).toContain("Status: **COMPLETED**");
    expect(pr?.body).toContain(`Verification: **passed** at \`${v.commit_sha}\``);
    expect(pr?.body).not.toContain("The agent is working");
    // push はすべて Gateway が発行したトークンで行われ、タスクが終わればトークンは失効する
    expectPushesUsedIssuedTokens(reqFrom);
    await waitFor("tokens revoked", () => allRevoked(tokensSince(tokensBefore)));
    // 失効したトークンでは、偽 git はもう受け付けない
    const [revoked] = tokensSince(tokensBefore);
    expect(upstream.acceptToken?.(revoked?.token ?? "")).toBe(false);

    // 枠が解放され、次の task_start ができる（停止確認後）
    const next = await startWhenFree(aClient, startArgs("a-next", "scenario:a-next"));
    expect(next.isError, JSON.stringify(next.body)).toBe(false);
    await cancelAndSettle(aClient, next.body.task_id as string);
  });

  it("b. 検証失敗 → 修正 → 成功。ブランチは最後の検証済み commit に揃う", async () => {
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
    const r = await settledResult(client, taskId);
    const v = r.verification as { verified: boolean; attempts: number; commit_sha?: string };
    expect(r.status).toBe("COMPLETED");
    expect(v).toMatchObject({ verified: true, attempts: 2 });
    expect(r.patch).toContain("+exports.add = (a, b) => a + b;");
    expect(upstream.refSha("calc", refOf(taskId))).toBe(v.commit_sha);
    expect(r.pr).toMatchObject({ head_sha: v.commit_sha, head_matches_verified: true });
  });

  it("c. 実行中に task_cancel → CANCELLED。PR は閉じずに残って本文が更新され、トークンは失効する", async () => {
    const client = await newClient("carol");
    const tokensBefore = tokensNow();
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

    const r = await settledResult(client, taskId, { pushed: false });
    expect(r).toMatchObject({ task_id: taskId, status: "CANCELLED" });
    // 停止後でも usage が取れる（最終 usage を含めて確定済み）
    expect((r.usage as { cost_usd: number }).cost_usd).toBeGreaterThanOrEqual(0);

    // PR は閉じない（design 4.7）。Draft のまま、本文だけ終端の内容になる
    const pr = pullOf(taskId);
    expect(pr).toMatchObject({ state: "open", draft: true });
    expect(pr?.body).toContain("Status: **CANCELLED**");
    expect(pr?.body).toContain("The task ended as CANCELLED.");
    await waitFor("tokens revoked", () => allRevoked(tokensSince(tokensBefore)));

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

  describe("f. Draft PR を作れないリポジトリ（DRAFT_PR_FALLBACK）", () => {
    const setFallback = async (value?: string) => {
      const res = await fetch(`${wrangler.baseUrl}/__test/draft-fallback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(value === undefined ? {} : { value }),
      });
      expect(res.status).toBe(200);
    };
    beforeAll(() => app().setDraftUnsupported(true));
    afterAll(async () => {
      app().setDraftUnsupported(false);
      await setFallback();
    });

    it("既定（fail）: FAILED（draft_pr_unsupported）。通常の PR は作られず、トークンは失効する", async () => {
      await setFallback();
      const client = await newClient("frank");
      const tokensBefore = tokensNow();
      const { taskId } = await startTask(client, "f-fail", HAPPY("到達しない"));
      const { status, events } = await collect(client, taskId);
      expect(status).toBe("FAILED");
      expect(
        events.find((e) => e.type === "status_changed" && e.payload.status === "FAILED")?.payload
          .reason,
      ).toBe("draft_pr_unsupported");
      expect(pullOf(taskId)).toBeUndefined();
      await waitFor("tokens revoked", () => allRevoked(tokensSince(tokensBefore)));
    });

    it("ready: [WIP] 付きの通常の PR で進み、警告 draft_pr_unavailable が events と task_result に出る", async () => {
      await setFallback("ready");
      const client = await newClient("grace");
      const { taskId } = await startTask(client, "f-ready", HAPPY("通常の PR で完了"));
      const { status, events } = await collect(client, taskId);
      expect(status, JSON.stringify(events)).toBe("COMPLETED");
      expect(
        events.some((e) => e.type === "warning" && e.payload.code === "draft_pr_unavailable"),
      ).toBe(true);
      expect(events.find((e) => e.type === "draft_pr_created")?.payload).toMatchObject({
        draft: false,
      });
      const r = await settledResult(client, taskId);
      expect((r.warnings as string[]).some((w) => w.startsWith("draft_pr_unavailable"))).toBe(true);
      const pr = pullOf(taskId);
      expect(pr?.draft).toBe(false);
      expect(pr?.title.startsWith("[WIP] ")).toBe(true);
      expect(pr?.body).toContain("Do not merge until the task has finished");
      expect(pr?.body).toContain("Status: **COMPLETED**");
    });
  });

  it("g. 完了の後に PR の head が動いたら、head_moved_after_verification の警告が出る", async () => {
    const client = await newClient("heidi");
    let moved: string | undefined;
    // TaskDO が終端で PR の head を読む直前（= AgentDO が検証済みの SHA に揃えた後）に、別の人が push した状況にする
    app().beforeHandle = async (key) => {
      if (moved !== undefined || !/^GET \/repos\/acme\/calc\/pulls\/\d+$/.test(key)) return;
      const pr = app()
        .pulls(REPO.fullName)
        .find((p) => `GET /repos/acme/calc/pulls/${p.number}` === key);
      const head = pr && app().branch(REPO.fullName, pr.head);
      // 検証済みの SHA に揃った後（= 初期コミットでも base でもない）の head にだけ作用させる
      if (!pr || !head || head === upstream.calcSha) return;
      moved = await app().addCommit(REPO.fullName, head, "someone else pushed");
      app().setBranch(REPO.fullName, pr.head, moved);
    };
    try {
      const { taskId } = await startTask(client, "g-moved", HAPPY("head が動く"));
      const { status, events } = await collect(client, taskId);
      expect(status, JSON.stringify(events)).toBe("COMPLETED");
      const r = await settledResult(client, taskId);
      const v = r.verification as { commit_sha?: string };
      expect(moved).toBeDefined();
      expect(moved).not.toBe(v.commit_sha);
      expect(r.pr).toMatchObject({ head_sha: moved, head_matches_verified: false });
      expect(
        (r.warnings as string[]).some((w) => w.startsWith("head_moved_after_verification")),
      ).toBe(true);
      const pr = pullOf(taskId);
      expect(pr?.body).toContain("differs from the verified commit");
      expect(upstream.refSha("calc", refOf(taskId))).toBe(moved);
    } finally {
      app().beforeHandle = undefined;
    }
  });
});
