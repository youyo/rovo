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

export function registerTestRoutes(app: Hono<{ Bindings: Env }>) {
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

/** AgentDO の台本設定 RPC（apps/agent の AgentDO.setScript。ENVIRONMENT=test のときだけ動く）。 */
type ScriptableAgent = AgentRpc & { setScript(key: string, script: unknown[]): Promise<void> };

/**
 * test 環境のとき、start の前に預かった台本を AgentDO へ渡すスタブを返す。それ以外は元のスタブをそのまま返す。
 * 台本が預けられていなければ何もしない。
 */
export function withTestScripts(env: Env, agent: AgentRpc): AgentRpc {
  if (env.ENVIRONMENT !== "test") return agent;
  const scriptable = agent as ScriptableAgent;
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
  };
}
