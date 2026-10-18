import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it } from "vitest";
import { createApiApp } from "../../src/app";
import { FakeGitHubFetch, installFakeGitHub } from "./fake-github-fetch";
import { fakeAgent, newUserId, taskStub, userStub } from "./helpers";

// OAuthProvider が apiHandler に渡す ExecutionContext を模す（props はリクエスト単位）
function ctxWithProps(props: Record<string, unknown>): ExecutionContext {
  return {
    waitUntil() {},
    passThroughOnException() {},
    props,
  } as unknown as ExecutionContext;
}

type App = ReturnType<typeof createApiApp>;

async function connect(
  app: App,
  props: Record<string, unknown>,
  testEnv: Env = env as unknown as Env,
) {
  const ctx = ctxWithProps(props);
  const transport = new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
    fetch: async (input, init) => {
      const request = new Request(input, init);
      // 実環境では workerd が Host を付ける。合成 Request には無いので補う（handler は Host を検証する）
      request.headers.set("host", new URL(request.url).host);
      return app.fetch(request, testEnv, ctx);
    },
  });
  const client = new Client({ name: "unit", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

type ToolResult = Awaited<ReturnType<Client["callTool"]>>;
function body(r: ToolResult): Record<string, unknown> {
  return JSON.parse((r.content as { text: string }[])[0]?.text ?? "{}");
}

const startArgs = (title: string, extra: Record<string, unknown> = {}) => ({
  repository: "acme/widgets",
  base_ref: "main",
  base_sha: "0123456789abcdef",
  title,
  instructions: "do it",
  ...extra,
});

async function user(login: string) {
  const id = newUserId();
  const gh = new FakeGitHubFetch();
  gh.user = { id, login };
  await installFakeGitHub(id, gh);
  return { id, login, gh, props: { githubUserId: id, login } };
}

describe("/mcp ツール一覧", () => {
  it("5 つのツールだけを公開し、Phase 2 の挙動を説明に書く", async () => {
    const u = await user("alice");
    const client = await connect(createApiApp(), u.props);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "task_cancel",
      "task_result",
      "task_start",
      "task_status",
      "task_wait",
    ]);
    const start = tools.find((t) => t.name === "task_start");
    expect(start?.description).toContain("RUNNING");
    expect(start?.description).toContain("idempotency_key");
    expect(start?.description).toContain("verification_commands");
    expect(start?.description).toContain("budget_exceeded");
    const props = start?.inputSchema.properties as Record<string, { type?: string }>;
    expect(props.verification_commands?.type).toBe("array");
    const result = tools.find((t) => t.name === "task_result");
    expect(result?.description).toContain("not_ready");
    await client.close();
  });
});

describe("task_start / status / wait / cancel", () => {
  it("start -> status -> wait(timeout 0) -> cancel -> wait が通る", async () => {
    const u = await user("alice");
    const client = await connect(createApiApp(), u.props);

    const started = await client.callTool({ name: "task_start", arguments: startArgs("t1") });
    expect(started.isError).toBeFalsy();
    const s = body(started);
    expect(s).toMatchObject({ status: "RUNNING", draft_pr_url: null });
    expect(typeof s.note).toBe("string");

    const status = body(
      await client.callTool({ name: "task_status", arguments: { task_id: s.task_id } }),
    );
    expect(status).toMatchObject({
      task_id: s.task_id,
      status: "RUNNING",
      repository: "acme/widgets",
      title: "t1",
      draft_pr_url: null,
      latest_cursor: "2",
    });
    expect(Object.keys(status)).not.toContain("owner_id");

    const w1 = body(
      await client.callTool({
        name: "task_wait",
        arguments: { task_id: s.task_id, cursor: "2", timeout_seconds: 0 },
      }),
    );
    expect(w1).toMatchObject({ status: "RUNNING", cursor: "2", events: [] });

    const c = body(
      await client.callTool({ name: "task_cancel", arguments: { task_id: s.task_id } }),
    );
    expect(c).toEqual({ task_id: s.task_id, status: "CANCELLED" });

    const w2 = body(
      await client.callTool({ name: "task_wait", arguments: { task_id: s.task_id, cursor: "2" } }),
    );
    expect(w2).toMatchObject({ status: "CANCELLED", cursor: "3" });
    expect((w2.events as { type: string }[]).map((e) => e.type)).toEqual(["cancelled"]);
    await client.close();
  });

  it("同じ idempotency_key で同じ task_id、別の入力なら conflict", async () => {
    const u = await user("alice");
    const client = await connect(createApiApp(), u.props);
    const a = body(
      await client.callTool({
        name: "task_start",
        arguments: startArgs("t", { idempotency_key: "k-1" }),
      }),
    );
    const b = body(
      await client.callTool({
        name: "task_start",
        arguments: startArgs("t", { idempotency_key: "k-1" }),
      }),
    );
    expect(b.task_id).toBe(a.task_id);
    const c = await client.callTool({
      name: "task_start",
      arguments: startArgs("other", { idempotency_key: "k-1" }),
    });
    expect(c.isError).toBe(true);
    expect(body(c).code).toBe("conflict");
    await client.close();
  });

  it("同時実行は 1 件まで（concurrency_limit）", async () => {
    const u = await user("alice");
    const client = await connect(createApiApp(), u.props);
    await client.callTool({ name: "task_start", arguments: startArgs("a") });
    const r = await client.callTool({ name: "task_start", arguments: startArgs("b") });
    expect(r.isError).toBe(true);
    expect(body(r).code).toBe("concurrency_limit");
    await client.close();
  });
});

describe("task_start の追加入力と task_result", () => {
  it("verification_commands を受け付け、不正なら invalid_input", async () => {
    const u = await user("alice");
    const client = await connect(createApiApp(), u.props);
    const bad = await client.callTool({
      name: "task_start",
      arguments: startArgs("t", { verification_commands: [{ argv: [] }] }),
    });
    expect(bad.isError).toBe(true);
    expect(body(bad).code).toBe("invalid_input");
    const ok = await client.callTool({
      name: "task_start",
      arguments: startArgs("t", {
        verification_commands: [{ argv: ["npm", "test"], cwd: "pkg", timeout_seconds: 60 }],
      }),
    });
    expect(ok.isError).toBeFalsy();
    await client.close();
  });

  it("月額の枠が足りなければ budget_exceeded（concurrency_limit とは別コード）", async () => {
    const u = await user("alice");
    await runInDurableObject(userStub(u.id), (i) => {
      (i as unknown as { monthlyLimitUsd: () => number }).monthlyLimitUsd = () => 1;
    });
    const client = await connect(createApiApp(), u.props);
    const r = await client.callTool({ name: "task_start", arguments: startArgs("t") });
    expect(r.isError).toBe(true);
    expect(body(r).code).toBe("budget_exceeded");
    await client.close();
  });

  it("task_result: 実行中は not_ready、終端なら成果を返す。他人のタスクは not_found", async () => {
    const alice = await user("alice");
    const bob = await user("bob");
    const ca = await connect(createApiApp(), alice.props);
    const cb = await connect(createApiApp(), bob.props);
    const started = body(await ca.callTool({ name: "task_start", arguments: startArgs("t") }));
    const taskId = started.task_id as string;

    const notReady = await ca.callTool({ name: "task_result", arguments: { task_id: taskId } });
    expect(notReady.isError).toBe(true);
    expect(body(notReady).code).toBe("not_ready");

    const other = await cb.callTool({ name: "task_result", arguments: { task_id: taskId } });
    expect(body(other).code).toBe("not_found");

    await fakeAgent(taskId).setPhase("completed");
    await taskStub(taskId).advance();
    const done = await ca.callTool({ name: "task_result", arguments: { task_id: taskId } });
    expect(done.isError).toBeFalsy();
    expect(body(done)).toMatchObject({
      task_id: taskId,
      status: "COMPLETED",
      summary: "fake summary",
      verification: { verified: false },
      patch_too_large: false,
    });
    await ca.close();
    await cb.close();
  });

  it("task_result は team 非所属なら forbidden、入力が不正なら invalid_input", async () => {
    const u = await user("alice");
    const client = await connect(createApiApp(), u.props);
    const bad = await client.callTool({ name: "task_result", arguments: {} });
    expect(body(bad).code).toBe("invalid_input");
    u.gh.team = "none";
    const r = await client.callTool({
      name: "task_result",
      arguments: { task_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV" },
    });
    expect(body(r).code).toBe("forbidden");
    await client.close();
  });
});

describe("SDK の入力検証に届く前の不正（必須欠落・型不一致）", () => {
  const cases: [string, string, Record<string, unknown>][] = [
    [
      "task_start",
      "title 欠落",
      (() => {
        const { title: _t, ...rest } = startArgs("x");
        return rest;
      })(),
    ],
    ["task_start", "idempotency_key が数値", startArgs("x", { idempotency_key: 123 })],
    [
      "task_start",
      "acceptance_criteria が数値の配列",
      startArgs("x", { acceptance_criteria: [1] }),
    ],
    ["task_status", "task_id 欠落", {}],
    ["task_wait", "cursor が数値", { task_id: "t", cursor: 1 }],
    ["task_wait", "timeout_seconds が文字列", { task_id: "t", timeout_seconds: "5" }],
    ["task_cancel", "task_id が数値", { task_id: 1 }],
    ["task_result", "task_id が数値", { task_id: 1 }],
    [
      "task_start",
      "verification_commands の未知のキー(timeoutSeconds の誤記)",
      startArgs("x", { verification_commands: [{ argv: ["npm", "test"], timeoutSeconds: 60 }] }),
    ],
    [
      "task_start",
      "verification_commands の argv が文字列",
      startArgs("x", { verification_commands: [{ argv: "npm test" }] }),
    ],
  ];
  it.each(cases)(
    "%s: %s は invalid_input + code で返り、GitHub は呼ばれない",
    async (name, _label, args) => {
      const u = await user("alice");
      const client = await connect(createApiApp(), u.props);
      const before = u.gh.calls.length;
      const r = await client.callTool({ name, arguments: args });
      expect(r.isError).toBe(true);
      const b = body(r);
      expect(b.code).toBe("invalid_input");
      expect(typeof b.message).toBe("string");
      expect(u.gh.calls.length).toBe(before);
      await client.close();
    },
  );

  it("tools/list の JSON Schema は利用者に分かる型を保つ", async () => {
    const u = await user("alice");
    const client = await connect(createApiApp(), u.props);
    const { tools } = await client.listTools();
    const start = tools.find((t) => t.name === "task_start");
    const props = start?.inputSchema.properties as Record<string, { type?: string }>;
    expect(props.title?.type).toBe("string");
    expect(props.acceptance_criteria?.type).toBe("array");
    expect(start?.inputSchema.required).toEqual(
      expect.arrayContaining(["repository", "base_ref", "base_sha", "title", "instructions"]),
    );
    const wait = tools.find((t) => t.name === "task_wait");
    const waitProps = wait?.inputSchema.properties as Record<string, { type?: string }>;
    expect(waitProps["timeout_seconds"]?.type).toBe("number");
    await client.close();
  });
});

describe("エラーの返し方", () => {
  it("入力が不正なら invalid_input。GitHub は呼ばない", async () => {
    const u = await user("alice");
    const before = u.gh.calls.length;
    const client = await connect(createApiApp(), u.props);
    const r = await client.callTool({
      name: "task_start",
      arguments: startArgs("t", { repository: "nope" }),
    });
    expect(r.isError).toBe(true);
    expect(body(r).code).toBe("invalid_input");
    expect(u.gh.calls.length).toBe(before);
    await client.close();
  });

  it("App 未導入のリポジトリは forbidden。予約は消費されない", async () => {
    const u = await user("alice");
    const client = await connect(createApiApp(), u.props);
    const r = await client.callTool({
      name: "task_start",
      arguments: startArgs("t", { repository: "other/public" }),
    });
    expect(r.isError).toBe(true);
    expect(body(r).code).toBe("forbidden");
    const ok = await client.callTool({ name: "task_start", arguments: startArgs("t") });
    expect(ok.isError).toBeFalsy();
    await client.close();
  });

  it("team 非所属は全ツールで forbidden", async () => {
    const u = await user("alice");
    u.gh.team = "none";
    const client = await connect(createApiApp(), u.props);
    for (const [name, args] of [
      ["task_start", startArgs("t")],
      ["task_status", { task_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV" }],
      ["task_wait", { task_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV" }],
      ["task_cancel", { task_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV" }],
      ["task_result", { task_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV" }],
    ] as const) {
      const r = await client.callTool({ name, arguments: args });
      expect(r.isError).toBe(true);
      expect(body(r).code).toBe("forbidden");
    }
    await client.close();
  });

  it("GitHub の 5xx は upstream_unavailable（retry_after_seconds 付き）", async () => {
    const u = await user("alice");
    u.gh.apiFault = 503;
    const client = await connect(createApiApp(), u.props);
    const r = await client.callTool({
      name: "task_status",
      arguments: { task_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV" },
    });
    expect(r.isError).toBe(true);
    expect(body(r)).toMatchObject({ code: "upstream_unavailable" });
    expect(body(r).retry_after_seconds).toBeGreaterThan(0);
    await client.close();
  });

  it("資格が無ければ reauth_required", async () => {
    const id = newUserId();
    await installFakeGitHub(id, new FakeGitHubFetch(), { login: false });
    const client = await connect(createApiApp(), { githubUserId: id, login: "x" });
    const r = await client.callTool({
      name: "task_status",
      arguments: { task_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV" },
    });
    expect(body(r).code).toBe("reauth_required");
    await client.close();
  });

  it("props が不正（認証情報なし）なら reauth_required", async () => {
    const client = await connect(createApiApp(), {});
    const r = await client.callTool({
      name: "task_status",
      arguments: { task_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV" },
    });
    expect(r.isError).toBe(true);
    expect(body(r).code).toBe("reauth_required");
    await client.close();
  });

  it("DO の想定外の例外は internal に写し、メッセージ・スタック・トークンを漏らさない", async () => {
    const u = await user("alice");
    const broken = Object.create(env, {
      USER_DO: {
        value: {
          getByName() {
            throw new Error("boom ghu_SECRET_TOKEN at /src/secret.ts:1");
          },
        },
      },
    }) as Env;
    const client = await connect(createApiApp(), u.props, broken);
    const r = await client.callTool({
      name: "task_status",
      arguments: { task_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV" },
    });
    expect(r.isError).toBe(true);
    const text = (r.content as { text: string }[])[0]?.text ?? "";
    expect(JSON.parse(text).code).toBe("internal");
    expect(text).not.toMatch(/ghu_|boom|secret|\.ts/);
    await client.close();
  });

  it("DO が一時的に使えない（retryable）なら upstream_unavailable", async () => {
    const u = await user("alice");
    const flaky = Object.create(env, {
      USER_DO: {
        value: {
          getByName() {
            throw Object.assign(new Error("overloaded"), { retryable: true });
          },
        },
      },
    }) as Env;
    const client = await connect(createApiApp(), u.props, flaky);
    const r = await client.callTool({
      name: "task_status",
      arguments: { task_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV" },
    });
    expect(body(r).code).toBe("upstream_unavailable");
    await client.close();
  });
});

describe("props の分離（単一の createApiApp に複数ユーザーを同時接続）", () => {
  it("交互・並列に何度呼んでも、本人の値だけが返り、他人のタスクは not_found", async () => {
    const app = createApiApp(); // 単一の handler を共有する
    const [alice, bob] = await Promise.all([user("alice"), user("bob")]);
    const [ca, cb] = await Promise.all([connect(app, alice.props), connect(app, bob.props)]);

    const [sa, sb] = await Promise.all([
      ca.callTool({ name: "task_start", arguments: startArgs("alice-task") }),
      cb.callTool({ name: "task_start", arguments: startArgs("bob-task") }),
    ]);
    const idA = body(sa).task_id as string;
    const idB = body(sb).task_id as string;
    expect(idA).not.toBe(idB);

    for (let round = 0; round < 5; round++) {
      const calls =
        round % 2 === 0
          ? [
              ca.callTool({ name: "task_status", arguments: { task_id: idA } }),
              cb.callTool({ name: "task_status", arguments: { task_id: idB } }),
              ca.callTool({ name: "task_status", arguments: { task_id: idB } }),
              cb.callTool({ name: "task_status", arguments: { task_id: idA } }),
            ]
          : [
              cb.callTool({ name: "task_status", arguments: { task_id: idA } }),
              ca.callTool({ name: "task_status", arguments: { task_id: idB } }),
              cb.callTool({ name: "task_status", arguments: { task_id: idB } }),
              ca.callTool({ name: "task_status", arguments: { task_id: idA } }),
            ];
      const rs = await Promise.all(calls);
      const byKey = new Map<string, ToolResult>();
      const keys =
        round % 2 === 0
          ? ["a-own", "b-own", "a-other", "b-other"]
          : ["b-other", "a-other", "b-own", "a-own"];
      for (const [i, k] of keys.entries()) byKey.set(k, rs[i] as ToolResult);
      expect(body(byKey.get("a-own") as ToolResult)).toMatchObject({ title: "alice-task" });
      expect(body(byKey.get("b-own") as ToolResult)).toMatchObject({ title: "bob-task" });
      for (const k of ["a-other", "b-other"]) {
        const r = byKey.get(k) as ToolResult;
        expect(r.isError).toBe(true);
        expect(body(r).code).toBe("not_found");
      }
    }
    await Promise.all([ca.close(), cb.close()]);
  });
});
