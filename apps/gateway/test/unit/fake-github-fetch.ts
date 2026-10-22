import { runInDurableObject } from "cloudflare:test";
import type { TokenSet } from "../../src/github";
import type { UserDO } from "../../src/tasks/user-do";
import type { FakeGitHubApp } from "../support/fake-github-app";
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
  /**
   * 渡すと、/repos/... と /graphql を偽の GitHub App（利用者のトークンでの呼び出しとして）に任せる。
   * PR の Ready 化・マージのテスト用。user.login の人が、リポジトリに push できるものとして扱う。
   */
  app: FakeGitHubApp | undefined = undefined;
  /**
   * 複数の installation とページ分けを試すときに指定する（未指定なら repos を持つ installation 77 の 1 つ）。
   * pageSize を超える件数は Link ヘッダ（rel="next"）で次のページに分ける。
   */
  installations:
    | { id: number; repos: { id: number; full_name: string; push: boolean }[] }[]
    | null = null;
  pageSize = 100;
  /** パス（クエリなし）+ ページ番号 → 返すステータス。"/user/installations/77/repositories#2" のように指定 */
  pathFaults = new Map<string, number>();
  apiFault: number | null = null;
  /**
   * PR の状態の照会（POST /graphql。ダッシュボード）の偽物。キーは "owner/name#番号"（小文字）。
   * 無い PR は pullRequest: null（GitHub が見えない・存在しないときに返す形）。
   */
  pulls = new Map<string, { state: string; merged?: boolean }>();
  /** /graphql だけを失敗させるステータス（他の API は動く） */
  graphqlFault: number | null = null;
  /** 渡すと、/graphql の応答をこの Promise が解決するまで待たせる（同時呼び出しの束ねの確認用） */
  graphqlGate: Promise<void> | null = null;
  /** /graphql 1 回ごとの alias の数と、同時に進行していた最大数 */
  graphqlBatches: number[] = [];
  graphqlMaxParallel = 0;
  private graphqlRunning = 0;
  /** /graphql の要求から取り出した Authorization と変数（確認用） */
  graphqlSeen: { auth: string | null; variables: Record<string, unknown>; query: string }[] = [];
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

  private async pullStatesGraphql(
    req: Request,
    json: (body: unknown, status?: number) => Response,
  ): Promise<Response> {
    const body = (await req.json()) as { query?: string; variables?: Record<string, unknown> };
    const variables = body.variables ?? {};
    this.graphqlSeen.push({
      auth: req.headers.get("authorization"),
      variables,
      query: body.query ?? "",
    });
    const n = Object.keys(variables).filter((k) => k.startsWith("o")).length;
    this.graphqlBatches.push(n);
    this.graphqlRunning++;
    this.graphqlMaxParallel = Math.max(this.graphqlMaxParallel, this.graphqlRunning);
    try {
      if (this.graphqlGate) await this.graphqlGate;
      if (this.graphqlFault) return json({ message: "fault" }, this.graphqlFault);
      const data: Record<string, unknown> = {};
      for (let i = 0; i < n; i++) {
        const key = `${String(variables[`o${i}`])}/${String(variables[`n${i}`])}#${String(variables[`p${i}`])}`;
        const pull = this.pulls.get(key.toLowerCase());
        data[`r${i}`] = pull
          ? { pullRequest: { state: pull.state, merged: pull.merged ?? pull.state === "MERGED" } }
          : { pullRequest: null };
      }
      return json({ data });
    } finally {
      this.graphqlRunning--;
    }
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

    if (!this.app && req.method === "POST" && url.pathname === "/graphql") {
      return this.pullStatesGraphql(req, json);
    }

    if (this.app && /^\/(repos\/|graphql$)/.test(url.pathname)) {
      const r = await this.app.handle(req, { login: this.user.login, canPush: () => true });
      return r ?? json({ message: "Not Found" }, 404);
    }

    if (url.pathname === "/user") return json(this.user);
    if (url.pathname === `/orgs/acme/teams/core/memberships/${this.user.login}`) {
      if (this.team === "none") return json({ message: "Not Found" }, 404);
      return json({ state: this.team });
    }
    const page = Number(url.searchParams.get("page") ?? "1");
    const fault =
      this.pathFaults.get(`${url.pathname}#${page}`) ?? this.pathFaults.get(url.pathname);
    if (fault) return json({ message: "fault" }, fault);
    const insts = this.installations ?? [{ id: 77, repos: this.repos }];
    const paged = <T>(key: string, items: T[], total: number) => {
      const start = (page - 1) * this.pageSize;
      const slice = items.slice(start, start + this.pageSize);
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (start + this.pageSize < items.length) {
        headers.link = `<${url.origin}${url.pathname}?per_page=${this.pageSize}&page=${page + 1}>; rel="next"`;
      }
      return new Response(JSON.stringify({ total_count: total, [key]: slice }), { headers });
    };
    if (url.pathname === "/user/installations") {
      return paged(
        "installations",
        insts.map((i) => ({ id: i.id })),
        insts.length,
      );
    }
    const m = /^\/user\/installations\/(\d+)\/repositories$/.exec(url.pathname);
    if (m) {
      const inst = insts.find((i) => i.id === Number(m[1]));
      if (!inst) return json({ message: "Not Found" }, 404);
      return paged(
        "repositories",
        inst.repos.map((r) => ({
          id: r.id,
          full_name: r.full_name,
          permissions: { push: r.push },
        })),
        inst.repos.length,
      );
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
