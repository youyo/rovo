// wrangler types の生成物（worker-configuration.d.ts）に含まれないものを補う。
interface Env {
  /** OAuthProvider が defaultHandler / apiHandler の env に注入するヘルパー */
  OAUTH_PROVIDER: import("@cloudflare/workers-oauth-provider").OAuthHelpers;
  // ---- Worker Secret（wrangler secret put。ローカルは .dev.vars）----
  /** GitHub App のクライアントシークレット */
  GITHUB_APP_CLIENT_SECRET: string;
  /** GitHub トークンを UserDO に暗号化保存する鍵。base64 の 32 バイト */
  TOKEN_ENC_KEY: string;
  // ---- ENVIRONMENT=test のときだけ上書きできる GitHub の接続先 ----
  GITHUB_OAUTH_BASE?: string;
  GITHUB_API_BASE?: string;
  /** 月額の費用上限（USD）。未設定は 100 */
  MONTHLY_BUDGET_USD?: string;
}
