import { DEFAULT_GITHUB_API_BASE, DEFAULT_GITHUB_OAUTH_BASE } from "./config";

export type GitHubErrorCode = "reauth_required" | "forbidden" | "upstream_unavailable";

/** メッセージにトークン・シークレットは入れない。 */
export class GitHubError extends Error {
  readonly code: GitHubErrorCode;
  readonly status: number | undefined;
  constructor(code: GitHubErrorCode, message: string, status?: number) {
    super(message);
    this.name = "GitHubError";
    this.code = code;
    this.status = status;
  }
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string | null;
  /** epoch ms。null は期限なし */
  accessExpiresAt: number | null;
  refreshExpiresAt: number | null;
}

export interface GitHubClientOptions {
  clientId: string;
  clientSecret: string;
  oauthBase?: string;
  apiBase?: string;
  fetch?: typeof fetch;
  /** epoch ms */
  now?: () => number;
}

export type TeamMembershipState = "active" | "pending" | "none";

export interface RepositoryAccess {
  repositoryId: number;
  installationId: number;
  fullName: string;
}

const MAX_PAGES = 50;
const PER_PAGE = 100;
/** refresh を試みても無駄な（ユーザーに再ログインさせるべき）token エンドポイントのエラー */
const REAUTH_TOKEN_ERRORS = new Set([
  "bad_refresh_token",
  "bad_verification_code",
  "expired_token",
  "invalid_grant",
  "access_denied",
]);

function trimSlash(s: string): string {
  return s.replace(/\/+$/, "");
}

export class GitHubClient {
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly oauthBase: string;
  private readonly apiBase: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(opts: GitHubClientOptions) {
    this.clientId = opts.clientId;
    this.clientSecret = opts.clientSecret;
    this.oauthBase = trimSlash(opts.oauthBase ?? DEFAULT_GITHUB_OAUTH_BASE);
    this.apiBase = trimSlash(opts.apiBase ?? DEFAULT_GITHUB_API_BASE);
    this.fetchImpl = opts.fetch ?? ((...a) => fetch(...a));
    this.now = opts.now ?? Date.now;
  }

  authorizeUrl(args: { redirectUri: string; state: string }): string {
    const u = new URL(`${this.oauthBase}/login/oauth/authorize`);
    u.searchParams.set("client_id", this.clientId);
    u.searchParams.set("redirect_uri", args.redirectUri);
    u.searchParams.set("state", args.state);
    return u.toString();
  }

  async exchangeCode(args: { code: string; redirectUri: string }): Promise<TokenSet> {
    return this.tokenRequest({
      code: args.code,
      redirect_uri: args.redirectUri,
    });
  }

  async refreshToken(refreshToken: string): Promise<TokenSet> {
    return this.tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken });
  }

  async getUser(accessToken: string): Promise<{ id: number; login: string }> {
    const res = await this.api(accessToken, "/user");
    const body = (await this.json(res)) as { id?: unknown; login?: unknown };
    if (typeof body.id !== "number" || typeof body.login !== "string") {
      throw new GitHubError("upstream_unavailable", "unexpected /user response");
    }
    return { id: body.id, login: body.login };
  }

  /** 404 は所属なし。それ以外のエラーは GitHubError。 */
  async getTeamMembership(
    accessToken: string,
    args: { org: string; teamSlug: string; username: string },
  ): Promise<TeamMembershipState> {
    const path = `/orgs/${encodeURIComponent(args.org)}/teams/${encodeURIComponent(args.teamSlug)}/memberships/${encodeURIComponent(args.username)}`;
    const res = await this.rawApi(accessToken, path);
    if (res.status === 404) return "none";
    this.throwIfError(res);
    const body = (await this.json(res)) as { state?: unknown };
    if (body.state === "active") return "active";
    if (body.state === "pending") return "pending";
    return "none";
  }

  async isActiveTeamMember(
    accessToken: string,
    args: { org: string; teamSlug: string; username: string },
  ): Promise<boolean> {
    return (await this.getTeamMembership(accessToken, args)) === "active";
  }

  /**
   * App の Installation を走査し、対象リポジトリ（"owner/name" か repository ID）に
   * push 権限があることを確かめる。未導入・選択対象外・権限なしは区別せず forbidden。
   */
  async findWritableRepository(
    accessToken: string,
    target: string | number,
  ): Promise<RepositoryAccess> {
    const denied = () =>
      new GitHubError(
        "forbidden",
        "repository not accessible via this GitHub App with push access",
      );
    let match: (r: { id?: unknown; full_name?: unknown }) => boolean;
    if (typeof target === "number") {
      match = (r) => r.id === target;
    } else {
      if (!/^[^/\s]+\/[^/\s]+$/.test(target)) throw denied();
      const want = target.toLowerCase();
      match = (r) => typeof r.full_name === "string" && r.full_name.toLowerCase() === want;
    }

    for await (const inst of this.paginate(
      accessToken,
      `/user/installations?per_page=${PER_PAGE}`,
      "installations",
    )) {
      const installationId = (inst as { id?: unknown }).id;
      if (typeof installationId !== "number") continue;
      for await (const item of this.paginate(
        accessToken,
        `/user/installations/${installationId}/repositories?per_page=${PER_PAGE}`,
        "repositories",
      )) {
        const repo = item as {
          id?: unknown;
          full_name?: unknown;
          permissions?: { push?: unknown };
        };
        if (!match(repo)) continue;
        if (
          repo.permissions?.push === true &&
          typeof repo.id === "number" &&
          typeof repo.full_name === "string"
        ) {
          return { repositoryId: repo.id, installationId, fullName: repo.full_name };
        }
        // 同じリポジトリが別 Installation にある可能性は無い。権限なしは forbidden
        throw denied();
      }
    }
    throw denied();
  }

  // ---- 内部 ----

  private async tokenRequest(extra: Record<string, string>): Promise<TokenSet> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.oauthBase}/login/oauth/access_token`, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "user-agent": "rovo-gateway",
        },
        body: JSON.stringify({
          client_id: this.clientId,
          client_secret: this.clientSecret,
          ...extra,
        }),
      });
    } catch {
      throw new GitHubError(
        "upstream_unavailable",
        "network error contacting GitHub token endpoint",
      );
    }
    if (res.status === 429 || res.status >= 500) {
      throw new GitHubError("upstream_unavailable", `token endpoint ${res.status}`, res.status);
    }
    let body: Record<string, unknown>;
    try {
      body = (await res.json()) as Record<string, unknown>;
    } catch {
      throw new GitHubError("upstream_unavailable", "token endpoint returned non-JSON", res.status);
    }
    if (typeof body.error === "string") {
      const code = REAUTH_TOKEN_ERRORS.has(body.error) ? "reauth_required" : "upstream_unavailable";
      throw new GitHubError(code, `token endpoint error: ${body.error}`, res.status);
    }
    if (!res.ok || typeof body.access_token !== "string" || body.access_token === "") {
      throw new GitHubError(
        "upstream_unavailable",
        "unexpected token endpoint response",
        res.status,
      );
    }
    const at = this.now();
    const ttl = (v: unknown) => (typeof v === "number" && v > 0 ? at + v * 1000 : null);
    return {
      accessToken: body.access_token,
      refreshToken:
        typeof body.refresh_token === "string" && body.refresh_token !== ""
          ? body.refresh_token
          : null,
      accessExpiresAt: ttl(body.expires_in),
      refreshExpiresAt: ttl(body.refresh_token_expires_in),
    };
  }

  private async rawApi(accessToken: string, pathOrUrl: string): Promise<Response> {
    const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${this.apiBase}${pathOrUrl}`;
    try {
      return await this.fetchImpl(url, {
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${accessToken}`,
          "x-github-api-version": "2022-11-28",
          "user-agent": "rovo-gateway",
        },
      });
    } catch {
      throw new GitHubError("upstream_unavailable", "network error contacting GitHub API");
    }
  }

  private async api(accessToken: string, pathOrUrl: string): Promise<Response> {
    const res = await this.rawApi(accessToken, pathOrUrl);
    this.throwIfError(res);
    return res;
  }

  private throwIfError(res: Response): void {
    if (res.ok) return;
    const s = res.status;
    if (s === 401) throw new GitHubError("reauth_required", "GitHub returned 401", s);
    if (s === 403) {
      const limited =
        res.headers.get("x-ratelimit-remaining") === "0" || res.headers.get("retry-after") !== null;
      if (limited) throw new GitHubError("upstream_unavailable", "GitHub rate limited", s);
      throw new GitHubError("forbidden", "GitHub returned 403", s);
    }
    if (s === 404) throw new GitHubError("forbidden", "GitHub returned 404", s);
    throw new GitHubError("upstream_unavailable", `GitHub returned ${s}`, s);
  }

  private async json(res: Response): Promise<unknown> {
    try {
      return await res.json();
    } catch {
      throw new GitHubError("upstream_unavailable", "GitHub returned non-JSON", res.status);
    }
  }

  private async *paginate(
    accessToken: string,
    firstPath: string,
    key: string,
  ): AsyncGenerator<unknown> {
    let next: string | null = firstPath;
    const apiOrigin = new URL(this.apiBase).origin;
    for (let page = 0; next !== null; page++) {
      if (page >= MAX_PAGES) {
        throw new GitHubError("upstream_unavailable", "too many pages");
      }
      const res = await this.api(accessToken, next);
      const body = (await this.json(res)) as Record<string, unknown>;
      const items = body[key];
      if (!Array.isArray(items)) {
        throw new GitHubError("upstream_unavailable", `unexpected response: missing ${key}`);
      }
      for (const item of items) yield item;
      next = parseNextLink(res.headers.get("link"));
      // トークン漏洩を防ぐため、API と別オリジンの next は辿らない
      if (next !== null && new URL(next, this.apiBase).origin !== apiOrigin) {
        throw new GitHubError("upstream_unavailable", "pagination link points to a foreign origin");
      }
    }
  }
}

export function parseNextLink(header: string | null): string | null {
  if (!header) return null;
  for (const part of header.split(",")) {
    const m = part.match(/<([^>]+)>\s*;\s*rel="?next"?/);
    if (m?.[1]) return m[1];
  }
  return null;
}
