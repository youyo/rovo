export interface OutboundRequest {
  method: string;
  url: string;
  /** Upgrade ヘッダ（WebSocket など）が付いているか。付いていれば拒否する。 */
  upgrade?: boolean;
}
export interface OutboundOptions {
  /** git clone を許す対象リポジトリ。未設定なら github.com へは何も許可しない（fail-closed）。 */
  repo?: { owner: string; name: string };
}
/** code は固定の識別子（ログ用。入力を含まない）。reason は人間向けの説明で、入力のホスト名などを含みうる。 */
export type OutboundDecision = { allow: true } | { allow: false; reason: string; code: string };

const REGISTRY_HOSTS = new Set(["registry.npmjs.org", "pypi.org", "files.pythonhosted.org"]);
const deny = (code: string, reason: string): OutboundDecision => ({ allow: false, reason, code });

/**
 * Sandbox からの外向き通信を許可するか判定する純粋関数（design 7.2）。
 * 許可: github.com の git-upload-pack（fetch/clone）、レジストリの GET/HEAD。それ以外はすべて拒否。
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

  if (host === "github.com") return decideGitHub(method, url, opts);
  if (REGISTRY_HOSTS.has(host)) {
    return method === "GET" || method === "HEAD"
      ? { allow: true }
      : deny("registry_method", `${method} is not allowed for registry: ${host}`);
  }
  return deny("host_not_allowed", `host is not allowed: ${host}`);
}

function decideGitHub(method: string, url: URL, opts: OutboundOptions): OutboundDecision {
  // パスは正規化済み（URL が .. を解決する）。余計なセグメントは正規表現で弾く。
  const m =
    /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/(info\/refs|git-upload-pack)$/.exec(
      url.pathname,
    );
  if (!m) return deny("github_path", "github.com: only git-upload-pack paths are allowed");
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
  if (tail === "info/refs") {
    const q = [...url.searchParams.entries()];
    if (
      method === "GET" &&
      q.length === 1 &&
      q[0]?.[0] === "service" &&
      q[0][1] === "git-upload-pack"
    ) {
      return { allow: true };
    }
    return deny("github_service", "github.com: only service=git-upload-pack is allowed");
  }
  return method === "POST" && url.search === ""
    ? { allow: true }
    : deny("github_method", "github.com: git-upload-pack requires POST");
}
