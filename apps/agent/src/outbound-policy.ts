export interface OutboundRequest {
  method: string;
  url: string;
  /** Upgrade ヘッダ（WebSocket など）が付いているか。付いていれば拒否する。 */
  upgrade?: boolean;
}
export interface OutboundOptions {
  /** git clone を許す対象リポジトリ。未設定なら github.com へは何も許可しない（fail-closed）。 */
  repo?: { owner: string; name: string };
  /**
   * push を許す唯一の作業ブランチ（`agent/task-<id>`）。未設定、または形が違うなら push は何も許可しない（fail-closed）。
   * ref の中身（本文）の検証は OutboundGateway が行う。ここでは URL の形と対象リポジトリだけを見る。
   */
  branch?: string;
}

/** パッケージレジストリ（GET / HEAD だけ許可）。ログの分類（outbound-gateway の classifyDestination）も同じ一覧を使う。 */
export const REGISTRY_HOSTS: ReadonlySet<string> = new Set([
  "registry.npmjs.org",
  "pypi.org",
  "files.pythonhosted.org",
  "proxy.golang.org",
  "sum.golang.org",
  // Takumi Guard（npm のレジストリのプロキシ）。npm のレジストリと同じく GET / HEAD だけ
  "npm.flatt.tech",
]);
/**
 * python-build-standalone（astral-sh/python-build-standalone）の GitHub のリポジトリ ID。
 * github.com の releases/download は、配布物を `/github-production-release-asset/<リポジトリ ID>/<資産の ID>` の形の
 * 署名付き URL へ 302 で転送する。転送先のホストは誰でも releases を置けるので、このリポジトリの ID のパスだけを許す。
 */
export const PYTHON_BUILD_STANDALONE_REPO_ID = "162334160";

/**
 * ホスト全体ではなく、パスの先頭が一致するものだけを許可するレジストリ（GET / HEAD だけ）。
 * - storage.googleapis.com: proxy.golang.org が、モジュールの zip（GOTOOLCHAIN の toolchain 本体も）を 302 でこのバケットへ転送する。
 *   誰でもバケットを作れるので、ホストごとは許可しない。
 * - nodejs.org の /dist/: mise が焼いていない node の版を取る（index.json・本体・SHASUMS256.txt・SHASUMS256.txt.sig）。
 * - mise-versions.jdx.dev の /data/python-precompiled-: mise が python の precompiled の版の一覧を取る。
 * - github.com の python-build-standalone の /releases/download/: mise が焼いていない python の版を取る。
 *   github.com のほかのパスは git の smart HTTP だけ（decideGitHub）。ほかのリポジトリの releases は許さない。
 * - release-assets.githubusercontent.com / objects.githubusercontent.com: 上の releases/download の 302 の転送先（新旧）。
 *   python-build-standalone のリポジトリ ID のパスだけ。
 * 根拠と一覧は docs/specs/phase2.md の許可先の節。
 */
export const REGISTRY_PATH_PREFIXES: ReadonlyMap<string, readonly string[]> = new Map([
  ["storage.googleapis.com", ["/proxy-golang-org-prod/"]],
  ["nodejs.org", ["/dist/"]],
  ["mise-versions.jdx.dev", ["/data/python-precompiled-"]],
  ["github.com", ["/astral-sh/python-build-standalone/releases/download/"]],
  [
    "release-assets.githubusercontent.com",
    [`/github-production-release-asset/${PYTHON_BUILD_STANDALONE_REPO_ID}/`],
  ],
  [
    "objects.githubusercontent.com",
    [`/github-production-release-asset-2e65be/${PYTHON_BUILD_STANDALONE_REPO_ID}/`],
  ],
]);

/**
 * host と pathname が、パス限定のレジストリに当たるか。判定は pathname だけで行い、query は見ない。
 * pathname は URL が正規化済み（.. と %2e%2e は解決される）。解決されずに残る %2f・%5c・%2e を含むものは、別のバケットへ
 * 抜けるおそれがあるので許可しない。
 */
export function isPathRegistry(host: string, pathname: string): boolean {
  const prefixes = REGISTRY_PATH_PREFIXES.get(host.toLowerCase());
  if (!prefixes) return false;
  if (/%2f|%5c|%2e/i.test(pathname)) return false;
  return prefixes.some((p) => pathname.startsWith(p));
}

/**
 * decideOutbound が返しうる違反コードの全部（outbound_denied の reason になる）。
 * deny() の引数の型にしてあるので、足し忘れるとコンパイルが通らない。テスト（outbound-denied-reasons.test.ts）が表の過不足を確かめる。
 */
export const POLICY_DENY_CODES = [
  "invalid_url",
  "upgrade_not_allowed",
  "non_https",
  "port_not_allowed",
  "url_credentials",
  "registry_method",
  "host_not_allowed",
  "github_path",
  "github_no_repo",
  "github_other_repo",
  "github_push_not_allowed",
  "github_service",
  "github_method",
] as const;
export type PolicyDenyCode = (typeof POLICY_DENY_CODES)[number];
/** code は固定の識別子（ログ用。入力を含まない）。reason は人間向けの説明で、入力のホスト名などを含みうる。 */
export type OutboundDecision =
  | { allow: true }
  | { allow: false; reason: string; code: PolicyDenyCode };
const deny = (code: PolicyDenyCode, reason: string): OutboundDecision => ({
  allow: false,
  reason,
  code,
});

/**
 * Sandbox からの外向き通信を許可するか判定する純粋関数（design 7.2）。
 * 許可: github.com の git-upload-pack（fetch/clone）と、作業ブランチ向けの git-receive-pack（push。本文の検証は別）、
 * レジストリ（パス限定のもの。github.com の特定のリポジトリの releases の配布物を含む）の GET/HEAD。それ以外はすべて拒否。
 */
export function decideOutbound(req: OutboundRequest, opts: OutboundOptions = {}): OutboundDecision {
  let url: URL;
  try {
    url = new URL(req.url);
  } catch {
    return deny("invalid_url", "invalid url");
  }
  const host = url.hostname.toLowerCase();
  const method = req.method.toUpperCase();
  if (req.upgrade) return deny("upgrade_not_allowed", `protocol upgrade is not allowed: ${host}`);
  if (url.protocol !== "https:") return deny("non_https", `non-https is not allowed: ${host}`);
  if (url.port !== "" && url.port !== "443")
    return deny("port_not_allowed", `port ${url.port} is not allowed: ${host}`);
  if (url.username || url.password)
    return deny("url_credentials", `credentials in url are not allowed: ${host}`);

  if (host === "github.com") {
    // 特定のリポジトリの releases の配布物だけは、レジストリと同じ扱い（GET / HEAD。認証は付けない）
    if (isPathRegistry(host, url.pathname)) {
      return method === "GET" || method === "HEAD"
        ? { allow: true }
        : deny("registry_method", `${method} is not allowed for registry: ${host}`);
    }
    return decideGitHub(method, url, opts);
  }
  if (REGISTRY_HOSTS.has(host)) {
    return method === "GET" || method === "HEAD"
      ? { allow: true }
      : deny("registry_method", `${method} is not allowed for registry: ${host}`);
  }
  if (REGISTRY_PATH_PREFIXES.has(host)) {
    if (!isPathRegistry(host, url.pathname))
      return deny("host_not_allowed", `host is not allowed: ${host}`);
    return method === "GET" || method === "HEAD"
      ? { allow: true }
      : deny("registry_method", `${method} is not allowed for registry: ${host}`);
  }
  return deny("host_not_allowed", `host is not allowed: ${host}`);
}

const GITHUB_PATH =
  /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/(info\/refs|git-upload-pack|git-receive-pack)$/;
const WORK_BRANCH = /^agent\/task-[A-Za-z0-9_-]+$/;

/** github.com への許可済みリクエストが、git のどの段階か。判定を通ったものにだけ使う。 */
export type GitRoute =
  | "upload-pack-advert"
  | "upload-pack"
  | "receive-pack-advert"
  | "receive-pack";

/** URL とメソッドから git の段階を分類する（許可の判定ではない。該当しなければ undefined）。 */
export function gitRoute(method: string, url: URL): GitRoute | undefined {
  if (url.hostname.toLowerCase() !== "github.com") return undefined;
  const m = GITHUB_PATH.exec(url.pathname);
  if (!m) return undefined;
  const tail = m[3];
  const verb = method.toUpperCase();
  if (tail === "git-upload-pack") return verb === "POST" ? "upload-pack" : undefined;
  if (tail === "git-receive-pack") return verb === "POST" ? "receive-pack" : undefined;
  if (verb !== "GET") return undefined;
  const service = url.searchParams.get("service");
  if (service === "git-upload-pack") return "upload-pack-advert";
  if (service === "git-receive-pack") return "receive-pack-advert";
  return undefined;
}

function decideGitHub(method: string, url: URL, opts: OutboundOptions): OutboundDecision {
  // パスは正規化済み（URL が .. を解決する）。余計なセグメントは正規表現で弾く。
  const m = GITHUB_PATH.exec(url.pathname);
  if (!m) return deny("github_path", "github.com: only git smart-http paths are allowed");
  const [, owner, name, tail] = m as unknown as [string, string, string, string];
  // リポジトリが設定されていなければ、どれも許可しない（fail-closed）
  if (!opts.repo) return deny("github_no_repo", "github.com: no task repository is configured");
  if (
    owner.toLowerCase() !== opts.repo.owner.toLowerCase() ||
    name.toLowerCase() !== opts.repo.name.toLowerCase()
  ) {
    return deny(
      "github_other_repo",
      `github.com: repository ${owner}/${name} is not the task repository`,
    );
  }
  const receive =
    tail === "git-receive-pack" || url.searchParams.get("service") === "git-receive-pack";
  if (receive && !(opts.branch && WORK_BRANCH.test(opts.branch))) {
    return deny("github_push_not_allowed", "github.com: push is not allowed");
  }
  if (tail === "info/refs") {
    const q = [...url.searchParams.entries()];
    if (
      method === "GET" &&
      q.length === 1 &&
      q[0]?.[0] === "service" &&
      (q[0][1] === "git-upload-pack" || q[0][1] === "git-receive-pack")
    ) {
      return { allow: true };
    }
    return deny(
      "github_service",
      "github.com: only service=git-upload-pack or git-receive-pack is allowed",
    );
  }
  return method === "POST" && url.search === ""
    ? { allow: true }
    : deny("github_method", `github.com: ${tail} requires POST`);
}
