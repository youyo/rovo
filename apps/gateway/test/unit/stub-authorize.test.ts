import { describe, expect, it, vi } from "vitest";
import { createDefaultApp } from "../../src/app";
import { isStubAuthorizeEnabled } from "../../src/auth/stub-authorize";

const AUTHORIZE_URL =
  "http://localhost/authorize?response_type=code&client_id=c&redirect_uri=http%3A%2F%2Flocalhost%2Fcb&code_challenge=x&code_challenge_method=S256&state=s";

function fakeEnv(environment: string | undefined) {
  const parseAuthRequest = vi.fn(async () => ({ scope: [] }));
  const completeAuthorization = vi.fn(async () => ({ redirectTo: "http://localhost/cb?code=abc" }));
  const env = {
    ENVIRONMENT: environment,
    PUBLIC_BASE_URL: "http://localhost",
    OAUTH_PROVIDER: { parseAuthRequest, completeAuthorization },
  } as unknown as Env;
  return { env, parseAuthRequest, completeAuthorization };
}

describe("isStubAuthorizeEnabled", () => {
  it("ENVIRONMENT=test のときだけ true", () => {
    expect(isStubAuthorizeEnabled({ ENVIRONMENT: "test" } as Env)).toBe(true);
  });

  it.each(["production", "staging", "Test", "TEST", "", undefined])(
    "ENVIRONMENT=%j では false（fail closed）",
    (value) => {
      expect(isStubAuthorizeEnabled({ ENVIRONMENT: value } as unknown as Env)).toBe(false);
    },
  );
});

describe("GET /authorize（defaultHandler）", () => {
  it("ENVIRONMENT=test: 固定ユーザーで即認可して redirect する", async () => {
    const { env, completeAuthorization } = fakeEnv("test");
    const res = await createDefaultApp().request(AUTHORIZE_URL, {}, env);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("http://localhost/cb?code=abc");
    expect(completeAuthorization).toHaveBeenCalledOnce();
    const arg = (completeAuthorization.mock.calls[0] as unknown[])[0] as {
      userId: string;
      props: { githubUserId: number; login: string };
    };
    expect(arg.userId).toBe("1001");
    expect(arg.props).toEqual({ githubUserId: 1001, login: "e2e-user" });
  });

  it.each(["production", "staging", "Test", "", undefined])(
    "ENVIRONMENT=%j: スタブは無効で、認可を完了させない",
    async (value) => {
      const { env, parseAuthRequest, completeAuthorization } = fakeEnv(value);
      const res = await createDefaultApp().request(AUTHORIZE_URL, {}, env);
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.headers.get("location")).toBeNull();
      expect(parseAuthRequest).not.toHaveBeenCalled();
      expect(completeAuthorization).not.toHaveBeenCalled();
    },
  );
});
