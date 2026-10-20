import type { AuditCaller } from "@rovo/audit";
import { auditFromWorker } from "../audit-sink";
import { GitHubClient, GitHubError, resolveGitHubBaseUrls } from "../github";
import { type AllowRules, isUserIdAllowed, loadAllowRules } from "./allowlist";

/**
 * ログインの共通部分。MCP の認可（/authorize → /callback）とダッシュボードのログイン（/dashboard/auth/login → /callback）が
 * 同じ関数で身元確認をする。許可ルールの判定が 2 か所でずれないように、二重実装はしない
 * （docs/specs/dashboard.md D2）。流用しないのは MCP の認可の復元（finishUpstream / completeAuthorization）。
 */

export interface LoginDeps {
  /** GitHub への fetch（テストで差し替える） */
  fetch?: typeof fetch;
}

export interface LoginConfig {
  client: GitHubClient;
  rules: AllowRules;
  redirectUri: string;
}

/** 設定が足りない・不正なら null（呼び出し側は 500 で止める。fail closed）。 */
export function loadConfig(env: Env, deps: LoginDeps): LoginConfig | null {
  const { GITHUB_APP_CLIENT_ID: id, GITHUB_APP_CLIENT_SECRET: secret } = env;
  if (!id || !secret || !env.PUBLIC_BASE_URL) return null;
  // org/team と user ID の許可ルール。不正・不足（org/team の片方だけ、ID の不正な要素など）なら null
  const rules = loadAllowRules(env);
  if (!rules) return null;
  let urls: ReturnType<typeof resolveGitHubBaseUrls>;
  try {
    // 本番（ENVIRONMENT !== "test"）で既定値以外が指定されていたら例外
    urls = resolveGitHubBaseUrls(env);
  } catch {
    return null;
  }
  return {
    client: new GitHubClient({
      clientId: id,
      clientSecret: secret,
      oauthBase: urls.oauthBase,
      apiBase: urls.apiBase,
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
    }),
    rules,
    redirectUri: `${env.PUBLIC_BASE_URL.replace(/\/+$/, "")}/callback`,
  };
}

export type IdentityResult =
  | { ok: true; user: { id: number; login: string } }
  /** 許可ルールを通らない / GitHub が code を拒否した（認証・認可の失敗） */
  | { ok: false; kind: "denied" }
  /** GitHub の一時的な障害（認証の失敗ではない） */
  | { ok: false; kind: "unavailable" };

/**
 * code を GitHub のユーザートークンに交換し、本人と許可ルールを確かめ、通れば資格を保存する。
 * 失敗の監査（固定コードだけ。GitHub の応答の内容・トークン・login は出さない）もここで出す。caller で呼び出し元を区別する。
 * GitHubError 以外の例外（DO の障害など）はそのまま投げる。
 */
export async function verifyIdentity(
  env: Env,
  config: LoginConfig,
  code: string,
  caller: AuditCaller,
): Promise<IdentityResult> {
  try {
    const tokens = await config.client.exchangeCode({ code, redirectUri: config.redirectUri });
    const user = await config.client.getUser(tokens.accessToken);
    // user ID のルールは GET /user で得た id で判定する。通らず、org/team の対があるときだけ team を確認する
    const { rules } = config;
    const member =
      isUserIdAllowed(rules, user.id) ||
      (rules.team !== null &&
        (await config.client.isActiveTeamMember(tokens.accessToken, {
          org: rules.team.org,
          teamSlug: rules.team.team,
          username: user.login,
        })));
    if (!member) {
      await auditFromWorker(env, "authz_denied", {
        userId: user.id,
        caller,
        reason: "not_team_member",
      });
      return { ok: false, kind: "denied" };
    }
    await env.USER_DO.getByName(String(user.id)).saveCredential(tokens);
    return { ok: true, user: { id: user.id, login: user.login } };
  } catch (error) {
    if (error instanceof GitHubError) {
      // 一時的な障害（upstream_unavailable）は認証の失敗ではない
      if (error.code === "upstream_unavailable") return { ok: false, kind: "unavailable" };
      await auditFromWorker(env, "auth_failed", { caller, reason: "code_exchange_rejected" });
      return { ok: false, kind: "denied" };
    }
    throw error;
  }
}
