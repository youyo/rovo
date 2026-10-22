import { runInDurableObject } from "cloudflare:test";
import { env as workerEnv } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultApp } from "../../src/app";
import { readWorkerAudit } from "../../src/audit-sink";
import {
  DASH_STATE_KV_PREFIX,
  DASH_STATE_PREFIX,
  isDashboardState,
  safeReturnTo,
} from "../../src/dashboard/auth";
import { handleDashboard } from "../../src/dashboard/serve";
import {
  LOGIN_COOKIE,
  openSession,
  SESSION_AAD,
  SESSION_COOKIE,
  sealSession,
} from "../../src/dashboard/session";
import { dashboardUrl } from "../../src/dashboard/url";
import { encryptString, importEncryptionKey } from "../../src/github/crypto";
import { ulid } from "../../src/tasks/ulid";
import { json, routerFetch, tokenResponse } from "./github/helpers";
import { clearWorkerAudit, newUserId, userStub } from "./helpers";

const BASE = workerEnv.PUBLIC_BASE_URL;
const ENC_KEY = (workerEnv as unknown as { TOKEN_ENC_KEY: string }).TOKEN_ENC_KEY;
const STATE_RE = /^rovo-dash\.[A-Za-z0-9_-]{43}$/;
const TASK_ID = "01JZ0000000000000000000000";

/** OAuthProvider の代わり。ダッシュボードのログインがこれに触れないことを確かめる。 */
function mcpProvider() {
  return {
    finishUpstream: vi.fn(async () => {
      throw new Error("MCP の経路に入ってはいけない");
    }),
    completeAuthorization: vi.fn(async () => {
      throw new Error("MCP の認可を完了してはいけない");
    }),
    beginUpstream: vi.fn(),
    approveConsent: vi.fn(),
  };
}

function makeEnv(over: Record<string, unknown> = {}) {
  const provider = mcpProvider();
  const env = {
    ...workerEnv,
    ENVIRONMENT: "test",
    OAUTH_PROVIDER: provider,
    ...over,
  } as unknown as Env;
  return { env, provider };
}

type GithubOpts = {
  userId: number;
  login: string;
  team?: "active" | "none";
  tokenStatus?: number;
  /** GitHub が 200 で返す OAuth のエラー（code の拒否） */
  tokenError?: string;
};

function githubFetch(o: GithubOpts) {
  return routerFetch({
    "POST /login/oauth/access_token": () =>
      o.tokenError
        ? json({ error: o.tokenError })
        : o.tokenStatus
          ? json({ message: "x" }, { status: o.tokenStatus })
          : tokenResponse({
              access_token: "ghu_SECRET_ACCESS",
              refresh_token: "ghr_SECRET_REFRESH",
            }),
    "GET /user": () => json({ id: o.userId, login: o.login }),
    [`GET /orgs/acme/teams/core/memberships/${o.login}`]: () =>
      o.team === "none"
        ? json({ message: "Not Found" }, { status: 404 })
        : json({ state: "active" }),
  });
}

function newGithubUser(over: Partial<GithubOpts> = {}): GithubOpts {
  const userId = newUserId();
  return { userId, login: `dash-${userId}`, ...over };
}

const dash = (path: string, init: RequestInit = {}, env: Env = makeEnv().env) =>
  handleDashboard(new Request(`${BASE}${path}`, init), env);

/** ログインを開始する（ブラウザの代わり）。state・ログイン Cookie・GitHub へのリダイレクト先を返す。 */
async function beginLogin(env: Env, query = "") {
  const res = await dash(`/dashboard/auth/login${query}`, {}, env);
  const location = new URL(res.headers.get("location") ?? "http://invalid.test/");
  const cookie = (res.headers.getSetCookie()[0] ?? "").split(";")[0] ?? "";
  return { res, location, state: location.searchParams.get("state") ?? "", cookie };
}

function callback(
  env: Env,
  github: ReturnType<typeof githubFetch>,
  query: string,
  cookie?: string,
) {
  const app = createDefaultApp({ fetch: github.fetch });
  return app.request(`${BASE}/callback?${query}`, { headers: cookie ? { cookie } : {} }, env);
}

const cb = (state: string, extra = "") => `code=gh-code&state=${encodeURIComponent(state)}${extra}`;

function sessionCookieOf(res: Response): string {
  const c = res.headers.getSetCookie().find((s) => s.startsWith(`${SESSION_COOKIE}=`));
  return c ? (c.split(";")[0] ?? "") : "";
}

async function credentialGeneration(userId: number): Promise<number> {
  const rows = await runInDurableObject(
    userStub(userId),
    (_i, state) =>
      state.storage.sql
        .exec("SELECT generation FROM github_credential WHERE singleton = 1")
        .toArray() as { generation: number }[],
  );
  return rows[0]?.generation ?? -1;
}

async function sessionRows(userId: number): Promise<number> {
  const rows = await runInDurableObject(userStub(userId), (_i, state) =>
    state.storage.sql.exec("SELECT sid FROM dashboard_session").toArray(),
  );
  return rows.length;
}

beforeEach(async () => {
  await clearWorkerAudit();
});

describe("safeReturnTo（戻り先は固定。オープンリダイレクトにしない）", () => {
  it("ダッシュボードの正規のパスだけを通す", () => {
    expect(safeReturnTo("/dashboard")).toBe("/dashboard");
    expect(safeReturnTo("/dashboard/")).toBe("/dashboard/");
    expect(safeReturnTo(`/dashboard/tasks/${TASK_ID}`)).toBe(`/dashboard/tasks/${TASK_ID}`);
  });

  it("それ以外は既定（/dashboard/）に倒す", () => {
    const bad = [
      null,
      "",
      "//evil.com",
      "//evil.com/dashboard/",
      "/\\evil.com",
      "\\\\evil.com",
      "\\evil",
      "https://evil.com/dashboard/",
      "https:",
      "http://rovo.example/dashboard/",
      "javascript:alert(1)",
      "dashboard/",
      "/dashboard/../x",
      "/dashboard/%2e%2e/x",
      "/dashboardx",
      "/dashboard//evil.com",
      "/dashboard/api/me",
      "/dashboard/assets/x.js",
      "/dashboard/tasks/not-a-ulid",
      `/dashboard/tasks/${TASK_ID}/extra`,
      `/dashboard/tasks/${TASK_ID}?x=1`,
      "/dashboard/#x",
      "/dashboard/\nSet-Cookie: a=b",
      "/dashboard/\r\n",
      " /dashboard/",
      "/mcp",
      "/authorize",
    ];
    for (const raw of bad) {
      expect(safeReturnTo(raw), String(raw)).toBe("/dashboard/");
    }
  });
});

describe("dashboard_url が戻り先として通る（M10。オープンリダイレクトにならない）", () => {
  const publicEnv = { PUBLIC_BASE_URL: BASE };

  it("dashboard_url の path（/dashboard/tasks/<ULID>）は戻り先として通る", () => {
    for (const id of [TASK_ID, ulid(), ulid(0), ulid(Date.UTC(2099, 0, 1))]) {
      const url = dashboardUrl(publicEnv, id);
      expect(url, id).toBeDefined();
      const { pathname, search, hash } = new URL(url ?? "");
      expect(pathname).toBe(`/dashboard/tasks/${id}`);
      expect(search + hash).toBe("");
      expect(safeReturnTo(pathname)).toBe(`/dashboard/tasks/${id}`);
    }
  });

  it("dashboard_url の絶対 URL そのものは戻り先にならない（既定に倒す。外部ホストへ飛ばない）", () => {
    const url = dashboardUrl(publicEnv, TASK_ID) ?? "";
    expect(url).toBe(`${BASE}/dashboard/tasks/${TASK_ID}`);
    expect(safeReturnTo(url)).toBe("/dashboard/");
    expect(safeReturnTo(`https://evil.example${new URL(url).pathname}`)).toBe("/dashboard/");
  });

  it("ULID の形でないタスクの path・区切りを偽装した path は既定に倒す", () => {
    const bad = [
      `/dashboard/tasks/${TASK_ID.toLowerCase()}`,
      `/dashboard/tasks/${TASK_ID.slice(0, 25)}`,
      `/dashboard/tasks/${TASK_ID}0`,
      `/dashboard/tasks/${TASK_ID.slice(0, 25)}I`,
      `/dashboard/tasks/${TASK_ID.slice(0, 25)}L`,
      `/dashboard/tasks/${TASK_ID.slice(0, 25)}O`,
      `/dashboard/tasks/${TASK_ID.slice(0, 25)}U`,
      `/dashboard/tasks/${TASK_ID.slice(0, 25)}a`,
      `/dashboard/tasks/${TASK_ID}/`,
      `/dashboard/tasks/${TASK_ID}%0d%0a`,
      `/dashboard/tasks/${TASK_ID}\\`,
      `/dashboard/tasks//${TASK_ID}`,
      `/dashboard/tasks/${TASK_ID.slice(0, 10)}%2F${TASK_ID.slice(11)}`,
      `/dashboard/tasks/../tasks/${TASK_ID}`,
      `//evil.example/dashboard/tasks/${TASK_ID}`,
      `/\\evil.example/dashboard/tasks/${TASK_ID}`,
      `/dashboard/tasks/${TASK_ID}@evil.example`,
      `/Dashboard/tasks/${TASK_ID}`,
    ];
    for (const raw of bad) {
      expect(safeReturnTo(raw), raw).toBe("/dashboard/");
    }
  });

  it("ログインの開始から完了まで、dashboard_url の path に戻る。絶対 URL を return_to に渡しても既定に戻る", async () => {
    const { env } = makeEnv();
    const path = new URL(dashboardUrl(publicEnv, TASK_ID) ?? "").pathname;
    for (const [returnTo, expected] of [
      [path, `/dashboard/tasks/${TASK_ID}`],
      [dashboardUrl(publicEnv, TASK_ID) ?? "", "/dashboard/"],
    ] as const) {
      const user = newGithubUser();
      const { state, cookie } = await beginLogin(env, `?return_to=${encodeURIComponent(returnTo)}`);
      const res = await callback(env, githubFetch(user), cb(state), cookie);
      expect(res.status, returnTo).toBe(302);
      expect(res.headers.get("location"), returnTo).toBe(expected);
    }
  });
});

describe("isDashboardState（振り分けは state の接頭辞だけ）", () => {
  it("接頭辞 rovo-dash. が付いた state が 1 つでもあれば true", () => {
    expect(isDashboardState(new URL(`${BASE}/callback?state=rovo-dash.abc`))).toBe(true);
    expect(isDashboardState(new URL(`${BASE}/callback?state=rovo-dash.`))).toBe(true);
    // 複数の state のどれかが接頭辞付きなら、ダッシュボード側で拒否する（MCP の経路に落とさない）
    expect(isDashboardState(new URL(`${BASE}/callback?state=x&state=rovo-dash.abc`))).toBe(true);
    expect(isDashboardState(new URL(`${BASE}/callback?state=rovo-dash.abc&state=x`))).toBe(true);
  });
  it("接頭辞が無ければ false（OAuthProvider の state は base64url で . を含まない）", () => {
    expect(isDashboardState(new URL(`${BASE}/callback?state=abc`))).toBe(false);
    expect(isDashboardState(new URL(`${BASE}/callback`))).toBe(false);
    expect(isDashboardState(new URL(`${BASE}/callback?state=ROVO-DASH.abc`))).toBe(false);
    expect(isDashboardState(new URL(`${BASE}/callback?state=xrovo-dash.abc`))).toBe(false);
    expect(isDashboardState(new URL(`${BASE}/callback?code=rovo-dash.abc`))).toBe(false);
    expect(DASH_STATE_PREFIX).toBe("rovo-dash.");
  });
});

describe("GET /dashboard/auth/login（ログインの開始）", () => {
  it("GitHub の authorize へ 302。state は rovo-dash. + 43 文字で、redirect_uri は /callback のまま", async () => {
    const { env } = makeEnv();
    const { res, location, state } = await beginLogin(env);
    expect(res.status).toBe(302);
    expect(location.origin + location.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(location.searchParams.get("client_id")).toBe(workerEnv.GITHUB_APP_CLIENT_ID);
    expect(location.searchParams.get("redirect_uri")).toBe(`${BASE}/callback`);
    expect(state).toMatch(STATE_RE);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("専用のログイン Cookie を発行する（__Host-・HttpOnly・Secure・SameSite=Lax・Path=/・Domain なし）", async () => {
    const { env } = makeEnv();
    const { res, cookie } = await beginLogin(env);
    const setCookie = res.headers.getSetCookie();
    expect(setCookie).toHaveLength(1);
    const header = setCookie[0] ?? "";
    expect(header.startsWith(`${LOGIN_COOKIE}=`)).toBe(true);
    const attrs = header.split("; ").map((s) => s.toLowerCase());
    for (const a of ["secure", "httponly", "samesite=lax", "path=/", "max-age=600"]) {
      expect(attrs, a).toContain(a);
    }
    expect(header.toLowerCase()).not.toContain("domain");
    expect(cookie.startsWith(`${LOGIN_COOKIE}=`)).toBe(true);
  });

  it("state は毎回違い、KV には transaction: と別の接頭辞で、Cookie の値そのものは保存しない", async () => {
    const { env } = makeEnv();
    const a = await beginLogin(env);
    const b = await beginLogin(env);
    expect(a.state).not.toBe(b.state);
    expect(a.cookie).not.toBe(b.cookie);
    expect(DASH_STATE_KV_PREFIX).not.toBe("transaction:");
    expect(DASH_STATE_KV_PREFIX.startsWith("transaction")).toBe(false);
    const stored = await workerEnv.OAUTH_KV.get(`${DASH_STATE_KV_PREFIX}${a.state}`);
    expect(stored).not.toBeNull();
    const bindingValue = a.cookie.slice(a.cookie.indexOf("=") + 1);
    expect(stored).not.toContain(bindingValue);
    // MCP の KV の名前空間（transaction:）には書かない
    expect(await workerEnv.OAUTH_KV.get(`transaction:${a.state}`)).toBeNull();
  });

  it("return_to は固定の形だけ保存し、それ以外は既定に倒す", async () => {
    const { env } = makeEnv();
    for (const [q, expected] of [
      [
        `?return_to=${encodeURIComponent(`/dashboard/tasks/${TASK_ID}`)}`,
        `/dashboard/tasks/${TASK_ID}`,
      ],
      [`?return_to=${encodeURIComponent("//evil.com")}`, "/dashboard/"],
      [`?return_to=${encodeURIComponent("https://evil.com/")}`, "/dashboard/"],
      ["", "/dashboard/"],
    ] as const) {
      const { state } = await beginLogin(env, q);
      const record = JSON.parse(
        (await workerEnv.OAUTH_KV.get(`${DASH_STATE_KV_PREFIX}${state}`)) ?? "{}",
      );
      expect(record.returnTo, q).toBe(expected);
    }
  });

  it("GET 以外は 405。設定が不足していれば何も発行しない（fail closed）", async () => {
    const { env } = makeEnv();
    const post = await dash("/dashboard/auth/login", { method: "POST" }, env);
    expect(post.status).toBe(405);
    expect(post.headers.getSetCookie()).toEqual([]);

    const broken = makeEnv({ ALLOWED_ORG: "", ALLOWED_TEAM: "", ALLOWED_USER_IDS: "" }).env;
    const res = await dash("/dashboard/auth/login", {}, broken);
    expect(res.status).toBe(500);
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.getSetCookie()).toEqual([]);
  });
});

describe("GET /callback（接頭辞付きの state はダッシュボードのハンドラ）", () => {
  it("正常: セッションを作り、Cookie を発行して固定の戻り先へ。資格も保存する。MCP の経路には入らない", async () => {
    const { env, provider } = makeEnv();
    const user = newGithubUser();
    const github = githubFetch(user);
    const { state, cookie } = await beginLogin(env);
    const res = await callback(env, github, cb(state), cookie);

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/dashboard/");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(provider.finishUpstream).not.toHaveBeenCalled();
    expect(provider.completeAuthorization).not.toHaveBeenCalled();

    // セッション Cookie と、ログイン Cookie の削除
    const cookies = res.headers.getSetCookie();
    const session = cookies.find((c) => c.startsWith(`${SESSION_COOKIE}=`)) ?? "";
    const attrs = session.split("; ").map((s) => s.toLowerCase());
    for (const a of ["secure", "httponly", "samesite=lax", "path=/"]) expect(attrs, a).toContain(a);
    expect(session.toLowerCase()).not.toContain("domain");
    expect(cookies.some((c) => c.startsWith(`${LOGIN_COOKIE}=;`) && /max-age=0/i.test(c))).toBe(
      true,
    );

    // Cookie の中身: GitHub のトークンも login も無く、uid だけが利用者を指す
    const value = (session.split(";")[0] ?? "").slice(SESSION_COOKIE.length + 1);
    expect(session).not.toContain("ghu_");
    const claims = await openSession(ENC_KEY, value, Date.now());
    expect(claims?.uid).toBe(user.userId);
    expect(JSON.stringify(claims)).not.toContain(user.login);
    expect(JSON.stringify(claims)).not.toContain("ghu_");

    // サーバー側の記録と、資格の保存（MCP と共用）
    expect(
      await userStub(user.userId).checkDashboardSession(claims?.sid ?? "", claims?.ver ?? -1),
    ).toEqual({
      ok: true,
      login: user.login,
    });
    expect(await credentialGeneration(user.userId)).toBe(1);
    // 成功は監査に出さない（MCP と同じ）。失敗の監査は出ていない
    expect(await readWorkerAudit(env)).toEqual([]);
  });

  it("戻り先は開始時に検証したものを使う（callback の URL からは取らない）", async () => {
    const { env } = makeEnv();
    const user = newGithubUser();
    const { state, cookie } = await beginLogin(
      env,
      `?return_to=${encodeURIComponent(`/dashboard/tasks/${TASK_ID}`)}`,
    );
    const res = await callback(
      env,
      githubFetch(user),
      cb(state, `&return_to=${encodeURIComponent("//evil.com")}&redirect=https://evil.com`),
      cookie,
    );
    expect(res.headers.get("location")).toBe(`/dashboard/tasks/${TASK_ID}`);
  });

  it("ログインのたびに新しい sid になり（ログイン前の sid は引き継がない = セッション固定の対策）、別端末の古いセッションも有効なまま", async () => {
    const { env } = makeEnv();
    const user = newGithubUser();
    const first = await beginLogin(env);
    const r1 = await callback(env, githubFetch(user), cb(first.state), first.cookie);
    const c1 = sessionCookieOf(r1);
    const second = await beginLogin(env);
    // 古いセッション Cookie を持ったまま再ログインしても、その sid は引き継がない
    const r2 = await callback(env, githubFetch(user), cb(second.state), `${second.cookie}; ${c1}`);
    const c2 = sessionCookieOf(r2);
    expect(c2).not.toBe("");
    expect(c2).not.toBe(c1);
    const v1 = await openSession(ENC_KEY, c1.slice(SESSION_COOKIE.length + 1), Date.now());
    const v2 = await openSession(ENC_KEY, c2.slice(SESSION_COOKIE.length + 1), Date.now());
    expect(v1?.sid).not.toBe(v2?.sid);
    // 複数端末: 最初のログインのセッションも有効なまま、2 つ目も有効
    expect(
      (await userStub(user.userId).checkDashboardSession(v1?.sid ?? "", v1?.ver ?? 0)).ok,
    ).toBe(true);
    expect(
      (await userStub(user.userId).checkDashboardSession(v2?.sid ?? "", v2?.ver ?? 0)).ok,
    ).toBe(true);
    expect(await sessionRows(user.userId)).toBe(2);
  });

  describe("state / Cookie の不一致は 400（fail closed）。MCP の経路・監査に落とさない", () => {
    async function expectRejected(
      res: Response,
      env: Env,
      provider: ReturnType<typeof mcpProvider>,
      github: ReturnType<typeof githubFetch>,
      userId: number,
    ) {
      expect(res.status).toBe(400);
      expect(res.headers.get("location")).toBeNull();
      expect(sessionCookieOf(res)).toBe("");
      expect(provider.finishUpstream).not.toHaveBeenCalled();
      expect(provider.completeAuthorization).not.toHaveBeenCalled();
      // GitHub へは行かない・資格も保存しない・セッションも作らない
      expect(github.calls).toHaveLength(0);
      expect(await credentialGeneration(userId)).toBe(0);
      expect(await sessionRows(userId)).toBe(0);
      // MCP 側の監査（caller: parent）を汚さない。ダッシュボード由来は caller: dashboard で区別する
      const audit = await readWorkerAudit(env);
      expect(audit.filter((r) => r.caller === "parent")).toEqual([]);
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        event: "auth_failed",
        caller: "dashboard",
        reason: "dashboard_invalid_state",
      });
      // 応答の本文に state・Cookie・コードを出さない
      const body = await res.text();
      expect(body).not.toContain("gh-code");
    }

    it("Cookie が無い（別のブラウザ）", async () => {
      const { env, provider } = makeEnv();
      const user = newGithubUser();
      const github = githubFetch(user);
      const { state } = await beginLogin(env);
      await expectRejected(
        await callback(env, github, cb(state)),
        env,
        provider,
        github,
        user.userId,
      );
    });

    it("別のブラウザの Cookie（別の開始の値）", async () => {
      const { env, provider } = makeEnv();
      const user = newGithubUser();
      const github = githubFetch(user);
      const a = await beginLogin(env);
      const b = await beginLogin(env);
      await expectRejected(
        await callback(env, github, cb(a.state), b.cookie),
        env,
        provider,
        github,
        user.userId,
      );
    });

    it("Cookie の値が空・改ざん", async () => {
      const { env, provider } = makeEnv();
      const user = newGithubUser();
      const github = githubFetch(user);
      const { state, cookie } = await beginLogin(env);
      await expectRejected(
        await callback(env, github, cb(state), `${cookie}x`),
        env,
        provider,
        github,
        user.userId,
      );
    });

    it("KV に無い state（偽造）", async () => {
      const { env, provider } = makeEnv();
      const user = newGithubUser();
      const github = githubFetch(user);
      const { cookie } = await beginLogin(env);
      const forged = `rovo-dash.${"A".repeat(43)}`;
      await expectRejected(
        await callback(env, github, cb(forged), cookie),
        env,
        provider,
        github,
        user.userId,
      );
    });

    it("接頭辞だけ・長さが違う・不正な文字の state", async () => {
      const { env, provider } = makeEnv();
      const user = newGithubUser();
      const github = githubFetch(user);
      const { cookie } = await beginLogin(env);
      for (const bad of [
        "rovo-dash.",
        "rovo-dash.short",
        `rovo-dash.${"A".repeat(44)}`,
        `rovo-dash.${"!".repeat(43)}`,
      ]) {
        provider.finishUpstream.mockClear();
        await clearWorkerAudit();
        await expectRejected(
          await callback(env, github, cb(bad), cookie),
          env,
          provider,
          github,
          user.userId,
        );
      }
    });

    it("state が複数ある（片方が接頭辞付き）", async () => {
      const { env, provider } = makeEnv();
      const user = newGithubUser();
      const github = githubFetch(user);
      const { state, cookie } = await beginLogin(env);
      const res = await callback(env, github, `code=gh-code&state=other&state=${state}`, cookie);
      await expectRejected(res, env, provider, github, user.userId);
    });

    it("期限切れ（10 分を過ぎた state）", async () => {
      const { env, provider } = makeEnv();
      const user = newGithubUser();
      const github = githubFetch(user);
      const { state, cookie } = await beginLogin(env);
      const key = `${DASH_STATE_KV_PREFIX}${state}`;
      const record = JSON.parse((await workerEnv.OAUTH_KV.get(key)) ?? "{}");
      await workerEnv.OAUTH_KV.put(key, JSON.stringify({ ...record, expiresAt: Date.now() - 1 }));
      await expectRejected(
        await callback(env, github, cb(state), cookie),
        env,
        provider,
        github,
        user.userId,
      );
    });

    it("再使用（同じ callback の再送）は 2 回目が 400。1 回目のセッションは残る", async () => {
      const { env, provider } = makeEnv();
      const user = newGithubUser();
      const github = githubFetch(user);
      const { state, cookie } = await beginLogin(env);
      const first = await callback(env, github, cb(state), cookie);
      expect(first.status).toBe(302);
      const callsAfterFirst = github.calls.length;
      await clearWorkerAudit();
      const second = await callback(env, github, cb(state), cookie);
      expect(second.status).toBe(400);
      expect(sessionCookieOf(second)).toBe("");
      expect(github.calls).toHaveLength(callsAfterFirst); // 2 回目は GitHub へ行かない
      expect(provider.finishUpstream).not.toHaveBeenCalled();
      const audit = await readWorkerAudit(env);
      expect(audit.filter((r) => r.caller === "parent")).toEqual([]);
      expect(audit[0]).toMatchObject({ caller: "dashboard", reason: "dashboard_invalid_state" });
      expect(await sessionRows(user.userId)).toBe(1);
    });

    it("state の消費は、検証に失敗しても行われる（試行を重ねさせない）", async () => {
      const { env } = makeEnv();
      const user = newGithubUser();
      const github = githubFetch(user);
      const a = await beginLogin(env);
      const b = await beginLogin(env);
      const bad = await callback(env, github, cb(a.state), b.cookie); // 別の Cookie
      expect(bad.status).toBe(400);
      // 正しい Cookie でも、消費済みの state は通らない
      const retry = await callback(env, github, cb(a.state), a.cookie);
      expect(retry.status).toBe(400);
    });
  });

  describe("身元確認の失敗（セッションを作らない・資格を保存しない）", () => {
    async function expectNoSession(res: Response, userId: number) {
      expect(sessionCookieOf(res)).toBe("");
      expect(res.headers.get("location")).toBeNull();
      expect(await credentialGeneration(userId)).toBe(0);
      expect(await sessionRows(userId)).toBe(0);
      // ログイン Cookie は消す
      expect(res.headers.getSetCookie().some((c) => c.startsWith(`${LOGIN_COOKIE}=;`))).toBe(true);
    }

    it("許可ルール外のユーザー（team のメンバーではない）は 403。authz_denied が caller: dashboard で残る", async () => {
      const { env, provider } = makeEnv();
      const user = newGithubUser({ team: "none" });
      const { state, cookie } = await beginLogin(env);
      const res = await callback(env, githubFetch(user), cb(state), cookie);
      expect(res.status).toBe(403);
      await expectNoSession(res, user.userId);
      expect(provider.completeAuthorization).not.toHaveBeenCalled();
      const audit = await readWorkerAudit(env);
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        event: "authz_denied",
        caller: "dashboard",
        reason: "not_team_member",
        userId: user.userId,
      });
    });

    it("ALLOWED_USER_IDS だけの構成でも、ID が違えば拒否し、一致すれば通す", async () => {
      const allowed = newGithubUser();
      const other = newGithubUser();
      const { env } = makeEnv({
        ALLOWED_ORG: "",
        ALLOWED_TEAM: "",
        ALLOWED_USER_IDS: String(allowed.userId),
      });
      const denied = await beginLogin(env);
      const r1 = await callback(
        env,
        githubFetch({ ...other, team: "none" }),
        cb(denied.state),
        denied.cookie,
      );
      expect(r1.status).toBe(403);
      await expectNoSession(r1, other.userId);
      const ok = await beginLogin(env);
      const r2 = await callback(env, githubFetch(allowed), cb(ok.state), ok.cookie);
      expect(r2.status).toBe(302);
    });

    it("GitHub が code を拒否する（4xx）は 403。監査は code_exchange_rejected（caller: dashboard）", async () => {
      const { env } = makeEnv();
      const user = newGithubUser({ tokenError: "bad_verification_code" });
      const { state, cookie } = await beginLogin(env);
      const res = await callback(env, githubFetch(user), cb(state), cookie);
      expect(res.status).toBe(403);
      await expectNoSession(res, user.userId);
      const audit = await readWorkerAudit(env);
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        event: "auth_failed",
        caller: "dashboard",
        reason: "code_exchange_rejected",
      });
      // 応答にも監査にも GitHub の応答の内容を出さない
      expect(JSON.stringify(audit)).not.toContain("ghu_");
    });

    it("GitHub の一時的な障害（5xx）は 503。認証の失敗としては記録しない", async () => {
      const { env } = makeEnv();
      const user = newGithubUser({ tokenStatus: 503 });
      const { state, cookie } = await beginLogin(env);
      const res = await callback(env, githubFetch(user), cb(state), cookie);
      expect(res.status).toBe(503);
      await expectNoSession(res, user.userId);
      expect(await readWorkerAudit(env)).toEqual([]);
    });

    it("GitHub 側でユーザーが拒否した（error=access_denied）は 403。GitHub へは行かない", async () => {
      const { env } = makeEnv();
      const user = newGithubUser();
      const github = githubFetch(user);
      const { state, cookie } = await beginLogin(env);
      const res = await callback(
        env,
        github,
        `error=access_denied&state=${encodeURIComponent(state)}`,
        cookie,
      );
      expect(res.status).toBe(403);
      await expectNoSession(res, user.userId);
      expect(github.calls).toHaveLength(0);
      const audit = await readWorkerAudit(env);
      expect(audit[0]).toMatchObject({
        event: "auth_failed",
        caller: "dashboard",
        reason: "github_denied",
      });
    });

    it("code が無い callback は 400", async () => {
      const { env } = makeEnv();
      const user = newGithubUser();
      const github = githubFetch(user);
      const { state, cookie } = await beginLogin(env);
      const res = await callback(env, github, `state=${encodeURIComponent(state)}`, cookie);
      expect(res.status).toBe(400);
      await expectNoSession(res, user.userId);
      expect(github.calls).toHaveLength(0);
      const audit = await readWorkerAudit(env);
      expect(audit[0]).toMatchObject({
        event: "auth_failed",
        caller: "dashboard",
        reason: "missing_code",
      });
    });
  });

  describe("接頭辞が無い state は今までどおり MCP の経路", () => {
    it("OAuthProvider の finishUpstream に渡し、不正なら MCP の監査（caller: parent / invalid_state）が出る", async () => {
      const { AuthorizationError } = await import("@cloudflare/workers-oauth-provider");
      const { env, provider } = makeEnv();
      provider.finishUpstream.mockRejectedValueOnce(
        new AuthorizationError("invalid_request", { description: "bad state" }),
      );
      const user = newGithubUser();
      const res = await callback(env, githubFetch(user), cb("A".repeat(43)));
      expect(res.status).toBe(400);
      expect(provider.finishUpstream).toHaveBeenCalledOnce();
      const audit = await readWorkerAudit(env);
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        event: "auth_failed",
        caller: "parent",
        reason: "invalid_state",
      });
    });

    it("接頭辞付きでない state ではダッシュボードの KV にも触れない", async () => {
      const { AuthorizationError } = await import("@cloudflare/workers-oauth-provider");
      const touched: string[] = [];
      const kv = workerEnv.OAUTH_KV;
      const recording = {
        get: (key: string, ...rest: unknown[]) => {
          touched.push(key);
          return (kv.get as (...a: unknown[]) => unknown)(key, ...rest);
        },
        put: (key: string, ...rest: unknown[]) => {
          touched.push(key);
          return (kv.put as (...a: unknown[]) => unknown)(key, ...rest);
        },
        delete: (key: string) => {
          touched.push(key);
          return kv.delete(key);
        },
        list: (...rest: unknown[]) => (kv.list as (...a: unknown[]) => unknown)(...rest),
      };
      const { env, provider } = makeEnv({ OAUTH_KV: recording });
      provider.finishUpstream.mockRejectedValueOnce(
        new AuthorizationError("invalid_request", { description: "x" }),
      );
      await callback(
        env,
        githubFetch(newGithubUser()),
        cb("Z".repeat(43)),
        `${LOGIN_COOKIE}=whatever`,
      );
      expect(touched.some((k) => k.startsWith(DASH_STATE_KV_PREFIX))).toBe(false);
    });
  });
});

describe("セッションの確認（GET /dashboard/api/me）とログアウト", () => {
  const SAME = { "sec-fetch-site": "same-origin" };

  async function loggedIn(env: Env, user = newGithubUser()) {
    const { state, cookie } = await beginLogin(env);
    const upstream = githubFetch(user);
    const res = await callback(env, upstream, cb(state), cookie);
    const session = sessionCookieOf(res);
    expect(session).not.toBe("");
    // /me は使うたびに許可ルールを確かめ直す（UserDO が GitHub を呼ぶ）。偽の GitHub を UserDO に差し込む
    await runInDurableObject(userStub(user.userId), (i) => {
      (i as unknown as { githubFetch: typeof fetch }).githubFetch = upstream.fetch;
    });
    return { user, session };
  }

  const me = (env: Env, headers: Record<string, string>) =>
    dash("/dashboard/api/me", { headers }, env);

  it("有効なセッションなら 200 で {login} だけを返す。nosniff・no-store・CORS なし", async () => {
    const { env } = makeEnv();
    const { user, session } = await loggedIn(env);
    const res = await me(env, { ...SAME, cookie: session });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ login: user.login });
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("Sec-Fetch-Site: none（アドレスバーからの GET）も通す", async () => {
    const { env } = makeEnv();
    const { session } = await loggedIn(env);
    const res = await me(env, { "sec-fetch-site": "none", cookie: session });
    expect(res.status).toBe(200);
  });

  it("Cookie が無い・壊れている・別用途の暗号文は一律 401（理由を出さない）", async () => {
    const { env } = makeEnv();
    const { session } = await loggedIn(env);
    const value = session.slice(SESSION_COOKIE.length + 1);
    const key = await importEncryptionKey(ENC_KEY);
    const claims = { uid: 1, sid: "A".repeat(43), ver: 1, iat: Date.now(), exp: Date.now() + 1000 };
    const wrongAad = await encryptString(key, JSON.stringify(claims), "access"); // MCP の access の暗号文を流用
    const cases = [
      "",
      `${SESSION_COOKIE}=`,
      `${SESSION_COOKIE}=garbage`,
      `${SESSION_COOKIE}=${value}x`,
      `${SESSION_COOKIE}=${wrongAad}`,
      `${SESSION_COOKIE}=${value}; ${SESSION_COOKIE}=${value}`, // 同名が 2 つ
    ];
    const bodies = new Set<string>();
    for (const cookie of cases) {
      const res = await me(env, { ...SAME, ...(cookie ? { cookie } : {}) });
      expect(res.status, cookie).toBe(401);
      expect(res.headers.get("content-type")).toBe("application/json");
      bodies.add(await res.text());
    }
    expect(bodies.size).toBe(1);
    expect([...bodies][0]).toBe(JSON.stringify({ error: "unauthorized" }));
  });

  it("期限切れの Cookie（exp が過去）は 401", async () => {
    const { env } = makeEnv();
    const { user } = await loggedIn(env);
    const created = await userStub(user.userId).createDashboardSession(user.login);
    const old = await sealSession(ENC_KEY, {
      uid: user.userId,
      sid: created.sid,
      ver: created.version,
      iat: Date.now() - 8 * 24 * 3600_000,
      exp: Date.now() - 1000,
    });
    const res = await me(env, { ...SAME, cookie: `${SESSION_COOKIE}=${old}` });
    expect(res.status).toBe(401);
  });

  it("version が合わない・サーバー側に無い sid の Cookie は 401（暗号文が正しくても通さない）", async () => {
    const { env } = makeEnv();
    const { user } = await loggedIn(env);
    const created = await userStub(user.userId).createDashboardSession(user.login);
    const seal = (over: Partial<{ sid: string; ver: number }>) =>
      sealSession(ENC_KEY, {
        uid: user.userId,
        sid: created.sid,
        ver: created.version,
        iat: Date.now(),
        exp: Date.now() + 3600_000,
        ...over,
      });
    for (const over of [
      { ver: created.version - 1 },
      { ver: created.version + 1 },
      { sid: "Z".repeat(43) },
    ]) {
      const res = await me(env, { ...SAME, cookie: `${SESSION_COOKIE}=${await seal(over)}` });
      expect(res.status, JSON.stringify(over)).toBe(401);
    }
    const ok = await me(env, { ...SAME, cookie: `${SESSION_COOKIE}=${await seal({})}` });
    expect(ok.status).toBe(200);
  });

  it("uid を差し替えても、他の利用者のセッションにはならない（別の DO には sid が無い）", async () => {
    const { env } = makeEnv();
    const a = await loggedIn(env);
    const b = await loggedIn(env);
    const claimsA = await openSession(
      ENC_KEY,
      a.session.slice(SESSION_COOKIE.length + 1),
      Date.now(),
    );
    const forged = await sealSession(ENC_KEY, {
      ...(claimsA as NonNullable<typeof claimsA>),
      uid: b.user.userId,
    });
    const res = await me(env, { ...SAME, cookie: `${SESSION_COOKIE}=${forged}` });
    expect(res.status).toBe(401);
  });

  it("再ログインしても古いセッションは 200 のまま（複数端末）。新しいセッションも 200", async () => {
    const { env } = makeEnv();
    const first = await loggedIn(env);
    const second = await loggedIn(env, first.user);
    expect(second.session).not.toBe(first.session);
    expect((await me(env, { ...SAME, cookie: first.session })).status).toBe(200);
    expect((await me(env, { ...SAME, cookie: second.session })).status).toBe(200);
  });

  it("ログアウトは自分のセッションだけを失効し、他の端末は 200 のまま", async () => {
    const { env } = makeEnv();
    const first = await loggedIn(env);
    const second = await loggedIn(env, first.user);
    const out = await dash(
      "/dashboard/api/logout",
      { method: "POST", headers: { ...SAME, cookie: first.session } },
      env,
    );
    expect(out.status).toBe(204);
    expect((await me(env, { ...SAME, cookie: first.session })).status).toBe(401);
    expect((await me(env, { ...SAME, cookie: second.session })).status).toBe(200);
  });

  it("許可ルールから外れた利用者は、セッションが生きていても /me が 401（使うたびに確かめ直す）", async () => {
    const { env } = makeEnv();
    const { user, session } = await loggedIn(env);
    expect((await me(env, { ...SAME, cookie: session })).status).toBe(200);
    // ルールの変更（user ID のルールだけにして、本人を外す）
    await runInDurableObject(userStub(user.userId), (i) => {
      const o = i as unknown as { env: Record<string, unknown> };
      o.env = {
        ...o.env,
        ALLOWED_ORG: "",
        ALLOWED_TEAM: "",
        ALLOWED_USER_IDS: String(user.userId + 1),
      };
    });
    const res = await me(env, { ...SAME, cookie: session });
    expect(res.status).toBe(401);
    expect(await res.text()).toBe(JSON.stringify({ error: "unauthorized" }));
    // 許可ルールが不正・未設定になっても同じ
    await runInDurableObject(userStub(user.userId), (i) => {
      const o = i as unknown as { env: Record<string, unknown> };
      o.env = { ...o.env, ALLOWED_ORG: "", ALLOWED_TEAM: "", ALLOWED_USER_IDS: "" };
    });
    expect((await me(env, { ...SAME, cookie: session })).status).toBe(401);
  });

  it("team から外れた利用者は（キャッシュが切れたあと）/me が 401。GitHub の障害で確かめられないときは 503（通さない）", async () => {
    const { env } = makeEnv();
    const { user, session } = await loggedIn(env);
    let t = Date.now();
    await runInDurableObject(userStub(user.userId), (i) => {
      (i as unknown as { now: () => number }).now = () => t;
    });
    expect((await me(env, { ...SAME, cookie: session })).status).toBe(200);
    // キャッシュ（5 分）が切れたあと、GitHub が 500 を返す
    t += 6 * 60_000;
    const down = routerFetch({ "GET /user": () => json({ message: "x" }, { status: 500 }) });
    await runInDurableObject(userStub(user.userId), (i) => {
      (i as unknown as { githubFetch: typeof fetch }).githubFetch = down.fetch;
    });
    const res = await me(env, { ...SAME, cookie: session });
    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain(user.login);
    // 復旧したが team から外れている
    const gone = githubFetch({ ...user, team: "none" });
    await runInDurableObject(userStub(user.userId), (i) => {
      (i as unknown as { githubFetch: typeof fetch }).githubFetch = gone.fetch;
    });
    expect((await me(env, { ...SAME, cookie: session })).status).toBe(401);
  });

  it("MCP の再ログイン（saveCredential）ではダッシュボードのセッションは落ちない", async () => {
    const { env } = makeEnv();
    const { user, session } = await loggedIn(env);
    await userStub(user.userId).saveCredential({
      accessToken: "ghu_other",
      refreshToken: "ghr_other",
      accessExpiresAt: Date.now() + 3600_000,
      refreshExpiresAt: Date.now() + 7200_000,
    });
    expect((await me(env, { ...SAME, cookie: session })).status).toBe(200);
  });

  describe("Sec-Fetch-Site（M1 から M4 に残した決定）", () => {
    it("cross-site / same-site は、有効な Cookie があっても 403。ヘッダが無い・未知の値も 403", async () => {
      const { env } = makeEnv();
      const { session } = await loggedIn(env);
      for (const headers of [
        { "sec-fetch-site": "cross-site", cookie: session },
        { "sec-fetch-site": "same-site", cookie: session },
        { cookie: session }, // ヘッダ無し（ナビゲーション以外の API では拒否）
        { "sec-fetch-site": "", cookie: session },
        { "sec-fetch-site": "bogus", cookie: session },
      ] as Record<string, string>[]) {
        const res = await me(env, headers);
        expect(res.status, JSON.stringify(headers)).toBe(403);
        expect(await res.json()).toEqual({ error: "forbidden" });
        expect(res.headers.get("access-control-allow-origin")).toBeNull();
      }
    });
  });

  describe("POST /dashboard/api/logout", () => {
    const logout = (env: Env, headers: Record<string, string>, method = "POST") =>
      dash("/dashboard/api/logout", { method, headers }, env);

    it("same-origin: sid を失効し、Cookie を消す。古い Cookie はもう使えない", async () => {
      const { env } = makeEnv();
      const { session } = await loggedIn(env);
      const res = await logout(env, { ...SAME, cookie: session });
      expect(res.status).toBe(204);
      const cleared =
        res.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=;`)) ?? "";
      expect(cleared).toMatch(/Max-Age=0/i);
      expect(cleared).toMatch(/Path=\//);
      expect(cleared).toMatch(/Secure/i);
      expect(res.headers.get("cache-control")).toBe("no-store");
      // Cookie を持ち続けていても、サーバー側で失効している
      expect((await me(env, { ...SAME, cookie: session })).status).toBe(401);
    });

    it("同じ Origin の Origin ヘッダがあっても通る", async () => {
      const { env } = makeEnv();
      const { session } = await loggedIn(env);
      const res = await logout(env, { ...SAME, origin: new URL(BASE).origin, cookie: session });
      expect(res.status).toBe(204);
    });

    it("別の Origin・cross-site・same-site・ヘッダ無し・none は 403 で、セッションは失効しない（CSRF）", async () => {
      const { env } = makeEnv();
      const { session } = await loggedIn(env);
      for (const headers of [
        { "sec-fetch-site": "cross-site", cookie: session },
        { "sec-fetch-site": "same-site", cookie: session },
        { "sec-fetch-site": "none", cookie: session },
        { cookie: session },
        { ...SAME, origin: "https://evil.example", cookie: session },
        { ...SAME, origin: "null", cookie: session },
      ] as Record<string, string>[]) {
        const res = await logout(env, headers);
        expect(res.status, JSON.stringify(headers)).toBe(403);
        expect(res.headers.getSetCookie()).toEqual([]);
        expect(res.headers.get("access-control-allow-origin")).toBeNull();
      }
      expect((await me(env, { ...SAME, cookie: session })).status).toBe(200);
    });

    it("セッションが無くても 204 で Cookie を消す（冪等）。GET は 405", async () => {
      const { env } = makeEnv();
      const res = await logout(env, { ...SAME });
      expect(res.status).toBe(204);
      expect(res.headers.getSetCookie().some((c) => c.startsWith(`${SESSION_COOKIE}=;`))).toBe(
        true,
      );
      const get = await logout(env, { ...SAME }, "GET");
      expect(get.status).toBe(405);
      expect(get.headers.get("allow")).toBe("POST");
    });

    it("GitHub の資格には触れない（MCP と共用のため）", async () => {
      const { env } = makeEnv();
      const { user, session } = await loggedIn(env);
      const before = await credentialGeneration(user.userId);
      await logout(env, { ...SAME, cookie: session });
      expect(await credentialGeneration(user.userId)).toBe(before);
    });
  });

  it("未知の API は same-origin なら JSON 404、me に POST は 405", async () => {
    const { env } = makeEnv();
    const unknown = await dash("/dashboard/api/x", { headers: SAME }, env);
    expect(unknown.status).toBe(404);
    const post = await dash("/dashboard/api/me", { method: "POST", headers: SAME }, env);
    expect(post.status).toBe(405);
  });
});

describe("AAD の固定", () => {
  it("セッション Cookie の AAD は dashboard-session-v1", () => {
    expect(SESSION_AAD).toBe("dashboard-session-v1");
  });
});
