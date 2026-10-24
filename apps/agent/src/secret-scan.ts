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
 * 検査の git の呼び出しの共通の前置き。ワーカーが .git/config・replace の ref・属性で、出力の形や中身を変えられないようにする。
 * - --no-replace-objects: `git replace` で秘密の commit を無害な commit に見せかけられない（replace の ref は push されない）
 * - core.quotepath / diff.noprefix / diff.mnemonicPrefix / diff.relative / color.ui: パースが前提にする形に固定する
 */
const GIT_SAFE = [
  "--no-replace-objects",
  "-c",
  "core.quotepath=false",
  "-c",
  "diff.noprefix=false",
  "-c",
  "diff.mnemonicPrefix=false",
  "-c",
  "diff.relative=false",
  "-c",
  "color.ui=false",
  "-c",
  "log.showSignature=false",
];
/** diff・log の出力の形を固定する引数。--text は、-diff・binary の属性（.gitattributes・.git/info/attributes）や NUL があっても中身を行として出す */
const DIFF_SHAPE = [
  "--no-color",
  "--no-ext-diff",
  "--no-textconv",
  "--no-renames",
  "--src-prefix=a/",
  "--dst-prefix=b/",
];

/**
 * --text で本文として出たファイルのうち、鍵らしい拡張子で NUL バイトを含むもの（バイナリ）。numstat は属性で本文扱いにされると
 * バイナリと判定しないため、追加行の NUL でも見る。
 */
function binaryKeyInAdded(added: AddedLine[]): AddedLine | undefined {
  return added.find((a) => isKeyFile(a.path) && a.text.includes("\u0000"));
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
    const common = [...GIT_SAFE, "diff", ...DIFF_SHAPE];
    // numstat は --text を付けない（バイナリを "-\t-" で見分けるため）
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

    const diff = await git(
      [...common, "--text", ...diffArgs, "--"],
      120_000,
      SECRET_SCAN_MAX_BYTES,
    );
    if (!okRun(diff)) return { status: "unscannable", reason: "git_failed" };
    if (diff.truncated === true) return { status: "unscannable", reason: "too_large" };

    if (mode === "strict") {
      return maskSecrets(diff.stdout) !== diff.stdout ? { status: "secret" } : { status: "clean" };
    }
    const added = addedLines(diff.stdout);
    const keyBin = binaryKeyInAdded(added);
    if (keyBin) return { status: "binary", path: keyBin.path };
    const found = findBlockingSecrets(added.map((a) => a.text).join("\n"))[0];
    if (!found) return { status: "clean" };
    const at = added[found.line - 1];
    return { status: "secret", category: found.category, path: at?.path, line: at?.line };
  } catch {
    return { status: "unscannable", reason: "git_failed" };
  }
}

/** git の rev に渡してよい SHA（16 進だけ。先頭が "-" のオプションにはならない） */
const SHA_RE = /^[0-9a-f]{4,64}$/;
/** log の出力で commit の区切りにする（先頭が制御文字の行。diff の行は " "・"+"・"-"・英字で始まるので、内容と混ざらない） */
const COMMIT_MARK = "\u0001";

/** `git log --format=%x01%H %P ...` の出力を commit ごとの本文に分ける（merge commit は親ごとに同じ SHA で複数出る。parent はその本文が何番目の親との差分か） */
function splitByCommit(
  out: string,
): { commit: string; parent: string | undefined; parentCount: number; body: string }[] {
  const sections: {
    commit: string;
    parent: string | undefined;
    parentCount: number;
    lines: string[];
  }[] = [];
  const seen = new Map<string, number>();
  for (const line of out.split("\n")) {
    if (line.startsWith(COMMIT_MARK)) {
      const [commit = "", ...parents] = line.slice(1).trim().split(" ");
      const n = seen.get(commit) ?? 0;
      seen.set(commit, n + 1);
      sections.push({ commit, parent: parents[n], parentCount: parents.length, lines: [] });
    } else {
      sections.at(-1)?.lines.push(line);
    }
  }
  return sections.map((x) => ({
    commit: x.commit,
    parent: x.parent,
    parentCount: x.parentCount,
    body: x.lines.join("\n"),
  }));
}

/**
 * merge commit の「各親との差分」のうち、検査に使うものを選ぶ。
 * 親の 1 つが検査の対象外（リモートに実在する = 公開済み）なら、その親との差分だけを見る。
 * 他の親との差分には、公開済みの側の変更が丸ごと「追加行」として出る（main を merge したときの main 側の変更）ので、誤検知のもとになる。
 * merge の中だけにある変更（evil merge）は、どの親との差分にも出るので、公開済みの親との差分でも見つかる。
 * 親がどちらも対象（まだ送っていない）のとき・対象の集合が分からないときは、全部の親との差分を見る。
 */
function selectSections<
  T extends { parent: string | undefined; parentCount: number; commit: string },
>(sections: T[], unpushed: Set<string> | undefined): T[] {
  if (!unpushed) return sections;
  const publicOf = new Map<string, boolean>();
  for (const sec of sections) {
    if (sec.parentCount > 1 && sec.parent !== undefined && !unpushed.has(sec.parent))
      publicOf.set(sec.commit, true);
  }
  return sections.filter(
    (sec) =>
      sec.parentCount <= 1 ||
      !publicOf.get(sec.commit) ||
      (sec.parent !== undefined && !unpushed.has(sec.parent)),
  );
}

/** ls-remote から読む ref の数の上限。超えた分は除外に使わない（除外が減るだけで、素通りは増えない） */
const MAX_REMOTE_REFS = 2000;
const FULL_SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * リモートに実在する commit の SHA（検査から外してよい、すでに公開済みのもの）を返す。
 * `git ls-remote --heads --tags <url>` の答え（GitHub のもので、ワーカーは偽造できない）のうち、ローカルに commit として存在するもの。
 * url は rovo が知っているリポジトリの URL（clone と同じ https://github.com/<owner>/<name>.git）で、設定の origin は使わない
 * （ワーカーが remote.origin.url・url.<base>.insteadOf を書き換えて、偽のリモートの答えを返させられるため）。
 * `-C /` でリポジトリの外から呼び、リポジトリの .git/config（insteadOf など）を読まない。認証は clone・push と同じ（外向き通信の傍受）。
 * ローカルのリモート追跡の参照（refs/remotes/*）も、ワーカーが update-ref で偽造できるので使わない。
 * baseSha は、その ls-remote の SHA のどれかから辿れる（祖先）ときだけ足す。
 * ls-remote が失敗・時間切れ・出力が上限超えなら、空（= last_pushed だけで判定。誤検知は増えても素通りはしない）。
 */
async function remoteKnownShas(
  git: ScanGit,
  remote: { url: string; baseSha?: string },
): Promise<string[]> {
  if (remote.url === "" || remote.url.startsWith("-")) return [];
  try {
    const ls = await git(
      ["-C", "/", "ls-remote", "--heads", "--tags", remote.url],
      60_000,
      1024 * 1024,
    );
    if (!okRun(ls) || ls.truncated === true) return [];
    const candidates = new Set<string>();
    for (const line of ls.stdout.split("\n")) {
      if (candidates.size >= MAX_REMOTE_REFS) break;
      const sha = line.split("\t")[0] ?? "";
      if (FULL_SHA_RE.test(sha)) candidates.add(sha);
    }
    if (candidates.size === 0) return [];
    // ローカルに無い SHA（リモートだけにある commit）は --ignore-missing で落とす。タグは commit に剥がれ、commit 以外は出ない
    const exist = await git(
      ["--no-replace-objects", "rev-list", "--no-walk", "--ignore-missing", ...candidates, "--"],
      60_000,
      SECRET_SCAN_MAX_BYTES,
    );
    if (!okRun(exist) || exist.truncated === true) return [];
    const known = exist.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => FULL_SHA_RE.test(l));
    if (known.length > 0 && remote.baseSha !== undefined && FULL_SHA_RE.test(remote.baseSha)) {
      // baseSha から辿れる commit が、known から辿れるものだけなら（出力が空）祖先。ローカルに無ければ失敗して足さない
      const anc = await git(
        [
          "--no-replace-objects",
          "rev-list",
          "--max-count=1",
          remote.baseSha,
          "--not",
          ...known,
          "--",
        ],
        60_000,
        SECRET_SCAN_MAX_BYTES,
      );
      if (okRun(anc) && anc.truncated !== true && anc.stdout.trim() === "")
        known.push(remote.baseSha);
    }
    return known;
  } catch {
    return [];
  }
}

/**
 * これから push で送る commit（head から辿れて、lastPushed から辿れないもの = `git rev-list head --not lastPushed`）を
 * commit ごとに検査する。2 つの木の差分（`lastPushed..head` の diff）では、途中の commit で足して後の commit で消した秘密が
 * 見えないが、push はリモートに無い commit をすべて送るので、途中の commit の秘密も公開される。ここは各 commit の追加行を見る。
 * - lastPushed が head の祖先でない（reset・rebase で履歴を書き換えた）ときも、リモートに無い commit だけが対象になる
 * - lastPushed が無いとき（初回）は、head から辿れる全部の commit（ルートを含む）
 * - merge commit は各親との差分（-m）を見る
 * - remote を渡したとき、リモートに実在する SHA（その url への ls-remote の heads・tags と、その祖先の baseSha）から辿れる commit も除く。
 *   作業ブランチに origin/main を merge・rebase したとき、main 側の公開済みの commit で誤って止まらないため。失敗したら lastPushed だけ
 * - 判定は push のモード: 止めるのは確度の高いパターン（findBlockingSecrets）と、鍵らしい拡張子のバイナリだけ。
 *   出力の上限（4MiB）は全 commit の合計。上限超え・git の失敗・例外は unscannable
 * path・line は、その commit での新しいファイルの値。
 */
export async function scanUnpushedForSecrets(
  git: ScanGit,
  head: string,
  lastPushed: string | undefined,
  opts: { shouldAbort?: () => boolean; remote?: { url: string; baseSha?: string } } = {},
): Promise<ScanVerdict> {
  try {
    if (!(head === "HEAD" || SHA_RE.test(head)))
      return { status: "unscannable", reason: "git_failed" };
    if (lastPushed !== undefined && !SHA_RE.test(lastPushed))
      return { status: "unscannable", reason: "git_failed" };
    const common = [
      ...GIT_SAFE,
      "log",
      "-m",
      "--reverse",
      ...DIFF_SHAPE,
      "--no-show-signature",
      "--format=%x01%H %P",
    ];
    const known = opts.remote ? await remoteKnownShas(git, opts.remote) : [];
    const nots = [...(lastPushed === undefined ? [] : [lastPushed]), ...known];
    const revs = nots.length === 0 ? [head] : [head, "--not", ...nots];
    const numstat = await git(
      [...common, "--numstat", ...revs, "--"],
      60_000,
      SECRET_SCAN_MAX_BYTES,
    );
    if (!okRun(numstat)) return { status: "unscannable", reason: "git_failed" };
    if (numstat.truncated === true) return { status: "unscannable", reason: "too_large" };
    // merge commit の親との差分の選び方に使う、送る commit の集合。取れなければ全部の親との差分を見る（安全側）
    let unpushed: Set<string> | undefined;
    const hasMerge = numstat.stdout
      .split("\n")
      .some((l) => l.startsWith(COMMIT_MARK) && l.split(" ").length > 2);
    if (hasMerge) {
      const list = await git(
        [...GIT_SAFE, "rev-list", ...revs, "--"],
        60_000,
        SECRET_SCAN_MAX_BYTES,
      );
      if (okRun(list) && list.truncated !== true)
        unpushed = new Set(list.stdout.split("\n").filter((l) => l !== ""));
    }
    for (const sec of selectSections(splitByCommit(numstat.stdout), unpushed)) {
      const key = sec.body
        .split("\n")
        .filter((l) => l.startsWith("-\t-\t"))
        .map(numstatPath)
        .find(isKeyFile);
      if (key !== undefined) return { status: "binary", path: key, commit: sec.commit };
    }
    if (opts.shouldAbort?.()) return { status: "aborted" };

    const diff = await git(
      [...common, "-p", "--text", ...revs, "--"],
      120_000,
      SECRET_SCAN_MAX_BYTES,
    );
    if (!okRun(diff)) return { status: "unscannable", reason: "git_failed" };
    if (diff.truncated === true) return { status: "unscannable", reason: "too_large" };
    for (const sec of selectSections(splitByCommit(diff.stdout), unpushed)) {
      const added = addedLines(sec.body);
      const keyBin = binaryKeyInAdded(added);
      if (keyBin) return { status: "binary", path: keyBin.path, commit: sec.commit };
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

/** spec の repository（owner/name）から、clone と同じ URL を作る。形が違えば undefined（その場合 ls-remote は使わず last_pushed だけで判定する） */
export function repositoryCloneUrl(repository: string | undefined): string | undefined {
  if (repository === undefined || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository))
    return undefined;
  return `https://github.com/${repository}.git`;
}

/** scanUnpushedForSecrets の remote 引数を作る。repository の形が不正なら undefined（ls-remote を使わない） */
export function remoteFor(
  repository: string | undefined,
  baseSha: string | undefined,
): { url: string; baseSha?: string } | undefined {
  const url = repositoryCloneUrl(repository);
  return url === undefined ? undefined : { url, baseSha };
}
