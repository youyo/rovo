import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { createApiApp, createDefaultApp } from "./app";

// Durable Object クラスは Worker のエントリから export する（wrangler.jsonc の migrations と対応）。
export { TaskDO } from "./tasks/task-do";
export { UserDO } from "./tasks/user-do";

const apiApp = createApiApp();
const defaultApp = createDefaultApp();

// resource / issuer は公開 URL に依存する（本番は https、wrangler dev は loopback の http）。
// env は fetch 時にしか得られないため、PUBLIC_BASE_URL ごとに一度だけ組み立てて使い回す。
// 保持するのは設定だけで、ユーザー情報は含めない。
const providers = new Map<string, OAuthProvider<Env>>();

function getProvider(env: Env): OAuthProvider<Env> {
  const baseUrl = env.PUBLIC_BASE_URL.replace(/\/+$/, "");
  let provider = providers.get(baseUrl);
  if (!provider) {
    provider = new OAuthProvider<Env>({
      apiRoute: "/mcp",
      apiHandler: { fetch: apiApp.fetch },
      defaultHandler: { fetch: defaultApp.fetch },
      authorizeEndpoint: "/authorize",
      tokenEndpoint: "/oauth/token",
      clientRegistrationEndpoint: "/oauth/register",
      resourceMetadata: {
        resource: `${baseUrl}/mcp`,
        authorization_servers: [baseUrl],
        resource_name: "rovo gateway",
      },
    });
    providers.set(baseUrl, provider);
  }
  return provider;
}

export default {
  fetch(request, env, ctx) {
    return getProvider(env).fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
