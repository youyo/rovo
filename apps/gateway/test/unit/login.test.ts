import { env as workerEnv } from "cloudflare:workers";
import { AuthorizationError } from "@cloudflare/workers-oauth-provider";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultApp } from "../../src/app";
import { readWorkerAudit } from "../../src/audit-sink";
import { json, routerFetch, tokenResponse } from "./github/helpers";
import { clearWorkerAudit } from "./helpers";

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
    describeConsent: vi.fn(async () => ({
      clientId: "c",
      clientName: "<img src=x onerror=alert(1)>Evil & Co",
      redirectUri: "http://localhost/cb",
      redirectHost: "localhost",
      redirectIsLoopback: true,
      scope: ['read"<b>'],
    })),
    beginConsent: vi.fn(async () => ({
      handle: "HANDLE-1",
      headers: new Headers({
        "set-cookie": "__Host-oauth-consent-x=1; Secure; HttpOnly; SameSite=Lax",
        "cache-control": "no-store",
        "content-security-policy": "frame-ancestors 'none'",
        "x-frame-options": "DENY",
      }),
    })),
    approveConsent: vi.fn(async (_req: unknown, _handle: string, _opts?: unknown) => ({
      request: AUTH_REQUEST,
      headers: new Headers({ "set-cookie": "__Host-oauth-consent-x=; Max-Age=0" }),
    })),
    denyConsent: vi.fn(async () => ({
      request: AUTH_REQUEST,
      redirectTo: "http://localhost/cb?error=access_denied&state=client-state",
      headers: new Headers({
        location: "http://localhost/cb?error=access_denied&state=client-state",
        "set-cookie": "__Host-oauth-consent-x=; Max-Age=0",
      }),
    })),
    beginUpstream: vi.fn(async (_req: unknown, opts?: { headers?: Headers }) => {
      const headers = opts?.headers ?? new Headers();
      headers.append("set-cookie", "__Host-oauth-upstream-x=1; Secure; HttpOnly");
      return { state: "UP", headers };
    }),
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

const approveForm = (over: Record<string, string> = {}) =>
  new URLSearchParams({ handle: "HANDLE-1", decision: "approve", ...over });

function post(env: Env, form: URLSearchParams | string) {
  return app().request(
    `${BASE}/authorize`,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: "__Host-x=1" },
      body: form.toString(),
    },
    env,
  );
}

describe("GET /authorize（同意画面。承認するまで GitHub へ行かない）", () => {
  it("同意画面を表示し、承認前に GitHub へ redirect せず、MCP の認可も完了させない", async () => {
    const { env, provider } = makeEnv();
    const res = await app().request(AUTHORIZE_URL, {}, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(provider.beginUpstream).not.toHaveBeenCalled();
    expect(provider.completeAuthorization).not.toHaveBeenCalled();
    expect(provider.beginConsent).toHaveBeenCalledWith(AUTH_REQUEST);
    // 同意の紐付け Cookie（ライブラリが発行）はそのまま返す
    expect(res.headers.get("set-cookie")).toContain("__Host-oauth-consent-");
  });

  it("client 名・redirect_uri のホスト・フル URI・scope を表示し、client 由来の文字列はすべてエスケープする", async () => {
    const { env } = makeEnv();
    const html = await (await app().request(AUTHORIZE_URL, {}, env)).text();
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<b>");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;Evil &amp; Co");
    expect(html).toContain("<strong>localhost</strong>");
    expect(html).toContain("http://localhost/cb");
    expect(html).toContain("read&quot;&lt;b&gt;");
    expect(html).toContain('name="handle" value="HANDLE-1"');
    expect(html).toContain('value="approve"');
    expect(html).toContain('value="deny"');
    expect(html).toMatch(/method="post"/i);
  });

  it("clickjacking 対策と CSP のヘッダが付く", async () => {
    const { env } = makeEnv();
    const res = await app().request(AUTHORIZE_URL, {}, env);
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("style-src 'unsafe-inline'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).not.toMatch(/script-src|unsafe-eval/);
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("設定が不足していれば同意画面も出さない（fail closed）", async () => {
    const { env, provider } = makeEnv({ ALLOWED_ORG: "" });
    const res = await app().request(AUTHORIZE_URL, {}, env);
    expect(res.status).toBe(500);
    expect(provider.beginConsent).not.toHaveBeenCalled();
  });

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
    expect(provider.beginConsent).not.toHaveBeenCalled();
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
    expect(provider.beginConsent).not.toHaveBeenCalled();
  });
});

describe("POST /authorize（同意の送信）", () => {
  it("承認: 同意を消費してから beginUpstream で GitHub の authorize URL へ redirect する", async () => {
    const { env, provider } = makeEnv();
    const res = await post(env, approveForm());
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location") ?? "");
    expect(loc.origin + loc.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(loc.searchParams.get("client_id")).toBe("app-id");
    expect(loc.searchParams.get("redirect_uri")).toBe(`${BASE}/callback`);
    expect(loc.searchParams.get("state")).toBe("UP");
    expect(loc.searchParams.get("code")).toBeNull();
    const cookies = res.headers.get("set-cookie") ?? "";
    expect(cookies).toContain("__Host-oauth-upstream-");
    expect(cookies).toContain("__Host-oauth-consent-x=;"); // 同意の Cookie は消す
    expect(provider.approveConsent).toHaveBeenCalledOnce();
    expect((provider.approveConsent.mock.calls[0] as unknown[])[1]).toBe("HANDLE-1");
    // beginUpstream に渡すのは保存済み（検証済み）の request。フォームの値ではない
    expect((provider.beginUpstream.mock.calls[0] as unknown[])[0]).toBe(AUTH_REQUEST);
    expect(provider.completeAuthorization).not.toHaveBeenCalled();
    expect(provider.denyConsent).not.toHaveBeenCalled();
  });

  it("承認の scope はフォームから受け取らない（client が要求した範囲のまま）", async () => {
    const { env, provider } = makeEnv();
    const form = approveForm();
    form.append("scope", "admin");
    await post(env, form);
    expect((provider.approveConsent.mock.calls[0] as unknown[])[2]).toBeUndefined();
  });

  it("拒否: client の redirect_uri へ access_denied。GitHub へは行かない", async () => {
    const { env, provider } = makeEnv();
    const res = await post(env, approveForm({ decision: "deny" }));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "http://localhost/cb?error=access_denied&state=client-state",
    );
    expect(res.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(provider.denyConsent).toHaveBeenCalledOnce();
    expect(provider.approveConsent).not.toHaveBeenCalled();
    expect(provider.beginUpstream).not.toHaveBeenCalled();
  });

  it.each(["", "APPROVE", "yes", "approve "])(
    "decision が %j（approve 以外）なら承認として扱わない",
    async (decision) => {
      const { env, provider } = makeEnv();
      const res = await post(env, approveForm({ decision }));
      expect(res.headers.get("location")).toContain("error=access_denied");
      expect(provider.approveConsent).not.toHaveBeenCalled();
      expect(provider.beginUpstream).not.toHaveBeenCalled();
    },
  );

  it("handle が無い・空・複数なら 400。何も消費しない", async () => {
    for (const body of [
      "decision=approve",
      "handle=&decision=approve",
      "handle=a&handle=b&decision=approve",
    ]) {
      const { env, provider } = makeEnv();
      const res = await post(env, body);
      expect(res.status).toBe(400);
      expect(res.headers.get("location")).toBeNull();
      expect(provider.approveConsent).not.toHaveBeenCalled();
      expect(provider.denyConsent).not.toHaveBeenCalled();
      expect(provider.beginUpstream).not.toHaveBeenCalled();
    }
  });

  it("form 以外の Content-Type は 400", async () => {
    const { env, provider } = makeEnv();
    const res = await app().request(
      `${BASE}/authorize`,
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
      env,
    );
    expect(res.status).toBe(400);
    expect(provider.beginUpstream).not.toHaveBeenCalled();
  });

  it("CSRF: approveConsent が拒否（Cookie 無し・不一致・再使用・期限切れ）なら 400。GitHub へ行かない", async () => {
    const { env, provider } = makeEnv();
    provider.approveConsent.mockRejectedValueOnce(
      new AuthorizationError("invalid_request", { description: "not started in this browser" }),
    );
    const res = await post(env, approveForm());
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(provider.beginUpstream).not.toHaveBeenCalled();
    expect(provider.completeAuthorization).not.toHaveBeenCalled();
  });

  it("CSRF: denyConsent が拒否なら 400（拒否の redirect も出さない）", async () => {
    const { env, provider } = makeEnv();
    provider.denyConsent.mockRejectedValueOnce(
      new AuthorizationError("invalid_request", { description: "used" }),
    );
    const res = await post(env, approveForm({ decision: "deny" }));
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
  });

  it("本番で GITHUB_OAUTH_BASE を差し替えようとすると拒否（fail closed）。同意も消費しない", async () => {
    const { env, provider } = makeEnv({ GITHUB_OAUTH_BASE: "https://evil.example.com" });
    const res = await post(env, approveForm());
    expect(res.status).toBe(500);
    expect(res.headers.get("location")).toBeNull();
    expect(provider.approveConsent).not.toHaveBeenCalled();
    expect(provider.beginUpstream).not.toHaveBeenCalled();
  });

  it("ENVIRONMENT=test のときだけ GITHUB_OAUTH_BASE を差し替えられる", async () => {
    const { env } = makeEnv({ ENVIRONMENT: "test", GITHUB_OAUTH_BASE: "http://127.0.0.1:9999" });
    const res = await post(env, approveForm());
    expect(res.headers.get("location")).toMatch(
      /^http:\/\/127\.0\.0\.1:9999\/login\/oauth\/authorize\?/,
    );
  });

  it.each(["production", "test", "staging", "Test", "", undefined])(
    "ENVIRONMENT=%j でも固定ユーザーで認可を完了させない（スタブは無い）",
    async (environment) => {
      const { env, provider } = makeEnv({ ENVIRONMENT: environment });
      const res = await post(env, approveForm());
      expect(provider.completeAuthorization).not.toHaveBeenCalled();
      const loc = res.headers.get("location");
      if (loc) expect(new URL(loc).searchParams.get("code")).toBeNull();
    },
  );

  it.each(["GITHUB_APP_CLIENT_ID", "GITHUB_APP_CLIENT_SECRET", "ALLOWED_ORG", "ALLOWED_TEAM"])(
    "%s が未設定ならログインを開始しない",
    async (name) => {
      const { env, provider } = makeEnv({ [name]: "" });
      const res = await post(env, approveForm());
      expect(res.status).toBe(500);
      expect(res.headers.get("location")).toBeNull();
      expect(provider.beginUpstream).not.toHaveBeenCalled();
    },
  );
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

describe("ALLOWED_USER_IDS（数値の user ID の許可リスト）", () => {
  beforeEach(clearWorkerAudit);
  const NO_TEAM = { ALLOWED_ORG: "", ALLOWED_TEAM: "" };
  const auditEnv = (over: EnvOver = {}) =>
    makeEnv({ ENVIRONMENT: "test", OAUTH_KV: workerEnv.OAUTH_KV, ...over });
  const memberships = (gh: ReturnType<typeof githubFetch>) =>
    gh.calls.filter((r) => new URL(r.url).pathname.includes("/memberships/"));

  it("ID のルールだけの構成: 一致すればログインでき、team の確認は呼ばない", async () => {
    const gh = githubFetch({ team: "none" });
    const { env, provider, saveCredential } = makeEnv({ ...NO_TEAM, ALLOWED_USER_IDS: "7,1001" });
    const res = await app(gh.fetch).request(CALLBACK_URL, {}, env);
    expect(res.headers.get("location")).toBe(
      "http://localhost/cb?code=mcp-code&state=client-state",
    );
    expect(saveCredential).toHaveBeenCalledOnce();
    expect(provider.completeAuthorization).toHaveBeenCalledOnce();
    expect(memberships(gh)).toHaveLength(0);
  });

  it("ID のルールだけの構成: リストに無ければ拒否。監査は not_team_member と同じ", async () => {
    const gh = githubFetch();
    const { env, provider, saveCredential } = auditEnv({ ...NO_TEAM, ALLOWED_USER_IDS: "7,8" });
    const res = await app(gh.fetch).request(CALLBACK_URL, {}, env);
    expect(new URL(res.headers.get("location") ?? "").searchParams.get("error")).toBe(
      "access_denied",
    );
    expect(saveCredential).not.toHaveBeenCalled();
    expect(provider.completeAuthorization).not.toHaveBeenCalled();
    expect(memberships(gh)).toHaveLength(0);
    expect(await readWorkerAudit(env)).toEqual([
      expect.objectContaining({
        event: "authz_denied",
        reason: "not_team_member",
        userId: 1001,
        caller: "parent",
      }),
    ]);
  });

  it("ID に無くても、org/team の active メンバーならログインできる", async () => {
    const gh = githubFetch({ team: "active" });
    const { env, provider } = makeEnv({ ALLOWED_USER_IDS: "7,8" });
    const res = await app(gh.fetch).request(CALLBACK_URL, {}, env);
    expect(res.headers.get("location")).toContain("code=mcp-code");
    expect(provider.completeAuthorization).toHaveBeenCalledOnce();
    expect(memberships(gh)).toHaveLength(1);
  });

  it("ID に無く、team にも居なければ拒否（team を確認する）", async () => {
    const gh = githubFetch({ team: "none" });
    const { env, provider } = auditEnv({ ALLOWED_USER_IDS: "7,8" });
    const res = await app(gh.fetch).request(CALLBACK_URL, {}, env);
    expect(res.headers.get("location")).toContain("error=access_denied");
    expect(provider.completeAuthorization).not.toHaveBeenCalled();
    expect(memberships(gh)).toHaveLength(1);
    expect((await readWorkerAudit(env)).map((r) => r.reason)).toEqual(["not_team_member"]);
  });

  it.each([
    ["org だけ + 一致する ID", { ALLOWED_TEAM: "", ALLOWED_USER_IDS: "1001" }],
    ["team だけ + 一致する ID", { ALLOWED_ORG: "", ALLOWED_USER_IDS: "1001" }],
    ["ID が不正（空要素）", { ...NO_TEAM, ALLOWED_USER_IDS: "1001,,2" }],
    ["ID が不正（重複）", { ...NO_TEAM, ALLOWED_USER_IDS: "1001,1001" }],
    ["org/team は完全だが ID が不正", { ALLOWED_USER_IDS: "abc" }],
    ["どのルールも無い", { ...NO_TEAM, ALLOWED_USER_IDS: "" }],
  ])("設定が不正ならログインを開始せず、callback も 500: %s", async (_name, over) => {
    const a = makeEnv(over);
    const res = await post(a.env, approveForm());
    expect(res.status).toBe(500);
    expect(a.provider.beginUpstream).not.toHaveBeenCalled();

    const gh = githubFetch();
    const b = makeEnv(over);
    const cb = await app(gh.fetch).request(CALLBACK_URL, {}, b.env);
    expect(cb.status).toBe(500);
    expect(cb.headers.get("location")).toBeNull();
    expect(b.saveCredential).not.toHaveBeenCalled();
    expect(b.provider.completeAuthorization).not.toHaveBeenCalled();
    expect(gh.calls).toHaveLength(0);
  });

  it("ID のルールだけの構成でも、/authorize は開始できる", async () => {
    const { env, provider } = makeEnv({ ...NO_TEAM, ALLOWED_USER_IDS: "1001" });
    const res = await post(env, approveForm());
    expect(res.status).toBe(302);
    expect(provider.beginUpstream).toHaveBeenCalledOnce();
  });
});

describe("監査（auth_failed / authz_denied）", () => {
  beforeEach(clearWorkerAudit);
  // 記録先の KV だけ本物にして、ENVIRONMENT=test で出す
  const auditEnv = (over: EnvOver = {}) =>
    makeEnv({ ENVIRONMENT: "test", OAUTH_KV: workerEnv.OAUTH_KV, ...over });
  const records = (env: Env) => readWorkerAudit(env);

  it("state / Cookie が不正（finishUpstream が拒否）なら auth_failed(invalid_state)", async () => {
    const { env, provider } = auditEnv();
    provider.finishUpstream.mockRejectedValueOnce(
      new AuthorizationError("invalid_request", { description: "state mismatch" }),
    );
    const res = await app(githubFetch().fetch).request(CALLBACK_URL, {}, env);
    expect(res.status).toBe(400);
    expect(await records(env)).toEqual([
      expect.objectContaining({ audit: true, event: "auth_failed", reason: "invalid_state" }),
    ]);
  });

  it("code が無ければ auth_failed(missing_code)、GitHub 側の拒否なら auth_failed(github_denied)", async () => {
    const a = auditEnv();
    await app(githubFetch().fetch).request(`${BASE}/callback?state=UP`, {}, a.env);
    const b = auditEnv();
    await app(githubFetch().fetch).request(
      `${BASE}/callback?error=access_denied&state=UP`,
      {},
      b.env,
    );
    const all = await records(a.env);
    expect(all.map((r) => r.reason)).toEqual(["missing_code", "github_denied"]);
    expect(all.every((r) => r.event === "auth_failed")).toBe(true);
  });

  it("GitHub の code 交換が拒否されたら auth_failed(code_exchange_rejected)。5xx（一時的な障害）は出さない", async () => {
    const bad = routerFetch({
      "POST /login/oauth/access_token": () => json({ error: "bad_verification_code" }),
    });
    const a = auditEnv();
    await app(bad.fetch).request(CALLBACK_URL, {}, a.env);
    expect((await records(a.env)).map((r) => [r.event, r.reason])).toEqual([
      ["auth_failed", "code_exchange_rejected"],
    ]);
    const before = (await records(a.env)).length;
    const b = auditEnv();
    await app(githubFetch({ tokenStatus: 503 }).fetch).request(CALLBACK_URL, {}, b.env);
    expect((await records(b.env)).length).toBe(before);
  });

  it("team に所属していなければ authz_denied(not_team_member) を userId つきで出す。トークンは出さない", async () => {
    const gh = githubFetch({ team: "none" });
    const { env } = auditEnv();
    const res = await app(gh.fetch).request(CALLBACK_URL, {}, env);
    expect(new URL(res.headers.get("location") ?? "").searchParams.get("error")).toBe(
      "access_denied",
    );
    const recs = await records(env);
    expect(recs).toEqual([
      expect.objectContaining({
        event: "authz_denied",
        reason: "not_team_member",
        userId: 1001,
        caller: "parent",
      }),
    ]);
    expect(JSON.stringify(recs)).not.toMatch(/ghu_|ghr_|alice/);
  });

  it("同意の検証（CSRF・期限切れ）で拒否されたら auth_failed(consent_rejected)", async () => {
    const { env, provider } = auditEnv();
    provider.approveConsent.mockRejectedValueOnce(
      new AuthorizationError("invalid_request", { description: "bad cookie" }),
    );
    const res = await post(env, approveForm());
    expect(res.status).toBe(400);
    expect((await records(env)).map((r) => [r.event, r.reason])).toEqual([
      ["auth_failed", "consent_rejected"],
    ]);
  });

  it("成功したログインでは何も出さない。production では記録しない", async () => {
    const ok = auditEnv();
    await app(githubFetch().fetch).request(CALLBACK_URL, {}, ok.env);
    expect(await records(ok.env)).toEqual([]);
    const prod = makeEnv({ OAUTH_KV: workerEnv.OAUTH_KV });
    prod.provider.finishUpstream.mockRejectedValueOnce(
      new AuthorizationError("invalid_request", { description: "state mismatch" }),
    );
    await app(githubFetch().fetch).request(CALLBACK_URL, {}, prod.env);
    expect(await records({ ...prod.env, ENVIRONMENT: "test" } as Env)).toEqual([]);
  });
});
