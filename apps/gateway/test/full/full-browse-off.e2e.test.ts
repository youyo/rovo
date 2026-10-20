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
import { type FakeWeb, startFakeWeb } from "../../../web/test/support/fake-web";
import { fakeGitHubAdmin } from "../e2e/fake-admin";
import { connectAuthenticated } from "../e2e/oauth-client";
import { type FakeGitHub, startFakeGitHub } from "../fake-github/server";
import { generateAppKeyPair } from "../support/app-keys";
import { collectUntil } from "../support/collect";
import { gitRepoStore } from "../support/git-store";

// Phase 7 M3: web_browse が無効（本番の既定）のときの通し。full.e2e.test.ts は 3 つの Worker すべてで
// WEB_BROWSE_ENABLED="true" にしているので、ここでは var を一切渡さず、各 wrangler.jsonc の既定値（"false"）のまま 3 つを起動する。
// 確かめるのは、ユーザーから見えるところ: 親の tools/list に web_browse が出ない・呼んでも拒否される、
// 子（Pi）のツールにも無く、台本が呼んでもツールのエラーになる。どちらの経路でも Browser Run（偽の BROWSER）は呼ばれない。
// 他の web ツール（web_search / web_fetch）は影響を受けず動く。
// （apps/web の browse が disabled を返すことは Unit: apps/web/test/unit/service-browse.test.ts）
let github: FakeGitHub;
let upstream: FakeUpstream;
let fakeWeb: FakeWeb;
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
  const appKeys = await generateAppKeyPair();
  upstream = await startFakeUpstream();
  fakeWeb = await startFakeWeb();
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
  persistDir = mkdtempSync(join(tmpdir(), "rovo-full-browse-off-"));
  const port = await freePort();
  wrangler = await startWrangler({
    configs: [
      "apps/gateway/wrangler.jsonc",
      "apps/agent/wrangler.jsonc",
      "apps/web/wrangler.jsonc",
    ],
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
      // 既存のシナリオは「同時実行は 1 件で埋まる」前提で書かれている（wrangler.jsonc の既定は 2）
      MAX_CONCURRENT_TASKS: "1",
      TOKEN_ENC_KEY: Buffer.alloc(32, 7).toString("base64"),
      GITHUB_APP_ID: "424242",
      GITHUB_APP_PRIVATE_KEY: appKeys.privatePem
        .replace(/-----[^-]+-----/g, "")
        .replace(/\s+/g, ""),
      // WEB_BROWSE_ENABLED は渡さない（wrangler.jsonc の既定値 = 無効のまま）
    },
    configVars: {
      "apps/agent/wrangler.jsonc": {
        ENVIRONMENT: "test",
        TEST_UPSTREAM: upstream.url,
        TOKEN_ENC_KEY: E2E_TOKEN_ENC_KEY,
      },
      "apps/web/wrangler.jsonc": {
        ENVIRONMENT: "test",
        TEST_FAKE_BASE: fakeWeb.url,
        AI_GATEWAY_ID: "e2e-gateway",
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
  await fakeWeb?.stop();
  await github?.stop();
  if (persistDir) rmSync(persistDir, { recursive: true, force: true });
});

let userSeq = (Date.now() % 1_000_000) * 100;
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
async function call(client: Client, name: string, args: Body) {
  const r = await client.callTool({ name, arguments: args });
  const text = (r.content as { text: string }[])[0]?.text ?? "{}";
  return { isError: r.isError === true, text, body: JSON.parse(text) as Body };
}

interface Ev {
  seq: number;
  type: string;
  payload: Record<string, unknown>;
}
const TERMINAL = new Set(["COMPLETED", "FAILED", "BUDGET_EXCEEDED", "CANCELLED"]);
const tool = (name: string, args: Record<string, unknown>) => ({
  toolCall: { name, arguments: args },
});
const FIX = tool("edit_file", { path: "calc.js", old_string: "a - b", new_string: "a + b" });

/** 偽 BROWSER（Browser Run）に届いた要求の数。web_browse が使われたかどうか。 */
const browserCalls = () => fakeWeb.requests.filter((r) => r.path.startsWith("/browser/")).length;

describe("web_browse が無効（既定）の通し", () => {
  it("x. 親: tools/list に web_browse が出ない（web_search / web_fetch は出る）。呼んでも拒否され、Browser Run は呼ばれない", async () => {
    const client = await newClient("xena");
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain("web_browse");
    expect(names).toContain("web_search");
    expect(names).toContain("web_fetch");

    const before = browserCalls();
    const r = await client
      .callTool({ name: "web_browse", arguments: { url: "https://docs.example.com/spa" } })
      .then(
        (res) => ({ isError: res.isError === true, text: JSON.stringify(res.content) }),
        (e: unknown) => ({ isError: true, text: e instanceof Error ? e.message : String(e) }),
      );
    expect(r.isError, r.text).toBe(true);
    expect(r.text).not.toContain("BROWSE-BODY-TOKEN");
    expect(browserCalls()).toBe(before);

    // 他の web ツールは影響を受けない
    const fetched = await call(client, "web_fetch", { url: "https://docs.example.com/guide" });
    expect(fetched.isError, fetched.text).toBe(false);
  });

  it("y. 子: 台本が web_browse を呼んでも「ツールが無い」エラーになり、Browser Run は呼ばれない。web_fetch は使えて、タスクは完了する。usage の browse は 0", async () => {
    const client = await newClient("yuri");
    const instructions = "scenario:browse-off";
    const script = [
      tool("web_browse", { url: "https://docs.example.com/spa" }),
      tool("web_fetch", { url: "https://docs.example.com/guide" }),
      FIX,
      tool("git_commit", { message: "fix: correct add" }),
      { ...tool("report_completion", { summary: "web_browse なしで完了した" }) },
    ];
    const set = await fetch(`${wrangler.baseUrl}/__test/agent/set-script`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: instructions, script }),
    });
    expect(set.status).toBe(200);
    const started = await call(client, "task_start", {
      repository: REPO.fullName,
      base_ref: "main",
      base_sha: upstream.calcSha,
      title: "browse-off",
      instructions,
      verification_commands: [{ argv: ["npm", "test"], timeout_seconds: 120 }],
    });
    expect(started.isError, started.text).toBe(false);
    const taskId = started.body.task_id as string;

    const before = browserCalls();
    const done = await collectUntil({
      wait: async (cursor) => {
        const w = await call(client, "task_wait", {
          task_id: taskId,
          ...(cursor !== undefined ? { cursor } : {}),
          timeout_seconds: 20,
        });
        expect(w.isError, w.text).toBe(false);
        return {
          status: w.body.status as string,
          events: w.body.events as Ev[],
          cursor: w.body.cursor as string,
        };
      },
      until: (s) => TERMINAL.has(s),
      timeoutMs: 240_000,
    });
    expect(done.status, JSON.stringify(done.events)).toBe("COMPLETED");

    const ends = done.events.filter(
      (e) => e.type === "tool_end" && String(e.payload.name).startsWith("web_"),
    );
    // web_browse は登録されていないので、AgentDO のツールの前後のフック（tool_start / tool_end）を通らない。web_fetch は通る
    expect(ends.map((e) => [e.payload.name, e.payload.is_error])).toEqual([["web_fetch", false]]);
    const resMsg = await fetch(`${wrangler.baseUrl}/__test/agent/model-tool-results`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ task_id: taskId }),
    });
    const calls = ((await resMsg.json()) as { calls: string[][] }).calls;
    // モデルには「ツールが無い」というハーネスのエラーが届き、Browser Run の本文は届かない
    const seen = calls.map((c) => c.join("\n")).join("\n");
    expect(seen).toContain("[error] Tool web_browse is not available");
    expect(seen).not.toContain("BROWSE-BODY-TOKEN");
    expect(browserCalls()).toBe(before);
    const usages = done.events.filter((e) => e.type === "usage");
    expect(usages[usages.length - 1]?.payload).toMatchObject({ web_browse: 0 });
  });
});
