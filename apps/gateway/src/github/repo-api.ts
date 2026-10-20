import { GitHubApiError, throwApiError } from "./app";
import { DEFAULT_GITHUB_API_BASE } from "./config";

export interface PullInfo {
  number: number;
  /** html_url */
  url: string;
  draft: boolean;
  state: string;
  body: string;
  headSha: string;
  baseRef: string;
}

export interface CommitIdentity {
  name: string;
  email: string;
  /** ISO 8601。固定すると同じ入力から同じ SHA になる */
  date: string;
}

export interface GitHubRepoApiOptions {
  /** Installation Access Token */
  token: string;
  /** "owner/name" */
  repository: string;
  apiBase?: string;
  fetch?: typeof fetch;
}

const enc = encodeURIComponent;
/** ブランチ名は "/" を残してエスケープする */
const encPath = (p: string) => p.split("/").map(enc).join("/");

/** Installation Token で呼ぶ、1 つのリポジトリ向けの Git Data / Pulls API。 */
export class GitHubRepoApi {
  private readonly token: string;
  private readonly owner: string;
  private readonly name: string;
  private readonly apiBase: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: GitHubRepoApiOptions) {
    const m = /^([^/\s]+)\/([^/\s]+)$/.exec(opts.repository);
    if (!m) throw new Error("repository must be owner/name");
    this.owner = m[1] as string;
    this.name = m[2] as string;
    this.token = opts.token;
    this.apiBase = (opts.apiBase ?? DEFAULT_GITHUB_API_BASE).replace(/\/+$/, "");
    this.fetchImpl = opts.fetch ?? ((...a) => fetch(...a));
  }

  private repoPath(rest: string): string {
    return `${this.apiBase}/repos/${enc(this.owner)}/${enc(this.name)}${rest}`;
  }

  private async call(
    what: string,
    method: string,
    url: string,
    body?: unknown,
    accept: readonly number[] = [],
  ): Promise<{ status: number; json: unknown }> {
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${this.token}`,
          "x-github-api-version": "2022-11-28",
          "user-agent": "rovo-gateway",
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      throw new GitHubApiError({ status: 0, what });
    }
    if (!res.ok && !accept.includes(res.status)) return throwApiError(res, what);
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      if (res.ok)
        throw new GitHubApiError({ status: res.status, what, detail: "non-JSON response" });
    }
    return { status: res.status, json };
  }

  private bad(what: string): never {
    throw new GitHubApiError({ status: 200, what, detail: "unexpected response" });
  }

  async getCommit(sha: string): Promise<{ sha: string; treeSha: string }> {
    const what = "get commit";
    const { json } = await this.call(what, "GET", this.repoPath(`/git/commits/${enc(sha)}`));
    const b = json as { sha?: unknown; tree?: { sha?: unknown } } | null;
    if (typeof b?.sha !== "string" || typeof b.tree?.sha !== "string") return this.bad(what);
    return { sha: b.sha, treeSha: b.tree.sha };
  }

  /**
   * tree の項目。既定は直下だけ。`recursive: true` なら全体（?recursive=1。path は "packages/a/package.json" のような相対パス）。
   * 依存関係のキャッシュ（D14）が、lockfile・package.json の blob SHA を読むのに使う。
   * truncated は GitHub が一覧を切り詰めたか（直下だけなら、ほぼ起きない。再帰では大きなリポジトリで起きる）。
   * 形の違う項目は読み飛ばす。
   */
  async getTree(
    treeSha: string,
    opts: { recursive?: boolean } = {},
  ): Promise<{
    truncated: boolean;
    entries: { path: string; mode: string; type: string; sha: string }[];
  }> {
    const what = "get tree";
    const { json } = await this.call(
      what,
      "GET",
      this.repoPath(`/git/trees/${enc(treeSha)}${opts.recursive ? "?recursive=1" : ""}`),
    );
    const b = json as { tree?: unknown; truncated?: unknown } | null;
    if (!Array.isArray(b?.tree)) return this.bad(what);
    const entries: { path: string; mode: string; type: string; sha: string }[] = [];
    for (const raw of b.tree as unknown[]) {
      const e = raw as { path?: unknown; mode?: unknown; type?: unknown; sha?: unknown } | null;
      if (
        typeof e?.path === "string" &&
        typeof e.mode === "string" &&
        typeof e.type === "string" &&
        typeof e.sha === "string"
      ) {
        entries.push({ path: e.path, mode: e.mode, type: e.type, sha: e.sha });
      }
    }
    return { truncated: b.truncated === true, entries };
  }

  async createCommit(args: {
    message: string;
    treeSha: string;
    parents: string[];
    identity: CommitIdentity;
  }): Promise<string> {
    const what = "create commit";
    const { json } = await this.call(what, "POST", this.repoPath("/git/commits"), {
      message: args.message,
      tree: args.treeSha,
      parents: args.parents,
      author: { ...args.identity },
      committer: { ...args.identity },
    });
    const sha = (json as { sha?: unknown } | null)?.sha;
    if (typeof sha !== "string") return this.bad(what);
    return sha;
  }

  /** ブランチの先頭 SHA。無ければ null。 */
  async getBranchSha(branch: string): Promise<string | null> {
    const what = "get ref";
    const { status, json } = await this.call(
      what,
      "GET",
      this.repoPath(`/git/ref/heads/${encPath(branch)}`),
      undefined,
      [404],
    );
    if (status === 404) return null;
    const sha = (json as { object?: { sha?: unknown } } | null)?.object?.sha;
    if (typeof sha !== "string") return this.bad(what);
    return sha;
  }

  /** 作成できれば "created"。既にあれば "exists"（上書きも削除もしない）。 */
  async createBranch(branch: string, sha: string): Promise<"created" | "exists"> {
    try {
      await this.call("create ref", "POST", this.repoPath("/git/refs"), {
        ref: `refs/heads/${branch}`,
        sha,
      });
      return "created";
    } catch (e) {
      if (e instanceof GitHubApiError && e.status === 422 && /already exists/i.test(e.detail)) {
        return "exists";
      }
      throw e;
    }
  }

  async compare(
    base: string,
    head: string,
  ): Promise<{ status: string; aheadBy: number; behindBy: number }> {
    const what = "compare";
    const { json } = await this.call(
      what,
      "GET",
      this.repoPath(`/compare/${enc(base)}...${enc(head)}`),
    );
    const b = json as { status?: unknown; ahead_by?: unknown; behind_by?: unknown } | null;
    if (typeof b?.status !== "string") return this.bad(what);
    return {
      status: b.status,
      aheadBy: typeof b.ahead_by === "number" ? b.ahead_by : 0,
      behindBy: typeof b.behind_by === "number" ? b.behind_by : 0,
    };
  }

  private toPull(raw: unknown, what: string): PullInfo {
    const p = raw as {
      number?: unknown;
      html_url?: unknown;
      draft?: unknown;
      state?: unknown;
      body?: unknown;
      head?: { sha?: unknown };
      base?: { ref?: unknown };
    } | null;
    if (
      typeof p?.number !== "number" ||
      typeof p.html_url !== "string" ||
      typeof p.head?.sha !== "string" ||
      typeof p.base?.ref !== "string"
    ) {
      return this.bad(what);
    }
    return {
      number: p.number,
      url: p.html_url,
      draft: p.draft === true,
      state: typeof p.state === "string" ? p.state : "open",
      body: typeof p.body === "string" ? p.body : "",
      headSha: p.head.sha,
      baseRef: p.base.ref,
    };
  }

  /** head が owner:branch の open な PR。無ければ null。 */
  async findOpenPull(branch: string): Promise<PullInfo | null> {
    const what = "list pulls";
    const q = new URLSearchParams({ head: `${this.owner}:${branch}`, state: "open" });
    const { json } = await this.call(what, "GET", `${this.repoPath("/pulls")}?${q}`);
    if (!Array.isArray(json)) return this.bad(what);
    const first = json[0];
    return first === undefined ? null : this.toPull(first, what);
  }

  async createPull(args: {
    title: string;
    head: string;
    base: string;
    body: string;
    draft: boolean;
  }): Promise<PullInfo> {
    const what = "create pull";
    const { json } = await this.call(what, "POST", this.repoPath("/pulls"), {
      title: args.title,
      head: args.head,
      base: args.base,
      body: args.body,
      draft: args.draft,
    });
    return this.toPull(json, what);
  }

  async getPull(number: number): Promise<PullInfo> {
    const what = "get pull";
    const { json } = await this.call(what, "GET", this.repoPath(`/pulls/${number}`));
    return this.toPull(json, what);
  }

  async updatePullBody(number: number, body: string): Promise<void> {
    await this.call("update pull", "PATCH", this.repoPath(`/pulls/${number}`), { body });
  }
}
