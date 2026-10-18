import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { AgentRpc, TaskSpec } from "../../src/agent/contract";
import { createDefaultApp } from "../../src/app";
import { testDraftFallback, withTestScripts } from "../../src/test-routes";

const SCRIPT = [{ toolCall: { name: "report_completion", arguments: { summary: "x" } } }];

const post = (body: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

/** KV だけを差し替えた env（ENVIRONMENT も指定する）。 */
const withEnv = (environment: string | undefined) =>
  ({ ...env, ENVIRONMENT: environment }) as never;

describe("E2E 用テストルート /__test/agent/set-script", () => {
  it("ENVIRONMENT=production（既定）では Worker 全体で 404 で、何も保存しない", async () => {
    expect(env.ENVIRONMENT).toBe("production");
    const res = await SELF.fetch(
      `${env.PUBLIC_BASE_URL}/__test/agent/set-script`,
      post({ key: "k-prod", script: SCRIPT }),
    );
    expect(res.status).toBe(404);
    expect(await env.OAUTH_KV.get("test-script:k-prod")).toBeNull();
  });

  it("ENVIRONMENT が test 以外（production・空・未設定）なら 404 で何も保存しない", async () => {
    const app = createDefaultApp();
    for (const environment of ["production", "", undefined]) {
      const res = await app.request(
        "/__test/agent/set-script",
        post({ key: "k-nontest", script: SCRIPT }),
        withEnv(environment),
      );
      expect(res.status).toBe(404);
    }
    expect(await env.OAUTH_KV.get("test-script:k-nontest")).toBeNull();
  });

  it("ENVIRONMENT=test では台本を KV に保存する", async () => {
    const res = await createDefaultApp().request(
      "/__test/agent/set-script",
      post({ key: "scenario:a", script: SCRIPT }),
      withEnv("test"),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(JSON.parse((await env.OAUTH_KV.get("test-script:scenario:a")) ?? "null")).toEqual(
      SCRIPT,
    );
  });

  it("ENVIRONMENT=test でも不正な入力は 400 で保存しない", async () => {
    const app = createDefaultApp();
    for (const body of [
      {},
      { key: "", script: [] },
      { key: "k-bad" },
      { key: "k-bad", script: "x" },
    ]) {
      expect(
        (await app.request("/__test/agent/set-script", post(body), withEnv("test"))).status,
      ).toBe(400);
    }
    expect(await env.OAUTH_KV.get("test-script:k-bad")).toBeNull();
  });

  it("test でも POST 以外は 404", async () => {
    const res = await createDefaultApp().request("/__test/agent/set-script", {}, withEnv("test"));
    expect(res.status).toBe(404);
  });
});

describe("withTestScripts（TaskDO が子エージェントを呼ぶ前に台本を渡す）", () => {
  const spec = { taskId: "T", instructions: "scenario:wt" } as TaskSpec;

  function fakeAgent() {
    const calls: string[] = [];
    const agent = {
      setScript: async (key: string) => void calls.push(`setScript:${key}`),
      start: async () => {
        calls.push("start");
        return { status: "accepted", phase: "starting", alreadyAccepted: false } as const;
      },
      cancel: async () => ({ stopped: true }),
      getEvents: async () => ({}) as never,
      getResult: async () => ({ status: "not_ready" }) as const,
    };
    return { agent, calls };
  }

  it("ENVIRONMENT が test 以外では元のスタブをそのまま返す", async () => {
    const { agent } = fakeAgent();
    expect(withTestScripts(withEnv("production"), agent as unknown as AgentRpc)).toBe(agent);
  });

  it("test で台本があれば、setScript してから start する", async () => {
    await env.OAUTH_KV.put("test-script:scenario:wt", JSON.stringify(SCRIPT));
    const { agent, calls } = fakeAgent();
    const wrapped = withTestScripts(withEnv("test"), agent as unknown as AgentRpc);
    expect(await wrapped.start(spec)).toMatchObject({ status: "accepted" });
    expect(calls).toEqual(["setScript:scenario:wt", "start"]);
    expect(await wrapped.cancel()).toEqual({ stopped: true });
  });

  it("test でも台本が無ければ setScript せず start だけ", async () => {
    const { agent, calls } = fakeAgent();
    const wrapped = withTestScripts(withEnv("test"), agent as unknown as AgentRpc);
    await wrapped.start({ ...spec, instructions: "scenario:none" });
    expect(calls).toEqual(["start"]);
  });
});

describe("E2E 用テストルート（Phase 4: 配送の保留・モデルへのメッセージ・配送状態）", () => {
  it("test 以外では hold-deliveries / model-calls / deliveries は 404 で、何も保存しない", async () => {
    const app = createDefaultApp();
    for (const path of [
      "/__test/hold-deliveries",
      "/__test/agent/model-calls",
      "/__test/task/deliveries",
    ]) {
      for (const environment of ["production", "", undefined]) {
        const res = await app.request(
          path,
          post({ value: true, task_id: "x" }),
          withEnv(environment),
        );
        expect(res.status, path).toBe(404);
      }
    }
    expect(await env.OAUTH_KV.get("test-hold-deliveries")).toBeNull();
  });

  it("test の hold-deliveries は KV に保存し、value 省略で解除する", async () => {
    const app = createDefaultApp();
    expect(
      (await app.request("/__test/hold-deliveries", post({ value: true }), withEnv("test"))).status,
    ).toBe(200);
    expect(await env.OAUTH_KV.get("test-hold-deliveries")).toBe("1");
    await app.request("/__test/hold-deliveries", post({}), withEnv("test"));
    expect(await env.OAUTH_KV.get("test-hold-deliveries")).toBeNull();
  });

  it("deliveries / model-calls は task_id が不正なら 400", async () => {
    const app = createDefaultApp();
    for (const path of ["/__test/agent/model-calls", "/__test/task/deliveries"]) {
      expect((await app.request(path, post({}), withEnv("test"))).status, path).toBe(400);
      expect((await app.request(path, post({ task_id: "../x" }), withEnv("test"))).status).toBe(
        400,
      );
    }
  });

  it("withTestScripts は、hold-deliveries の間 answer / steer を AgentDO に届けず ok:false を返す。解除すれば届く", async () => {
    const calls: string[] = [];
    const agent = {
      answer: async (q: string) => {
        calls.push(`answer:${q}`);
        return { ok: true };
      },
      steer: async (s: string) => {
        calls.push(`steer:${s}`);
        return { ok: true };
      },
    };
    const wrapped = withTestScripts(withEnv("test"), agent as unknown as AgentRpc);
    await env.OAUTH_KV.put("test-hold-deliveries", "1");
    try {
      expect(await wrapped.answer("q1", "a")).toEqual({ ok: false });
      expect(await wrapped.steer("s1", "m")).toEqual({ ok: false });
      expect(calls).toEqual([]);
    } finally {
      await env.OAUTH_KV.delete("test-hold-deliveries");
    }
    expect(await wrapped.answer("q1", "a")).toEqual({ ok: true });
    expect(await wrapped.steer("s1", "m")).toEqual({ ok: true });
    expect(calls).toEqual(["answer:q1", "steer:s1"]);
  });
});

describe("E2E 用テストルート /__test/draft-fallback", () => {
  it("test 以外では 404 で何も保存せず、上書きも効かない", async () => {
    const app = createDefaultApp();
    const res = await app.request(
      "/__test/draft-fallback",
      post({ value: "ready" }),
      withEnv("production"),
    );
    expect(res.status).toBe(404);
    expect(await env.OAUTH_KV.get("test-draft-fallback")).toBeNull();
    await env.OAUTH_KV.put("test-draft-fallback", "ready");
    try {
      expect(await testDraftFallback(withEnv("production"))).toBeUndefined();
      expect(await testDraftFallback(withEnv("test"))).toBe("ready");
    } finally {
      await env.OAUTH_KV.delete("test-draft-fallback");
    }
  });

  it("test では値を保存し、value 省略で解除する", async () => {
    const app = createDefaultApp();
    const set = await app.request(
      "/__test/draft-fallback",
      post({ value: "ready" }),
      withEnv("test"),
    );
    expect(set.status).toBe(200);
    expect(await testDraftFallback(withEnv("test"))).toBe("ready");
    const clear = await app.request("/__test/draft-fallback", post({}), withEnv("test"));
    expect(clear.status).toBe(200);
    expect(await testDraftFallback(withEnv("test"))).toBeUndefined();
  });
});
