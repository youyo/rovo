import { beforeEach, describe, expect, it } from "vitest";
import { addMember, admin, auditRecords, baseUrl, login, newUser, waitForAudit } from "./helpers";
import { approveAtGitHub, callCallback } from "./oauth-client";

// 実 Worker（wrangler dev）+ 偽 GitHub で、ダッシュボードのブラウザのログインを HTTP の往復で通しに確かめる（M4）。
// ブラウザの代わりに Cookie を手で運ぶ。ブラウザが付ける Sec-Fetch-Site も手で付ける。

const SESSION_COOKIE = "__Host-rovo_dash";
const LOGIN_COOKIE = "__Host-rovo_dash_login";
const SAME = { "sec-fetch-site": "same-origin" };

beforeEach(async () => {
  await admin.reset();
});

function cookiePairs(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0] ?? "")
    .filter((c) => c.includes("=") && !c.endsWith("="))
    .join("; ");
}

function cookieNamed(res: Response, name: string): string {
  const c = res.headers.getSetCookie().find((s) => s.startsWith(`${name}=`));
  return c ? (c.split(";")[0] ?? "") : "";
}

/** ログインを開始する（GET /dashboard/auth/login）。GitHub の authorize URL と、開始したブラウザの Cookie を返す。 */
async function startLogin(query = "") {
  const res = await fetch(`${baseUrl}/dashboard/auth/login${query}`, { redirect: "manual" });
  expect(res.status).toBe(302);
  const githubUrl = res.headers.get("location") ?? "";
  return {
    res,
    githubUrl,
    cookie: cookiePairs(res),
    state: new URL(githubUrl).searchParams.get("state") ?? "",
  };
}

/** ログインを最後まで進める（偽 GitHub の「現在のユーザー」でログイン）。callback の応答を返す。 */
async function completeLogin(user: { id: number; login: string }, query = "") {
  await admin.setCurrentUser(user.login);
  const start = await startLogin(query);
  const callbackUrl = await approveAtGitHub(start.githubUrl);
  const res = await callCallback(callbackUrl, start.cookie);
  return { start, callbackUrl, res, session: cookieNamed(res, SESSION_COOKIE) };
}

/** このテストの開始以降の Worker 側の監査。DO の外の記録は非同期で、他のテストの記録も残るので、時刻で絞って少し待つ。 */
async function auditSince(startedAt: number) {
  await new Promise((r) => setTimeout(r, 700));
  return (await auditRecords()).filter((r) => r.ts >= startedAt);
}

const me = (cookie: string, headers: Record<string, string> = SAME) =>
  fetch(`${baseUrl}/dashboard/api/me`, { headers: { ...headers, ...(cookie ? { cookie } : {}) } });

describe("ダッシュボードのログイン（正常系）", () => {
  it("ログイン → /me → ログアウト → /me が 401。戻り先は /dashboard/", async () => {
    const user = newUser("dash");
    await addMember(user);
    const { start, res, session } = await completeLogin(user);

    // 開始: GitHub の authorize へ。redirect_uri は MCP と共有する /callback で、state は rovo-dash. + 43 文字
    const gh = new URL(start.githubUrl);
    expect(gh.searchParams.get("redirect_uri")).toBe(`${baseUrl}/callback`);
    expect(start.state).toMatch(/^rovo-dash\.[A-Za-z0-9_-]{43}$/);
    const loginCookie = start.res.headers.getSetCookie()[0] ?? "";
    expect(loginCookie.startsWith(`${LOGIN_COOKIE}=`)).toBe(true);
    expect(loginCookie).toMatch(/HttpOnly/i);
    expect(loginCookie).toMatch(/SameSite=Lax/i);
    expect(loginCookie).toMatch(/Secure/i);

    // callback: セッション Cookie を発行して固定の戻り先へ
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/dashboard/");
    expect(session).not.toBe("");
    const setCookie =
      res.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`)) ?? "";
    for (const attr of [/Secure/i, /HttpOnly/i, /SameSite=Lax/i, /Path=\//i]) {
      expect(setCookie).toMatch(attr);
    }
    expect(setCookie).not.toMatch(/Domain=/i);
    expect(setCookie).not.toContain("ghu_"); // GitHub のトークンは Cookie に入れない

    const ok = await me(session);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ login: user.login });
    expect(ok.headers.get("cache-control")).toBe("no-store");
    expect(ok.headers.get("x-content-type-options")).toBe("nosniff");
    expect(ok.headers.get("access-control-allow-origin")).toBeNull();

    // 別サイトからの /me は、Cookie があっても 403
    expect((await me(session, { "sec-fetch-site": "cross-site" })).status).toBe(403);
    // ログアウト（CSRF: cross-site の POST は拒否され、セッションは残る）
    const csrf = await fetch(`${baseUrl}/dashboard/api/logout`, {
      method: "POST",
      headers: { "sec-fetch-site": "cross-site", cookie: session },
    });
    expect(csrf.status).toBe(403);
    expect((await me(session)).status).toBe(200);

    const out = await fetch(`${baseUrl}/dashboard/api/logout`, {
      method: "POST",
      headers: { ...SAME, cookie: session },
    });
    expect(out.status).toBe(204);
    expect(out.headers.getSetCookie().some((c) => c.startsWith(`${SESSION_COOKIE}=;`))).toBe(true);
    // 古い Cookie を持ち続けていても、サーバー側で失効している
    expect((await me(session)).status).toBe(401);
  });

  it("戻り先は /dashboard/tasks/<ULID> だけ許し、外部 URL は既定に倒す", async () => {
    const user = newUser("dash");
    await addMember(user);
    const task = "01JZ0000000000000000000000";
    const ok = await completeLogin(
      user,
      `?return_to=${encodeURIComponent(`/dashboard/tasks/${task}`)}`,
    );
    expect(ok.res.headers.get("location")).toBe(`/dashboard/tasks/${task}`);
    for (const evil of ["//evil.example/", "https://evil.example/", "/\\evil.example"]) {
      const r = await completeLogin(user, `?return_to=${encodeURIComponent(evil)}`);
      expect(r.res.headers.get("location"), evil).toBe("/dashboard/");
    }
  });

  it("再ログインしても古いセッションは有効なまま（複数端末）。ログアウトは自分の分だけ", async () => {
    const user = newUser("dash");
    await addMember(user);
    const first = await completeLogin(user);
    const second = await completeLogin(user);
    expect(second.session).not.toBe(first.session);
    expect((await me(first.session)).status).toBe(200);
    expect((await me(second.session)).status).toBe(200);
    const out = await fetch(`${baseUrl}/dashboard/api/logout`, {
      method: "POST",
      headers: { ...SAME, cookie: first.session },
    });
    expect(out.status).toBe(204);
    expect((await me(first.session)).status).toBe(401);
    expect((await me(second.session)).status).toBe(200);
  });

  it("未ログイン・壊れた Cookie・ヘッダ無しは拒否される", async () => {
    const user = newUser("dash");
    await addMember(user);
    const { session } = await completeLogin(user);
    expect((await me("")).status).toBe(401);
    expect((await me(`${SESSION_COOKIE}=garbage`)).status).toBe(401);
    // Sec-Fetch-Site が無い呼び出し（ブラウザ以外）は、有効な Cookie があっても 403
    expect((await me(session, {})).status).toBe(403);
  });
});

describe("MCP のログインとの共存", () => {
  it("ダッシュボードのログインのあとでも MCP のログインができ、ダッシュボードのセッションは落ちない", async () => {
    const startedAt = Date.now();
    const user = newUser("both");
    await addMember(user);
    const dash = await completeLogin(user);
    const client = await login(user); // MCP の OAuth（接頭辞なしの state）。同じ /callback を通る
    try {
      const tools = await client.listTools();
      expect(tools.tools.length).toBeGreaterThan(0);
    } finally {
      await client.close();
    }
    // MCP の再ログイン（資格の保存）ではダッシュボードのセッションは落ちない
    expect((await me(dash.session)).status).toBe(200);
    // MCP のログインでダッシュボードの監査（caller: dashboard）は出ていない
    const records = await auditSince(startedAt);
    expect(records.filter((r) => r.caller === "dashboard")).toEqual([]);
  });

  it("ダッシュボードのログインで保存した資格を、MCP のログインの前にも後にも使える（資格は共用）", async () => {
    const user = newUser("shared");
    await addMember(user);
    await completeLogin(user);
    const client = await login(user);
    await client.close();
  });
});

describe("ダッシュボードのログインの失敗", () => {
  it("許可外のユーザー（team のメンバーではない）は 303（denied）でセッションを作らない。監査は caller: dashboard", async () => {
    const user = newUser("outsider");
    await admin.addUser(user); // team には入れない
    const { res, session } = await completeLogin(user);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/dashboard/?login_error=denied");
    expect(session).toBe("");
    const hit = await waitForAudit((r) => r.event === "authz_denied" && r.caller === "dashboard");
    expect(hit.userId).toBe(user.id);
    expect(hit.reason).toBe("not_team_member");
    // 本文にユーザーの情報・トークンを出さない
    const body = await res.text();
    expect(body).not.toContain(user.login);
    expect(body).not.toContain("ghu_");
  });

  it("GitHub のトークン交換が障害（503）のときは 303（unavailable）でセッションを作らない。認証の失敗としては記録しない", async () => {
    const startedAt = Date.now();
    const user = newUser("flaky");
    await addMember(user);
    await admin.setFault("token", 503, 1);
    const { res, session } = await completeLogin(user);
    expect(res.status).toBe(303);
    expect(session).toBe("");
    expect(res.headers.get("location")).toBe("/dashboard/?login_error=unavailable");
    expect((await auditSince(startedAt)).filter((r) => r.caller === "dashboard")).toEqual([]);
    // 障害が直れば、最初からやり直せる
    const retry = await completeLogin(user);
    expect(retry.res.status).toBe(302);
  });

  it("state の不一致: 開始していない（偽造した）state・別のブラウザの Cookie は 303（invalid）。MCP の監査は汚れない", async () => {
    const startedAt = Date.now();
    const user = newUser("csrf");
    await addMember(user);
    await admin.setCurrentUser(user.login);
    const a = await startLogin();
    const b = await startLogin();
    const callbackA = await approveAtGitHub(a.githubUrl);

    // 別のブラウザの Cookie（b の開始の値）
    const wrongCookie = await callCallback(callbackA, b.cookie);
    expect(wrongCookie.status).toBe(303);
    expect(wrongCookie.headers.get("location")).toBe("/dashboard/?login_error=invalid");
    expect(cookieNamed(wrongCookie, SESSION_COOKIE)).toBe("");
    // Cookie 無し
    const noCookie = await callCallback(callbackA, "");
    expect(noCookie.status).toBe(303);
    // 偽造した state（KV に無い）
    const forged = new URL(callbackA);
    forged.searchParams.set("state", `rovo-dash.${"A".repeat(43)}`);
    const forgedRes = await callCallback(forged.toString(), a.cookie);
    expect(forgedRes.status).toBe(303);
    // 接頭辞付きの state の不一致は、MCP の経路に落ちない（MCP の監査 caller: parent / invalid_state が出ない）
    const records = await auditSince(startedAt);
    expect(records.filter((r) => r.caller === "parent")).toEqual([]);
    expect(
      records.filter((r) => r.caller === "dashboard" && r.reason === "dashboard_invalid_state")
        .length,
    ).toBeGreaterThanOrEqual(3);
    // 最初の試行で a の state は消費されている（不一致でも消費する）
    const retry = await callCallback(callbackA, a.cookie);
    expect(retry.status).toBe(303);
  });

  it("同じ callback の再送は 2 回目が 303（invalid）。1 回目のセッションは残る", async () => {
    const user = newUser("replay");
    await addMember(user);
    const { callbackUrl, start, res, session } = await completeLogin(user);
    expect(res.status).toBe(302);
    const again = await callCallback(callbackUrl, start.cookie);
    expect(again.status).toBe(303);
    expect(again.headers.get("location")).toBe("/dashboard/?login_error=invalid");
    expect(cookieNamed(again, SESSION_COOKIE)).toBe("");
    expect((await me(session)).status).toBe(200);
  });

  it("接頭辞の無い不正な state は、今までどおり MCP の経路で拒否される（監査は caller: parent）", async () => {
    const res = await fetch(`${baseUrl}/callback?code=x&state=${"A".repeat(43)}`, {
      redirect: "manual",
    });
    expect(res.status).toBe(400);
    const hit = await waitForAudit(
      (r) => r.event === "auth_failed" && r.reason === "invalid_state",
    );
    expect(hit.caller).toBe("parent");
  });
});
