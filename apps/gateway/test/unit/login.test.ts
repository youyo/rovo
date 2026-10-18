import { AuthorizationError } from "@cloudflare/workers-oauth-provider";
import { describe, expect, it, vi } from "vitest";
import { createDefaultApp } from "../../src/app";
import { json, routerFetch, tokenResponse } from "./github/helpers";

const BASE = "https://rovo.example.com";
const AUTHORIZE_URL = `${BASE}/authorize?response_type=code&client_id=c&redirect_uri=http%3A%2F%2Flocalhost%2Fcb&code_challenge=x&code_challenge_method=S256&state=s`;
const CALLBACK_URL = `${BASE}/callback?code=gh-code&state=UP`;
const AUTH_REQUEST = {
  responseType: "code",
  clientId: "c",
  redirectUri: "http://localhost/cb",
  scope: [],
  state: "client-state",
  codeChallenge: "x",
  codeChallengeMethod: "S256",
};

type EnvOver = Record<string, unknown>;

function makeEnv(over: EnvOver = {}) {
  const provider = {
    parseAuthRequest: vi.fn(async () => AUTH_REQUEST),
    beginUpstream: vi.fn(async () => ({
      state: "UP",
      headers: new Headers({ "set-cookie": "__Host-oauth-upstream-x=1; Secure; HttpOnly" }),
    })),
    finishUpstream: vi.fn(async () => ({
      request: AUTH_REQUEST,
      data: undefined,
      headers: new Headers({ "set-cookie": "__Host-oauth-upstream-x=; Max-Age=0" }),
    })),
    completeAuthorization: vi.fn(async () => ({
      redirectTo: "http://localhost/cb?code=mcp-code&state=client-state",
    })),
  };
  const saveCredential = vi.fn(async () => {});
  const env = {
    ENVIRONMENT: "production",
    PUBLIC_BASE_URL: BASE,
    GITHUB_APP_CLIENT_ID: "app-id",
    GITHUB_APP_CLIENT_SECRET: "app-secret",
    ALLOWED_ORG: "acme",
    ALLOWED_TEAM: "core",
    TOKEN_ENC_KEY: "unused",
    OAUTH_PROVIDER: provider,
    USER_DO: { getByName: vi.fn(() => ({ saveCredential })) },
    ...over,
  } as unknown as Env;
  return { env, provider, saveCredential };
}

function githubFetch(opts: { team?: "active" | "pending" | "none"; tokenStatus?: number } = {}) {
  return routerFetch({
    "POST /login/oauth/access_token": () =>
      opts.tokenStatus
        ? json({ message: "x" }, { status: opts.tokenStatus })
        : tokenResponse({ access_token: "ghu_SECRET_ACCESS", refresh_token: "ghr_SECRET_REFRESH" }),
    "GET /user": () => json({ id: 1001, login: "alice" }),
    "GET /orgs/acme/teams/core/memberships/alice": () =>
      opts.team === "none"
        ? json({ message: "Not Found" }, { status: 404 })
        : json({ state: opts.team ?? "active" }),
  });
}

const app = (fetchImpl?: typeof fetch) => createDefaultApp({ fetch: fetchImpl });

describe("GET /authorize（GitHub App のユーザー認可へ）", () => {
  it("本番: GitHub の authorize URL へ redirect する。MCP の認可は完了させない", async () => {
    const { env, provider } = makeEnv();
    const res = await app().request(AUTHORIZE_URL, {}, env);
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location") ?? "");
    expect(loc.origin + loc.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(loc.searchParams.get("client_id")).toBe("app-id");
    expect(loc.searchParams.get("redirect_uri")).toBe(`${BASE}/callback`);
    expect(loc.searchParams.get("state")).toBe("UP");
    expect(loc.searchParams.get("code")).toBeNull();
    expect(res.headers.get("set-cookie")).toContain("__Host-oauth-upstream-");
    expect(provider.beginUpstream).toHaveBeenCalledWith(AUTH_REQUEST);
    expect(provider.completeAuthorization).not.toHaveBeenCalled();
  });

  it.each(["production", "test", "staging", "Test", "", undefined])(
    "ENVIRONMENT=%j でも /authorize は固定ユーザーで認可を完了させない（スタブは無い）",
    async (environment) => {
      const { env, provider } = makeEnv({ ENVIRONMENT: environment });
      const res = await app().request(AUTHORIZE_URL, {}, env);
      expect(provider.completeAuthorization).not.toHaveBeenCalled();
      const loc = res.headers.get("location");
      if (loc) expect(new URL(loc).searchParams.get("code")).toBeNull();
    },
  );

  it("ENVIRONMENT=test のときだけ GITHUB_OAUTH_BASE を差し替えられる", async () => {
    const { env } = makeEnv({ ENVIRONMENT: "test", GITHUB_OAUTH_BASE: "http://127.0.0.1:9999" });
    const res = await app().request(AUTHORIZE_URL, {}, env);
    expect(res.headers.get("location")).toMatch(
      /^http:\/\/127\.0\.0\.1:9999\/login\/oauth\/authorize\?/,
    );
  });

  it("本番で GITHUB_OAUTH_BASE を差し替えようとすると拒否（fail closed）", async () => {
    const { env, provider } = makeEnv({ GITHUB_OAUTH_BASE: "https://evil.example.com" });
    const res = await app().request(AUTHORIZE_URL, {}, env);
    expect(res.status).toBe(500);
    expect(res.headers.get("location")).toBeNull();
    expect(provider.beginUpstream).not.toHaveBeenCalled();
  });

  it.each(["GITHUB_APP_CLIENT_ID", "GITHUB_APP_CLIENT_SECRET", "ALLOWED_ORG", "ALLOWED_TEAM"])(
    "%s が未設定ならログインを開始しない",
    async (name) => {
      const { env, provider } = makeEnv({ [name]: "" });
      const res = await app().request(AUTHORIZE_URL, {}, env);
      expect(res.status).toBe(500);
      expect(res.headers.get("location")).toBeNull();
      expect(provider.beginUpstream).not.toHaveBeenCalled();
    },
  );

  it("redirect_uri が検証済みの AuthorizationError は client へ error redirect", async () => {
    const { env, provider } = makeEnv();
    provider.parseAuthRequest.mockRejectedValueOnce(
      new AuthorizationError("invalid_scope", {
        description: "bad",
        redirectUri: "http://localhost/cb",
        state: "s",
      }),
    );
    const res = await app().request(AUTHORIZE_URL, {}, env);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("error=invalid_scope");
    expect(provider.beginUpstream).not.toHaveBeenCalled();
  });

  it("redirect_uri が未検証の AuthorizationError は redirect せず 400", async () => {
    const { env, provider } = makeEnv();
    provider.parseAuthRequest.mockRejectedValueOnce(
      new AuthorizationError("invalid_request", { description: "unknown client" }),
    );
    const res = await app().request(AUTHORIZE_URL, {}, env);
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
    expect(provider.beginUpstream).not.toHaveBeenCalled();
  });
});

describe("GET /callback", () => {
  it("成功: 資格を UserDO に保存し、props は githubUserId と login だけで MCP の認可を完了する", async () => {
    const gh = githubFetch();
    const { env, provider, saveCredential } = makeEnv();
    const res = await app(gh.fetch).request(CALLBACK_URL, {}, env);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "http://localhost/cb?code=mcp-code&state=client-state",
    );
    expect(res.headers.get("set-cookie")).toContain("Max-Age=0"); // 紐付け Cookie は消す

    expect(env.USER_DO.getByName).toHaveBeenCalledWith("1001");
    expect(saveCredential).toHaveBeenCalledOnce();
    const saved = (saveCredential.mock.calls[0] as unknown[])[0] as { accessToken: string };
    expect(saved.accessToken).toBe("ghu_SECRET_ACCESS");

    expect(provider.completeAuthorization).toHaveBeenCalledOnce();
    const arg = (provider.completeAuthorization.mock.calls[0] as unknown[])[0] as Record<
      string,
      unknown
    >;
    expect(arg.userId).toBe("1001");
    expect(arg.props).toEqual({ githubUserId: 1001, login: "alice" });
    expect(JSON.stringify(arg)).not.toMatch(/ghu_|ghr_/); // props / metadata にトークンを入れない
    // token 交換の redirect_uri は /authorize と同じ
    const exchange = gh.calls.find((c) => c.url.endsWith("/login/oauth/access_token"));
    expect(await exchange?.clone().json()).toMatchObject({
      code: "gh-code",
      redirect_uri: `${BASE}/callback`,
    });
  });

  it("state / Cookie が不正（finishUpstream が拒否）なら 400。GitHub を呼ばず、認可も完了しない", async () => {
    const gh = githubFetch();
    const { env, provider, saveCredential } = makeEnv();
    provider.finishUpstream.mockRejectedValueOnce(
      new AuthorizationError("invalid_request", { description: "state mismatch" }),
    );
    const res = await app(gh.fetch).request(CALLBACK_URL, {}, env);
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
    expect(gh.calls).toHaveLength(0);
    expect(saveCredential).not.toHaveBeenCalled();
    expect(provider.completeAuthorization).not.toHaveBeenCalled();
  });

  it("GitHub 側で拒否された（error=access_denied）なら client へ access_denied", async () => {
    const gh = githubFetch();
    const { env, provider } = makeEnv();
    const res = await app(gh.fetch).request(
      `${BASE}/callback?error=access_denied&state=UP`,
      {},
      env,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("error=access_denied");
    expect(gh.calls).toHaveLength(0);
    expect(provider.completeAuthorization).not.toHaveBeenCalled();
  });

  it("code が無ければ invalid_request で client へ返す", async () => {
    const gh = githubFetch();
    const { env, provider } = makeEnv();
    const res = await app(gh.fetch).request(`${BASE}/callback?state=UP`, {}, env);
    expect(res.headers.get("location")).toContain("error=invalid_request");
    expect(provider.completeAuthorization).not.toHaveBeenCalled();
  });

  it.each(["none", "pending"] as const)(
    "team の状態が %s ならログインさせない（資格を保存せず access_denied）",
    async (team) => {
      const gh = routerFetch({
        "POST /login/oauth/access_token": () => tokenResponse(),
        "GET /user": () => json({ id: 1001, login: "alice" }),
        "GET /orgs/acme/teams/core/memberships/alice": () =>
          team === "none" ? json({ message: "Not Found" }, { status: 404 }) : json({ state: team }),
      });
      const { env, provider, saveCredential } = makeEnv();
      const res = await app(gh.fetch).request(CALLBACK_URL, {}, env);
      expect(res.status).toBe(302);
      const loc = new URL(res.headers.get("location") ?? "");
      expect(loc.searchParams.get("error")).toBe("access_denied");
      expect(loc.searchParams.get("code")).toBeNull();
      expect(saveCredential).not.toHaveBeenCalled();
      expect(provider.completeAuthorization).not.toHaveBeenCalled();
    },
  );

  it("GitHub の code 交換が拒否されたら access_denied、5xx なら temporarily_unavailable", async () => {
    const bad = routerFetch({
      "POST /login/oauth/access_token": () => json({ error: "bad_verification_code" }),
    });
    const a = makeEnv();
    const r1 = await app(bad.fetch).request(CALLBACK_URL, {}, a.env);
    expect(r1.headers.get("location")).toContain("error=access_denied");

    const down = githubFetch({ tokenStatus: 503 });
    const b = makeEnv();
    const r2 = await app(down.fetch).request(CALLBACK_URL, {}, b.env);
    expect(r2.headers.get("location")).toContain("error=temporarily_unavailable");
    expect(a.provider.completeAuthorization).not.toHaveBeenCalled();
    expect(b.provider.completeAuthorization).not.toHaveBeenCalled();
  });

  it("資格の保存に失敗したら 500。認可を完了させず、トークンを応答に出さない", async () => {
    const gh = githubFetch();
    const { env, provider, saveCredential } = makeEnv();
    saveCredential.mockRejectedValueOnce(new Error("disk ghu_SECRET_ACCESS exploded"));
    const res = await app(gh.fetch).request(CALLBACK_URL, {}, env);
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toMatch(/ghu_|exploded/);
    expect(provider.completeAuthorization).not.toHaveBeenCalled();
  });
});
