import { DEFAULT_GITHUB_API_BASE, DEFAULT_GITHUB_OAUTH_BASE } from "./config";

export type GitHubErrorCode =
  | "reauth_required"
  | "forbidden"
  | "upstream_unavailable"
  // PR の操作（D9）: GitHub が操作そのものを拒否した。メッセージに GitHub の文言が入る
  | "merge_blocked"
  | "head_moved"
  | "github_rejected";

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

/** 閲覧者の見えるリポジトリの集合が上限を超えた（ダッシュボードは fail closed で 503 にする）。 */
export class VisibleSetTooLargeError extends Error {
  constructor() {
    super("visible repository set is too large");
    this.name = "VisibleSetTooLargeError";
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

/** 利用者のトークンで読む PR（D9）。 */
export interface UserPull {
  nodeId: string;
  number: number;
  url: string;
  draft: boolean;
  state: string;
  merged: boolean;
  headSha: string;
  headRef: string;
  /** head / base のリポジトリ（owner/name）。fork の PR を見分けるのに使う */
  headRepo: string | null;
  baseRef: string;
  baseRepo: string | null;
  /** base の SHA（task_review の差分の起点）。読めなければ null */
  baseSha: string | null;
  /** タイトルと本文（task_review。本文は非信頼データ）。読めなければ空 */
  title: string;
  body: string;
}

/** PR の状態（ダッシュボード用）。取れなかったものは "unknown"。 */
export type PullStateValue = "open" | "merged" | "closed" | "unknown";
export interface PullRef {
  /** owner/name */
  repository: string;
  number: number;
}
/** getPullStates の 1 回の GraphQL にまとめる PR の最大数（alias の数）。超える分は呼び出し側が分ける。 */
export const MAX_PULL_STATE_BATCH = 40;
/** PR の状態の 1 回の問い合わせを待つ上限（ms）。ダッシュボードの応答を遅らせないよう短くする */
const PULL_STATE_TIMEOUT_MS = 8_000;

/** ダッシュボードに出す check 1 件（check run または commit status）。url は https://github.com/ で始まるものだけ。 */
export interface PullCheck {
  name: string;
  kind: "check_run" | "status";
  status: "queued" | "in_progress" | "completed";
  conclusion: string | null;
  started_at: string | null;
  completed_at: string | null;
  url: string | null;
}
export interface PullChecks {
  headSha: string;
  state: "none" | "passing" | "failing" | "pending";
  checks: PullCheck[];
  /** check run 100 件・commit status 100 件の上限を超えて、一部だけを返した */
  truncated: boolean;
  /** check run か commit status の片方だけ読めた（権限が片方だけ・片方の障害） */
  partial: boolean;
}
/** listChecks が 1 回の呼び出し（pulls・check-runs・status）を待つ上限（ms） */
const CHECKS_TIMEOUT_MS = 8_000;
const CHECKS_PER_SOURCE_MAX = 100;
const CHECK_NAME_MAX = 200;
const CHECK_URL_MAX = 300;

/** GitHub のエラーメッセージを呼び出し元に返すときの上限。 */
const MAX_GITHUB_MESSAGE = 300;

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

  /**
   * トークンの持ち主の org への所属（GET /user/memberships/orgs/{org}）。team と同じ 3 値。
   * 404（所属していない・外部コラボレーター）は none。403（App に権限が無い・org が App を制限）などは GitHubError で、所属なしとして黙らせない。
   */
  async getOrgMembership(accessToken: string, args: { org: string }): Promise<TeamMembershipState> {
    const res = await this.rawApi(
      accessToken,
      `/user/memberships/orgs/${encodeURIComponent(args.org)}`,
    );
    if (res.status === 404) return "none";
    this.throwIfError(res);
    const body = (await this.json(res)) as { state?: unknown };
    if (body.state === "active") return "active";
    if (body.state === "pending") return "pending";
    return "none";
  }

  async isActiveOrgMember(accessToken: string, args: { org: string }): Promise<boolean> {
    return (await this.getOrgMembership(accessToken, args)) === "active";
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

  /**
   * 閲覧者のユーザートークンで見える repository id の集合（ダッシュボードの認可。docs/specs/dashboard.md D5）。
   * `GET /user/installations` の全ページ → 各 installation の `/repositories` の全ページを辿る。
   * fail closed: どこか 1 回でも失敗したら例外を投げ、部分的な集合は返さない。形が想定外の項目（id が整数でない）も失敗。
   * 重複を除いた件数が maxIds を超えたら VisibleSetTooLargeError。戻り値は昇順。
   */
  async listVisibleRepositoryIds(accessToken: string, maxIds: number): Promise<number[]> {
    const ids = new Set<number>();
    for await (const inst of this.paginate(
      accessToken,
      `/user/installations?per_page=${PER_PAGE}`,
      "installations",
    )) {
      const installationId = (inst as { id?: unknown } | null)?.id;
      if (typeof installationId !== "number" || !Number.isSafeInteger(installationId)) {
        throw new GitHubError("upstream_unavailable", "unexpected installation entry");
      }
      for await (const item of this.paginate(
        accessToken,
        `/user/installations/${installationId}/repositories?per_page=${PER_PAGE}`,
        "repositories",
      )) {
        const id = (item as { id?: unknown } | null)?.id;
        if (typeof id !== "number" || !Number.isSafeInteger(id)) {
          throw new GitHubError("upstream_unavailable", "unexpected repository entry");
        }
        ids.add(id);
        if (ids.size > maxIds) throw new VisibleSetTooLargeError();
      }
    }
    return [...ids].sort((a, b) => a - b);
  }

  // ---- PR の操作（利用者のトークン。D9）----

  /** PR を読む。node_id は GraphQL の Ready 化に要る。404 は forbidden（見えない・存在しない）。 */
  async getPull(accessToken: string, repository: string, number: number): Promise<UserPull> {
    const res = await this.api(accessToken, `${this.pullPath(repository, number)}`);
    const p = (await this.json(res)) as {
      number?: unknown;
      node_id?: unknown;
      html_url?: unknown;
      draft?: unknown;
      state?: unknown;
      merged?: unknown;
      title?: unknown;
      body?: unknown;
      head?: { ref?: unknown; sha?: unknown; repo?: { full_name?: unknown } | null };
      base?: { ref?: unknown; sha?: unknown; repo?: { full_name?: unknown } | null };
    } | null;
    if (
      typeof p?.number !== "number" ||
      typeof p.node_id !== "string" ||
      typeof p.html_url !== "string" ||
      typeof p.state !== "string" ||
      typeof p.head?.sha !== "string" ||
      typeof p.head.ref !== "string" ||
      typeof p.base?.ref !== "string"
    ) {
      throw new GitHubError("upstream_unavailable", "unexpected pull response");
    }
    const repoName = (r: { full_name?: unknown } | null | undefined) =>
      typeof r?.full_name === "string" ? r.full_name : null;
    return {
      nodeId: p.node_id,
      number: p.number,
      url: p.html_url,
      draft: p.draft === true,
      state: p.state,
      merged: p.merged === true,
      headSha: p.head.sha,
      headRef: p.head.ref,
      headRepo: repoName(p.head.repo),
      baseRef: p.base.ref,
      baseRepo: repoName(p.base.repo),
      baseSha: typeof p.base.sha === "string" ? p.base.sha : null,
      title: typeof p.title === "string" ? p.title : "",
      body: typeof p.body === "string" ? p.body : "",
    };
  }

  /**
   * 複数の PR の状態を GraphQL の 1 回で取る（ダッシュボード。閲覧者のユーザートークン）。
   * owner / name / 番号は変数で渡し、クエリの文字列には埋めない（クエリは件数だけで決まる定数）。
   * 戻り値は refs と同じ並び。見えない・存在しない・形が想定外のものは "unknown"（そのほかの PR は取れる）。
   * 要求全体の失敗（401・403・レート制限・5xx・タイムアウト・data なし）は GitHubError を投げる。
   * owner/name の形でない・番号が正でないものは問い合わせず "unknown"。refs が MAX_PULL_STATE_BATCH を超えたら RangeError。
   */
  async getPullStates(accessToken: string, refs: PullRef[]): Promise<PullStateValue[]> {
    if (refs.length > MAX_PULL_STATE_BATCH) throw new RangeError("too many pull requests");
    const out: PullStateValue[] = refs.map(() => "unknown");
    const asked: { at: number; owner: string; name: string; number: number }[] = [];
    refs.forEach((ref, at) => {
      const m = /^([^/\s]+)\/([^/\s]+)$/.exec(ref.repository);
      if (!m || !Number.isSafeInteger(ref.number) || ref.number <= 0) return;
      asked.push({ at, owner: m[1] as string, name: m[2] as string, number: ref.number });
    });
    if (asked.length === 0) return out;

    const variables: Record<string, string | number> = {};
    const decls: string[] = [];
    const fields: string[] = [];
    asked.forEach((a, i) => {
      variables[`o${i}`] = a.owner;
      variables[`n${i}`] = a.name;
      variables[`p${i}`] = a.number;
      decls.push(`$o${i}: String!, $n${i}: String!, $p${i}: Int!`);
      fields.push(
        `r${i}: repository(owner: $o${i}, name: $n${i}) { pullRequest(number: $p${i}) { state merged } }`,
      );
    });
    const res = await this.send(
      accessToken,
      "POST",
      "/graphql",
      { query: `query(${decls.join(", ")}) { ${fields.join(" ")} }`, variables },
      AbortSignal.timeout(PULL_STATE_TIMEOUT_MS),
    );
    if (!res.ok) this.throwIfError(res);
    const body = (await this.json(res)) as { data?: unknown } | null;
    const data = body?.data;
    if (typeof data !== "object" || data === null) {
      throw new GitHubError("upstream_unavailable", "unexpected GraphQL response");
    }
    asked.forEach((a, i) => {
      const pull = (data as Record<string, { pullRequest?: unknown } | null | undefined>)[`r${i}`]
        ?.pullRequest as { state?: unknown; merged?: unknown } | null | undefined;
      if (typeof pull !== "object" || pull === null) return;
      if (pull.merged === true || pull.state === "MERGED") out[a.at] = "merged";
      else if (pull.state === "CLOSED") out[a.at] = "closed";
      else if (pull.state === "OPEN") out[a.at] = "open";
    });
    return out;
  }

  /** Draft の PR を Ready for review にする（GraphQL。REST には無い）。 */
  async markReadyForReview(accessToken: string, pullRequestNodeId: string): Promise<void> {
    const res = await this.send(accessToken, "POST", "/graphql", {
      query:
        "mutation($id: ID!) { markPullRequestReadyForReview(input: {pullRequestId: $id}) { pullRequest { id isDraft } } }",
      variables: { id: pullRequestNodeId },
    });
    if (!res.ok) await this.throwWriteError(res);
    const body = (await this.json(res)) as {
      data?: { markPullRequestReadyForReview?: { pullRequest?: { isDraft?: unknown } } } | null;
      errors?: { type?: unknown; message?: unknown }[];
    } | null;
    const first = body?.errors?.[0];
    if (first) {
      const msg = cleanMessage(first.message);
      const type = typeof first.type === "string" ? first.type : "";
      if (type === "FORBIDDEN" || type === "NOT_FOUND" || type === "INSUFFICIENT_SCOPES") {
        throw new GitHubError("forbidden", `GitHub refused the request: ${msg}`);
      }
      throw new GitHubError("github_rejected", `GitHub rejected the request: ${msg}`);
    }
    if (body?.data?.markPullRequestReadyForReview?.pullRequest?.isDraft !== false) {
      throw new GitHubError("github_rejected", "GitHub did not mark the pull request as ready");
    }
  }

  /**
   * PR をマージする。sha（検証済みの head）を渡し、ブランチがそれより進んでいれば GitHub が 409 で拒否する。
   * 405 / 422 はブランチ保護・必須チェック・レビュー要件・ルールなどによる拒否で、GitHub のメッセージを残す。
   */
  async mergePull(
    accessToken: string,
    repository: string,
    number: number,
    args: { sha: string; method: "squash" | "merge" | "rebase" },
  ): Promise<{ sha: string | null }> {
    const res = await this.send(accessToken, "PUT", `${this.pullPath(repository, number)}/merge`, {
      sha: args.sha,
      merge_method: args.method,
    });
    if (!res.ok) await this.throwWriteError(res, { merge: true });
    const body = (await this.json(res)) as { sha?: unknown; merged?: unknown } | null;
    if (body?.merged !== true) {
      throw new GitHubError("merge_blocked", "GitHub did not merge the pull request");
    }
    return { sha: typeof body.sha === "string" ? body.sha : null };
  }

  /**
   * PR の head の commit に付いた GitHub の check（check run と commit status）の状態を返す（task_pr_merge の前の確認）。
   * - none: check run も commit status も 1 つも無い（statuses が 0 件の pending は「無い」とみなす）
   * - failing: completed の check run の conclusion が success / skipped / neutral 以外、または commit status が failure / error
   * - pending: failing は無いが、completed でない check run か、pending の commit status がある
   * - passing: 1 つ以上あり、すべて成功
   * 読めなかったとき（Checks の read 権限が無い 403 など）は GitHubError を投げる。通すか止めるかは呼び出し側（UserDO.prMerge は止めずに通し、warnings に checks_unreadable を残す）が決める。
   */
  async getCheckState(
    accessToken: string,
    repository: string,
    sha: string,
  ): Promise<"none" | "passing" | "failing" | "pending"> {
    if (!/^[0-9a-fA-F]{40}$/.test(sha)) throw new GitHubError("forbidden", "invalid commit sha");
    try {
      return await this.readCheckState(accessToken, repository, sha);
    } catch (e) {
      // 403 / 404 は、App に Checks / Commit statuses の read 権限が無い（利用者に原因の見当が付くよう、案内を添える）
      if (e instanceof GitHubError && e.code === "forbidden") {
        throw new GitHubError(
          "forbidden",
          "GitHub refused to read the checks of the pull request head; the GitHub App needs the Checks: Read-only and Commit statuses: Read-only permissions (see docs/deploy.md)",
          e.status,
        );
      }
      throw e;
    }
  }

  /**
   * PR の**今の head**（pulls/{n} の head.sha）に付いた check run と commit status の一覧（ダッシュボード。閲覧者のトークン）。
   * check run は 1 ページ（100 件）、commit status は combined status の 100 件（同じ context は最新だけ）。超える分は truncated。
   * check run と commit status は片方が読めなくても（403 / 404 / 5xx）読めた分を返し、partial にする。両方読めなければ、
   * check run の側のエラーを投げる。401 は partial にせず reauth_required を投げる。pulls が読めないときも投げる。
   * リンクは https://github.com/ で始まるものだけを残す（check の URL は外部が任意に書ける）。
   */
  async listChecks(accessToken: string, repository: string, number: number): Promise<PullChecks> {
    const signal = () => AbortSignal.timeout(CHECKS_TIMEOUT_MS);
    const pullRes = await this.api(accessToken, this.pullPath(repository, number), signal());
    const head = ((await this.json(pullRes)) as { head?: { sha?: unknown } } | null)?.head?.sha;
    if (typeof head !== "string" || !/^[0-9a-f]{40}$/.test(head)) {
      throw new GitHubError("upstream_unavailable", "unexpected pull response: head sha");
    }
    const base = `${this.repoPath(repository)}/commits/${head}`;
    const settle = async <T>(
      fn: () => Promise<T>,
    ): Promise<{ ok: true; v: T } | { ok: false; e: unknown }> => {
      try {
        return { ok: true, v: await fn() };
      } catch (e) {
        return { ok: false, e };
      }
    };
    const [runsOut, statusOut] = await Promise.all([
      settle(async () => {
        const res = await this.api(
          accessToken,
          `${base}/check-runs?per_page=${CHECKS_PER_SOURCE_MAX}`,
          signal(),
        );
        const body = (await this.json(res)) as {
          total_count?: unknown;
          check_runs?: unknown;
        } | null;
        if (!Array.isArray(body?.check_runs)) {
          throw new GitHubError("upstream_unavailable", "unexpected response: missing check_runs");
        }
        return { items: body.check_runs as unknown[], total: body.total_count };
      }),
      settle(async () => {
        const res = await this.api(
          accessToken,
          `${base}/status?per_page=${CHECKS_PER_SOURCE_MAX}`,
          signal(),
        );
        const body = (await this.json(res)) as { total_count?: unknown; statuses?: unknown } | null;
        if (!Array.isArray(body?.statuses)) {
          throw new GitHubError("upstream_unavailable", "unexpected response: missing statuses");
        }
        return { items: body.statuses as unknown[], total: body.total_count };
      }),
    ]);
    for (const out of [runsOut, statusOut]) {
      if (!out.ok && out.e instanceof GitHubError && out.e.code === "reauth_required") throw out.e;
    }
    if (!runsOut.ok && !statusOut.ok) throw runsOut.e;

    const checks: PullCheck[] = [];
    let truncated = false;
    if (runsOut.ok) {
      for (const raw of runsOut.v.items.slice(0, CHECKS_PER_SOURCE_MAX)) {
        const c = toCheckRun(raw);
        if (c) checks.push(c);
      }
      if (typeof runsOut.v.total === "number" && runsOut.v.total > runsOut.v.items.length) {
        truncated = true;
      }
    }
    if (statusOut.ok) {
      for (const raw of statusOut.v.items.slice(0, CHECKS_PER_SOURCE_MAX)) {
        const c = toCommitStatus(raw);
        if (c) checks.push(c);
      }
      if (typeof statusOut.v.total === "number" && statusOut.v.total > statusOut.v.items.length) {
        truncated = true;
      }
    }
    return {
      headSha: head,
      state: aggregateChecks(checks),
      checks,
      truncated,
      partial: !runsOut.ok || !statusOut.ok,
    };
  }

  private async readCheckState(
    accessToken: string,
    repository: string,
    sha: string,
  ): Promise<"none" | "passing" | "failing" | "pending"> {
    const base = `${this.repoPath(repository)}/commits/${sha}`;
    let runCount = 0;
    let failing = false;
    let pending = false;
    for await (const raw of this.paginate(
      accessToken,
      `${base}/check-runs?per_page=100`,
      "check_runs",
    )) {
      runCount++;
      const run = raw as { status?: unknown; conclusion?: unknown } | null;
      if (run?.status !== "completed") pending = true;
      else if (!CHECK_OK_CONCLUSIONS.has(String(run.conclusion))) failing = true;
    }
    const res = await this.api(accessToken, `${base}/status?per_page=100`);
    const body = (await this.json(res)) as { state?: unknown; statuses?: unknown } | null;
    if (!Array.isArray(body?.statuses)) {
      throw new GitHubError("upstream_unavailable", "unexpected response: missing statuses");
    }
    const statusCount = body.statuses.length;
    if (statusCount > 0) {
      if (body.state === "failure" || body.state === "error") failing = true;
      else if (body.state !== "success") pending = true;
    }
    if (runCount === 0 && statusCount === 0) return "none";
    return failing ? "failing" : pending ? "pending" : "passing";
  }

  /** ブランチを消す。すでに無い（422）ときは成功。 */
  async deleteBranch(accessToken: string, repository: string, branch: string): Promise<void> {
    const res = await this.send(
      accessToken,
      "DELETE",
      `${this.repoPath(repository)}/git/refs/heads/${branch.split("/").map(encodeURIComponent).join("/")}`,
    );
    if (res.ok || res.status === 422) return;
    await this.throwWriteError(res);
  }

  // ---- 内部 ----

  private repoPath(repository: string): string {
    const m = /^([^/\s]+)\/([^/\s]+)$/.exec(repository);
    if (!m) throw new GitHubError("forbidden", "invalid repository");
    return `/repos/${encodeURIComponent(m[1] as string)}/${encodeURIComponent(m[2] as string)}`;
  }

  private pullPath(repository: string, number: number): string {
    if (!Number.isSafeInteger(number) || number <= 0) {
      throw new GitHubError("forbidden", "invalid pull request number");
    }
    return `${this.repoPath(repository)}/pulls/${number}`;
  }

  /** 書き込みの API 呼び出し（JSON 本文）。ネットワークの失敗は upstream_unavailable。 */
  private async send(
    accessToken: string,
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<Response> {
    try {
      return await this.fetchImpl(`${this.apiBase}${path}`, {
        method,
        ...(signal ? { signal } : {}),
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${accessToken}`,
          "x-github-api-version": "2022-11-28",
          "user-agent": "rovo-gateway",
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      throw new GitHubError("upstream_unavailable", "network error contacting GitHub API");
    }
  }

  /** 書き込みの失敗を GitHubError にする（常に throw）。GitHub のメッセージは整形して残す。 */
  private async throwWriteError(res: Response, opts: { merge?: boolean } = {}): Promise<never> {
    const s = res.status;
    let message = "";
    try {
      message = cleanMessage(((await res.json()) as { message?: unknown } | null)?.message);
    } catch {
      // 本文なし
    }
    const detail = message === "" ? "" : `: ${message}`;
    if (s === 401) throw new GitHubError("reauth_required", "GitHub returned 401", s);
    if (s === 403) {
      const limited =
        res.headers.get("x-ratelimit-remaining") === "0" || res.headers.get("retry-after") !== null;
      if (limited) throw new GitHubError("upstream_unavailable", "GitHub rate limited", s);
      throw new GitHubError("forbidden", `GitHub refused the request (403)${detail}`, s);
    }
    if (s === 404) throw new GitHubError("forbidden", "GitHub returned 404", s);
    if (opts.merge && s === 409) {
      throw new GitHubError("head_moved", `GitHub rejected the merge (409)${detail}`, s);
    }
    if (opts.merge && (s === 405 || s === 422)) {
      throw new GitHubError("merge_blocked", `GitHub refused the merge (${s})${detail}`, s);
    }
    if (s === 429 || s >= 500) {
      throw new GitHubError("upstream_unavailable", `GitHub returned ${s}`, s);
    }
    throw new GitHubError("github_rejected", `GitHub rejected the request (${s})${detail}`, s);
  }

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

  private async rawApi(
    accessToken: string,
    pathOrUrl: string,
    signal?: AbortSignal,
  ): Promise<Response> {
    const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${this.apiBase}${pathOrUrl}`;
    try {
      return await this.fetchImpl(url, {
        ...(signal ? { signal } : {}),
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

  private async api(
    accessToken: string,
    pathOrUrl: string,
    signal?: AbortSignal,
  ): Promise<Response> {
    const res = await this.rawApi(accessToken, pathOrUrl, signal);
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

/** 成功とみなす check run の conclusion（それ以外は失敗） */
const CHECK_OK_CONCLUSIONS: ReadonlySet<string> = new Set(["success", "skipped", "neutral"]);

/** リンクにしてよい URL: https://github.com/ で始まり、空白・制御文字・バックスラッシュを含まず、長すぎないもの。 */
export function githubLinkOrNull(v: unknown): string | null {
  if (typeof v !== "string" || v.length > CHECK_URL_MAX) return null;
  if (!/^https:\/\/github\.com\/[^\s\\\p{Cc}]*$/u.test(v)) return null;
  try {
    return new URL(v).host === "github.com" ? v : null;
  } catch {
    return null;
  }
}

function isoOrNull(v: unknown): string | null {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(v))
    return null;
  return Number.isNaN(Date.parse(v)) ? null : v;
}

function checkName(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const name = [...v.slice(0, CHECK_NAME_MAX)]
    .map((ch) => (ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f ? " " : ch))
    .join("")
    .trim();
  return name === "" ? null : name;
}

function toCheckRun(raw: unknown): PullCheck | null {
  const r = raw as Record<string, unknown> | null;
  if (typeof r !== "object" || r === null) return null;
  const name = checkName(r.name);
  if (name === null) return null;
  const status =
    r.status === "completed" ? "completed" : r.status === "in_progress" ? "in_progress" : "queued";
  return {
    name,
    kind: "check_run",
    status,
    conclusion:
      status === "completed" && typeof r.conclusion === "string" ? r.conclusion.slice(0, 40) : null,
    started_at: isoOrNull(r.started_at),
    completed_at: isoOrNull(r.completed_at),
    url: githubLinkOrNull(r.html_url) ?? githubLinkOrNull(r.details_url),
  };
}

function toCommitStatus(raw: unknown): PullCheck | null {
  const r = raw as Record<string, unknown> | null;
  if (typeof r !== "object" || r === null) return null;
  const name = checkName(r.context);
  if (name === null) return null;
  const state = typeof r.state === "string" ? r.state.slice(0, 40) : "pending";
  const pending = state !== "success" && state !== "failure" && state !== "error";
  return {
    name,
    kind: "status",
    status: pending ? "in_progress" : "completed",
    conclusion: pending ? null : state,
    started_at: null,
    completed_at: null,
    url: githubLinkOrNull(r.target_url),
  };
}

/** check の集約（getCheckState と同じ規則）: 失敗 > 実行中 > 成功。1 件も無ければ none。 */
export function aggregateChecks(checks: PullCheck[]): PullChecks["state"] {
  if (checks.length === 0) return "none";
  let pending = false;
  for (const c of checks) {
    if (c.status !== "completed") pending = true;
    else if (c.kind === "status") {
      if (c.conclusion !== "success") return "failing";
    } else if (!CHECK_OK_CONCLUSIONS.has(String(c.conclusion))) return "failing";
  }
  return pending ? "pending" : "passing";
}

/** GitHub のメッセージを返せる形にする: 制御文字を空白にし、前後の空白を落として 300 文字で切る。 */
function cleanMessage(v: unknown): string {
  if (typeof v !== "string") return "";
  const printable = [...v].map((ch) => {
    const code = ch.charCodeAt(0);
    return code < 0x20 || code === 0x7f ? " " : ch;
  });
  return printable.join("").trim().slice(0, MAX_GITHUB_MESSAGE);
}

export function parseNextLink(header: string | null): string | null {
  if (!header) return null;
  for (const part of header.split(",")) {
    const m = part.match(/<([^>]+)>\s*;\s*rel="?next"?/);
    if (m?.[1]) return m[1];
  }
  return null;
}
