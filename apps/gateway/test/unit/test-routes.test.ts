import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { AgentRpc, TaskSpec } from "../../src/agent/contract";
import { createDefaultApp } from "../../src/app";
import { withTestScripts } from "../../src/test-routes";

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
