/**
 * Clef の判断の記録（usage.sandbox_scale_log）の cmd: コマンドの先頭の語だけを短く残す。argv の全体・コマンド文字列は残さない。
 *
 * 子の bash ツールは `bash -c "<コマンド>"` の形で exec するので、argv[0] の basename では常に `bash` になる。
 * `bash -c` / `sh -c`（`-lc` `-ec` などの束ねた形も）のときは、コマンド文字列の最初の単純コマンドの先頭の語を使う。探すとき、次を単純な規則で読み飛ばす:
 * - 環境変数の代入（`FOO=1`。値が引用符・`$(...)`・`` `...` `` で空白を含んでも 1 語として扱う）
 * - `cd <dir> &&` / `cd <dir> ;`
 * - 前置きの `env` `timeout` `time` `nice` `nohup` `exec` `command`（想定の形の引数だけ。合わなければ諦める）
 *
 * **迷ったら argv[0] の basename（bash）に戻す**（秘密の断片を残さないため）。戻すのは次のとき:
 * 引用符・`$(`・`` ` `` が閉じない / 代入だけ・区切りの後ろ（改行・`;`）に先頭の語が無い / 前置きの引数が想定の形でない /
 * 採った語がコマンド名らしくない（`^[A-Za-z_][A-Za-z0-9._+-]{0,23}$` に合わない。リダイレクト・展開・`=` を含む語を含む）/
 * 秘密らしい形（maskSecrets が変える・ghp_ や sk- などの接頭辞）。
 * シェルの展開・here-doc は解釈しない。返す値は gateway の sanitize（英数字と `._+-`）を通る形で、最大 SCALE_CMD_CHARS 文字。
 */
import { maskSecrets } from "./redact";

/** 判断の記録の cmd の最大の文字数 */
export const SCALE_CMD_CHARS = 24;
/** コマンド文字列のうち、先頭の語を探すために読む最大の文字数（長い文字列を全部は走査しない） */
const SCAN_CHARS = 2000;

const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ash", "ksh"]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SEPARATORS = new Set(["&&", "||", ";", "|", "&"]);
const DURATION = /^\d+(?:\.\d+)?[smhd]?$/;
const WRAPPERS = new Set(["env", "timeout", "time", "nice", "nohup", "exec", "command"]);
/** 秘密に使われる接頭辞（maskSecrets が拾わない短い形でも、コマンド名としては採らない） */
const SECRET_PREFIX =
  /^(?:ghp|gho|ghs|ghu|ghr|github_pat|sk|pk|rk|AKIA|ASIA|xox[a-z]|glpat|npm|eyJ)[-_A-Z]/i;
/** コマンド名らしい形。`-` や数字で始まらず、24 文字まで */
const COMMAND_NAME = /^[A-Za-z_][A-Za-z0-9._+-]{0,23}$/;
const FAIL = Symbol("fail");

const basename = (s: string): string => s.slice(s.lastIndexOf("/") + 1);

/** argv[0] の basename を、公開の sanitize（英数字と ._+-）に通る形にして切る */
function clean(word: string): string {
  return basename(word)
    .replace(/[^A-Za-z0-9._+-]/g, "")
    .slice(0, SCALE_CMD_CHARS);
}

/** `$(` の次の位置 from から、対応する `)` の位置を返す（入れ子・引用符を数える）。閉じなければ -1 */
function matchParen(s: string, from: number): number {
  let depth = 1;
  let quote: string | null = null;
  for (let i = from; i < s.length; i++) {
    const ch = s.charAt(i);
    if (quote !== null) {
      if (ch === "\\" && quote === '"') i++;
      else if (ch === quote) quote = null;
    } else if (ch === "\\") {
      i++;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "(") {
      depth++;
    } else if (ch === ")" && --depth === 0) {
      return i;
    }
  }
  return -1;
}

/**
 * 引用符の外の空白で区切る。`;` `&&` `||` `|` `&` と改行は区切りの語にする。語は引用符つきの元の形のまま返す。
 * `$(...)` と `` `...` `` は閉じるまでを 1 語に含める。閉じない引用符・置換は読めないので null。
 */
function tokenize(script: string): string[] | null {
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
    } else if (ch === "$" && s.charAt(i + 1) === "(") {
      const end = matchParen(s, i + 2);
      if (end < 0) return null;
      cur += s.slice(i, end + 1);
      i = end;
    } else if (ch === "`") {
      const end = s.indexOf("`", i + 1);
      if (end < 0) return null;
      cur += s.slice(i, end + 1);
      i = end;
    } else if (ch === "\n") {
      flush();
      tokens.push(";");
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
  if (quote !== null) return null;
  flush();
  return tokens;
}

/**
 * 前置きの語（`timeout 600 cmd` の `timeout 600` など）の後ろの引数を読み飛ばし、次の位置を返す。i は前置きの語の次の位置。
 * 想定した形（timeout の期間、nice の数、env の代入など）に合わなければ FAIL（ほかの語を先頭の語として採らない）。
 */
function skipWrapper(name: string, t: readonly string[], i: number): number | typeof FAIL {
  let j = i;
  const at = (k: number) => t[k] ?? "";
  if (name === "env") {
    // env [-i] [-u NAME] [VAR=val]...
    for (;;) {
      const w = at(j);
      if (w === "-i" || w === "-") j += 1;
      else if (w === "-u" && NAME.test(at(j + 1))) j += 2;
      else if (ASSIGNMENT.test(w)) j += 1;
      else if (w.startsWith("-")) return FAIL;
      else return j;
    }
  }
  if (name === "timeout") {
    for (;;) {
      const w = at(j);
      if ((w === "-k" || w === "-s") && DURATION.test(at(j + 1))) j += 2;
      else if (w === "--foreground" || w === "--preserve-status" || w === "-v") j += 1;
      else if (w.startsWith("-")) return FAIL;
      else break;
    }
    return DURATION.test(at(j)) ? j + 1 : FAIL;
  }
  if (name === "nice") {
    if (at(j) === "-n") return /^-?\d+$/.test(at(j + 1)) ? j + 2 : FAIL;
    if (/^-\d+$/.test(at(j))) return j + 1;
    return at(j).startsWith("-") ? FAIL : j;
  }
  if (name === "time") return at(j) === "-p" ? j + 1 : at(j).startsWith("-") ? FAIL : j;
  // nohup / exec / command: オプションは取らない
  return at(j).startsWith("-") ? FAIL : j;
}

/** 先頭の語として採ってよい形か（採れなければ null）。パスは basename にする。リダイレクト・展開・代入・秘密らしい形は不可 */
function acceptWord(raw: string): string | null {
  let w = raw;
  // `$(echo sk-abc) x` の形: 置換の中の先頭の語だけ
  if (w.startsWith("$(") && w.endsWith(")")) return leadingWord(w.slice(2, -1));
  if (w.length > 1 && w.startsWith("`") && w.endsWith("`")) return leadingWord(w.slice(1, -1));
  // 全体が引用符で囲まれた語（`"pnpm"`）は外す
  const q = w.charAt(0);
  if (w.length >= 2 && (q === '"' || q === "'") && w.endsWith(q)) w = w.slice(1, -1);
  if (/[<>&|;(){}$`=*?\\\s"'!~#]/.test(w)) return null;
  const base = basename(w);
  if (!COMMAND_NAME.test(base) || SECRET_PREFIX.test(base) || maskSecrets(base) !== base) {
    return null;
  }
  return base;
}

/** コマンド文字列の最初の単純コマンドの先頭の語（読み飛ばしたあと）。確実に取れなければ null */
function leadingWord(script: string): string | null {
  const t = tokenize(script);
  if (t === null) return null;
  let i = 0;
  while (i < t.length) {
    const w = t[i] ?? "";
    // 空のコマンド・代入だけのコマンドの後ろの別のコマンドは採らない
    if (SEPARATORS.has(w)) return null;
    if (ASSIGNMENT.test(w)) {
      i += 1;
    } else if (w === "cd" || w === "pushd") {
      // cd <dir> のあとの区切りの後ろから続ける。区切りが無ければ cd 自体が先頭の語
      let j = i + 1;
      while (j < t.length && !SEPARATORS.has(t[j] ?? "")) j += 1;
      if (j >= t.length) return "cd";
      while (SEPARATORS.has(t[j] ?? "")) j += 1;
      i = j;
    } else if (WRAPPERS.has(w)) {
      const next = skipWrapper(w, t, i + 1);
      if (next === FAIL) return null;
      i = next;
    } else {
      return acceptWord(w);
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

/** 判断の記録の cmd。`bash -c "<コマンド>"` なら先頭の語（確実に読めたときだけ）、そうでなければ・迷ったら argv[0] の basename */
export function scaleCmd(argv: readonly string[]): string {
  const script = shellScript(argv);
  if (script !== null) {
    const word = leadingWord(script);
    if (word !== null) return word;
  }
  return clean(argv[0] ?? "");
}
