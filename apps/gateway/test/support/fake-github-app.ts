/**
 * 偽 GitHub の「GitHub App として」の API（JWT / Installation Token / Git Data / Pulls）。
 * Request -> Response だけで書いてあるので、Node（偽 GitHub サーバー）と workerd（Unit の fetch 差し替え）の
 * 両方で同じ実装を使う。依存は WebCrypto のみ。
 */

/** コミットの保存先。既定は Map（メモリ）。E2E では実 git のリポジトリを差し込む（test/support/git-store.ts） */
export interface CommitStore {
  get(sha: string): FakeCommit | undefined;
  set(sha: string, commit: FakeCommit): unknown;
  has(sha: string): boolean;
}
/** ref（refs/heads/...）の保存先。既定は Map。 */
export interface RefStore {
  get(ref: string): string | undefined;
  set(ref: string, sha: string): unknown;
  has(ref: string): boolean;
  delete(ref: string): unknown;
}
export interface RepoStore {
  commits: CommitStore;
  refs: RefStore;
  /** tree の直下の項目（実 git の保存先のとき）。無ければ undefined。seedRootFiles で置いた tree が優先される */
  tree?(sha: string): { path: string; mode: string; type: string; sha: string }[] | undefined;
}

export interface FakeAppOptions {
  /**
   * リポジトリ（owner/name）ごとの保存先。undefined を返すとメモリ上の既定を使う。
   * 偽 git の bare リポジトリを正として、Git Data API をそこへの実 git 操作で実装するために使う。
   */
  storeFor?: (fullName: string) => RepoStore | undefined;
  appId: string | number;
  /** SPKI の PEM。JWT の RS256 署名を検証する */
  publicKeyPem: string;
  now?: () => number;
  tokenTtlSeconds?: number;
  /** App の slug（GET /app）。既定は架空の acme-rovo */
  slug?: string;
  /** App の bot ユーザーの id（GET /users/<slug>[bot]）。既定は架空の 12345 */
  botId?: number;
}

/** コミットに付く check run（GET /commits/:sha/check-runs）。 */
export interface FakeCheckRun {
  name: string;
  status: "queued" | "in_progress" | "completed";
  /** status が completed のときだけ */
  conclusion?: string;
}

/** コミットに付く commit status（GET /commits/:sha/status）。 */
export interface FakeCommitStatus {
  context: string;
  state: "success" | "failure" | "error" | "pending";
}

export interface FakeCommit {
  sha: string;
  tree: string;
  parents: string[];
  message: string;
  author: { name: string; email: string; date: string };
  committer: { name: string; email: string; date: string };
}

export interface FakePull {
  number: number;
  title: string;
  body: string;
  draft: boolean;
  state: "open" | "closed";
  head: string;
  base: string;
  /** マージ済みか（PUT .../merge で true になり、state は closed になる） */
  merged: boolean;
  /** マージで受け取った merge_method（確認用） */
  mergeMethod?: string;
  /** マージ API に渡された sha（確認用） */
  mergeSha?: string;
  /** マージした時点の head。マージ後にブランチを消しても、PR の head.sha として残る（GitHub と同じ） */
  headAtMerge?: string;
  /** POST /issues/:n/comments で付いたコメント（確認用） */
  comments?: string[];
}

/** 利用者のトークン（GitHub App のユーザーアクセストークン）で呼んだ人。 */
export interface FakeUser {
  login: string;
  /** そのリポジトリを見られる・書けるか（Installation のリポジトリに push 権限があるか） */
  canPush(fullName: string): boolean;
}

interface FakeRepoRec {
  id: number;
  fullName: string;
  installationId: number;
  commits: CommitStore;
  refs: RefStore;
  pulls: FakePull[];
  missing: Set<string>;
  /** tree の SHA -> 直下の項目（blob）。seedRootFiles が置く。置いていない tree は、保存先が読めればそれ、読めなければ空（lockfile なし） */
  trees: Map<string, { path: string; sha: string }[]>;
  readTree?: RepoStore["tree"];
  /** ブランチ保護の再現: 設定するとマージを 405 とこのメッセージで拒否する */
  mergeBlock: string | undefined;
  /** このリポジトリで許可していないマージ方法（405） */
  disallowedMethods: Set<string>;
  /** sha -> check run */
  checkRuns: Map<string, FakeCheckRun[]>;
  /** sha -> commit status */
  statuses: Map<string, FakeCommitStatus[]>;
}

interface TokenRec {
  token: string;
  installationId: number;
  repoIds: number[];
  permissions: Record<string, string>;
  expiresAt: number;
  revoked: boolean;
}

export interface FakeAppRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  auth: "jwt" | "token" | "user" | "none";
  body: unknown;
}

interface Fault {
  pattern: RegExp;
  status: number;
  remaining: number;
  /** 先頭のこの回数だけは通す（0 なら最初から失敗させる） */
  skip: number;
  headers: Record<string, string>;
  message: string;
  /** 指定すると { message } の代わりにこの本文を返す（status 200 と組み合わせて「空の一覧」などを再現する） */
  body?: unknown;
}

const hex = (buf: ArrayBuffer) =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

async function sha1(data: Uint8Array): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-1", data as BufferSource));
}

const b64u = (s: string) =>
  Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

function res(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

const fail = (status: number, message: string, errors?: unknown) =>
  res(status, errors === undefined ? { message } : { message, errors });

function dateToUnix(iso: string): number {
  return Math.floor(Date.parse(iso) / 1000);
}

/** git の commit オブジェクトの SHA-1（本物の git と同じ並び）。同じ入力なら同じ SHA になる。 */
export async function gitCommitSha(c: Omit<FakeCommit, "sha">): Promise<string> {
  const id = (p: { name: string; email: string; date: string }) =>
    `${p.name} <${p.email}> ${dateToUnix(p.date)} +0000`;
  const text = [
    `tree ${c.tree}`,
    ...c.parents.map((p) => `parent ${p}`),
    `author ${id(c.author)}`,
    `committer ${id(c.committer)}`,
    "",
    c.message,
  ].join("\n");
  const body = new TextEncoder().encode(text);
  const header = new TextEncoder().encode(`commit ${body.length}\0`);
  const all = new Uint8Array(header.length + body.length);
  all.set(header, 0);
  all.set(body, header.length);
  return sha1(all);
}

export class FakeGitHubApp {
  appId: string;
  now: () => number;
  tokenTtlSeconds: number;
  slug: string;
  botId: number;
  /** true なら draft:true の PR 作成を 422 で拒否する（Free プランの private リポジトリ相当） */
  draftUnsupported = false;
  /**
   * リクエストを処理する直前に呼ぶ（"METHOD /path"）。「終端の後に head が動いた」のように、
   * 特定の API 呼び出しの直前に状態を変えたいときに使う。
   */
  beforeHandle: ((key: string) => void | Promise<void>) | undefined;
  private publicKeyPem: string;
  private storeFor: ((fullName: string) => RepoStore | undefined) | undefined;
  private publicKey: Promise<CryptoKey> | undefined;
  private repos = new Map<string, FakeRepoRec>();
  private tokens = new Map<string, TokenRec>();
  private faults: Fault[] = [];
  private log: FakeAppRequest[] = [];
  private tokenSeq = 0;
  /** PR の html_url の host。既定は github.test。ダッシュボードの契約は github.com の URL だけを通すので、E2E で切り替える */
  prHost = "github.test";
  /** 利用者のトークンで呼んだときの App の権限（Installation Token の permissions と同じ形）。 */
  private userPermissions: Record<string, string> = {
    contents: "write",
    pull_requests: "write",
    checks: "read",
    statuses: "read",
  };

  constructor(opts: FakeAppOptions) {
    this.appId = String(opts.appId);
    this.publicKeyPem = opts.publicKeyPem;
    this.storeFor = opts.storeFor;
    this.now = opts.now ?? Date.now;
    this.tokenTtlSeconds = opts.tokenTtlSeconds ?? 3600;
    this.slug = opts.slug ?? "acme-rovo";
    this.botId = opts.botId ?? 12345;
  }

  // ---- 管理 ----

  reset(): void {
    this.repos.clear();
    this.tokens.clear();
    this.faults = [];
    this.log = [];
    this.draftUnsupported = false;
    this.beforeHandle = undefined;
    this.userPermissions = {
      contents: "write",
      pull_requests: "write",
      checks: "read",
      statuses: "read",
    };
    this.prHost = "github.test";
  }

  /** PR の html_url の host を変える（"github.com" など。reset で github.test に戻る）。 */
  setPrHost(host: string): void {
    this.prHost = host;
  }

  /** 利用者のトークンで呼んだときの App の権限を変える（Pull requests: write が無い App の再現など）。 */
  setUserPermissions(permissions: Record<string, string>): void {
    this.userPermissions = { ...permissions };
  }

  /** ブランチ保護の再現。message を渡すとそのリポジトリのマージを 405 で拒否する。null で解除。 */
  setMergeBlock(fullName: string, message: string | null): void {
    this.mustRepo(fullName).mergeBlock = message ?? undefined;
  }

  /** コミットに check run を付ける（置き直すと上書き。GitHub Actions などの再現）。 */
  setCheckRuns(fullName: string, sha: string, runs: FakeCheckRun[]): void {
    this.mustRepo(fullName).checkRuns.set(sha, runs);
  }

  /** コミットに commit status を付ける（置き直すと上書き）。 */
  setCommitStatuses(fullName: string, sha: string, statuses: FakeCommitStatus[]): void {
    this.mustRepo(fullName).statuses.set(sha, statuses);
  }

  /** そのマージ方法（squash / merge / rebase）を許可しない。 */
  disallowMergeMethod(fullName: string, method: string): void {
    this.mustRepo(fullName).disallowedMethods.add(method);
  }

  /**
   * この Installation Token が、いま fullName への書き込み（contents: write）に使えるか。
   * 偽 git が Basic 認証の x-access-token を検証するために使う。失効・期限切れ・対象外のリポジトリは false。
   */
  isTokenValid(token: string, fullName: string): boolean {
    const rec = this.tokens.get(token);
    const repo = this.repos.get(fullName.toLowerCase());
    if (!rec || !repo || rec.revoked || rec.expiresAt <= this.now()) return false;
    return rec.repoIds.includes(repo.id) && rec.permissions.contents === "write";
  }

  /** リポジトリを用意する。base_sha を渡した未知の SHA は、既定でベースのコミットとして扱う。 */
  seedRepo(args: { id: number; fullName: string; installationId: number }): void {
    const key = args.fullName.toLowerCase();
    if (this.repos.has(key)) return;
    const store = this.storeFor?.(args.fullName);
    this.repos.set(key, {
      id: args.id,
      fullName: args.fullName,
      installationId: args.installationId,
      commits: store?.commits ?? new Map(),
      refs: store?.refs ?? new Map(),
      pulls: [],
      missing: new Set(),
      trees: new Map(),
      ...(store?.tree ? { readTree: store.tree.bind(store) } : {}),
      mergeBlock: undefined,
      disallowedMethods: new Set(),
      checkRuns: new Map(),
      statuses: new Map(),
    });
  }

  /**
   * コミットの tree の直下のファイル（名前 -> blob の SHA）を置く（置き直すと上書き）。
   * 依存関係のキャッシュ（D14）が、ルート直下の lockfile を GET /git/trees/:sha で読むのに使う。
   */
  async seedRootFiles(
    fullName: string,
    commitSha: string,
    files: Record<string, string>,
  ): Promise<void> {
    const repo = this.mustRepo(fullName);
    const c = await this.ensureCommit(repo, commitSha);
    repo.trees.set(
      c.tree,
      Object.entries(files).map(([path, sha]) => ({ path, sha })),
    );
  }

  /** このコミットは存在しない（base_sha_not_found の再現）。 */
  markMissing(fullName: string, sha: string): void {
    this.mustRepo(fullName).missing.add(sha);
  }

  setDraftUnsupported(v: boolean): void {
    this.draftUnsupported = v;
  }

  /** ブランチを強制的に動かす（force push / 別の人の push の再現）。 */
  setBranch(fullName: string, branch: string, sha: string): void {
    this.mustRepo(fullName).refs.set(`refs/heads/${branch}`, sha);
  }

  deleteBranch(fullName: string, branch: string): void {
    this.mustRepo(fullName).refs.delete(`refs/heads/${branch}`);
  }

  /** 親の上に空コミットを足し、SHA を返す（head が動いた状況の再現）。 */
  async addCommit(fullName: string, parent: string, message: string): Promise<string> {
    const repo = this.mustRepo(fullName);
    const p = await this.ensureCommit(repo, parent);
    const who = {
      name: "someone",
      email: "s@example.test",
      date: new Date(this.now()).toISOString(),
    };
    const c = { tree: p.tree, parents: [p.sha], message, author: who, committer: who };
    const sha = await gitCommitSha(c);
    repo.commits.set(sha, { sha, ...c });
    return sha;
  }

  /** 別経路で PR を先に作っておく（head のブランチは存在している必要がある）。 */
  seedPull(
    fullName: string,
    args: { head: string; base: string; title?: string; body?: string; draft?: boolean },
  ): number {
    const repo = this.mustRepo(fullName);
    if (!repo.refs.has(`refs/heads/${args.head}`)) throw new Error("seedPull: head branch missing");
    const p: FakePull = {
      number: repo.pulls.length + 1,
      title: args.title ?? "pre-existing",
      body: args.body ?? "",
      draft: args.draft ?? true,
      state: "open",
      head: args.head,
      base: args.base,
      merged: false,
    };
    repo.pulls.push(p);
    return p.number;
  }

  /** PR を閉じる。 */
  closePull(fullName: string, number: number): void {
    const p = this.mustRepo(fullName).pulls.find((x) => x.number === number);
    if (p) p.state = "closed";
  }

  /** PR の本文を書き換える（利用者の編集の再現）。 */
  editPullBody(fullName: string, number: number, body: string): void {
    const p = this.mustRepo(fullName).pulls.find((x) => x.number === number);
    if (p) p.body = body;
  }

  branch(fullName: string, branch: string): string | null {
    return this.repos.get(fullName.toLowerCase())?.refs.get(`refs/heads/${branch}`) ?? null;
  }

  pulls(fullName: string): FakePull[] {
    return (this.repos.get(fullName.toLowerCase())?.pulls ?? []).map((p) => ({ ...p }));
  }

  commit(fullName: string, sha: string): FakeCommit | null {
    return this.repos.get(fullName.toLowerCase())?.commits.get(sha) ?? null;
  }

  tokenList(): { token: string; revoked: boolean; expiresAt: number; repoIds: number[] }[] {
    return [...this.tokens.values()].map((t) => ({
      token: t.token,
      revoked: t.revoked,
      expiresAt: t.expiresAt,
      repoIds: t.repoIds,
    }));
  }

  /** トークンを期限切れにする（未指定ならすべて）。 */
  expireTokens(token?: string): void {
    for (const t of this.tokens.values()) if (!token || t.token === token) t.expiresAt = 0;
  }

  /** "METHOD /path" に対する正規表現に合うリクエストを status で失敗させる。 */
  setFault(args: {
    pattern: string;
    status: number | null;
    count?: number;
    skip?: number;
    headers?: Record<string, string>;
    message?: string;
    body?: unknown;
  }): void {
    this.faults = this.faults.filter((f) => f.pattern.source !== args.pattern);
    if (args.status === null) return;
    this.faults.push({
      pattern: new RegExp(args.pattern),
      status: args.status,
      remaining: args.count ?? Number.POSITIVE_INFINITY,
      skip: args.skip ?? 0,
      headers: args.headers ?? {},
      message: args.message ?? "injected fault",
      ...(args.body !== undefined ? { body: args.body } : {}),
    });
  }

  requests(): FakeAppRequest[] {
    return this.log.map((r) => ({ ...r }));
  }

  private mustRepo(fullName: string): FakeRepoRec {
    const r = this.repos.get(fullName.toLowerCase());
    if (!r) throw new Error(`fake github app: repo not seeded: ${fullName}`);
    return r;
  }

  private async ensureCommit(repo: FakeRepoRec, sha: string): Promise<FakeCommit> {
    const found = repo.commits.get(sha);
    if (found) return found;
    // 未知の SHA はベースのコミットとして自動登録する（短縮形は 40 桁の SHA に解決する）
    const full = /^[0-9a-f]{40}$/.test(sha) ? sha : await sha1(new TextEncoder().encode(sha));
    const existing = repo.commits.get(full);
    if (existing) {
      repo.commits.set(sha, existing);
      return existing;
    }
    const tree = await sha1(new TextEncoder().encode(`tree:${full}`));
    const who = { name: "base", email: "base@example.test", date: "2026-01-01T00:00:00Z" };
    const c: FakeCommit = {
      sha: full,
      tree,
      parents: [],
      message: "base",
      author: who,
      committer: who,
    };
    repo.commits.set(full, c);
    if (sha !== full) repo.commits.set(sha, c);
    return c;
  }

  // ---- 認証 ----

  private async verifyJwt(jwt: string): Promise<boolean> {
    const parts = jwt.split(".");
    if (parts.length !== 3) return false;
    const [h, p, s] = parts as [string, string, string];
    try {
      const header = JSON.parse(new TextDecoder().decode(b64u(h))) as { alg?: string };
      const payload = JSON.parse(new TextDecoder().decode(b64u(p))) as {
        iss?: unknown;
        iat?: unknown;
        exp?: unknown;
      };
      if (header.alg !== "RS256") return false;
      this.publicKey ??= crypto.subtle.importKey(
        "spki",
        Uint8Array.from(
          atob(this.publicKeyPem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "")),
          (c) => c.charCodeAt(0),
        ),
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["verify"],
      );
      const ok = await crypto.subtle.verify(
        "RSASSA-PKCS1-v1_5",
        await this.publicKey,
        b64u(s),
        new TextEncoder().encode(`${h}.${p}`),
      );
      if (!ok) return false;
      if (String(payload.iss) !== this.appId) return false;
      const nowSec = Math.floor(this.now() / 1000);
      if (typeof payload.exp !== "number" || typeof payload.iat !== "number") return false;
      // GitHub と同じく、未来の iat・期限切れ・10 分を超える有効期間は拒否する
      return payload.iat <= nowSec && payload.exp > nowSec && payload.exp - payload.iat <= 600;
    } catch {
      return false;
    }
  }

  private tokenFrom(auth: string): TokenRec | null {
    const m = /^(?:Bearer|token)\s+(\S+)$/i.exec(auth);
    const rec = m?.[1] ? this.tokens.get(m[1]) : undefined;
    if (!rec || rec.revoked || rec.expiresAt <= this.now()) return null;
    return rec;
  }

  // ---- ハンドラ ----

  /**
   * この偽物が扱うパスなら Response、そうでなければ null。
   * user を渡すと、利用者のトークン（GitHub App のユーザーアクセストークン）での呼び出しとして扱う
   * （トークンの検証は呼び出し側。Installation Token の検証はしない）。
   */
  async handle(req: Request, user?: FakeUser): Promise<Response | null> {
    const url = new URL(req.url);
    const path = url.pathname;
    if (!/^\/(app(\/|$)|users\/|repos\/|installation\/|graphql$)/.test(path)) return null;
    const auth = req.headers.get("authorization") ?? "";
    let body: unknown = null;
    if (req.method !== "GET" && req.method !== "DELETE") {
      const text = await req.text();
      try {
        body = text === "" ? null : JSON.parse(text);
      } catch {
        body = text;
      }
    }
    const isJwtRoute = path === "/app" || path.startsWith("/app/");
    this.log.push({
      method: req.method,
      path,
      query: Object.fromEntries(url.searchParams),
      auth: auth === "" ? "none" : isJwtRoute ? "jwt" : user ? "user" : "token",
      body,
    });

    const key = `${req.method} ${path}`;
    await this.beforeHandle?.(key);
    for (const f of this.faults) {
      if (f.pattern.test(key) && f.skip > 0) {
        f.skip -= 1;
        continue;
      }
      if (f.pattern.test(key) && f.remaining > 0) {
        f.remaining -= 1;
        return res(f.status, f.body !== undefined ? f.body : { message: f.message }, f.headers);
      }
    }

    // 公開のユーザー情報（認証なしでも引ける）。App の bot ユーザーだけを知っている
    if (req.method === "GET" && path.startsWith("/users/")) {
      return decodeURIComponent(path.slice("/users/".length)) === `${this.slug}[bot]`
        ? res(200, { login: `${this.slug}[bot]`, id: this.botId, type: "Bot" })
        : fail(404, "Not Found");
    }
    if (isJwtRoute) return this.appRoute(req, path, auth, body);
    if (user) return this.userRoute(req.method, path, url, body, user);
    const rec = this.tokenFrom(auth);
    if (!rec) return fail(401, "Bad credentials");
    if (req.method === "DELETE" && path === "/installation/token") {
      rec.revoked = true;
      return new Response(null, { status: 204 });
    }
    if (path === "/graphql") {
      // Installation Token での GraphQL（完了時の自動の Ready）。対象は token のリポジトリだけ
      return req.method === "POST"
        ? this.graphql(body, {
            canPush: (fullName) => {
              const repo = this.repos.get(fullName.toLowerCase());
              return repo !== undefined && rec.repoIds.includes(repo.id);
            },
            permissions: rec.permissions,
          })
        : fail(404, "Not Found");
    }
    const m = /^\/repos\/([^/]+)\/([^/]+)(\/.*)$/.exec(path);
    if (!m) return fail(404, "Not Found");
    const owner = decodeURIComponent(m[1] as string);
    const name = decodeURIComponent(m[2] as string);
    const repo = this.repos.get(`${owner}/${name}`.toLowerCase());
    if (!repo || !rec.repoIds.includes(repo.id)) return fail(404, "Not Found");
    return this.repoRoute(req.method, m[3] as string, url, rec, repo, body);
  }

  private async appRoute(
    req: Request,
    path: string,
    auth: string,
    body: unknown,
  ): Promise<Response> {
    const jwt = /^Bearer\s+(\S+)$/i.exec(auth)?.[1];
    if (!jwt || !(await this.verifyJwt(jwt))) {
      return fail(401, "A JSON web token could not be decoded");
    }
    if (path === "/app" && req.method === "GET") {
      return res(200, { id: Number(this.appId), slug: this.slug, name: this.slug });
    }
    const m = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(path);
    if (!m || req.method !== "POST") return fail(404, "Not Found");
    const installationId = Number(m[1]);
    const repos = [...this.repos.values()].filter((r) => r.installationId === installationId);
    if (repos.length === 0) return fail(404, "Not Found");
    const b = (body ?? {}) as { repository_ids?: unknown; permissions?: unknown };
    let repoIds = repos.map((r) => r.id);
    if (Array.isArray(b.repository_ids)) {
      const want = b.repository_ids as number[];
      if (!want.every((id) => repoIds.includes(id))) {
        return fail(422, "The repository IDs are not part of this installation");
      }
      repoIds = want;
    }
    const permissions = (b.permissions ?? { contents: "write", pull_requests: "write" }) as Record<
      string,
      string
    >;
    const token = `ghs_fake${(++this.tokenSeq).toString().padStart(4, "0")}${hex(crypto.getRandomValues(new Uint8Array(12)).buffer)}`;
    const expiresAt = this.now() + this.tokenTtlSeconds * 1000;
    this.tokens.set(token, {
      token,
      installationId,
      repoIds,
      permissions,
      expiresAt,
      revoked: false,
    });
    return res(201, {
      token,
      expires_at: new Date(expiresAt).toISOString().replace(/\.\d+Z$/, "Z"),
      permissions,
      repository_selection: "selected",
    });
  }

  private nodeId(repo: FakeRepoRec, p: FakePull): string {
    return `PR_fake_${repo.id}_${p.number}`;
  }

  private pullJson(repo: FakeRepoRec, p: FakePull) {
    return {
      number: p.number,
      node_id: this.nodeId(repo, p),
      html_url: `https://${this.prHost}/${repo.fullName}/pull/${p.number}`,
      title: p.title,
      body: p.body,
      draft: p.draft,
      state: p.state,
      merged: p.merged,
      head: {
        ref: p.head,
        sha: repo.refs.get(`refs/heads/${p.head}`) ?? p.headAtMerge ?? null,
        repo: { full_name: repo.fullName },
      },
      base: { ref: p.base, repo: { full_name: repo.fullName } },
    };
  }

  /** 利用者のトークンでの /repos/... と /graphql。リポジトリを見られない利用者には 404（存在を隠す）。 */
  private async userRoute(
    method: string,
    path: string,
    url: URL,
    body: unknown,
    user: FakeUser,
  ): Promise<Response> {
    if (path === "/graphql") {
      return method === "POST"
        ? this.graphql(body, { canPush: (f) => user.canPush(f), permissions: this.userPermissions })
        : fail(404, "Not Found");
    }
    const m = /^\/repos\/([^/]+)\/([^/]+)(\/.*)$/.exec(path);
    if (!m) return fail(404, "Not Found");
    const owner = decodeURIComponent(m[1] as string);
    const name = decodeURIComponent(m[2] as string);
    const repo = this.repos.get(`${owner}/${name}`.toLowerCase());
    if (!repo || !user.canPush(repo.fullName)) return fail(404, "Not Found");
    // check run / commit status を読むには、App に Checks / Commit statuses の read 権限が要る
    const checkKind =
      method === "GET" ? /^\/commits\/[^/]+\/(check-runs|status)$/.exec(m[3] as string) : null;
    if (checkKind) {
      const perm = checkKind[1] === "check-runs" ? "checks" : "statuses";
      if (!["read", "write"].includes(this.userPermissions[perm] ?? "")) {
        return fail(403, "Resource not accessible by integration");
      }
    }
    const rec: TokenRec = {
      token: "user",
      installationId: repo.installationId,
      repoIds: [repo.id],
      permissions: this.userPermissions,
      expiresAt: Number.POSITIVE_INFINITY,
      revoked: false,
    };
    return this.repoRoute(method, m[3] as string, url, rec, repo, body);
  }

  /** markPullRequestReadyForReview だけを扱う GraphQL。エラーは GitHub と同じく HTTP 200 の errors で返す。 */
  private graphql(
    body: unknown,
    user: { canPush(fullName: string): boolean; permissions: Record<string, string> },
  ): Response {
    const b = (body ?? {}) as { query?: unknown; variables?: { id?: unknown } };
    if (typeof b.query !== "string") return fail(400, "Problems parsing JSON");
    const errors = (type: string, message: string) =>
      res(200, { data: null, errors: [{ type, message }] });
    if (/\bpullRequest\(number:/.test(b.query) && /\brepository\(owner:/.test(b.query)) {
      return this.pullStates(
        b.query,
        (body as { variables?: Record<string, unknown> }).variables ?? {},
        user,
      );
    }
    if (!/markPullRequestReadyForReview/.test(b.query)) {
      return errors("UNSUPPORTED", "fake github: unsupported GraphQL operation");
    }
    const id = b.variables?.id;
    for (const repo of this.repos.values()) {
      for (const p of repo.pulls) {
        if (this.nodeId(repo, p) !== id || !user.canPush(repo.fullName)) continue;
        if (user.permissions.pull_requests !== "write") {
          return errors("FORBIDDEN", "Resource not accessible by integration");
        }
        if (!p.draft) return errors("UNPROCESSABLE", "Pull request is not a draft");
        p.draft = false;
        return res(200, {
          data: {
            markPullRequestReadyForReview: {
              pullRequest: { id: this.nodeId(repo, p), isDraft: false },
            },
          },
        });
      }
    }
    return errors("NOT_FOUND", `Could not resolve to a node with the global id of '${String(id)}'`);
  }

  /**
   * ダッシュボードの PR の状態の照会: `rN: repository(owner: $oI, name: $nI) { pullRequest(number: $pI) { state merged } }` を並べた GraphQL。
   * 見えない・無いリポジトリは GitHub と同じく data の alias が null + errors に NOT_FOUND（HTTP は 200）。無い PR は pullRequest: null。
   */
  private pullStates(
    query: string,
    variables: Record<string, unknown>,
    user: { canPush(fullName: string): boolean },
  ): Response {
    const data: Record<string, unknown> = {};
    const errors: { type: string; path: string[]; message: string }[] = [];
    const re =
      /\b(r\d+): repository\(owner: \$(o\d+), name: \$(n\d+)\)\s*\{\s*pullRequest\(number: \$(p\d+)\)/g;
    for (const m of query.matchAll(re)) {
      const [, alias, o, n, p] = m as unknown as [string, string, string, string, string];
      const repo = this.repos.get(`${String(variables[o])}/${String(variables[n])}`.toLowerCase());
      if (!repo || !user.canPush(repo.fullName)) {
        data[alias] = null;
        errors.push({
          type: "NOT_FOUND",
          path: [alias],
          message: "Could not resolve to a Repository",
        });
        continue;
      }
      const pull = repo.pulls.find((x) => x.number === variables[p]);
      data[alias] = {
        pullRequest: pull
          ? {
              state: pull.merged ? "MERGED" : pull.state === "closed" ? "CLOSED" : "OPEN",
              merged: pull.merged,
            }
          : null,
      };
    }
    return res(200, { data, ...(errors.length > 0 ? { errors } : {}) });
  }

  private resolve(repo: FakeRepoRec, nameOrSha: string): string {
    return repo.refs.get(`refs/heads/${nameOrSha}`) ?? nameOrSha;
  }

  private ancestors(repo: FakeRepoRec, sha: string): Set<string> {
    const seen = new Set<string>();
    const stack = [sha];
    while (stack.length > 0) {
      const s = stack.pop() as string;
      if (seen.has(s)) continue;
      seen.add(s);
      for (const p of repo.commits.get(s)?.parents ?? []) stack.push(p);
    }
    return seen;
  }

  private async repoRoute(
    method: string,
    rest: string,
    url: URL,
    tok: TokenRec,
    repo: FakeRepoRec,
    body: unknown,
  ): Promise<Response> {
    const can = (perm: string) => tok.permissions[perm] === "write";
    const b = (body ?? {}) as Record<string, unknown>;
    const match = (re: RegExp) => re.exec(rest);

    const commitGet = method === "GET" ? match(/^\/git\/commits\/([^/]+)$/) : null;
    if (commitGet) {
      const sha = decodeURIComponent(commitGet[1] as string);
      if (repo.missing.has(sha)) return fail(404, "Not Found");
      const c = await this.ensureCommit(repo, sha);
      return res(200, {
        sha: c.sha,
        tree: { sha: c.tree },
        parents: c.parents.map((p) => ({ sha: p })),
        message: c.message,
      });
    }

    const treeGet = method === "GET" ? match(/^\/git\/trees\/([^/]+)$/) : null;
    if (treeGet) {
      const sha = decodeURIComponent(treeGet[1] as string);
      const seeded = repo.trees.get(sha);
      // seedRootFiles の path に "/" を含むもの（入れ子のファイル）は ?recursive=1 のときだけ返す
      const recursive = url.searchParams.get("recursive") === "1";
      const entries = seeded
        ? seeded
            .filter((e) => recursive || !e.path.includes("/"))
            .map((e) => ({ path: e.path, mode: "100644", type: "blob", sha: e.sha }))
        : (repo.readTree?.(sha) ?? []);
      return res(200, { sha, truncated: false, tree: entries });
    }

    if (method === "POST" && rest === "/git/commits") {
      if (!can("contents")) return fail(403, "Resource not accessible by integration");
      const parents = Array.isArray(b.parents) ? (b.parents as string[]) : [];
      const author = b.author as FakeCommit["author"] | undefined;
      const committer = b.committer as FakeCommit["committer"] | undefined;
      if (typeof b.tree !== "string" || typeof b.message !== "string") {
        return fail(422, "Validation Failed");
      }
      const now = new Date(this.now()).toISOString();
      const fallback = { name: "app", email: "app@example.test", date: now };
      const c = {
        tree: b.tree,
        parents,
        message: b.message,
        author: author ?? fallback,
        committer: committer ?? author ?? fallback,
      };
      const sha = await gitCommitSha(c);
      repo.commits.set(sha, { sha, ...c });
      return res(201, { sha, tree: { sha: c.tree }, parents: parents.map((p) => ({ sha: p })) });
    }

    const refGet = method === "GET" ? match(/^\/git\/ref\/(.+)$/) : null;
    if (refGet) {
      const ref = `refs/${decodeURIComponent(refGet[1] as string)}`;
      const sha = repo.refs.get(ref);
      if (!sha) return fail(404, "Not Found");
      return res(200, { ref, object: { sha, type: "commit" } });
    }

    if (method === "POST" && rest === "/git/refs") {
      if (!can("contents")) return fail(403, "Resource not accessible by integration");
      if (typeof b.ref !== "string" || typeof b.sha !== "string")
        return fail(422, "Validation Failed");
      if (repo.refs.has(b.ref)) return fail(422, "Reference already exists");
      if (!repo.commits.has(b.sha)) return fail(422, "Object does not exist");
      repo.refs.set(b.ref, b.sha);
      return res(201, { ref: b.ref, object: { sha: b.sha, type: "commit" } });
    }

    const cmpGet = method === "GET" ? match(/^\/compare\/(.+)\.\.\.(.+)$/) : null;
    if (cmpGet) {
      const base = this.resolve(repo, decodeURIComponent(cmpGet[1] as string));
      const head = this.resolve(repo, decodeURIComponent(cmpGet[2] as string));
      if (!repo.commits.has(base) || !repo.commits.has(head)) return fail(404, "Not Found");
      const headAnc = this.ancestors(repo, head);
      const baseAnc = this.ancestors(repo, base);
      let status: string;
      if (base === head) status = "identical";
      else if (headAnc.has(base)) status = "ahead";
      else if (baseAnc.has(head)) status = "behind";
      else status = "diverged";
      return res(200, {
        status,
        ahead_by: [...headAnc].filter((s) => !baseAnc.has(s)).length,
        behind_by: [...baseAnc].filter((s) => !headAnc.has(s)).length,
      });
    }

    if (method === "GET" && rest === "/pulls") {
      const head = url.searchParams.get("head") ?? "";
      const state = url.searchParams.get("state") ?? "open";
      const branch = head.includes(":") ? head.slice(head.indexOf(":") + 1) : head;
      const list = repo.pulls.filter(
        (p) => (state === "all" || p.state === state) && (head === "" || p.head === branch),
      );
      return res(
        200,
        list.map((p) => this.pullJson(repo, p)),
      );
    }

    if (method === "POST" && rest === "/pulls") {
      if (!can("pull_requests")) return fail(403, "Resource not accessible by integration");
      const head = String(b.head ?? "");
      const base = String(b.base ?? "");
      if (!repo.refs.has(`refs/heads/${head}`)) {
        return fail(422, "Validation Failed", [
          { resource: "PullRequest", field: "head", code: "invalid" },
        ]);
      }
      if (repo.pulls.some((p) => p.state === "open" && p.head === head && p.base === base)) {
        return fail(422, "Validation Failed", [
          {
            resource: "PullRequest",
            code: "custom",
            message: `A pull request already exists for ${repo.fullName.split("/")[0]}:${head}.`,
          },
        ]);
      }
      if (b.draft === true && this.draftUnsupported) {
        return fail(422, "Draft pull requests are not supported in this repository.");
      }
      const p: FakePull = {
        number: repo.pulls.length + 1,
        title: String(b.title ?? ""),
        body: String(b.body ?? ""),
        draft: b.draft === true,
        state: "open",
        head,
        base,
        merged: false,
      };
      repo.pulls.push(p);
      return res(201, this.pullJson(repo, p));
    }

    const checkRunsGet = method === "GET" ? match(/^\/commits\/([^/]+)\/check-runs$/) : null;
    if (checkRunsGet) {
      const sha = decodeURIComponent(checkRunsGet[1] as string);
      const runs = repo.checkRuns.get(sha) ?? [];
      return res(200, {
        total_count: runs.length,
        check_runs: runs.map((c, i) => ({
          id: i + 1,
          name: c.name,
          status: c.status,
          conclusion: c.conclusion ?? null,
        })),
      });
    }

    const statusGet = method === "GET" ? match(/^\/commits\/([^/]+)\/status$/) : null;
    if (statusGet) {
      const sha = decodeURIComponent(statusGet[1] as string);
      const list = repo.statuses.get(sha) ?? [];
      // GitHub と同じ: 1 件も無ければ pending。failure / error が 1 つでもあれば failure、pending があれば pending
      const state =
        list.length === 0
          ? "pending"
          : list.some((x) => x.state === "failure" || x.state === "error")
            ? "failure"
            : list.some((x) => x.state === "pending")
              ? "pending"
              : "success";
      return res(200, {
        state,
        sha,
        total_count: list.length,
        statuses: list.map((x) => ({ context: x.context, state: x.state })),
      });
    }

    const mergeOne = method === "PUT" ? match(/^\/pulls\/(\d+)\/merge$/) : null;
    if (mergeOne) {
      const p = repo.pulls.find((x) => x.number === Number(mergeOne[1]));
      if (!p) return fail(404, "Not Found");
      if (!can("pull_requests") || !can("contents")) {
        return fail(403, "Resource not accessible by integration");
      }
      const how = b.merge_method === undefined ? "merge" : String(b.merge_method);
      if (!["merge", "squash", "rebase"].includes(how)) {
        return fail(422, "Validation Failed");
      }
      if (p.merged || p.state !== "open") return fail(405, "Pull Request is not mergeable");
      if (p.draft) return fail(405, "Pull Request is still a draft");
      if (repo.mergeBlock !== undefined) return fail(405, repo.mergeBlock);
      if (repo.disallowedMethods.has(how)) {
        return fail(405, `${how} merges are not allowed on this repository.`);
      }
      const head = repo.refs.get(`refs/heads/${p.head}`) ?? null;
      if (typeof b.sha === "string" && b.sha !== head) {
        return fail(409, "Head branch was modified. Review and try the merge again.");
      }
      p.merged = true;
      p.state = "closed";
      p.mergeMethod = how;
      if (head !== null) p.headAtMerge = head;
      if (typeof b.sha === "string") p.mergeSha = b.sha;
      return res(200, {
        sha: head,
        merged: true,
        message: "Pull Request successfully merged",
      });
    }

    const refDelete = method === "DELETE" ? match(/^\/git\/refs\/(heads\/.+)$/) : null;
    if (refDelete) {
      if (!can("contents")) return fail(403, "Resource not accessible by integration");
      const ref = `refs/${decodeURIComponent(refDelete[1] as string)}`;
      if (!repo.refs.has(ref)) return fail(422, "Reference does not exist");
      repo.refs.delete(ref);
      return new Response(null, { status: 204 });
    }

    const issueComment = method === "POST" ? match(/^\/issues\/(\d+)\/comments$/) : null;
    if (issueComment) {
      const p = repo.pulls.find((x) => x.number === Number(issueComment[1]));
      if (!p) return fail(404, "Not Found");
      if (!can("pull_requests")) return fail(403, "Resource not accessible by integration");
      p.comments = [...(p.comments ?? []), String(b.body ?? "")];
      return res(201, { id: 1, body: b.body });
    }

    const pullOne = match(/^\/pulls\/(\d+)$/);
    if (pullOne) {
      const p = repo.pulls.find((x) => x.number === Number(pullOne[1]));
      if (!p) return fail(404, "Not Found");
      if (method === "GET") return res(200, this.pullJson(repo, p));
      if (method === "PATCH") {
        if (!can("pull_requests")) return fail(403, "Resource not accessible by integration");
        if (typeof b.body === "string") {
          if (b.body.length > 65_536)
            return fail(422, "Body is too long (maximum is 65536 characters)");
          p.body = b.body;
        }
        if (typeof b.title === "string") p.title = b.title;
        if (b.state === "closed") p.state = "closed";
        return res(200, this.pullJson(repo, p));
      }
    }

    return fail(404, "Not Found");
  }
}
