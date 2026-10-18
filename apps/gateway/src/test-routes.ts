import type { Hono } from "hono";
import type { AgentRpc, TaskSpec } from "./agent/contract";

/**
 * 通しの E2E 専用の仕組み（ENVIRONMENT=test のときだけ有効。それ以外は 404 / 何もしない）。
 *
 * 子エージェントの fake モデルの台本は、AgentDO.setScript(key, script) で AgentDO（1 task = 1 インスタンス、
 * 名前は task_id）に置く。しかし task_id は task_start の応答で初めて決まり、その時点で子エージェントは
 * もう動き出している（Sandbox が速いと最初のモデル呼び出しに間に合わない）。そこで次の 2 段にする。
 *   1. POST /__test/agent/set-script {key, script}: 台本を KV（key = task_start の instructions）に預ける
 *   2. TaskDO が AgentDO.start を呼ぶ直前に withTestScripts が、預かった台本を setScript で渡す
 */

const SCRIPT_KEY_PREFIX = "test-script:";
const SCRIPT_TTL_SECONDS = 3600;

const DRAFT_FALLBACK_KEY = "test-draft-fallback";
const HOLD_DELIVERIES_KEY = "test-hold-deliveries";
const TASK_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** 通しの E2E が預けた DRAFT_PR_FALLBACK の上書き値。test 環境以外・未設定なら undefined。 */
export async function testDraftFallback(env: Env): Promise<string | undefined> {
  if (env.ENVIRONMENT !== "test") return undefined;
  return (await env.OAUTH_KV.get(DRAFT_FALLBACK_KEY)) ?? undefined;
}

export function registerTestRoutes(app: Hono<{ Bindings: Env }>) {
  // DRAFT_PR_FALLBACK を実行中に切り替える（value 省略で上書きを解除）
  app.post("/__test/draft-fallback", async (c) => {
    if (c.env.ENVIRONMENT !== "test") return c.notFound();
    const body = (await c.req.json().catch(() => ({}))) as { value?: unknown };
    if (typeof body.value === "string") await c.env.OAUTH_KV.put(DRAFT_FALLBACK_KEY, body.value);
    else await c.env.OAUTH_KV.delete(DRAFT_FALLBACK_KEY);
    return c.json({ ok: true });
  });

  // 回答と steer の AgentDO への配送を保留する（TaskDO には「未配送の意図」が残る。cancel で skipped になることの確認用）
  app.post("/__test/hold-deliveries", async (c) => {
    if (c.env.ENVIRONMENT !== "test") return c.notFound();
    const body = (await c.req.json().catch(() => ({}))) as { value?: unknown };
    if (body.value === true) await c.env.OAUTH_KV.put(HOLD_DELIVERIES_KEY, "1");
    else await c.env.OAUTH_KV.delete(HOLD_DELIVERIES_KEY);
    return c.json({ ok: true });
  });

  // モデル呼び出しごとの user メッセージ（回答・steer がモデルに届いたことの確認用）
  app.post("/__test/agent/model-calls", async (c) => {
    if (c.env.ENVIRONMENT !== "test") return c.notFound();
    const id = await taskIdOf(c.req);
    if (!id) return c.json({ error: "task_id is required" }, 400);
    const agent = c.env.AGENT_DO.getByName(id) as unknown as {
      testModelCalls(): Promise<string[][]>;
    };
    return c.json({ calls: await agent.testModelCalls() });
  });

  // TaskDO の回答・steer の配送状態（pending / delivered / skipped）
  app.post("/__test/task/deliveries", async (c) => {
    if (c.env.ENVIRONMENT !== "test") return c.notFound();
    const id = await taskIdOf(c.req);
    if (!id) return c.json({ error: "task_id is required" }, 400);
    return c.json(await c.env.TASK_DO.getByName(id).testDeliveryStates());
  });

  app.post("/__test/agent/set-script", async (c) => {
    if (c.env.ENVIRONMENT !== "test") return c.notFound();
    let body: { key?: unknown; script?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }
    if (typeof body.key !== "string" || body.key === "" || !Array.isArray(body.script)) {
      return c.json({ error: "key (non-empty string) and script (array) are required" }, 400);
    }
    await c.env.OAUTH_KV.put(SCRIPT_KEY_PREFIX + body.key, JSON.stringify(body.script), {
      expirationTtl: SCRIPT_TTL_SECONDS,
    });
    return c.json({ ok: true });
  });
}

async function taskIdOf(req: { json(): Promise<unknown> }): Promise<string | undefined> {
  const body = (await req.json().catch(() => ({}))) as { task_id?: unknown };
  return typeof body.task_id === "string" && TASK_ID_RE.test(body.task_id)
    ? body.task_id
    : undefined;
}

/** AgentDO の台本設定 RPC（apps/agent の AgentDO.setScript。ENVIRONMENT=test のときだけ動く）。 */
type ScriptableAgent = AgentRpc & { setScript(key: string, script: unknown[]): Promise<void> };

/**
 * test 環境のとき、start の前に預かった台本を AgentDO へ渡すスタブを返す。それ以外は元のスタブをそのまま返す。
 * 台本が預けられていなければ何もしない。
 */
export function withTestScripts(env: Env, agent: AgentRpc): AgentRpc {
  if (env.ENVIRONMENT !== "test") return agent;
  const scriptable = agent as ScriptableAgent;
  // 回答と steer の配送を保留する間は、AgentDO に届けず ok:false を返す（TaskDO は pending のまま再送を続ける）
  const held = async () => (await env.OAUTH_KV.get(HOLD_DELIVERIES_KEY)) !== null;
  return {
    start: async (spec: TaskSpec) => {
      const raw = await env.OAUTH_KV.get(SCRIPT_KEY_PREFIX + spec.instructions);
      if (raw !== null) await scriptable.setScript(spec.instructions, JSON.parse(raw) as unknown[]);
      return agent.start(spec);
    },
    cancel: () => agent.cancel(),
    getEvents: (afterSeq, limit) => agent.getEvents(afterSeq, limit),
    getResult: () => agent.getResult(),
    setGitCredential: (c) => agent.setGitCredential(c),
    answer: async (questionId, answer) =>
      (await held()) ? { ok: false } : agent.answer(questionId, answer),
    steer: async (steerId, message) =>
      (await held()) ? { ok: false } : agent.steer(steerId, message),
  };
}
