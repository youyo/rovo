import { AgentDO } from "./agent-do";
import { OutboundGateway } from "./outbound-gateway";
import { SandboxDO } from "./sandbox-do";
import { handleTestRoute } from "./test-routes";

export { AgentDO, OutboundGateway, SandboxDO };

export default {
  async fetch(request, env): Promise<Response> {
    // E2E 専用のルート。本番（ENVIRONMENT=production）では無効。
    const test = await handleTestRoute(request, env);
    if (test) return test;
    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
