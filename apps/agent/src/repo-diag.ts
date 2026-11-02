// 起動時の作業ツリーの診断（.npmrc の registry と mise.toml の go の版）。
// ワーカーには英語の短い文で、クライアントには task_result の warnings（固定コード）と usage（検証したホスト名だけ）で伝える。
// リポジトリの中身は非信頼データ。固定コードと、ホスト名として検証できた値のほかは外へ出さない（_authToken などの行は読まない）。

import { decideOutbound } from "./outbound-policy";

export const NPMRC_REGISTRY_NOT_ALLOWED = "npmrc_registry_not_allowed";
export const MISE_GO_VERSION_UNAVAILABLE = "mise_go_version_unavailable";
/** task_result の warnings に付けうる固定コードの全部（AgentDO はこれ以外を捨てる） */
export const REPO_DIAG_WARNINGS: readonly string[] = [
  NPMRC_REGISTRY_NOT_ALLOWED,
  MISE_GO_VERSION_UNAVAILABLE,
];
export type RepoDiagWarning =
  | typeof NPMRC_REGISTRY_NOT_ALLOWED
  | typeof MISE_GO_VERSION_UNAVAILABLE;

/** usage.npmrc_registry_hosts の件数の上限 */
export const NPMRC_HOSTS_MAX = 5;

/** ホスト名の厳密な形（小文字・英数字とハイフンのラベルを . でつないだもの。ラベルは 63 文字、全体は 253 文字まで） */
export const HOSTNAME_RE =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

export function isValidHostname(v: unknown): v is string {
  return typeof v === "string" && HOSTNAME_RE.test(v);
}

/** 検証したホスト名だけを、重複を除いて max 件まで残す */
export function sanitizeHostnames(v: unknown, max = NPMRC_HOSTS_MAX): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const h of v) {
    if (out.length >= max) break;
    if (isValidHostname(h) && !out.includes(h)) out.push(h);
  }
  return out;
}

const NPMRC_REGISTRY_LINE = /^(?:@[^\s:=]+:)?registry\s*=\s*(.*)$/;

/**
 * .npmrc の `registry=` と `@scope:registry=` を読み、外向き通信の判定（decideOutbound）で許可されないものを拾う。
 * blocked: 許可されない registry が 1 つでもある（URL として読めないものも含む）。hosts: そのうちホスト名として検証できたもの（最大 5 件）。
 */
export function npmrcDiagnostics(text: string): { blocked: boolean; hosts: string[] } {
  let blocked = false;
  const hosts: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("#") || line.startsWith(";")) continue;
    const m = NPMRC_REGISTRY_LINE.exec(line);
    if (!m) continue;
    let value = (m[1] ?? "").trim();
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.endsWith(value[0])) {
      value = value.slice(1, -1).trim();
    }
    if (value === "") continue;
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      blocked = true;
      continue;
    }
    // npm はこの URL の下（GET）にパッケージを取りに行く。判定は外向き通信の policy にそのまま任せる
    if (decideOutbound({ method: "GET", url: url.href }).allow) continue;
    blocked = true;
    const host = url.hostname.toLowerCase();
    if (isValidHostname(host) && !hosts.includes(host) && hosts.length < NPMRC_HOSTS_MAX) {
      hosts.push(host);
    }
  }
  return { blocked, hosts };
}

/** TOML の値の先頭の文字列リテラル（"..." / '...'）。無ければ undefined */
function firstString(v: string): string | undefined {
  const m = /^\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)')/.exec(v);
  if (!m) return undefined;
  return m[1] ?? m[2];
}

/** [tools] の go の値（文字列 / { version = "..." } / [ "...", ... ]）から版を取る */
function toolVersion(value: string): string | undefined {
  const v = value.trim();
  let s: string | undefined;
  if (v.startsWith("{")) {
    const m = /(?:^|[{,\s])(?:version|"version")\s*=\s*(.*)$/.exec(v.slice(1));
    s = m ? firstString(m[1] ?? "") : undefined;
  } else if (v.startsWith("[")) {
    s = firstString(v.slice(1));
  } else {
    s = firstString(v);
  }
  // mise は空白区切りで複数の版を書ける。最初のものを使う
  const first = s?.trim().split(/\s+/)[0];
  return first ? first : undefined;
}

/**
 * mise.toml の [tools] の go の版。小さな TOML の部分集合だけを読む（1 行の key = value。複数行の値は読まない）。
 * 無ければ undefined。
 */
export function miseGoVersion(toml: string): string | undefined {
  let section = "";
  for (const raw of toml.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    if (line.startsWith("[[")) {
      section = "\0array";
      continue;
    }
    const head = /^\[\s*([^\]]+?)\s*\]\s*(?:#.*)?$/.exec(line);
    if (head) {
      section = (head[1] ?? "")
        .split(".")
        .map((p) => p.trim().replace(/^["']|["']$/g, ""))
        .join(".");
      continue;
    }
    if (section === "tools") {
      const m = /^(?:go|"go"|'go')\s*=\s*(.+)$/.exec(line);
      if (m) return toolVersion(m[1] ?? "");
    } else if (section === "") {
      const m = /^(?:tools|"tools")\s*\.\s*(?:go|"go"|'go')\s*=\s*(.+)$/.exec(line);
      if (m) return toolVersion(m[1] ?? "");
    }
  }
  return undefined;
}

/** mise の go の版の指定が、焼いた版で解決できるか（同じ版か、. 区切りの前方一致。prefix: と system も） */
export function goVersionMatches(requested: string, baked: string): boolean {
  let r = requested.trim();
  if (r.startsWith("prefix:")) r = r.slice("prefix:".length);
  if (r === "system") return true;
  if (r === "") return false;
  return r === baked || baked.startsWith(`${r}.`);
}

export interface RepoDiagnostics {
  /** task_result の warnings に付ける固定コード（.npmrc → mise の順。各 1 回） */
  warnings: RepoDiagWarning[];
  /** usage.npmrc_registry_hosts（検証したホスト名。最大 5 件） */
  npmrcRegistryHosts: string[];
  /** ワーカーの依存の節に足す英語の文。何も無ければ無い（gateway には送らない） */
  note?: string;
}

/** ワーカーへの文に載せてよい版の形（それ以外は版を書かない） */
const SAFE_VERSION = /^[0-9A-Za-z.:_-]{1,32}$/;

/** 作業ツリーのルートの .npmrc と mise.toml の中身から、警告・ホスト名・ワーカーへの文を作る */
export function repoDiagnostics(
  input: { npmrc?: string; miseToml?: string },
  bakedGo: string,
): RepoDiagnostics {
  const warnings: RepoDiagWarning[] = [];
  const notes: string[] = [];
  let hosts: string[] = [];
  if (input.npmrc !== undefined) {
    const npm = npmrcDiagnostics(input.npmrc);
    if (npm.blocked) {
      warnings.push(NPMRC_REGISTRY_NOT_ALLOWED);
      hosts = npm.hosts;
      const which = hosts.length > 0 ? ` (${hosts.join(", ")})` : "";
      notes.push(
        `The repository .npmrc sets a registry that the sandbox network does not allow${which}; installs from that registry will be denied.\nUse the default npm registry (registry.npmjs.org) instead, or if the task needs that registry, say so in your summary.`,
      );
    }
  }
  if (input.miseToml !== undefined) {
    const go = miseGoVersion(input.miseToml);
    if (go !== undefined && !goVersionMatches(go, bakedGo)) {
      warnings.push(MISE_GO_VERSION_UNAVAILABLE);
      const asked = SAFE_VERSION.test(go) ? ` go "${go}"` : " a go version";
      notes.push(
        `mise.toml asks for${asked}, but mise cannot fetch Go versions other than the baked Go ${bakedGo}: \`mise install\` / \`mise run\` will fail, and \`mise exec\` silently runs the baked Go ${bakedGo} with a warning. Check with \`go version\`; if another Go is required, prefer the go.mod \`toolchain\` directive, which is fetched through proxy.golang.org.`,
      );
    }
  }
  return {
    warnings,
    npmrcRegistryHosts: hosts,
    ...(notes.length > 0 ? { note: notes.join("\n") } : {}),
  };
}

/** 受け取った値を、診断の固定コード（REPO_DIAG_WARNINGS）だけに絞る（重複は除く） */
export function repoDiagWarnings(v: unknown): RepoDiagWarning[] {
  if (!Array.isArray(v)) return [];
  const out: RepoDiagWarning[] = [];
  for (const w of v) {
    if (
      typeof w === "string" &&
      REPO_DIAG_WARNINGS.includes(w) &&
      !out.includes(w as RepoDiagWarning)
    ) {
      out.push(w as RepoDiagWarning);
    }
  }
  return out;
}
