import type { TaskSpec } from "./agent/types";
import type { ScriptStep } from "./pi/scripted-provider";

/**
 * E2E 専用のルート（ENVIRONMENT=test のときだけ有効）。SandboxDO を HTTP から操作する。
 * 例外はメッセージを本文にして 500 で返す。
 */
export async function handleTestRoute(request: Request, env: Env): Promise<Response | undefined> {
  if (env.ENVIRONMENT !== "test" || request.method !== "POST") return undefined;
  const url = new URL(request.url);
  const agentRoute = /^\/test\/agent\/([a-z-]+)$/.exec(url.pathname);
  if (agentRoute) return handleAgentRoute(agentRoute[1] ?? "", request, env);
  const m = /^\/test\/sandbox\/([a-z-]+)$/.exec(url.pathname);
  if (!m) return undefined;
  const body = (await request.json()) as {
    name: string;
    spec?: never;
    argv?: string[];
    options?: Record<string, unknown>;
    path?: string;
    content?: string;
    credential?: { token: string; expiresAt: number };
  };
  const sandbox = env.SANDBOX_DO.getByName(body.name);
  try {
    switch (m[1]) {
      case "ensure-ready":
        await sandbox.ensureReady(body.spec as never);
        return Response.json({ ok: true });
      case "exec":
        return Response.json(await sandbox.exec(body.argv ?? [], body.options));
      case "read-file":
        return Response.json({ content: await sandbox.readFile(body.path ?? "") });
      case "write-file":
        await sandbox.writeFile(body.path ?? "", body.content ?? "");
        return Response.json({ ok: true });
      case "set-git-credential":
        await sandbox.setGitCredential(body.credential as never);
        return Response.json({ ok: true });
      case "stop":
        return Response.json(await sandbox.stop());
      case "terminate":
        return Response.json(await sandbox.terminate());
      case "destroy":
        await sandbox.destroyForTest();
        return Response.json({ ok: true });
      case "seed-workspace":
        await sandbox.seedWorkspaceForTest();
        return Response.json({ ok: true });
      case "fail-next-reap":
        await sandbox.failNextReapForTest();
        return Response.json({ ok: true });
      case "status":
        return Response.json(await sandbox.status());
      case "metrics":
        return Response.json(await sandbox.metrics());
      case "audit":
        return Response.json({ records: await sandbox.testAudit() });
      default:
        return undefined;
    }
  } catch (e) {
    return new Response(e instanceof Error ? e.message : String(e), { status: 500 });
  }
}

const AGENT_ACTIONS = [
  "set-script",
  "start",
  "cancel",
  "events",
  "result",
  "debug",
  "audit",
  "set-git-credential",
  "answer",
  "steer",
];

/** AgentDO を HTTP から操作する（台本の設定・start・cancel・イベントとresultの取得）。名前は SandboxDO と同じ task 名。 */
async function handleAgentRoute(
  action: string,
  request: Request,
  env: Env,
): Promise<Response | undefined> {
  if (!AGENT_ACTIONS.includes(action)) return undefined;
  const body = (await request.json()) as {
    name: string;
    key?: string;
    script?: ScriptStep[];
    spec?: TaskSpec;
    credential?: { token: string; expiresAt: number };
    afterSeq?: number;
    limit?: number;
    questionId?: string;
    answer?: string;
    steerId?: string;
    message?: string;
  };
  const agent = env.AGENT_DO.getByName(body.name);
  try {
    switch (action) {
      case "set-script":
        await agent.setScript(body.key ?? "", body.script ?? []);
        return Response.json({ ok: true });
      case "start":
        return Response.json(await agent.start(body.spec as TaskSpec));
      case "set-git-credential":
        return Response.json(await agent.setGitCredential(body.credential as never));
      case "answer":
        return Response.json(await agent.answer(body.questionId ?? "", body.answer ?? ""));
      case "steer":
        return Response.json(await agent.steer(body.steerId ?? "", body.message ?? ""));
      case "cancel":
        return Response.json(await agent.cancel());
      case "events":
        return Response.json(await agent.getEvents(body.afterSeq ?? 0, body.limit ?? 100));
      case "result":
        return Response.json(await agent.getResult());
      case "debug":
        return Response.json({ deadlineAt: await agent.debugDeadlineAt() });
      case "audit":
        return Response.json({ records: await agent.testAudit() });
      default:
        return undefined;
    }
  } catch (e) {
    return new Response(e instanceof Error ? e.message : String(e), { status: 500 });
  }
}
