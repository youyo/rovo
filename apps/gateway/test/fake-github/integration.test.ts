import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitHubClient, GitHubError } from "../../src/github/client";
import {
  CredentialManager,
  type CredentialStorage,
  type StoredCredential,
} from "../../src/github/credentials";
import { type FakeGitHub, startFakeGitHub } from "./server";

// 実際の GitHubClient / CredentialManager を偽 GitHub に向けて通しで動かす（M5 の E2E の予行）。

const KEY = Buffer.alloc(32, 1).toString("base64");

class Mem implements CredentialStorage {
  v: StoredCredential | null = null;
  get() {
    return this.v;
  }
  put(v: StoredCredential) {
    this.v = v;
  }
  delete() {
    this.v = null;
  }
}

let gh: FakeGitHub;
let client: GitHubClient;

beforeEach(async () => {
  gh = await startFakeGitHub();
  client = new GitHubClient({
    clientId: gh.clientId,
    clientSecret: gh.clientSecret,
    oauthBase: gh.url,
    apiBase: gh.url,
  });
  gh.admin.addUser({ id: 1, login: "alice" });
});
afterEach(async () => {
  await gh.stop();
});

async function loginTokens() {
  const res = await fetch(
    `${client.authorizeUrl({ redirectUri: "http://app.test/cb", state: "s" })}&login=alice`,
    { redirect: "manual" },
  );
  const code = new URL(res.headers.get("location") ?? "").searchParams.get("code") ?? "";
  return client.exchangeCode({ code, redirectUri: "http://app.test/cb" });
}

function manager(storage = new Mem()) {
  return { storage, mgr: new CredentialManager({ storage, encryptionKey: KEY, client }) };
}

describe("GitHubClient × 偽 GitHub", () => {
  it("ログイン → user / team / repository 確認", async () => {
    gh.admin.setTeamMembership("acme", "core", "alice", "active");
    gh.admin.setInstallation({
      id: 10,
      repositories: Array.from({ length: 250 }, (_, i) => ({
        id: i + 1,
        fullName: `acme/r${i + 1}`,
        push: i + 1 !== 250,
      })),
    });
    const t = await loginTokens();
    expect(await client.getUser(t.accessToken)).toEqual({ id: 1, login: "alice" });
    expect(
      await client.isActiveTeamMember(t.accessToken, {
        org: "acme",
        teamSlug: "core",
        username: "alice",
      }),
    ).toBe(true);
    // 3 ページ目にある
    expect(await client.findWritableRepository(t.accessToken, "acme/r205")).toEqual({
      repositoryId: 205,
      installationId: 10,
      fullName: "acme/r205",
    });
    // push なし / 未導入の公開リポ
    await expect(client.findWritableRepository(t.accessToken, "acme/r250")).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(
      client.findWritableRepository(t.accessToken, "other/public"),
    ).rejects.toMatchObject({
      code: "forbidden",
    });
  });

  it("期限切れ → getToken が自動リフレッシュし、旧トークンは使われない", async () => {
    const { mgr } = manager();
    await mgr.save(await loginTokens());
    const first = await mgr.getToken();
    gh.admin.expireAccessTokens();
    // 期限の情報は手元では未来のまま → withToken が 401 を受けて強制リフレッシュする
    const user = await mgr.withToken((tok) => client.getUser(tok));
    expect(user.login).toBe("alice");
    expect(await mgr.getToken()).not.toBe(first);
  });

  it("refresh 失効で reauth_required になり資格が消える", async () => {
    const { mgr, storage } = manager();
    await mgr.save(await loginTokens());
    gh.admin.expireAccessTokens();
    gh.admin.revokeRefreshTokens();
    await expect(mgr.withToken((tok) => client.getUser(tok))).rejects.toMatchObject({
      code: "reauth_required",
    });
    expect(storage.v).toBeNull();
  });

  it("refresh 時に GitHub が 5xx なら資格を残して upstream_unavailable", async () => {
    const { mgr, storage } = manager();
    await mgr.save(await loginTokens());
    gh.admin.expireAccessTokens();
    gh.admin.setFault("token", 503);
    const err = await mgr.withToken((tok) => client.getUser(tok)).catch((e) => e);
    expect(err).toBeInstanceOf(GitHubError);
    expect(err.code).toBe("upstream_unavailable");
    expect(storage.v).not.toBeNull();
    gh.admin.setFault("token", null);
    expect((await mgr.withToken((tok) => client.getUser(tok))).login).toBe("alice");
  });

  it("API の 429 / 5xx は upstream_unavailable", async () => {
    const t = await loginTokens();
    gh.admin.setFault("api", 429, 1);
    await expect(client.getUser(t.accessToken)).rejects.toMatchObject({
      code: "upstream_unavailable",
    });
    gh.admin.setFault("api", 500, 1);
    await expect(client.getUser(t.accessToken)).rejects.toMatchObject({
      code: "upstream_unavailable",
    });
  });

  it("同時に 10 回 getToken してもリフレッシュは 1 回", async () => {
    const { mgr } = manager();
    const t = await loginTokens();
    await mgr.save({ ...t, accessExpiresAt: Date.now() + 60_000 }); // 残り 5 分未満
    const tokens = await Promise.all(Array.from({ length: 10 }, () => mgr.getToken()));
    expect(new Set(tokens).size).toBe(1);
    expect(
      gh.admin
        .requests()
        .filter(
          (r) => r.path === "/login/oauth/access_token" && r.body?.grant_type === "refresh_token",
        ),
    ).toHaveLength(1);
  });
});
