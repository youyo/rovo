import { createMcpHandler } from "agents/mcp/server";
import { Hono } from "hono";
import { isStubAuthorizeEnabled, stubAuthorize } from "./auth/stub-authorize";
import { createRovoServer } from "./mcp/server";

type AppEnv = { Bindings: Env };

/** OAuthProvider の apiHandler。認証済みリクエストだけがここに届く（/mcp）。 */
export function createApiApp() {
  const app = new Hono<AppEnv>();
  // factory を渡す。リクエストごとに McpServer が作られ、共有状態を持たない。
  const handler = createMcpHandler(createRovoServer);
  // Hono の c.executionCtx は OAuthProvider が渡した ExecutionContext（props 付き）そのもの。
  // 型だけ Hono 側の定義が古い（tracing / abort が無い）ので workerd の型に合わせる。
  app.all("/mcp", (c) => handler(c.req.raw, c.env, c.executionCtx as unknown as ExecutionContext));
  return app;
}

/** OAuthProvider の defaultHandler。未認証で到達する経路（/authorize など）。 */
export function createDefaultApp() {
  const app = new Hono<AppEnv>();

  app.get("/", (c) => c.text("rovo gateway"));

  app.get("/authorize", async (c) => {
    if (isStubAuthorizeEnabled(c.env)) return await stubAuthorize(c.req.raw, c.env);
    // GitHub App 連携は M2 で実装する。それまで本番では認可を完了させない。
    return c.json(
      { error: "not_implemented", error_description: "login is not available yet" },
      501,
    );
  });

  return app;
}
