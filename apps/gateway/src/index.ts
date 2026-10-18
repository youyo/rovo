import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { createApiApp, createDefaultApp } from "./app";
import { auditFromWorker } from "./audit-sink";

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

/**
 * OAuthProvider が弾いた認証の失敗を監査する（/mcp に提示されたトークンの拒否、/oauth/token の拒否）。
 * トークンを提示していないリクエスト（MCP クライアントの最初の探索）は失敗ではないので出さない。
 * リクエストの内容（ヘッダの値・本文・URL）は出さず、固定コードと requestId（cf-ray）だけを出す。
 */
async function auditAuthFailure(request: Request, response: Response, env: Env): Promise<void> {
  try {
    const { pathname } = new URL(request.url);
    let reason: string | undefined;
    if (pathname === "/mcp" && response.status === 401) {
      if (request.headers.has("authorization")) reason = "token_rejected";
    } else if (pathname === "/oauth/token" && response.status >= 400 && response.status < 500) {
      reason = "token_request_rejected";
    }
    if (reason === undefined) return;
    const requestId = request.headers.get("cf-ray") ?? undefined;
    await auditFromWorker(env, "auth_failed", {
      caller: "parent",
      reason,
      ...(requestId !== undefined ? { requestId } : {}),
    });
  } catch {
    // 監査の失敗で応答を壊さない
  }
}

export default {
  async fetch(request, env, ctx) {
    const response = await getProvider(env).fetch(request, env, ctx);
    await auditAuthFailure(request, response, env);
    return response;
  },
} satisfies ExportedHandler<Env>;
