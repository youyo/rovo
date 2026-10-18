import { createMcpHandler } from "agents/mcp/server";
import { Hono } from "hono";
import { type LoginDeps, registerLoginRoutes } from "./auth/login";
import { createRovoServer } from "./mcp/server";

type AppEnv = { Bindings: Env };

/** OAuthProvider の apiHandler。認証済みリクエストだけがここに届く（/mcp）。 */
export function createApiApp() {
  const app = new Hono<AppEnv>();
  // リクエストごとに handler と McpServer を作る。env を閉じ込めるだけで、ユーザー情報は持たない
  // （props はツール実行時に getMcpAuthContext() から読む）。
  // Hono の c.executionCtx は OAuthProvider が渡した ExecutionContext（props 付き）そのもの。
  // 型だけ Hono 側の定義が古い（tracing / abort が無い）ので workerd の型に合わせる。
  app.all("/mcp", (c) => {
    const handler = createMcpHandler(() => createRovoServer(c.env));
    return handler(c.req.raw, c.env, c.executionCtx as unknown as ExecutionContext);
  });
  return app;
}

/** OAuthProvider の defaultHandler。未認証で到達する経路（/authorize・/callback）。 */
export function createDefaultApp(deps: LoginDeps = {}) {
  const app = new Hono<AppEnv>();

  app.get("/", (c) => c.text("rovo gateway"));
  registerLoginRoutes(app, deps);

  // 想定外の例外は内容を出さない（トークンやスタックを漏らさない）
  app.onError((error, c) => {
    console.error("default_handler_error", error instanceof Error ? error.name : typeof error);
    return c.text("internal error", 500, { "cache-control": "no-store" });
  });

  return app;
}
