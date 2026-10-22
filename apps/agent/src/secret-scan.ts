import { findBlockingSecrets, maskSecrets } from "@rovo/audit";
import type { ExecResult } from "./sandbox-port";

/** 検査する差分（numstat・diff それぞれ）の出力の上限。超えたら検査しきれないものとして扱う（4MiB） */
export const SECRET_SCAN_MAX_BYTES = 4 * 1024 * 1024;

/** 空の木（git の定数）。基準になる SHA が分からないとき、全体を検査するために使う */
export const EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

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
  /** 秘密らしきものがある。push モードでは category・path・line（新しいファイルでの行番号）が付く */
  | { status: "secret"; category?: string; path?: string; line?: number }
  /** 中身を検査できないバイナリ（push: 鍵らしい拡張子のもの / strict: 全部） */
  | { status: "binary"; path?: string }
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

/** numstat の行のパス（クォートされていれば外す） */
function numstatPath(line: string): string {
  const path = line.split("\t").slice(2).join("\t");
  return path.length >= 2 && path.startsWith('"') && path.endsWith('"') ? path.slice(1, -1) : path;
}

/** `+++ b/<path>` / `diff --git a/<x> b/<path>` のパス */
function headerPath(raw: string): string | undefined {
  let p = raw.replace(/\t.*$/, "");
  if (p.length >= 2 && p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1);
  if (p === "/dev/null") return undefined;
  return p.replace(/^[ab]\//, "");
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

/** 止めたときの固定の文（onPush の error になる）。一致した値は含めない */
export function blockedMessage(v: Exclude<ScanVerdict, { status: "clean" | "aborted" }>): string {
  switch (v.status) {
    case "secret": {
      const where = v.path ? ` in ${v.path}${v.line ? `:${v.line}` : ""}` : "";
      return `blocked: possible secret (${v.category ?? "unknown"})${where}`;
    }
    case "binary":
      return `blocked: possible secret (key file)${v.path ? ` in ${v.path}` : ""}`;
    case "unscannable":
      return v.reason === "too_large"
        ? "blocked: the diff is too large to scan for secrets"
        : "blocked: could not scan the diff for secrets";
  }
}
