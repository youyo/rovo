import { runInDurableObject } from "cloudflare:test";
import type { TokenSet } from "../../src/github";
import type { UserDO } from "../../src/tasks/user-do";
import { userStub } from "./helpers";

/**
 * workerd 上の Unit テスト用の最小の GitHub 偽物（fetch スタブ）。
 * 本物に近い偽 GitHub（Node）は E2E で使う。ここでは UserDO / MCP の分岐を確かめるだけ。
 */
export class FakeGitHubFetch {
  user = { id: 1, login: "alice" };
  team: "active" | "pending" | "none" = "active";
  repos: { id: number; full_name: string; push: boolean }[] = [
    { id: 4242, full_name: "acme/widgets", push: true },
  ];
  /** 有効な access token */
  validTokens = new Set<string>();
  /** 有効な refresh token -> 発行する新しい access token */
  refreshTokens = new Set<string>();
  apiFault: number | null = null;
  tokenFault: number | null = null;
  calls: { method: string; path: string }[] = [];
  private seq = 0;

  count(path: string): number {
    return this.calls.filter((c) => c.path === path).length;
  }

  /** ログイン相当のトークン組を発行する */
  issue(expiresInMs = 8 * 3600_000, now = Date.now()): TokenSet {
    const n = ++this.seq;
    const accessToken = `ghu_${n}`;
    const refreshToken = `ghr_${n}`;
    this.validTokens.add(accessToken);
    this.refreshTokens.add(refreshToken);
    return {
      accessToken,
      refreshToken,
      accessExpiresAt: now + expiresInMs,
      refreshExpiresAt: now + 180 * 24 * 3600_000,
    };
  }

  fetch: typeof fetch = async (input, init) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    this.calls.push({ method: req.method, path: url.pathname });
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });

    if (url.pathname === "/login/oauth/access_token") {
      if (this.tokenFault) return json({ message: "fault" }, this.tokenFault);
      const body = (await req.json()) as { refresh_token?: string };
      if (!body.refresh_token || !this.refreshTokens.has(body.refresh_token)) {
        return json({ error: "bad_refresh_token" });
      }
      this.refreshTokens.delete(body.refresh_token);
      const t = this.issue();
      return json({
        access_token: t.accessToken,
        refresh_token: t.refreshToken,
        expires_in: 28800,
        refresh_token_expires_in: 15811200,
      });
    }

    if (this.apiFault) return json({ message: "fault" }, this.apiFault);
    const token = /^Bearer (.+)$/.exec(req.headers.get("authorization") ?? "")?.[1];
    if (!token || !this.validTokens.has(token)) return json({ message: "Bad credentials" }, 401);

    if (url.pathname === "/user") return json(this.user);
    if (url.pathname === `/orgs/acme/teams/core/memberships/${this.user.login}`) {
      if (this.team === "none") return json({ message: "Not Found" }, 404);
      return json({ state: this.team });
    }
    if (url.pathname === "/user/installations") {
      return json({ total_count: 1, installations: [{ id: 77 }] });
    }
    if (url.pathname === "/user/installations/77/repositories") {
      return json({
        total_count: this.repos.length,
        repositories: this.repos.map((r) => ({
          id: r.id,
          full_name: r.full_name,
          permissions: { push: r.push },
        })),
      });
    }
    return json({ message: "Not Found" }, 404);
  };
}

/** UserDO に偽 GitHub と時刻を差し込み、ログイン済み（資格保存済み）にする。 */
export async function installFakeGitHub(
  userId: number,
  gh: FakeGitHubFetch,
  opts: { login?: boolean; now?: () => number } = {},
) {
  const stub = userStub(userId);
  await runInDurableObject(stub, (instance: UserDO) => {
    instance.githubFetch = gh.fetch;
    if (opts.now) instance.now = opts.now;
  });
  if (opts.login !== false) await stub.saveCredential(gh.issue());
  return stub;
}
