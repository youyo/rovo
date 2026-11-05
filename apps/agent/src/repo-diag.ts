// 起動時の作業ツリーの診断（.npmrc の registry と mise.toml の go の版）。
// ワーカーには英語の短い文で、クライアントには task_result の warnings（固定コード）と usage（検証したホスト名だけ）で伝える。
// リポジトリの中身は非信頼データ。固定コードと、ホスト名として検証できた値のほかは外へ出さない（_authToken などの行は読まない）。

import { decideOutbound } from "./outbound-policy";

export const NPMRC_REGISTRY_NOT_ALLOWED = "npmrc_registry_not_allowed";
export const MISE_GO_VERSION_UNAVAILABLE = "mise_go_version_unavailable";
export const MISE_TOOL_UNAVAILABLE = "mise_tool_unavailable";
/** task_result の warnings に付けうる固定コードの全部（AgentDO はこれ以外を捨てる） */
export const REPO_DIAG_WARNINGS: readonly string[] = [
  NPMRC_REGISTRY_NOT_ALLOWED,
  MISE_GO_VERSION_UNAVAILABLE,
  MISE_TOOL_UNAVAILABLE,
];
export type RepoDiagWarning =
  | typeof NPMRC_REGISTRY_NOT_ALLOWED
  | typeof MISE_GO_VERSION_UNAVAILABLE
  | typeof MISE_TOOL_UNAVAILABLE;

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

/** TOML のキー 1 つ分（裸 / "..." / '...'）の先頭を読む。読めなければ undefined */
function tomlKey(text: string): { key: string; rest: string } | undefined {
  const m = /^\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([A-Za-z0-9_-]+))(?=\s*(?:$|=|\.))/.exec(text);
  if (!m) return undefined;
  return { key: m[1] ?? m[2] ?? m[3] ?? "", rest: text.slice(m[0].length).trimStart() };
}

/**
 * mise.toml の [tools] のエントリ（key と、値の文字列）を宣言順に返す。小さな TOML の部分集合だけを読む
 * （1 行の key = value、トップレベルの tools.key = value、[tools.key] の節。複数行の値は読まない）。
 * [tools.key] の節は、値を version = ... の行から読む。
 */
function miseToolEntries(toml: string): { key: string; value: string }[] {
  const out: { key: string; value: string }[] = [];
  let section = "";
  let sub: { key: string; value: string } | undefined;
  for (const raw of toml.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    if (line.startsWith("[[")) {
      section = "\0array";
      sub = undefined;
      continue;
    }
    const head = /^\[\s*([^\]]+?)\s*\]\s*(?:#.*)?$/.exec(line);
    if (head) {
      const h = head[1] ?? "";
      sub = undefined;
      if (/^["']?tools["']?\s*$/.test(h)) {
        section = "tools";
      } else {
        const m = /^["']?tools["']?\s*\.\s*(.+)$/.exec(h);
        const k = m ? tomlKey(m[1] ?? "") : undefined;
        if (k && k.rest.trim() === "") {
          section = "\0tool";
          sub = { key: k.key, value: "" };
          out.push(sub);
        } else {
          section = h
            .split(".")
            .map((p) => p.trim().replace(/^["']|["']$/g, ""))
            .join(".");
        }
      }
      continue;
    }
    if (sub && section === "\0tool") {
      const v = /^(?:version|"version"|'version')\s*=\s*(.+)$/.exec(line);
      if (v && sub.value === "") sub.value = (v[1] ?? "").trim();
      continue;
    }
    if (section === "tools") {
      const k = tomlKey(line);
      const eq = k ? /^=\s*(.+)$/.exec(k.rest) : null;
      if (k && eq) out.push({ key: k.key, value: eq[1] ?? "" });
    } else if (section === "") {
      const m = /^["']?tools["']?\s*\.\s*(.+)$/.exec(line);
      const k = m ? tomlKey(m[1] ?? "") : undefined;
      const eq = k ? /^=\s*(.+)$/.exec(k.rest) : null;
      if (k && eq) out.push({ key: k.key, value: eq[1] ?? "" });
    }
  }
  return out;
}

/**
 * mise.toml の [tools] の go の版。無ければ undefined。
 */
export function miseGoVersion(toml: string): string | undefined {
  for (const e of miseToolEntries(toml)) {
    if (e.key === "go") return toolVersion(e.value);
  }
  return undefined;
}

/** Sandbox の mise で用意できるとみなす [tools] のキー（go の版違いは mise_go_version_unavailable の担当） */
const MISE_AVAILABLE_TOOLS: readonly string[] = ["node", "nodejs", "go", "golang", "python"];
/** backend 付きで、許可先（npm・PyPI・proxy.golang.org）から取れうる接頭辞 */
const MISE_AVAILABLE_PREFIXES: readonly string[] = ["npm:", "pipx:", "go:"];
/** ワーカーへの文・usage に載せてよいツール名の形 */
export const MISE_TOOL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,63}$/;
/** ツール名を書く件数の上限（文・usage.mise_unavailable_tools） */
export const MISE_TOOLS_MAX = 5;

export function isSafeMiseToolName(v: unknown): v is string {
  return typeof v === "string" && MISE_TOOL_NAME_RE.test(v);
}

/** 検証した（安全な形の）ツール名だけを、重複を除いて max 件まで残す */
export function sanitizeMiseToolNames(v: unknown, max = MISE_TOOLS_MAX): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const n of v) {
    if (out.length >= max) break;
    if (isSafeMiseToolName(n) && !out.includes(n)) out.push(n);
  }
  return out;
}

/**
 * mise.toml の [tools] のうち、Sandbox の mise で用意できないもの。
 * tools: 安全な名前の形に合うものだけ（宣言順・重複なし・最大 5 件）。total: 用意できないものの数（名前が不正なものも含む）。
 */
export function miseUnavailableTools(toml: string): { tools: string[]; total: number } {
  const seen: string[] = [];
  for (const { key } of miseToolEntries(toml)) {
    if (MISE_AVAILABLE_TOOLS.includes(key)) continue;
    if (MISE_AVAILABLE_PREFIXES.some((p) => key.startsWith(p))) continue;
    if (!seen.includes(key)) seen.push(key);
  }
  return { tools: sanitizeMiseToolNames(seen), total: seen.length };
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
  /** task_result の warnings に付ける固定コード（.npmrc → mise の go の版 → mise のツールの順。各 1 回） */
  warnings: RepoDiagWarning[];
  /** usage.npmrc_registry_hosts（検証したホスト名。最大 5 件） */
  npmrcRegistryHosts: string[];
  /** usage.mise_unavailable_tools（mise で用意できないツール名。安全な形のものだけ。最大 5 件） */
  miseUnavailableTools: string[];
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
  let miseTools: string[] = [];
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
    const unavailable = miseUnavailableTools(input.miseToml);
    if (unavailable.total > 0) {
      warnings.push(MISE_TOOL_UNAVAILABLE);
      miseTools = unavailable.tools;
      const hidden = unavailable.total - miseTools.length;
      const which =
        miseTools.length === 0
          ? `${hidden} tool${hidden === 1 ? "" : "s"} (names not shown)`
          : hidden > 0
            ? `${miseTools.join(", ")}, and ${hidden} more`
            : miseTools.join(", ");
      notes.push(
        `mise.toml lists tools that mise cannot install in this sandbox: ${which}. \`mise install\` / \`mise run\` / \`mise exec\` will try to fetch them and fail. Check each with \`command -v <tool>\`: if it is on PATH (pnpm, yarn and uv are), call it directly without mise. If it is not, do not try to download it (outbound network access is denied); write in your summary that the verification needing it was not run.`,
      );
    }
  }
  return {
    warnings,
    npmrcRegistryHosts: hosts,
    miseUnavailableTools: miseTools,
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
