import { AuthorizationError } from "@cloudflare/workers-oauth-provider";
import type { AuthProps } from "./props";

/** E2E 用の固定ユーザー。 */
export const STUB_USER: AuthProps = { githubUserId: 1001, login: "e2e-user" };

/**
 * E2E 専用の簡易 /authorize を有効にするか。
 * `ENVIRONMENT === "test"` のときだけ true にする（未設定・表記ゆれ・他の値はすべて無効 = fail closed）。
 */
export function isStubAuthorizeEnabled(env: { ENVIRONMENT?: string }): boolean {
  return env.ENVIRONMENT === "test";
}

/** 固定ユーザーで即座に認可を完了させ、クライアントの redirect_uri へ戻す。 */
export async function stubAuthorize(request: Request, env: Env): Promise<Response> {
  try {
    const authRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
    const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
      request: authRequest,
      userId: String(STUB_USER.githubUserId), // ":" を含められない
      metadata: {},
      scope: authRequest.scope,
      props: STUB_USER,
    });
    return Response.redirect(redirectTo, 302);
  } catch (error) {
    if (error instanceof AuthorizationError) {
      // redirect_uri が検証済みのときだけライブラリが redirectTo を持つ
      if (error.redirectTo) return Response.redirect(error.redirectTo, 302);
      return Response.json(
        { error: error.code, error_description: error.message },
        { status: 400 },
      );
    }
    throw error;
  }
}
