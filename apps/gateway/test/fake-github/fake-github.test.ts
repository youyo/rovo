import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type FakeGitHub, startFakeGitHub } from "./server";

let gh: FakeGitHub;

beforeEach(async () => {
  gh = await startFakeGitHub();
});
afterEach(async () => {
  await gh.stop();
});

async function admin(path: string, body: unknown = {}) {
  const res = await fetch(`${gh.url}/__admin/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(200);
  return res.json() as Promise<Record<string, unknown>>;
}

/** authorize -> code -> token まで通す */
async function login(loginName: string) {
  const res = await fetch(
    `${gh.url}/login/oauth/authorize?client_id=${gh.clientId}&redirect_uri=${encodeURIComponent("http://app.test/callback")}&state=S1&login=${loginName}`,
    { redirect: "manual" },
  );
  expect(res.status).toBe(302);
  const loc = new URL(res.headers.get("location") ?? "");
  expect(loc.origin + loc.pathname).toBe("http://app.test/callback");
  expect(loc.searchParams.get("state")).toBe("S1");
  const code = loc.searchParams.get("code") ?? "";
  const tok = await exchange({ code });
  return { ...tok, code } as Record<string, string | number>;
}

async function exchange(body: Record<string, string>) {
  const res = await fetch(`${gh.url}/login/oauth/access_token`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ client_id: gh.clientId, client_secret: gh.clientSecret, ...body }),
  });
  return (await res.json()) as Record<string, string | number>;
}

function get(path: string, token?: string) {
  return fetch(`${gh.url}${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

describe("OAuth", () => {
  it("authorize は即リダイレクトし、code が access/refresh token と交換できる", async () => {
    await admin("users", { id: 1, login: "alice" });
    const t = await login("alice");
    expect(String(t.access_token)).toMatch(/^ghu_/);
    expect(String(t.refresh_token)).toMatch(/^ghr_/);
    expect(t.expires_in).toBe(28800);
    expect(t.refresh_token_expires_in).toBe(15811200);
  });

  it("login クエリが無ければ直近に登録したユーザー（または set-current-user）でログインする", async () => {
    await admin("users", { id: 1, login: "alice" });
    await admin("users", { id: 2, login: "bob" });
    await admin("current-user", { login: "alice" });
    const res = await fetch(
      `${gh.url}/login/oauth/authorize?client_id=${gh.clientId}&redirect_uri=http://app.test/cb&state=x`,
      { redirect: "manual" },
    );
    const code = new URL(res.headers.get("location") ?? "").searchParams.get("code") ?? "";
    const t = await exchange({ code });
    const me = await (await get("/user", String(t.access_token))).json();
    expect(me).toMatchObject({ id: 1, login: "alice" });
  });

  it("code は 1 回しか使えない / 不明な code は bad_verification_code", async () => {
    await admin("users", { id: 1, login: "alice" });
    const code = String((await login("alice")).code);
    expect(await exchange({ code })).toMatchObject({ error: "bad_verification_code" });
    expect(await exchange({ code: "nope" })).toMatchObject({ error: "bad_verification_code" });
  });

  it("client_id / client_secret が違えば拒否", async () => {
    const res = await fetch(
      `${gh.url}/login/oauth/authorize?client_id=wrong&redirect_uri=http://app.test/cb&state=x`,
      { redirect: "manual" },
    );
    expect(res.status).toBe(400);
    await admin("users", { id: 1, login: "alice" });
    const ok = await fetch(
      `${gh.url}/login/oauth/authorize?client_id=${gh.clientId}&redirect_uri=http://app.test/cb&state=x&login=alice`,
      { redirect: "manual" },
    );
    const code = new URL(ok.headers.get("location") ?? "").searchParams.get("code") ?? "";
    const bad = await fetch(`${gh.url}/login/oauth/access_token`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ client_id: gh.clientId, client_secret: "wrong", code }),
    });
    expect(await bad.json()).toMatchObject({ error: "incorrect_client_credentials" });
  });

  it("form-urlencoded でも受け付け、Accept が json でなければ form で返す", async () => {
    await admin("users", { id: 1, login: "alice" });
    const ok = await fetch(
      `${gh.url}/login/oauth/authorize?client_id=${gh.clientId}&redirect_uri=http://app.test/cb&state=x&login=alice`,
      { redirect: "manual" },
    );
    const code = new URL(ok.headers.get("location") ?? "").searchParams.get("code") ?? "";
    const res = await fetch(`${gh.url}/login/oauth/access_token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: gh.clientId,
        client_secret: gh.clientSecret,
        code,
      }).toString(),
    });
    const p = new URLSearchParams(await res.text());
    expect(p.get("access_token")).toMatch(/^ghu_/);
  });

  it("refresh でトークンを入れ替え、旧 access / 旧 refresh は無効になる", async () => {
    await admin("users", { id: 1, login: "alice" });
    const t1 = await login("alice");
    const t2 = await exchange({
      grant_type: "refresh_token",
      refresh_token: String(t1.refresh_token),
    });
    expect(t2.access_token).not.toBe(t1.access_token);
    expect(t2.refresh_token).not.toBe(t1.refresh_token);
    expect((await get("/user", String(t1.access_token))).status).toBe(401);
    expect((await get("/user", String(t2.access_token))).status).toBe(200);
    expect(
      await exchange({ grant_type: "refresh_token", refresh_token: String(t1.refresh_token) }),
    ).toMatchObject({ error: "bad_refresh_token" });
  });

  it("access トークンの期限切れ: expire-access-tokens で 401 になり、refresh で回復する", async () => {
    await admin("users", { id: 1, login: "alice" });
    const t1 = await login("alice");
    await admin("expire-access-tokens");
    expect((await get("/user", String(t1.access_token))).status).toBe(401);
    const t2 = await exchange({
      grant_type: "refresh_token",
      refresh_token: String(t1.refresh_token),
    });
    expect((await get("/user", String(t2.access_token))).status).toBe(200);
  });

  it("refresh 失効: revoke-refresh-tokens 後の refresh は bad_refresh_token", async () => {
    await admin("users", { id: 1, login: "alice" });
    const t1 = await login("alice");
    await admin("revoke-refresh-tokens");
    expect(
      await exchange({ grant_type: "refresh_token", refresh_token: String(t1.refresh_token) }),
    ).toMatchObject({ error: "bad_refresh_token" });
  });

  it("config でトークンの有効期限を変えられる（null で期限なし）", async () => {
    await admin("config", { accessTokenTtlSeconds: null, refreshTokenTtlSeconds: null });
    await admin("users", { id: 1, login: "alice" });
    const t = await login("alice");
    expect(t.expires_in).toBeUndefined();
    expect(t.refresh_token).toBeUndefined();
  });
});

describe("API", () => {
  it("トークン無し・不正は 401", async () => {
    expect((await get("/user")).status).toBe(401);
    expect((await get("/user", "bogus")).status).toBe(401);
  });

  it("GET /user", async () => {
    await admin("users", { id: 7, login: "alice" });
    const t = await login("alice");
    expect(await (await get("/user", String(t.access_token))).json()).toMatchObject({
      id: 7,
      login: "alice",
    });
  });

  it("team membership: active / pending / なし(404)", async () => {
    await admin("users", { id: 1, login: "alice" });
    await admin("users", { id: 2, login: "bob" });
    await admin("teams", { org: "acme", team: "core", login: "alice", state: "active" });
    await admin("teams", { org: "acme", team: "core", login: "bob", state: "pending" });
    const t = String((await login("alice")).access_token);
    expect(await (await get("/orgs/acme/teams/core/memberships/alice", t)).json()).toMatchObject({
      state: "active",
    });
    expect(await (await get("/orgs/acme/teams/core/memberships/bob", t)).json()).toMatchObject({
      state: "pending",
    });
    expect((await get("/orgs/acme/teams/core/memberships/carol", t)).status).toBe(404);
    await admin("teams", { org: "acme", team: "core", login: "alice", state: "none" });
    expect((await get("/orgs/acme/teams/core/memberships/alice", t)).status).toBe(404);
  });

  it("installations と repositories（push 権限つき）", async () => {
    await admin("users", { id: 1, login: "alice" });
    await admin("installations", {
      id: 100,
      repositories: [
        { id: 1, fullName: "acme/a", push: true },
        { id: 2, fullName: "acme/b", push: false },
      ],
    });
    const t = String((await login("alice")).access_token);
    const insts = await (await get("/user/installations", t)).json();
    expect(insts).toMatchObject({ total_count: 1, installations: [{ id: 100 }] });
    const repos = (await (await get("/user/installations/100/repositories", t)).json()) as {
      repositories: { id: number; full_name: string; permissions: { push: boolean } }[];
    };
    expect(repos.repositories.map((r) => [r.id, r.full_name, r.permissions.push])).toEqual([
      [1, "acme/a", true],
      [2, "acme/b", false],
    ]);
    expect((await get("/user/installations/999/repositories", t)).status).toBe(404);
  });

  it("visibleTo を持つリポジトリは、そのユーザーの repositories にだけ出る（無ければ全員に見える）", async () => {
    await admin("users", { id: 1, login: "alice" });
    await admin("users", { id: 2, login: "bob" });
    await admin("installations", {
      id: 100,
      repositories: [
        { id: 1, fullName: "acme/open", push: true },
        { id: 2, fullName: "acme/private", push: true, visibleTo: ["alice"] },
      ],
    });
    const ta = String((await login("alice")).access_token);
    const tb = String((await login("bob")).access_token);
    const ids = async (t: string) => {
      const body = (await (await get("/user/installations/100/repositories", t)).json()) as {
        total_count: number;
        repositories: { id: number }[];
      };
      expect(body.total_count).toBe(body.repositories.length);
      return body.repositories.map((r) => r.id);
    };
    expect(await ids(ta)).toEqual([1, 2]);
    expect(await ids(tb)).toEqual([1]);
  });

  it("repositories は per_page / page と Link ヘッダでページ送りできる", async () => {
    await admin("users", { id: 1, login: "alice" });
    await admin("installations", {
      id: 100,
      repositories: Array.from({ length: 5 }, (_, i) => ({
        id: i + 1,
        fullName: `acme/r${i + 1}`,
        push: true,
      })),
    });
    const t = String((await login("alice")).access_token);
    const p1 = await get("/user/installations/100/repositories?per_page=2&page=1", t);
    expect(((await p1.clone().json()) as { repositories: unknown[] }).repositories).toHaveLength(2);
    const link = p1.headers.get("link") ?? "";
    expect(link).toContain('rel="next"');
    const next = /<([^>]+)>; rel="next"/.exec(link)?.[1] ?? "";
    expect(next.startsWith(gh.url)).toBe(true);
    const p3 = await fetch(next.replace("&page=2", "&page=3"), {
      headers: { authorization: `Bearer ${t}` },
    });
    expect(((await p3.clone().json()) as { repositories: unknown[] }).repositories).toHaveLength(1);
    expect(p3.headers.get("link") ?? "").not.toContain('rel="next"');
  });
});

describe("障害注入とリクエストログ", () => {
  it("fault: API を 5xx / 429 にできる。count 回で自動復旧", async () => {
    await admin("users", { id: 1, login: "alice" });
    const t = String((await login("alice")).access_token);
    await admin("fault", { target: "api", status: 503, count: 2 });
    expect((await get("/user", t)).status).toBe(503);
    expect((await get("/user", t)).status).toBe(503);
    expect((await get("/user", t)).status).toBe(200);
    await admin("fault", { target: "api", status: 429, count: 1 });
    const r = await get("/user", t);
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).not.toBeNull();
  });

  it("fault: token エンドポイントも 5xx にでき、clear で解除できる", async () => {
    await admin("users", { id: 1, login: "alice" });
    const t1 = await login("alice");
    await admin("fault", { target: "token", status: 502 });
    const res = await fetch(`${gh.url}/login/oauth/access_token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: String(t1.refresh_token),
      }),
    });
    expect(res.status).toBe(502);
    await admin("fault", { target: "token", status: null });
    const ok = await exchange({
      grant_type: "refresh_token",
      refresh_token: String(t1.refresh_token),
    });
    expect(ok.access_token).toBeDefined();
  });

  it("reset で全状態を初期化する", async () => {
    await admin("users", { id: 1, login: "alice" });
    const t = String((await login("alice")).access_token);
    await admin("reset");
    expect((await get("/user", t)).status).toBe(401);
  });

  it("requests でリクエストログを取得できる", async () => {
    await admin("users", { id: 1, login: "alice" });
    const t = String((await login("alice")).access_token);
    await get("/user", t);
    const log = (await (await fetch(`${gh.url}/__admin/requests`)).json()) as {
      requests: { method: string; path: string }[];
    };
    expect(log.requests.some((r) => r.method === "GET" && r.path === "/user")).toBe(true);
  });

  it("プロセス内の admin API からも同じ操作ができる", async () => {
    gh.admin.addUser({ id: 1, login: "alice" });
    gh.admin.setTeamMembership("acme", "core", "alice", "active");
    gh.admin.setInstallation({ id: 5, repositories: [{ id: 9, fullName: "acme/x", push: true }] });
    const t = String((await login("alice")).access_token);
    expect((await get("/orgs/acme/teams/core/memberships/alice", t)).status).toBe(200);
    expect((await get("/user/installations/5/repositories", t)).status).toBe(200);
  });
});
