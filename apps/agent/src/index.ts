import { AgentDO } from "./agent-do";
import { OutboundGateway } from "./outbound-gateway";
import { SandboxDO } from "./sandbox-do";

export { AgentDO, OutboundGateway, SandboxDO };

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    // E2E 専用のルート。本番（ENVIRONMENT=production）では無効。
    if (
      env.ENVIRONMENT === "test" &&
      url.pathname === "/test/sandbox/exec" &&
      request.method === "POST"
    ) {
      const { name, argv, options } = (await request.json()) as {
        name: string;
        argv: string[];
        options?: Record<string, unknown>;
      };
      const sandbox = env.SANDBOX_DO.getByName(name);
      return Response.json(await sandbox.exec(argv, options));
    }
    if (
      env.ENVIRONMENT === "test" &&
      url.pathname === "/test/sandbox/stop" &&
      request.method === "POST"
    ) {
      const { name } = (await request.json()) as { name: string };
      await env.SANDBOX_DO.getByName(name).stop();
      return Response.json({ stopped: true });
    }
    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
