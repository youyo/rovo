import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { MEMBERSHIP_CACHE_TTL_MS } from "../../src/tasks/user-do";
import { FakeGitHubFetch, installFakeGitHub } from "./fake-github-fetch";
import { newUserId } from "./helpers";

const MIN = 60_000;

function clock(start = Date.now()) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

function sql<T>(stub: Awaited<ReturnType<typeof installFakeGitHub>>, q: string) {
  return runInDurableObject(stub, (_i, state) => state.storage.sql.exec(q).toArray() as T[]);
}

describe("UserDO.saveCredential", () => {
  it("DO には暗号文しか残らない（平文のトークンが無い）", async () => {
    const gh = new FakeGitHubFetch();
    const stub = await installFakeGitHub(newUserId(), gh, { login: false });
    await stub.saveCredential({
      accessToken: "ghu_PLAIN_ACCESS",
      refreshToken: "ghr_PLAIN_REFRESH",
      accessExpiresAt: Date.now() + 3600_000,
      refreshExpiresAt: Date.now() + 9e9,
    });
    const rows = await sql(stub, "SELECT * FROM github_credential");
    const raw = JSON.stringify(rows);
    expect(raw).not.toContain("PLAIN_ACCESS");
    expect(raw).not.toContain("PLAIN_REFRESH");
    expect(rows[0]).toMatchObject({ generation: 1, version: 1 });
  });

  it("再ログインは資格を上書きし、世代が進む", async () => {
    const gh = new FakeGitHubFetch();
    const stub = await installFakeGitHub(newUserId(), gh); // 1 回目
    await stub.saveCredential(gh.issue());
    const [row] = await sql<{ generation: number }>(
      stub,
      "SELECT generation FROM github_credential",
    );
    expect(row?.generation).toBe(2);
  });

  it("再ログインで team 所属のキャッシュは捨てられる", async () => {
    const gh = new FakeGitHubFetch();
    const stub = await installFakeGitHub(newUserId(), gh);
    expect(await stub.ensureMember(1)).toEqual({ ok: true });
    gh.team = "none";
    await stub.saveCredential(gh.issue());
    expect(await stub.ensureMember(1)).toMatchObject({ ok: false, code: "forbidden" });
  });
});

describe("UserDO.ensureMember", () => {
  it("active なら ok。結果は TTL 内ならキャッシュされ GitHub を呼ばない", async () => {
    const gh = new FakeGitHubFetch();
    const stub = await installFakeGitHub(newUserId(), gh);
    expect(await stub.ensureMember(1)).toEqual({ ok: true });
    const calls = gh.calls.length;
    expect(await stub.ensureMember(1)).toEqual({ ok: true });
    expect(gh.calls.length).toBe(calls);
  });

  it.each(["pending", "none"] as const)("team の状態が %s なら forbidden", async (state) => {
    const gh = new FakeGitHubFetch();
    gh.team = state;
    const stub = await installFakeGitHub(newUserId(), gh);
    expect(await stub.ensureMember(1)).toMatchObject({ ok: false, code: "forbidden" });
  });

  it("ログイン後に team から外されたら、TTL が切れた後の呼び出しで拒否される", async () => {
    const gh = new FakeGitHubFetch();
    const c = clock();
    const stub = await installFakeGitHub(newUserId(), gh, { now: c.now });
    expect(await stub.ensureMember(1)).toEqual({ ok: true });
    gh.team = "none";
    c.advance(MEMBERSHIP_CACHE_TTL_MS - 1000);
    expect(await stub.ensureMember(1)).toEqual({ ok: true }); // まだキャッシュ内（最大 5 分の遅れ）
    c.advance(2000);
    expect(await stub.ensureMember(1)).toMatchObject({ ok: false, code: "forbidden" });
  });

  it("拒否の結果も TTL 内はキャッシュされ、TTL 後に再確認する", async () => {
    const gh = new FakeGitHubFetch();
    gh.team = "none";
    const c = clock();
    const stub = await installFakeGitHub(newUserId(), gh, { now: c.now });
    await stub.ensureMember(1);
    const n = gh.calls.length;
    await stub.ensureMember(1);
    expect(gh.calls.length).toBe(n);
    gh.team = "active";
    c.advance(MEMBERSHIP_CACHE_TTL_MS + 1);
    expect(await stub.ensureMember(1)).toEqual({ ok: true });
  });

  it("同時の呼び出しは 1 回の確認を共有する", async () => {
    const gh = new FakeGitHubFetch();
    const stub = await installFakeGitHub(newUserId(), gh);
    const rs = await Promise.all(Array.from({ length: 5 }, () => stub.ensureMember(1)));
    expect(rs.every((r) => r.ok)).toBe(true);
    expect(gh.count("/user")).toBe(1);
  });

  it("資格が別人のもの（user id 不一致）なら forbidden", async () => {
    const gh = new FakeGitHubFetch();
    const stub = await installFakeGitHub(newUserId(), gh);
    expect(await stub.ensureMember(999)).toMatchObject({ ok: false, code: "forbidden" });
  });

  it.each([
    [500, "upstream_unavailable"],
    [429, "upstream_unavailable"],
    [403, "forbidden"],
  ])("GitHub が %s なら %s（fail-closed。失敗はキャッシュしない）", async (status, code) => {
    const gh = new FakeGitHubFetch();
    const stub = await installFakeGitHub(newUserId(), gh);
    gh.apiFault = status;
    expect(await stub.ensureMember(1)).toMatchObject({ ok: false, code });
    gh.apiFault = null;
    expect(await stub.ensureMember(1)).toEqual({ ok: true }); // 失敗後に復旧すれば通る
  });

  it("資格が無ければ reauth_required", async () => {
    const gh = new FakeGitHubFetch();
    const stub = await installFakeGitHub(newUserId(), gh, { login: false });
    expect(await stub.ensureMember(1)).toMatchObject({ ok: false, code: "reauth_required" });
  });

  it("access token の期限切れ: refresh token が有効なら自動でリフレッシュして成功する", async () => {
    const gh = new FakeGitHubFetch();
    const c = clock();
    const stub = await installFakeGitHub(newUserId(), gh, { now: c.now });
    c.advance(9 * 3600_000);
    expect(await stub.ensureMember(1)).toEqual({ ok: true });
    expect(gh.calls.filter((x) => x.path === "/login/oauth/access_token")).toHaveLength(1);
  });

  it("GitHub が 401 を返したら 1 回だけ強制リフレッシュして再試行する（旧トークンは使われない）", async () => {
    const gh = new FakeGitHubFetch();
    const stub = await installFakeGitHub(newUserId(), gh);
    gh.validTokens.clear(); // 手元の期限は未来だが GitHub 側では失効
    expect(await stub.ensureMember(1)).toEqual({ ok: true });
    expect(gh.count("/login/oauth/access_token")).toBe(1);
  });

  it("refresh token も無効なら reauth_required。資格は消える", async () => {
    const gh = new FakeGitHubFetch();
    const stub = await installFakeGitHub(newUserId(), gh);
    gh.validTokens.clear();
    gh.refreshTokens.clear();
    expect(await stub.ensureMember(1)).toMatchObject({ ok: false, code: "reauth_required" });
    const [row] = await sql<{ access_token_enc: string | null }>(
      stub,
      "SELECT access_token_enc FROM github_credential",
    );
    expect(row?.access_token_enc).toBeNull();
    expect(await stub.ensureMember(1)).toMatchObject({ ok: false, code: "reauth_required" });
  });

  it("リフレッシュ時に GitHub が 5xx なら資格を残して upstream_unavailable", async () => {
    const gh = new FakeGitHubFetch();
    const c = clock();
    const stub = await installFakeGitHub(newUserId(), gh, { now: c.now });
    c.advance(9 * 3600_000);
    gh.tokenFault = 503;
    expect(await stub.ensureMember(1)).toMatchObject({ ok: false, code: "upstream_unavailable" });
    gh.tokenFault = null;
    expect(await stub.ensureMember(1)).toEqual({ ok: true });
  });

  it("同時に呼んでもリフレッシュは 1 回（single-flight）", async () => {
    const gh = new FakeGitHubFetch();
    const c = clock();
    const stub = await installFakeGitHub(newUserId(), gh, { now: c.now });
    c.advance(9 * 3600_000);
    // ensureMember 自体も共有されるので、キャッシュの無い authorizeStart も混ぜて並列に呼ぶ
    await Promise.all([
      stub.ensureMember(1),
      stub.authorizeStart(1, "acme/widgets"),
      stub.authorizeStart(1, "acme/widgets"),
    ]);
    expect(gh.count("/login/oauth/access_token")).toBe(1);
  });

  it("設定が足りない（ENC 鍵など）場合は internal を返し、詳細を漏らさない", async () => {
    const gh = new FakeGitHubFetch();
    const stub = await installFakeGitHub(newUserId(), gh);
    await runInDurableObject(stub, (instance) => {
      const i = instance as unknown as { env: Record<string, unknown>; credentials: null };
      i.env = { ...i.env, ALLOWED_TEAM: "" };
      i.credentials = null;
    });
    const r = await stub.ensureMember(1);
    expect(r).toEqual({ ok: false, code: "internal", message: "internal error" });
  });
});

describe("UserDO.authorizeStart", () => {
  it("push 権限のある導入済みリポジトリなら repositoryId / installationId を返す", async () => {
    const gh = new FakeGitHubFetch();
    const stub = await installFakeGitHub(newUserId(), gh);
    expect(await stub.authorizeStart(1, "acme/widgets")).toEqual({
      ok: true,
      repositoryId: 4242,
      installationId: 77,
    });
  });

  it("公開リポジトリでも App が未導入（一覧に無い）なら forbidden", async () => {
    const gh = new FakeGitHubFetch();
    const stub = await installFakeGitHub(newUserId(), gh);
    expect(await stub.authorizeStart(1, "other/public")).toMatchObject({
      ok: false,
      code: "forbidden",
    });
  });

  it("push 権限が無ければ forbidden", async () => {
    const gh = new FakeGitHubFetch();
    gh.repos = [{ id: 1, full_name: "acme/ro", push: false }];
    const stub = await installFakeGitHub(newUserId(), gh);
    expect(await stub.authorizeStart(1, "acme/ro")).toMatchObject({ ok: false, code: "forbidden" });
  });

  it("team 非所属なら Installation の確認まで進まない", async () => {
    const gh = new FakeGitHubFetch();
    gh.team = "none";
    const stub = await installFakeGitHub(newUserId(), gh);
    expect(await stub.authorizeStart(1, "acme/widgets")).toMatchObject({
      ok: false,
      code: "forbidden",
    });
    expect(gh.count("/user/installations")).toBe(0);
  });

  it("返り値にトークンが含まれない", async () => {
    const gh = new FakeGitHubFetch();
    const stub = await installFakeGitHub(newUserId(), gh);
    const r = JSON.stringify(await stub.authorizeStart(1, "acme/widgets"));
    expect(r).not.toMatch(/ghu_|ghr_/);
  });
});

describe("経過時間の確認", () => {
  it("5 分は MEMBERSHIP_CACHE_TTL_MS", () => {
    expect(MEMBERSHIP_CACHE_TTL_MS).toBe(5 * MIN);
  });
});
