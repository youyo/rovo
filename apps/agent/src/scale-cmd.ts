/**
 * Clef の判断の記録（usage.sandbox_scale_log）の cmd: コマンドの先頭の語だけを短く残す。argv の全体・コマンド文字列は残さない。
 *
 * 子の bash ツールは `bash -c "<コマンド>"` の形で exec するので、argv[0] の basename では常に `bash` になる。
 * `bash -c` / `sh -c`（`-lc` `-ec` などの束ねた形も）のときは、コマンド文字列の先頭の語を使う。先頭の語を探すとき、次を単純な規則で読み飛ばす:
 * - 環境変数の代入（`FOO=1`。値が引用符で空白を含んでも 1 語として扱う）
 * - `cd <dir> &&` / `cd <dir> ;`（`;` `&&` `||` の区切りの後ろ）
 * - 前置きの `env` `timeout` `time` `nice` `nohup` `exec` `command`（とその引数）
 * 読み取れなければ argv[0] の basename に戻す。シェルの展開・入れ子・here-doc は解釈しない（先頭の語が取れなければ戻すだけ）。
 * 返す値は gateway の sanitize（英数字と `._+-`）を通る形で、最大 SCALE_CMD_CHARS 文字。
 */

/** 判断の記録の cmd の最大の文字数 */
export const SCALE_CMD_CHARS = 24;
/** コマンド文字列のうち、先頭の語を探すために読む最大の文字数（長い文字列を全部は走査しない） */
const SCAN_CHARS = 2000;

const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ash", "ksh"]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;
const SEPARATORS = new Set(["&&", "||", ";", "|", "&"]);
const DURATION = /^\d+(?:\.\d+)?[smhd]?$/;

const basename = (s: string): string => s.slice(s.lastIndexOf("/") + 1);

/** 公開の sanitize（英数字と ._+-）に通る形にして切る */
function clean(word: string): string {
  return basename(word)
    .replace(/[^A-Za-z0-9._+-]/g, "")
    .slice(0, SCALE_CMD_CHARS);
}

/** 引用符の外の空白で区切る。`;` `&&` `||` `|` `&` は単独の語にする。語は引用符つきの元の形のまま返す */
function tokenize(script: string): string[] {
  const tokens: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  const flush = () => {
    if (cur !== "") tokens.push(cur);
    cur = "";
  };
  const s = script.slice(0, SCAN_CHARS);
  for (let i = 0; i < s.length; i++) {
    const ch = s.charAt(i);
    if (quote !== null) {
      cur += ch;
      if (ch === "\\" && quote === '"' && i + 1 < s.length) cur += s.charAt(++i);
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "\\" && i + 1 < s.length) {
      cur += ch + s.charAt(++i);
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
    } else if (/\s/.test(ch)) {
      flush();
    } else if (ch === ";" || ch === "&" || ch === "|") {
      flush();
      let sep = ch;
      if ((ch === "&" || ch === "|") && s.charAt(i + 1) === ch) sep = s.slice(i, ++i + 1);
      tokens.push(sep);
    } else {
      cur += ch;
    }
  }
  flush();
  return tokens;
}

/** 前置きの語（`timeout 600 cmd` の `timeout 600` など）の後ろの引数を何個読み飛ばすか。i は前置きの語の次の位置。戻り値は次の位置 */
function skipWrapper(name: string, t: readonly string[], i: number): number {
  let j = i;
  if (name === "env") {
    // env [-i] [-u NAME] [VAR=val]...
    while (j < t.length) {
      const w = t[j] ?? "";
      if (w === "-u" || w === "-C" || w === "-S") j += 2;
      else if (w.startsWith("-") || ASSIGNMENT.test(w)) j += 1;
      else break;
    }
    return j;
  }
  if (name === "timeout") {
    while ((t[j] ?? "").startsWith("-")) j += t[j] === "-k" || t[j] === "-s" ? 2 : 1;
    if (DURATION.test(t[j] ?? "")) j += 1;
    return j;
  }
  if (name === "nice") {
    while ((t[j] ?? "").startsWith("-")) j += t[j] === "-n" ? 2 : 1;
    return j;
  }
  // time / nohup / exec / command: 続く -オプションだけ
  while ((t[j] ?? "").startsWith("-")) j += 1;
  return j;
}

const WRAPPERS = new Set(["env", "timeout", "time", "nice", "nohup", "exec", "command"]);

/** コマンド文字列の先頭の語（読み飛ばしたあと）。取れなければ null */
function leadingWord(script: string): string | null {
  const t = tokenize(script);
  let i = 0;
  while (i < t.length) {
    const w = t[i] ?? "";
    if (SEPARATORS.has(w) || w === "(" || w === "{") {
      i += 1;
    } else if (ASSIGNMENT.test(w)) {
      i += 1;
    } else if (w === "cd" || w === "pushd") {
      // cd <dir> [区切り]。区切りの後ろから続ける。区切りが無ければ cd 自体が先頭の語
      let j = i + 1;
      while (j < t.length && !SEPARATORS.has(t[j] ?? "")) j += 1;
      if (j >= t.length) return w;
      i = j;
    } else if (WRAPPERS.has(w)) {
      i = skipWrapper(w, t, i + 1);
    } else {
      // 先頭の括弧・引用符は外す（`(make)` `"pnpm"`）
      const bare = w.replace(/^[({"'`$]+/, "");
      return bare === "" ? null : bare;
    }
  }
  return null;
}

/** `bash -c` の形のとき、コマンド文字列を返す。そうでなければ null */
function shellScript(argv: readonly string[]): string | null {
  if (!SHELLS.has(basename(argv[0] ?? ""))) return null;
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (!a.startsWith("-") || a === "--") return null;
    // -c / -lc / -ec など、短いオプションの束に c を含むもの
    if (!a.startsWith("--") && a.includes("c")) return argv[i + 1] ?? null;
  }
  return null;
}

/** 判断の記録の cmd。`bash -c "<コマンド>"` ならそのコマンドの先頭の語、そうでなければ argv[0] の basename */
export function scaleCmd(argv: readonly string[]): string {
  const script = shellScript(argv);
  if (script !== null) {
    const word = leadingWord(script);
    const c = word !== null ? clean(word) : "";
    if (c !== "") return c;
  }
  return clean(argv[0] ?? "");
}
