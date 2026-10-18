// OAuthProvider が defaultHandler / apiHandler の env に注入するヘルパー。
// wrangler types の生成物（worker-configuration.d.ts）には含まれないので補う。
interface Env {
  OAUTH_PROVIDER: import("@cloudflare/workers-oauth-provider").OAuthHelpers;
}
