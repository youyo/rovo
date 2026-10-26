import { describe, expect, it } from "vitest";
import { GitHubClient, GitHubError } from "../../../src/github/client";
import { json, routerFetch, tokenResponse } from "./helpers";

const NOW = 1_700_000_000_000;

function make(routes: Parameters<typeof routerFetch>[0]) {
  const r = routerFetch(routes);
  const client = new GitHubClient({
    clientId: "cid",
    clientSecret: "csecret",
    oauthBase: "https://gh.test",
    apiBase: "https://api.gh.test",
    fetch: r.fetch,
    now: () => NOW,
  });
  return { client, ...r };
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof GitHubError) return e.code;
    throw e;
  }
  return "no-error";
}

describe("authorizeUrl", () => {
  it("authorize URL を組み立てる", () => {
    const { client } = make({});
    const u = new URL(
      client.authorizeUrl({ redirectUri: "https://app.test/callback", state: "st" }),
    );
    expect(u.origin + u.pathname).toBe("https://gh.test/login/oauth/authorize");
    expect(u.searchParams.get("client_id")).toBe("cid");
    expect(u.searchParams.get("redirect_uri")).toBe("https://app.test/callback");
    expect(u.searchParams.get("state")).toBe("st");
  });
});

describe("token 交換 / refresh", () => {
  it("code を交換し、expires_in から期限を計算する", async () => {
    const { client, calls } = make({
      "POST /login/oauth/access_token": () =>
        tokenResponse({ expires_in: 100, refresh_token_expires_in: 1000 }),
    });
    const t = await client.exchangeCode({ code: "c1", redirectUri: "https://app.test/callback" });
    expect(t).toEqual({
      accessToken: "ghu_new",
      refreshToken: "ghr_new",
      accessExpiresAt: NOW + 100_000,
      refreshExpiresAt: NOW + 1_000_000,
    });
    const body = await calls[0]?.json();
    expect(body).toMatchObject({ client_id: "cid", client_secret: "csecret", code: "c1" });
  });

  it("期限なしトークン（expires_in なし）は null", async () => {
    const { client } = make({
      "POST /login/oauth/access_token": () =>
        json({ access_token: "ghu_forever", token_type: "bearer" }),
    });
    const t = await client.exchangeCode({ code: "c", redirectUri: "https://app.test/callback" });
    expect(t).toEqual({
      accessToken: "ghu_forever",
      refreshToken: null,
      accessExpiresAt: null,
      refreshExpiresAt: null,
    });
  });

  it("refresh_token grant で更新する", async () => {
    const { client, calls } = make({ "POST /login/oauth/access_token": () => tokenResponse() });
    const t = await client.refreshToken("ghr_old");
    expect(t.accessToken).toBe("ghu_new");
    expect(await calls[0]?.json()).toMatchObject({
      grant_type: "refresh_token",
      refresh_token: "ghr_old",
      client_id: "cid",
      client_secret: "csecret",
    });
  });

  it("bad_refresh_token（200 + error）は reauth_required", async () => {
    const { client } = make({
      "POST /login/oauth/access_token": () => json({ error: "bad_refresh_token" }),
    });
    expect(await codeOf(client.refreshToken("x"))).toBe("reauth_required");
  });

  it("bad_verification_code は reauth_required", async () => {
    const { client } = make({
      "POST /login/oauth/access_token": () => json({ error: "bad_verification_code" }),
    });
    expect(await codeOf(client.exchangeCode({ code: "x", redirectUri: "r" }))).toBe(
      "reauth_required",
    );
  });

  it("token エンドポイントの 5xx / 429 は upstream_unavailable", async () => {
    for (const status of [500, 502, 503, 429]) {
      const { client } = make({
        "POST /login/oauth/access_token": () => new Response("x", { status }),
      });
      expect(await codeOf(client.refreshToken("x"))).toBe("upstream_unavailable");
    }
  });

  it("未知の error や設定不備（incorrect_client_credentials）は資格を消さない upstream_unavailable", async () => {
    for (const error of ["incorrect_client_credentials", "something_new"]) {
      const { client } = make({ "POST /login/oauth/access_token": () => json({ error }) });
      expect(await codeOf(client.refreshToken("x"))).toBe("upstream_unavailable");
    }
  });

  it("ネットワークエラーは upstream_unavailable", async () => {
    const client = new GitHubClient({
      clientId: "a",
      clientSecret: "b",
      oauthBase: "https://gh.test",
      apiBase: "https://api.gh.test",
      fetch: (async () => {
        throw new TypeError("network down");
      }) as unknown as typeof fetch,
    });
    expect(await codeOf(client.refreshToken("x"))).toBe("upstream_unavailable");
  });

  it("access_token が無い 200 応答は upstream_unavailable", async () => {
    const { client } = make({ "POST /login/oauth/access_token": () => json({}) });
    expect(await codeOf(client.refreshToken("x"))).toBe("upstream_unavailable");
  });

  it("エラーメッセージにトークンやシークレットを含めない", async () => {
    const { client } = make({
      "POST /login/oauth/access_token": () => json({ error: "bad_refresh_token" }),
    });
    try {
      await client.refreshToken("ghr_SECRETVALUE");
    } catch (e) {
      expect(String(e)).not.toContain("ghr_SECRETVALUE");
      expect(String(e)).not.toContain("csecret");
    }
  });
});

describe("GET /user", () => {
  it("id と login を返し、Bearer で認証する", async () => {
    const { client, calls } = make({
      "GET /user": () => json({ id: 42, login: "alice", extra: "ignored" }),
    });
    expect(await client.getUser("tok")).toEqual({ id: 42, login: "alice" });
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer tok");
  });
});

describe("エラー分類", () => {
  it.each([
    [401, "reauth_required"],
    [403, "forbidden"],
    [404, "forbidden"],
    [429, "upstream_unavailable"],
    [500, "upstream_unavailable"],
    [503, "upstream_unavailable"],
    [422, "upstream_unavailable"],
  ])("API %i -> %s", async (status, code) => {
    const { client } = make({ "GET /user": () => json({ message: "x" }, { status }) });
    expect(await codeOf(client.getUser("t"))).toBe(code);
  });

  it("レート制限の 403 は upstream_unavailable", async () => {
    const { client } = make({
      "GET /user": () =>
        json({ message: "rate" }, { status: 403, headers: { "x-ratelimit-remaining": "0" } }),
    });
    expect(await codeOf(client.getUser("t"))).toBe("upstream_unavailable");
    const r2 = make({
      "GET /user": () =>
        json({ message: "sec" }, { status: 403, headers: { "retry-after": "30" } }),
    });
    expect(await codeOf(r2.client.getUser("t"))).toBe("upstream_unavailable");
  });

  it("ネットワークエラーは upstream_unavailable", async () => {
    const client = new GitHubClient({
      clientId: "a",
      clientSecret: "b",
      fetch: (async () => {
        throw new TypeError("boom");
      }) as unknown as typeof fetch,
    });
    expect(await codeOf(client.getUser("t"))).toBe("upstream_unavailable");
  });
});

describe("team 所属", () => {
  const path = "GET /orgs/my-org/teams/core/memberships/alice";
  const args = { org: "my-org", teamSlug: "core", username: "alice" };

  it("active", async () => {
    const { client } = make({ [path]: () => json({ state: "active", role: "member" }) });
    expect(await client.getTeamMembership("t", args)).toBe("active");
    expect(await client.isActiveTeamMember("t", args)).toBe(true);
  });

  it("pending は許可しない", async () => {
    const { client } = make({ [path]: () => json({ state: "pending", role: "member" }) });
    expect(await client.getTeamMembership("t", args)).toBe("pending");
    expect(await client.isActiveTeamMember("t", args)).toBe(false);
  });

  it("404 は所属なし", async () => {
    const { client } = make({ [path]: () => json({ message: "Not Found" }, { status: 404 }) });
    expect(await client.getTeamMembership("t", args)).toBe("none");
    expect(await client.isActiveTeamMember("t", args)).toBe(false);
  });

  it("未知の state は所属なし扱い（fail closed）", async () => {
    const { client } = make({ [path]: () => json({ state: "weird" }) });
    expect(await client.isActiveTeamMember("t", args)).toBe(false);
  });

  it("401 / 403 / 5xx は例外（分類つき）", async () => {
    for (const [status, code] of [
      [401, "reauth_required"],
      [403, "forbidden"],
      [500, "upstream_unavailable"],
      [429, "upstream_unavailable"],
    ] as const) {
      const { client } = make({ [path]: () => json({}, { status }) });
      expect(await codeOf(client.isActiveTeamMember("t", args))).toBe(code);
    }
  });

  it("パス要素はエンコードされる", async () => {
    const { client, calls } = make({
      "GET /orgs/o%2Fx/teams/t%20s/memberships/u%2Fv": () => json({ state: "active" }),
    });
    await client.getTeamMembership("t", { org: "o/x", teamSlug: "t s", username: "u/v" });
    expect(calls).toHaveLength(1);
  });
});

function repo(id: number, full: string, push: boolean) {
  const [owner, name] = full.split("/");
  return { id, name, full_name: full, owner: { login: owner }, permissions: { push, pull: true } };
}

describe("findWritableRepository", () => {
  it("Installation を走査して push 権限のあるリポジトリを返す（ID も返す）", async () => {
    const { client } = make({
      "GET /user/installations": () =>
        json({ total_count: 2, installations: [{ id: 1 }, { id: 2 }] }),
      "GET /user/installations/1/repositories": () =>
        json({ total_count: 1, repositories: [repo(10, "acme/other", true)] }),
      "GET /user/installations/2/repositories": () =>
        json({ total_count: 1, repositories: [repo(20, "acme/Target", true)] }),
    });
    expect(await client.findWritableRepository("t", "acme/target")).toEqual({
      repositoryId: 20,
      installationId: 2,
      fullName: "acme/Target",
    });
  });

  it("repository ID（数値）でも照合できる", async () => {
    const { client } = make({
      "GET /user/installations": () => json({ installations: [{ id: 1 }] }),
      "GET /user/installations/1/repositories": () =>
        json({ repositories: [repo(10, "acme/a", true), repo(11, "acme/b", true)] }),
    });
    expect((await client.findWritableRepository("t", 11)).fullName).toBe("acme/b");
  });

  it("App が未導入（Installation が無い）なら forbidden", async () => {
    const { client } = make({ "GET /user/installations": () => json({ installations: [] }) });
    expect(await codeOf(client.findWritableRepository("t", "acme/public-repo"))).toBe("forbidden");
  });

  it("導入済みだが選択対象外なら forbidden", async () => {
    const { client } = make({
      "GET /user/installations": () => json({ installations: [{ id: 1 }] }),
      "GET /user/installations/1/repositories": () =>
        json({ repositories: [repo(10, "acme/other", true)] }),
    });
    expect(await codeOf(client.findWritableRepository("t", "acme/target"))).toBe("forbidden");
  });

  it("push 権限が無ければ forbidden", async () => {
    const { client } = make({
      "GET /user/installations": () => json({ installations: [{ id: 1 }] }),
      "GET /user/installations/1/repositories": () =>
        json({ repositories: [repo(10, "acme/target", false)] }),
    });
    expect(await codeOf(client.findWritableRepository("t", "acme/target"))).toBe("forbidden");
  });

  it("permissions が欠けていれば forbidden", async () => {
    const { client } = make({
      "GET /user/installations": () => json({ installations: [{ id: 1 }] }),
      "GET /user/installations/1/repositories": () =>
        json({ repositories: [{ id: 10, full_name: "acme/target" }] }),
    });
    expect(await codeOf(client.findWritableRepository("t", "acme/target"))).toBe("forbidden");
  });

  it("repositories をページ送り（Link ヘッダ）で走査する", async () => {
    const { client, calls } = make({
      "GET /user/installations": () => json({ installations: [{ id: 1 }] }),
      "GET /user/installations/1/repositories": (req) => {
        const page = new URL(req.url).searchParams.get("page") ?? "1";
        if (page === "1") {
          return json(
            { repositories: [repo(1, "acme/a", true)] },
            {
              headers: {
                link: '<https://api.gh.test/user/installations/1/repositories?per_page=100&page=2>; rel="next", <https://api.gh.test/user/installations/1/repositories?per_page=100&page=3>; rel="last"',
              },
            },
          );
        }
        if (page === "2") {
          return json(
            { repositories: [repo(2, "acme/b", true)] },
            {
              headers: {
                link: '<https://api.gh.test/user/installations/1/repositories?per_page=100&page=3>; rel="next"',
              },
            },
          );
        }
        return json({ repositories: [repo(3, "acme/target", true)] });
      },
    });
    expect((await client.findWritableRepository("t", "acme/target")).repositoryId).toBe(3);
    expect(calls.filter((c) => c.url.includes("/repositories"))).toHaveLength(3);
  });

  it("Installation 一覧もページ送りする", async () => {
    const { client } = make({
      "GET /user/installations": (req) => {
        const page = new URL(req.url).searchParams.get("page") ?? "1";
        return page === "1"
          ? json(
              { installations: [{ id: 1 }] },
              { headers: { link: '<https://api.gh.test/user/installations?page=2>; rel="next"' } },
            )
          : json({ installations: [{ id: 2 }] });
      },
      "GET /user/installations/1/repositories": () => json({ repositories: [] }),
      "GET /user/installations/2/repositories": () =>
        json({ repositories: [repo(5, "acme/target", true)] }),
    });
    expect((await client.findWritableRepository("t", "acme/target")).installationId).toBe(2);
  });

  it("Link の next が別オリジンならトークンを送らず upstream_unavailable", async () => {
    const { client, calls } = make({
      "GET /user/installations": () =>
        json(
          { installations: [{ id: 1 }] },
          { headers: { link: '<https://evil.test/steal?page=2>; rel="next"' } },
        ),
      "GET /user/installations/1/repositories": () => json({ repositories: [] }),
    });
    expect(await codeOf(client.findWritableRepository("t", "acme/target"))).toBe(
      "upstream_unavailable",
    );
    expect(calls.some((c) => c.url.startsWith("https://evil.test"))).toBe(false);
  });

  it("途中の API エラーは分類される（401 / 5xx）。forbidden に潰さない", async () => {
    const a = make({ "GET /user/installations": () => json({}, { status: 401 }) });
    expect(await codeOf(a.client.findWritableRepository("t", "acme/target"))).toBe(
      "reauth_required",
    );
    const b = make({
      "GET /user/installations": () => json({ installations: [{ id: 1 }] }),
      "GET /user/installations/1/repositories": () => json({}, { status: 502 }),
    });
    expect(await codeOf(b.client.findWritableRepository("t", "acme/target"))).toBe(
      "upstream_unavailable",
    );
  });

  it("owner/name の形式でない文字列は forbidden", async () => {
    const { client } = make({});
    expect(await codeOf(client.findWritableRepository("t", "nonsense"))).toBe("forbidden");
  });
});

describe("org 所属（GET /user/memberships/orgs/{org}。トークンの持ち主の所属）", () => {
  const path = "GET /user/memberships/orgs/my-org";
  const args = { org: "my-org" };

  it("active", async () => {
    const { client } = make({ [path]: () => json({ state: "active", role: "member" }) });
    expect(await client.getOrgMembership("t", args)).toBe("active");
    expect(await client.isActiveOrgMember("t", args)).toBe(true);
  });

  it("pending（招待中）は許可しない", async () => {
    const { client } = make({ [path]: () => json({ state: "pending", role: "member" }) });
    expect(await client.getOrgMembership("t", args)).toBe("pending");
    expect(await client.isActiveOrgMember("t", args)).toBe(false);
  });

  it("404（所属していない・外部コラボレーター）は所属なし", async () => {
    const { client } = make({ [path]: () => json({ message: "Not Found" }, { status: 404 }) });
    expect(await client.getOrgMembership("t", args)).toBe("none");
    expect(await client.isActiveOrgMember("t", args)).toBe(false);
  });

  it("未知の state・state 無しは所属なし扱い（fail closed）", async () => {
    for (const body of [{ state: "weird" }, {}]) {
      const { client } = make({ [path]: () => json(body) });
      expect(await client.isActiveOrgMember("t", args)).toBe(false);
    }
  });

  it("401 / 403 / 5xx は例外（分類つき。黙って所属なしにしない）", async () => {
    for (const [status, code] of [
      [401, "reauth_required"],
      [403, "forbidden"],
      [500, "upstream_unavailable"],
      [429, "upstream_unavailable"],
    ] as const) {
      const { client } = make({ [path]: () => json({}, { status }) });
      expect(await codeOf(client.isActiveOrgMember("t", args))).toBe(code);
      expect(await codeOf(client.getOrgMembership("t", args))).toBe(code);
    }
  });

  it("org はエンコードされる", async () => {
    const { client, calls } = make({
      "GET /user/memberships/orgs/o%2Fx": () => json({ state: "active" }),
    });
    await client.getOrgMembership("t", { org: "o/x" });
    expect(calls).toHaveLength(1);
  });
});
