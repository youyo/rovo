// wrangler types の生成物（worker-configuration.d.ts）に含まれないものを補う。
interface Env {
  /** OAuthProvider が defaultHandler / apiHandler の env に注入するヘルパー */
  OAUTH_PROVIDER: import("@cloudflare/workers-oauth-provider").OAuthHelpers;
  // ---- Worker Secret（wrangler secret put。ローカルは .dev.vars）----
  /** GitHub App のクライアントシークレット */
  GITHUB_APP_CLIENT_SECRET: string;
  /** GitHub App の App ID */
  GITHUB_APP_ID: string;
  /** GitHub App の秘密鍵（PKCS#8 の PEM）。Installation Token の発行に使う */
  GITHUB_APP_PRIVATE_KEY: string;
  /** GitHub トークンを UserDO に暗号化保存する鍵。base64 の 32 バイト */
  TOKEN_ENC_KEY: string;
  // ---- R2 アーカイブ（Phase 6 M4）----
  /**
   * アーカイブ先の R2 バケット。**任意**: wrangler.jsonc には置かない（バケット名は環境固有の値で、下流が束ねる）。
   * 無ければアーカイブをスキップする（fail-open。archive_skipped）。Unit / E2E の test 構成だけが束ねる。
   */
  LOGS?: R2Bucket;
  // ---- ENVIRONMENT=test のときだけ上書きできる GitHub の接続先 ----
  GITHUB_OAUTH_BASE?: string;
  GITHUB_API_BASE?: string;
  /** Draft PR を作れないリポジトリでの扱い。fail（既定。不正な値も fail）/ ready */
  DRAFT_PR_FALLBACK?: string;
  /** "true" のときだけ、費用を PR 本文に載せる */
  PR_SHOW_COST?: string;
  /** 月額の費用上限（USD）。未設定は 100 */
  MONTHLY_BUDGET_USD?: string;
  // TASK_BUDGET_USD（タスク 1 件に予約する予算 USD。既定 10。0 以下・不正は 10）は wrangler.jsonc の vars にあるので、
  // worker-configuration.d.ts（mise run typegen:gateway）が型を出す。読むのは src/tasks/budget.ts の taskBudgetUsd だけ。
}
