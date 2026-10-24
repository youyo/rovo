import { env } from "cloudflare:workers";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it } from "vitest";
import { createApiApp } from "../../src/app";
import { DIRECTORY_NAME, type TaskIndexSnapshot } from "../../src/directory/types";
import { stageOf, TASK_LIST_RECENT_MS } from "../../src/tasks/task-list";
import { FakeGitHubFetch, installFakeGitHub } from "./fake-github-fetch";
import { newUserId } from "./helpers";

type StageInput = Parameters<typeof stageOf>[0];

const base: StageInput = {
  kind: "task",
  status: "RUNNING",
  failure_phase: null,
  started_at: null,
  reached_verifying: false,
  pr_number: null,
  pr_merged: false,
  review_stage: null,
};
const stage = (over: Partial<StageInput>) => stageOf({ ...base, ...over });

describe("stageOf（task の段階）", () => {
  it("非終端は状態で決まる", () => {
    expect(stage({ status: "CREATING" })).toBe("setup");
    expect(stage({ status: "RUNNING" })).toBe("work");
    expect(stage({ status: "INPUT_REQUIRED" })).toBe("work");
    expect(stage({ status: "RECOVERING" })).toBe("work");
    expect(stage({ status: "VERIFYING" })).toBe("verify");
  });
  it("COMPLETED は PR があって未マージなら pr、それ以外は done", () => {
    expect(stage({ status: "COMPLETED", pr_number: 3 })).toBe("pr");
    expect(stage({ status: "COMPLETED", pr_number: 3, pr_merged: true })).toBe("done");
    expect(stage({ status: "COMPLETED" })).toBe("done");
  });
  it("失敗・予算超過・キャンセルは止まった段階（ダッシュボードの stopped_phase と同じ考え方）", () => {
    for (const status of ["FAILED", "BUDGET_EXCEEDED", "CANCELLED"]) {
      expect(stage({ status, failure_phase: "setup", started_at: 1 })).toBe("setup");
      expect(stage({ status, reached_verifying: true, started_at: 1 })).toBe("verify");
      expect(stage({ status, started_at: 1 })).toBe("work");
      expect(stage({ status })).toBe("setup");
    }
  });
});

describe("stageOf（review の段階）", () => {
  it("COMPLETED 以外の終端は止まった段を返す（review_stage × 終端）", () => {
    const stages = ["waiting", "commands", "reviewing", "posting", "done", null] as const;
    const want = {
      waiting: "fetch",
      commands: "fetch",
      reviewing: "investigate",
      posting: "post",
      done: "post",
    } as const;
    for (const status of ["FAILED", "BUDGET_EXCEEDED", "CANCELLED"]) {
      for (const rs of stages) {
        const expected = rs === null ? "fetch" : want[rs];
        expect(stage({ kind: "review", status, review_stage: rs }), `${status}/${rs}`).toBe(
          expected,
        );
      }
    }
  });
  const r = (over: Partial<StageInput>) => stage({ kind: "review", ...over });
  it("非終端は review の段で決まる", () => {
    expect(r({ status: "CREATING" })).toBe("fetch");
    expect(r({ review_stage: "waiting" })).toBe("fetch");
    expect(r({ review_stage: "commands" })).toBe("fetch");
    expect(r({ review_stage: "reviewing" })).toBe("investigate");
    expect(r({ review_stage: null })).toBe("fetch");
  });
  it("COMPLETED は投稿が済んでいれば done、まだなら post", () => {
    expect(r({ status: "COMPLETED", review_stage: "done" })).toBe("done");
    expect(r({ status: "COMPLETED", review_stage: "posting" })).toBe("post");
  });
  it("失敗は止まった段（task の値とは別の語彙）", () => {
    expect(r({ status: "FAILED", review_stage: "reviewing" })).toBe("investigate");
    expect(r({ status: "CANCELLED", review_stage: "waiting" })).toBe("fetch");
  });
});

// --- ディレクトリと MCP ---

const NOW = Date.now();
const HOUR = 3_600_000;

function snap(id: string, owner: number, over: Partial<TaskIndexSnapshot> = {}): TaskIndexSnapshot {
  return {
    task_id: id,
    owner_id: owner,
    owner_login: "alice",
    repository: "acme/widgets",
    repository_id: 100,
    title: `title ${id}`,
    status: "RUNNING",
    model: "anthropic/claude-sonnet-5-5",
    effort: "medium",
    created_at: NOW - HOUR,
    updated_at: NOW - HOUR,
    started_at: NOW - HOUR,
    ended_at: null,
    cost_micro: 123_456,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    pr_number: null,
    pr_url: null,
    pr_draft: null,
    pr_merged: false,
    reason: "secret_reason_code",
    failure_phase: null,
    deps_cache: null,
    sandbox_runtime_ms: null,
    ...over,
  };
}

async function seed(rows: TaskIndexSnapshot[]) {
  const dir = env.DIRECTORY_DO.getByName(DIRECTORY_NAME);
  for (const s of rows) await dir.upsertTask(s, 1);
}

let idSeq = 0;
const tid = () =>
  `01TASKLIST${String(Date.now()).padStart(10, "0")}${String(idSeq++).padStart(6, "0")}`;

async function connectAs(userId: number) {
  const gh = new FakeGitHubFetch();
  gh.user = { id: userId, login: "u" };
  await installFakeGitHub(userId, gh);
  const app = createApiApp();
  const ctx = {
    waitUntil() {},
    passThroughOnException() {},
    props: { githubUserId: userId, login: "u" },
  } as unknown as ExecutionContext;
  const transport = new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
    fetch: async (input, init) => {
      const request = new Request(input, init);
      request.headers.set("host", new URL(request.url).host);
      return app.fetch(request, env as unknown as Env, ctx);
    },
  });
  const client = new Client({ name: "unit", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

async function list(client: Client, args: Record<string, unknown> = {}) {
  const r = await client.callTool({ name: "task_list", arguments: args });
  return {
    isError: r.isError,
    text: (r.content as { text: string }[])[0]?.text ?? "{}",
    body: JSON.parse((r.content as { text: string }[])[0]?.text ?? "{}") as {
      tasks: Record<string, unknown>[];
      truncated: boolean;
    },
  };
}

describe("task_list", () => {
  it("読み取り専用の分類で登録されている", async () => {
    const client = await connectAs(newUserId());
    const tool = (await client.listTools()).tools.find((t) => t.name === "task_list");
    expect(tool?.annotations?.readOnlyHint).toBe(true);
    expect(tool?.description).toMatch(/ペイン|ダッシュボード/);
  });

  it("呼んだ人のタスクだけを新しい順に返し、他人のタスクは返さない", async () => {
    const me = newUserId();
    const other = newUserId();
    const [a, b, c, x] = [tid(), tid(), tid(), tid()];
    await seed([
      snap(a, me, { created_at: NOW - 3 * HOUR }),
      snap(b, me, { created_at: NOW - 1 * HOUR }),
      snap(c, me, { created_at: NOW - 2 * HOUR, repository_id: null }),
      snap(x, other, { created_at: NOW - 30_000 }),
    ]);
    const { body, text } = await list(await connectAs(me));
    expect(body.tasks.map((t) => t.task_id)).toEqual([b, c, a]);
    expect(body.truncated).toBe(false);
    expect(text).not.toContain(x);
  });

  it("各要素は固定の形で、費用・理由・自由文を含まない", async () => {
    const me = newUserId();
    const id = tid();
    await seed([
      snap(id, me, {
        status: "INPUT_REQUIRED",
        pr_number: 7,
        pr_url: "https://github.com/acme/widgets/pull/7",
      }),
    ]);
    const { body, text } = await list(await connectAs(me));
    const t = body.tasks[0] as Record<string, unknown>;
    expect(t).toMatchObject({
      task_id: id,
      kind: "task",
      title: `title ${id}`,
      repository: "acme/widgets",
      status: "INPUT_REQUIRED",
      stage: "work",
      waiting_for_answer: true,
      model: "anthropic/claude-sonnet-5-5",
      pr: { number: 7, url: "https://github.com/acme/widgets/pull/7" },
    });
    expect(typeof t.created_at).toBe("string");
    expect(typeof t.updated_at).toBe("string");
    expect(t).not.toHaveProperty("ended_at");
    expect(text).not.toMatch(/cost|secret_reason_code|reason|owner|123456|effort/);
  });

  it("scope: active は終端を除き、recent は 24 時間以内に終端になったものを足す。limit と truncated が効く", async () => {
    const me = newUserId();
    const [run, fresh, old] = [tid(), tid(), tid()];
    await seed([
      snap(run, me, { created_at: NOW - 5 * HOUR }),
      snap(fresh, me, {
        status: "COMPLETED",
        created_at: NOW - 4 * HOUR,
        ended_at: NOW - 2 * HOUR,
      }),
      snap(old, me, {
        status: "FAILED",
        created_at: NOW - 60 * HOUR,
        ended_at: NOW - TASK_LIST_RECENT_MS - HOUR,
      }),
    ]);
    const client = await connectAs(me);
    expect((await list(client)).body.tasks.map((t) => t.task_id)).toEqual([run]);
    expect((await list(client, { scope: "active" })).body.tasks.map((t) => t.task_id)).toEqual([
      run,
    ]);
    const recent = await list(client, { scope: "recent" });
    expect(recent.body.tasks.map((t) => t.task_id)).toEqual([fresh, run]);
    expect(recent.body.tasks[0]).toMatchObject({ stage: "done", ended_at: expect.any(String) });
    const limited = await list(client, { scope: "recent", limit: 1 });
    expect(limited.body.tasks.map((t) => t.task_id)).toEqual([fresh]);
    expect(limited.body.truncated).toBe(true);
  });

  it("limit は 1〜50 だけ受け付ける", async () => {
    const client = await connectAs(newUserId());
    expect((await list(client, { limit: 0 })).isError).toBe(true);
    expect((await list(client, { limit: 51 })).isError).toBe(true);
    expect((await list(client, { scope: "all" })).isError).toBe(true);
    expect((await list(client, { limit: 50 })).isError).not.toBe(true);
  });

  it("review は review の段階と対象の PR を返し、索引が古い（新しい項目が無い）タスクも返す", async () => {
    const me = newUserId();
    const [rv, legacy] = [tid(), tid()];
    await seed([
      snap(rv, me, {
        kind: "review",
        review_stage: "reviewing",
        target_pr_number: 9,
        target_pr_url: "https://github.com/acme/widgets/pull/9",
        verify_attempt: null,
      }),
      snap(legacy, me, { created_at: NOW - 5 * HOUR }),
    ]);
    const { body } = await list(await connectAs(me));
    expect(body.tasks[0]).toMatchObject({
      task_id: rv,
      kind: "review",
      stage: "investigate",
      pr: { number: 9, url: "https://github.com/acme/widgets/pull/9" },
    });
    expect(body.tasks[1]).toMatchObject({ task_id: legacy, kind: "task", stage: "work" });
    expect(body.tasks[1]).not.toHaveProperty("verify_attempt");
  });

  it("verify_attempt があれば verify_max も付く", async () => {
    const me = newUserId();
    const id = tid();
    await seed([snap(id, me, { status: "VERIFYING", verify_attempt: 2 })]);
    const { body } = await list(await connectAs(me));
    expect(body.tasks[0]).toMatchObject({ stage: "verify", verify_attempt: 2, verify_max: 4 });
  });
});
