import { posix } from "node:path";

const DEFAULT_ROOT = "/workspace";
const SIMPLE_PATH = /^[A-Za-z0-9_./-]+$/;
const LEADING_CD = /^\s*cd\s+('[^']*'|"[^"]*"|[^\s;&|'"]+)\s*(;|&&)\s*([\s\S]*)$/;

/** root 基準の相対パス（"." 含む）に直す。ルートの外なら undefined。 */
function toRelative(root: string, abs: string): string | undefined {
  const n = posix.normalize(abs);
  if (n !== root && !n.startsWith(`${root}/`)) return undefined;
  return posix.relative(root, n) || ".";
}

/**
 * コマンドの先頭の `cd <素朴なパス>` + `;` / `&&` を cwd に移す（連続も繰り返し外す）。
 * 展開・特殊文字を含むもの、ルートの外に出るもの、残りが空のもの、`||` `|` などは変換しない。
 * 返す cwd はルート基準の相対パス。変換しなければ入力のまま。
 */
export function splitLeadingCd(
  command: string,
  cwd?: string,
  root: string = DEFAULT_ROOT,
): { command: string; cwd: string | undefined } {
  let cmd = command;
  let cur = cwd;
  for (;;) {
    const m = LEADING_CD.exec(cmd);
    if (!m) break;
    let p = m[1] as string;
    const rest = m[3] as string;
    if (p.length >= 2 && (p[0] === "'" || p[0] === '"') && p.endsWith(p[0])) p = p.slice(1, -1);
    if (!SIMPLE_PATH.test(p) || p.startsWith("-")) break;
    if (rest.trim() === "" || /^[;&|]/.test(rest.trimStart())) break;
    let base = root;
    if (cur !== undefined) {
      const b = toRelative(root, cur.startsWith("/") ? cur : posix.join(root, cur));
      if (b === undefined) break;
      base = posix.join(root, b);
    }
    const next = toRelative(root, p.startsWith("/") ? p : posix.join(base, p));
    if (next === undefined) break;
    cmd = rest.trim();
    cur = next;
  }
  return cur === cwd && cmd === command ? { command, cwd } : { command: cmd, cwd: cur };
}

/** tool_start の要約用: bash の引数だけ、同じ変換をかけた command / cwd にする。 */
export function normalizeBashArgs(name: string, args: unknown, root?: string): unknown {
  if (name !== "bash" || typeof args !== "object" || args === null) return args;
  const a = args as { command?: unknown; cwd?: unknown };
  if (typeof a.command !== "string") return args;
  const cwd = typeof a.cwd === "string" ? a.cwd : undefined;
  const r = splitLeadingCd(a.command, cwd, root);
  return { ...a, command: r.command, ...(r.cwd !== undefined ? { cwd: r.cwd } : {}) };
}
