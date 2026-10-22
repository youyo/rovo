import type { AuditRecord } from "@rovo/audit";
import type { Hono } from "hono";
import type { AgentRpc, TaskSpec } from "./agent/contract";
import { readWorkerAudit } from "./audit-sink";
import { DIRECTORY_NAME } from "./directory/types";
import { resetProviderKeysCache } from "./provider-keys";

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

  // provider_configs のキャッシュ（KV）と失敗の記録を消す（D10b。E2E がキーの有無を切り替えたあと、5 分待たずに反映させる）
  app.post("/__test/provider-keys/reset", async (c) => {
    if (c.env.ENVIRONMENT !== "test") return c.notFound();
    await resetProviderKeysCache(c.env.OAUTH_KV);
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

  // モデル呼び出しごとの、そのとき transcript に載っていたツール結果（web ツールの結果がモデルに届いたことの確認用）
  app.post("/__test/agent/model-tool-results", async (c) => {
    if (c.env.ENVIRONMENT !== "test") return c.notFound();
    const id = await taskIdOf(c.req);
    if (!id) return c.json({ error: "task_id is required" }, 400);
    const agent = c.env.AGENT_DO.getByName(id) as unknown as {
      testModelToolResults(): Promise<string[][]>;
    };
    return c.json({ calls: await agent.testModelToolResults() });
  });

  // AgentDO / SandboxDO の診断（最後の agent イベント、sandbox の ready 時刻・restarts・bootRetries）。
  // 失敗した collect が、原因（Sandbox が終端に至らなかったのか、遅かっただけか）を追えるようにする
  app.post("/__test/agent/diagnostics", async (c) => {
    if (c.env.ENVIRONMENT !== "test") return c.notFound();
    const id = await taskIdOf(c.req);
    if (!id) return c.json({ error: "task_id is required" }, 400);
    const agent = c.env.AGENT_DO.getByName(id) as unknown as {
      testDiagnostics(): Promise<unknown>;
    };
    return c.json(await agent.testDiagnostics());
  });

  // 子エージェント（E2E の偽 AgentDO）を終端にする。phase は completed / failed、result は getResult の戻り値（ResultDto）。
  // PR の Ready 化・マージ（D9）の通しの E2E が、COMPLETED / FAILED のタスクを作るために使う
  app.post("/__test/agent/finish", async (c) => {
    if (c.env.ENVIRONMENT !== "test") return c.notFound();
    const body = (await c.req.json().catch(() => ({}))) as {
      task_id?: unknown;
      phase?: unknown;
      result?: unknown;
    };
    const id =
      typeof body.task_id === "string" && TASK_ID_RE.test(body.task_id) ? body.task_id : undefined;
    if (!id) return c.json({ error: "task_id is required" }, 400);
    if (body.phase !== "completed" && body.phase !== "failed") {
      return c.json({ error: "phase must be completed or failed" }, 400);
    }
    if (body.result !== undefined && (typeof body.result !== "object" || body.result === null)) {
      return c.json({ error: "result must be an object" }, 400);
    }
    const agent = c.env.AGENT_DO.getByName(id) as unknown as {
      testFinish(phase: "completed" | "failed", result?: unknown): Promise<void>;
    };
    await agent.testFinish(body.phase, body.result);
    return c.json({ ok: true });
  });

  // 偽の子エージェント（E2E の偽 AgentDO）にイベントを 1 つ積ませる。構造化イベント（command など）の台本に使う。
  // 本物の AgentDO には emit が無いので、gateway 単体の E2E（偽の agent Worker）だけで使う
  app.post("/__test/agent/emit", async (c) => {
    if (c.env.ENVIRONMENT !== "test") return c.notFound();
    const body = (await c.req.json().catch(() => ({}))) as {
      task_id?: unknown;
      type?: unknown;
      data?: unknown;
    };
    const id =
      typeof body.task_id === "string" && TASK_ID_RE.test(body.task_id) ? body.task_id : undefined;
    if (!id) return c.json({ error: "task_id is required" }, 400);
    if (typeof body.type !== "string" || body.type === "" || body.type.length > 64) {
      return c.json({ error: "type is required" }, 400);
    }
    if (typeof body.data !== "object" || body.data === null) {
      return c.json({ error: "data must be an object" }, 400);
    }
    const agent = c.env.AGENT_DO.getByName(id) as unknown as {
      emit(type: string, data: unknown): Promise<number>;
    };
    return c.json({ ok: true, seq: await agent.emit(body.type, body.data) });
  });

  // TaskDO の回答・steer の配送状態（pending / delivered / skipped）
  app.post("/__test/task/deliveries", async (c) => {
    if (c.env.ENVIRONMENT !== "test") return c.notFound();
    const id = await taskIdOf(c.req);
    if (!id) return c.json({ error: "task_id is required" }, 400);
    return c.json(await c.env.TASK_DO.getByName(id).testDeliveryStates());
  });

  // 索引（DirectoryDO）の 1 タスクの行。無ければ row: null
  app.post("/__test/directory/task", async (c) => {
    if (c.env.ENVIRONMENT !== "test") return c.notFound();
    const id = await taskIdOf(c.req);
    if (!id) return c.json({ error: "task_id is required" }, 400);
    return c.json({ row: await c.env.DIRECTORY_DO.getByName(DIRECTORY_NAME).testGetTask(id) });
  });

  // 索引（DirectoryDO）の consult の行（M3b）。無ければ row: null
  app.post("/__test/directory/consult", async (c) => {
    if (c.env.ENVIRONMENT !== "test") return c.notFound();
    const body = (await c.req.json().catch(() => ({}))) as { consult_id?: unknown };
    const id = typeof body.consult_id === "string" ? body.consult_id : "";
    if (!/^consult-[0-9A-HJKMNP-TV-Z]{26}$/.test(id)) {
      return c.json({ error: "consult_id is required" }, 400);
    }
    return c.json({ row: await c.env.DIRECTORY_DO.getByName(DIRECTORY_NAME).testGetConsult(id) });
  });

  // 自分の consult の consult_id と、索引に入った行の一覧（M3b の E2E 用）
  app.post("/__test/directory/consults", async (c) => {
    if (c.env.ENVIRONMENT !== "test") return c.notFound();
    const body = (await c.req.json().catch(() => ({}))) as { owner_id?: unknown };
    if (typeof body.owner_id !== "number" || !Number.isSafeInteger(body.owner_id)) {
      return c.json({ error: "owner_id is required" }, 400);
    }
    const res = await c.env.DIRECTORY_DO.getByName(DIRECTORY_NAME).listConsults({
      from: 0,
      to: Number.MAX_SAFE_INTEGER,
      ownerId: body.owner_id,
      limit: 100,
    });
    return c.json(res);
  });

  // git_token の暗号文が空になったか（finalize_done の後）。暗号文そのものは返さず、件数と真偽だけを返す
  app.post("/__test/task/token-state", async (c) => {
    if (c.env.ENVIRONMENT !== "test") return c.notFound();
    const id = await taskIdOf(c.req);
    if (!id) return c.json({ error: "task_id is required" }, 400);
    return c.json(await c.env.TASK_DO.getByName(id).testTokenState());
  });

  // 監査イベント（audit-sink.ts）。Worker 側（KV）と、task_id を渡したときはその TaskDO の記録を、時刻順に返す
  app.post("/__test/audit", async (c) => {
    if (c.env.ENVIRONMENT !== "test") return c.notFound();
    const body = (await c.req.json().catch(() => ({}))) as { task_id?: unknown };
    let taskId: string | undefined;
    if (body.task_id !== undefined) {
      taskId =
        typeof body.task_id === "string" && TASK_ID_RE.test(body.task_id)
          ? body.task_id
          : undefined;
      if (taskId === undefined) return c.json({ error: "task_id is invalid" }, 400);
    }
    const records: AuditRecord[] = await readWorkerAudit(c.env);
    if (taskId !== undefined) records.push(...(await c.env.TASK_DO.getByName(taskId).testAudit()));
    // Array.prototype.sort は安定。同じ時刻なら Worker 側 → DO 側の順のまま
    records.sort((a, b) => a.ts - b.ts);
    return c.json({ records });
  });

  // R2 アーカイブ（LOGS）に、そのタスクについて保存されたオブジェクトを返す（キー・サイズ・書き込み時刻・本文）。
  // LOGS が束ねられていない構成では bound:false。MCP のツールではなく、E2E 専用のルート。
  app.post("/__test/archive", async (c) => {
    if (c.env.ENVIRONMENT !== "test") return c.notFound();
    const id = await taskIdOf(c.req);
    if (!id) return c.json({ error: "task_id is required" }, 400);
    const bucket = c.env.LOGS;
    if (!bucket) return c.json({ bound: false, objects: [] });
    const listed = await bucket.list({ prefix: "tasks/" });
    const objects = [];
    for (const o of listed.objects) {
      if (!o.key.includes(`/${id}/`)) continue;
      const body = await bucket.get(o.key);
      objects.push({
        key: o.key,
        size: o.size,
        uploaded: o.uploaded.getTime(),
        text: (await body?.text()) ?? "",
      });
    }
    return c.json({ bound: true, objects });
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
    // consult の台本も同じ置き場（最初の user メッセージがキー）から渡す
    consult: async (request) => {
      const key = request.messages[0]?.content ?? "";
      const raw = await env.OAUTH_KV.get(SCRIPT_KEY_PREFIX + key);
      if (raw !== null) await scriptable.setScript(key, JSON.parse(raw) as unknown[]);
      return agent.consult(request);
    },
  };
}
