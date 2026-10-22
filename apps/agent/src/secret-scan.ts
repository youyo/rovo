import { findBlockingSecrets, maskSecrets } from "@rovo/audit";
import type { ExecResult } from "./sandbox-port";

/** 検査する差分（numstat・diff それぞれ）の出力の上限。超えたら検査しきれないものとして扱う（4MiB） */
export const SECRET_SCAN_MAX_BYTES = 4 * 1024 * 1024;

/** 鍵らしい拡張子。バイナリは中身を検査できないので、push のモードではこれだけを止める */
const KEY_FILE_EXTENSIONS = [
  ".pem",
  ".key",
  ".p12",
  ".pfx",
  ".jks",
  ".keystore",
  ".der",
  ".p8",
  ".ppk",
];

/**
 * 検査の厳しさ。
 * - push: push 直前の範囲の検査。止めるのは確度の高いパターン（findBlockingSecrets）と、鍵らしい拡張子のバイナリだけ
 * - strict: 予算切れの WIP の commit 前。maskSecrets で変わるものは何でも止め、バイナリは 1 つでもあれば止める
 */
export type ScanMode = "push" | "strict";

/** 検査の結果。値（一致した文字列）は決して含めない */
export type ScanVerdict =
  | { status: "clean" }
  /**
   * 秘密らしきものがある。push モードでは category・path・line（その commit での新しいファイルの行番号）が付く。
   * commit は、見つかった commit の SHA（commit ごとの検査のとき）
   */
  | { status: "secret"; category?: string; path?: string; line?: number; commit?: string }
  /** 中身を検査できないバイナリ（push: 鍵らしい拡張子のもの / strict: 全部）。commit は見つかった commit の SHA */
  | { status: "binary"; path?: string; commit?: string }
  /** 差分が大きすぎる・git が失敗した・時間切れ。検査していないので、安全側で止める */
  | { status: "unscannable"; reason: "too_large" | "git_failed" }
  /** shouldAbort が立ったので、途中でやめた */
  | { status: "aborted" };

export type ScanGit = (
  argv: string[],
  timeoutMs: number,
  maxOutputBytes: number,
) => Promise<ExecResult>;

const okRun = (r: ExecResult) => r.exitCode === 0 && !r.timedOut;

function isKeyFile(path: string): boolean {
  const p = path.toLowerCase();
  return KEY_FILE_EXTENSIONS.some((ext) => p.endsWith(ext));
}

/** git の C 形式のクォート（"..."）を外す。\ooo の 8 進は UTF-8 のバイト列として読む。クォートされていなければそのまま */
function unquotePath(raw: string): string {
  if (raw.length < 2 || !raw.startsWith('"') || !raw.endsWith('"')) return raw;
  const inner = raw.slice(1, -1);
  const simple: Record<string, number> = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11 };
  const enc = new TextEncoder();
  const bytes: number[] = [];
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i] as string;
    if (c !== "\\") {
      bytes.push(...enc.encode(c));
      continue;
    }
    const n = inner[i + 1] ?? "";
    const oct = /^[0-7]{3}/.exec(inner.slice(i + 1, i + 4))?.[0];
    if (oct) {
      bytes.push(Number.parseInt(oct, 8) & 0xff);
      i += 3;
    } else if (n in simple) {
      bytes.push(simple[n] as number);
      i += 1;
    } else {
      bytes.push(...enc.encode(n));
      i += 1;
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/** numstat の行のパス（クォートされていれば外す） */
function numstatPath(line: string): string {
  return unquotePath(line.split("\t").slice(2).join("\t"));
}

/** `+++ b/<path>` / `diff --git a/<x> b/<path>` のパス */
function headerPath(raw: string): string | undefined {
  const path = unquotePath(raw.startsWith('"') ? raw : raw.replace(/\t.*$/, ""));
  if (path === "/dev/null") return undefined;
  return path.replace(/^[ab]\//, "");
}

interface AddedLine {
  text: string;
  path: string;
  /** 新しいファイルでの行番号。hunk の外（想定外の形）では 0 */
  line: number;
}

/** unified diff から、追加行（"+" の行。ヘッダの "+++" は除く）だけを取り出す。hunk の行数で、内容が "++" で始まる行とヘッダを区別する */
function addedLines(diff: string): AddedLine[] {
  const out: AddedLine[] = [];
  let path = "";
  let oldLeft = 0;
  let newLeft = 0;
  let newLine = 0;
  for (const line of diff.split("\n")) {
    if (oldLeft > 0 || newLeft > 0) {
      const c = line[0];
      if (c === "+") {
        out.push({ text: line.slice(1), path, line: newLine });
        newLine += 1;
        newLeft -= 1;
        continue;
      }
      if (c === "-") {
        oldLeft -= 1;
        continue;
      }
      if (c === " " || line === "") {
        oldLeft -= 1;
        newLeft -= 1;
        newLine += 1;
        continue;
      }
      if (c === "\\") continue; // "\ No newline at end of file"
      // 行数が合わない（想定外）。hunk を閉じてヘッダとして読み直す
      oldLeft = 0;
      newLeft = 0;
    }
    if (line.startsWith("diff --git ")) {
      const m = /^diff --git (?:"?a\/.*?"?) ("?b\/.*"?)$/.exec(line);
      path = (m?.[1] && headerPath(m[1])) || path;
    } else if (line.startsWith("+++ ")) {
      path = headerPath(line.slice(4)) ?? path;
    } else if (line.startsWith("@@")) {
      const m = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (m) {
        oldLeft = m[1] === undefined ? 1 : Number(m[1]);
        newLeft = m[3] === undefined ? 1 : Number(m[3]);
        newLine = Number(m[2]);
      }
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      // hunk の外の追加行（想定外の形）も見逃さない。行番号は分からない
      out.push({ text: line.slice(1), path, line: 0 });
    }
  }
  return out;
}

/**
 * 差分を取り、numstat・バイナリ・大きさ・パターンで判定する（git_commit の push 前と、WIP の commit 前が共有する）。
 * diffArgs は `git diff` に渡す範囲の引数（例: ["<last_pushed>..HEAD"] / ["--cached"]）。
 * 検査そのものの失敗（git の失敗・時間切れ・例外・出力が上限超え）は unscannable を返す（呼び出し側は安全側で止める）。
 */
export async function scanRangeForSecrets(
  git: ScanGit,
  diffArgs: string[],
  mode: ScanMode,
  opts: { shouldAbort?: () => boolean } = {},
): Promise<ScanVerdict> {
  try {
    const common = ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames"];
    const numstat = await git(
      [...common, "--numstat", ...diffArgs, "--"],
      60_000,
      SECRET_SCAN_MAX_BYTES,
    );
    if (!okRun(numstat)) return { status: "unscannable", reason: "git_failed" };
    if (numstat.truncated === true) return { status: "unscannable", reason: "too_large" };
    const binaries = numstat.stdout
      .split("\n")
      .filter((l) => l.startsWith("-\t-\t"))
      .map(numstatPath);
    const blocking = mode === "strict" ? binaries[0] : binaries.find(isKeyFile);
    if (blocking !== undefined) return { status: "binary", path: blocking };
    if (opts.shouldAbort?.()) return { status: "aborted" };

    const diff = await git([...common, ...diffArgs, "--"], 120_000, SECRET_SCAN_MAX_BYTES);
    if (!okRun(diff)) return { status: "unscannable", reason: "git_failed" };
    if (diff.truncated === true) return { status: "unscannable", reason: "too_large" };

    if (mode === "strict") {
      return maskSecrets(diff.stdout) !== diff.stdout ? { status: "secret" } : { status: "clean" };
    }
    const added = addedLines(diff.stdout);
    const found = findBlockingSecrets(added.map((a) => a.text).join("\n"))[0];
    if (!found) return { status: "clean" };
    const at = added[found.line - 1];
    return { status: "secret", category: found.category, path: at?.path, line: at?.line };
  } catch {
    return { status: "unscannable", reason: "git_failed" };
  }
}

const SHA_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
/** log の出力で commit の区切りにする（先頭が制御文字の行。diff の行は " "・"+"・"-"・英字で始まるので、内容と混ざらない） */
const COMMIT_MARK = "\u0001";

/** `git log --format=%x01%H ...` の出力を commit ごとの本文に分ける（merge commit は親ごとに同じ SHA で複数出る） */
function splitByCommit(out: string): { commit: string; body: string }[] {
  const sections: { commit: string; lines: string[] }[] = [];
  for (const line of out.split("\n")) {
    if (line.startsWith(COMMIT_MARK)) {
      sections.push({ commit: line.slice(1).trim(), lines: [] });
    } else {
      sections.at(-1)?.lines.push(line);
    }
  }
  return sections.map((x) => ({ commit: x.commit, body: x.lines.join("\n") }));
}

/**
 * これから push で送る commit（head から辿れて、lastPushed から辿れないもの = `git rev-list head --not lastPushed`）を
 * commit ごとに検査する。2 つの木の差分（`lastPushed..head` の diff）では、途中の commit で足して後の commit で消した秘密が
 * 見えないが、push はリモートに無い commit をすべて送るので、途中の commit の秘密も公開される。ここは各 commit の追加行を見る。
 * - lastPushed が head の祖先でない（reset・rebase で履歴を書き換えた）ときも、リモートに無い commit だけが対象になる
 * - lastPushed が無いとき（初回）は、head から辿れる全部の commit（ルートを含む）
 * - merge commit は各親との差分（-m）を見る
 * - 判定は push のモード: 止めるのは確度の高いパターン（findBlockingSecrets）と、鍵らしい拡張子のバイナリだけ。
 *   出力の上限（4MiB）は全 commit の合計。上限超え・git の失敗・例外は unscannable
 * path・line は、その commit での新しいファイルの値。
 */
export async function scanUnpushedForSecrets(
  git: ScanGit,
  head: string,
  lastPushed: string | undefined,
  opts: { shouldAbort?: () => boolean } = {},
): Promise<ScanVerdict> {
  try {
    if (!(head === "HEAD" || SHA_RE.test(head)))
      return { status: "unscannable", reason: "git_failed" };
    if (lastPushed !== undefined && !SHA_RE.test(lastPushed))
      return { status: "unscannable", reason: "git_failed" };
    const common = [
      "-c",
      "core.quotepath=false",
      "log",
      "-m",
      "--reverse",
      "--no-color",
      "--no-ext-diff",
      "--no-textconv",
      "--no-renames",
      "--no-show-signature",
      "--format=%x01%H",
    ];
    const revs = lastPushed === undefined ? [head] : [head, "--not", lastPushed];
    const numstat = await git(
      [...common, "--numstat", ...revs, "--"],
      60_000,
      SECRET_SCAN_MAX_BYTES,
    );
    if (!okRun(numstat)) return { status: "unscannable", reason: "git_failed" };
    if (numstat.truncated === true) return { status: "unscannable", reason: "too_large" };
    for (const sec of splitByCommit(numstat.stdout)) {
      const key = sec.body
        .split("\n")
        .filter((l) => l.startsWith("-\t-\t"))
        .map(numstatPath)
        .find(isKeyFile);
      if (key !== undefined) return { status: "binary", path: key, commit: sec.commit };
    }
    if (opts.shouldAbort?.()) return { status: "aborted" };

    const diff = await git([...common, "-p", ...revs, "--"], 120_000, SECRET_SCAN_MAX_BYTES);
    if (!okRun(diff)) return { status: "unscannable", reason: "git_failed" };
    if (diff.truncated === true) return { status: "unscannable", reason: "too_large" };
    for (const sec of splitByCommit(diff.stdout)) {
      const added = addedLines(sec.body);
      const found = findBlockingSecrets(added.map((a) => a.text).join("\n"))[0];
      if (!found) continue;
      const at = added[found.line - 1];
      return {
        status: "secret",
        category: found.category,
        path: at?.path,
        line: at?.line,
        commit: sec.commit,
      };
    }
    return { status: "clean" };
  } catch {
    return { status: "unscannable", reason: "git_failed" };
  }
}

/** 止めたときの固定の文（onPush の error になる）。一致した値は含めない。パスにトークンが入っていても出ないよう、パスも maskSecrets を通す */
export function blockedMessage(v: Exclude<ScanVerdict, { status: "clean" | "aborted" }>): string {
  const at = v.status !== "unscannable" && v.commit ? ` (commit ${v.commit.slice(0, 7)})` : "";
  switch (v.status) {
    case "secret": {
      const where = v.path ? ` in ${maskSecrets(v.path)}${v.line ? `:${v.line}` : ""}` : "";
      return `blocked: possible secret (${v.category ?? "unknown"})${where}${at}`;
    }
    case "binary":
      return `blocked: possible secret (key file)${v.path ? ` in ${maskSecrets(v.path)}` : ""}${at}`;
    case "unscannable":
      return v.reason === "too_large"
        ? "blocked: the diff is too large to scan for secrets"
        : "blocked: could not scan the diff for secrets";
  }
}
