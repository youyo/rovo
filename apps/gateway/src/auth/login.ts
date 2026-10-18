import { AuthorizationError, authorizationErrorRedirect } from "@cloudflare/workers-oauth-provider";
import type { Hono } from "hono";
import { GitHubClient, GitHubError, resolveGitHubBaseUrls } from "../github";
import type { AuthProps } from "./props";

type AppEnv = { Bindings: Env };

export interface LoginDeps {
  /** GitHub への fetch（テストで差し替える） */
  fetch?: typeof fetch;
}

interface LoginConfig {
  client: GitHubClient;
  org: string;
  team: string;
  redirectUri: string;
}

/** 設定が足りない・不正なら null（呼び出し側は 500 で止める。fail closed）。 */
function loadConfig(env: Env, deps: LoginDeps): LoginConfig | null {
  const { GITHUB_APP_CLIENT_ID: id, GITHUB_APP_CLIENT_SECRET: secret } = env;
  if (!id || !secret || !env.ALLOWED_ORG || !env.ALLOWED_TEAM || !env.PUBLIC_BASE_URL) return null;
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
    org: env.ALLOWED_ORG,
    team: env.ALLOWED_TEAM,
    redirectUri: `${env.PUBLIC_BASE_URL.replace(/\/+$/, "")}/callback`,
  };
}

const NO_STORE = { "cache-control": "no-store" };

function misconfigured(): Response {
  // 原因（どの設定が足りないか）は応答に出さない
  console.error("login_misconfigured");
  return new Response("login is not available", { status: 500, headers: NO_STORE });
}

function redirect(location: string, headers: Headers = new Headers()): Response {
  headers.set("location", location);
  headers.set("cache-control", "no-store");
  return new Response(null, { status: 302, headers });
}

/** AuthorizationError: redirect_uri が検証済みなら client へ、そうでなければ画面に返す。 */
function authorizationFailure(error: AuthorizationError): Response {
  if (error.redirectTo) return redirect(error.redirectTo);
  return Response.json(
    { error: error.code, error_description: error.message },
    { status: 400, headers: NO_STORE },
  );
}

/**
 * GitHub App のユーザー認可でログインする経路。
 *
 * state の保存（1 回限り・10 分・KV）と、開始したブラウザへの Cookie 紐付けは
 * OAuthProvider の beginUpstream / finishUpstream に任せる。
 */
export function registerLoginRoutes(app: Hono<AppEnv>, deps: LoginDeps = {}) {
  app.get("/authorize", async (c) => {
    const config = loadConfig(c.env, deps);
    if (!config) return misconfigured();
    try {
      const authRequest = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
      const { state, headers } = await c.env.OAUTH_PROVIDER.beginUpstream(authRequest);
      return redirect(
        config.client.authorizeUrl({ redirectUri: config.redirectUri, state }),
        headers,
      );
    } catch (error) {
      if (error instanceof AuthorizationError) return authorizationFailure(error);
      throw error;
    }
  });

  app.get("/callback", async (c) => {
    const config = loadConfig(c.env, deps);
    if (!config) return misconfigured();

    let resumed: Awaited<ReturnType<Env["OAUTH_PROVIDER"]["finishUpstream"]>>;
    try {
      // state の不一致・再使用・期限切れ・Cookie 無し（別のブラウザ）はここで拒否される
      resumed = await c.env.OAUTH_PROVIDER.finishUpstream(c.req.raw);
    } catch (error) {
      if (error instanceof AuthorizationError) {
        return new Response("The sign-in session is invalid or has expired. Please start again.", {
          status: 400,
          headers: NO_STORE,
        });
      }
      throw error;
    }
    const { request: original, headers } = resumed;
    const fail = (code: "access_denied" | "invalid_request" | "temporarily_unavailable") =>
      redirect(authorizationErrorRedirect(original, code), headers);

    const params = new URL(c.req.url).searchParams;
    if (params.get("error")) return fail("access_denied");
    const code = params.get("code");
    if (!code) return fail("invalid_request");

    try {
      const tokens = await config.client.exchangeCode({ code, redirectUri: config.redirectUri });
      const user = await config.client.getUser(tokens.accessToken);
      const member = await config.client.isActiveTeamMember(tokens.accessToken, {
        org: config.org,
        teamSlug: config.team,
        username: user.login,
      });
      if (!member) return fail("access_denied");

      await c.env.USER_DO.getByName(String(user.id)).saveCredential(tokens);

      // props は識別子だけ。GitHub のトークンは UserDO に置き、ここには入れない。
      const props: AuthProps = { githubUserId: user.id, login: user.login };
      const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
        request: original,
        userId: String(user.id), // ":" を含められない。数字文字列
        metadata: {},
        scope: original.scope,
        props,
      });
      return redirect(redirectTo, headers);
    } catch (error) {
      if (error instanceof GitHubError) {
        return fail(
          error.code === "upstream_unavailable" ? "temporarily_unavailable" : "access_denied",
        );
      }
      throw error;
    }
  });
}
