/**
 * レビューのモデルに渡す差分の整形（docs/specs/worker-review.md「レビューのモデルへの入力」）。純粋な関数だけ。
 * unified diff（`git diff` / GitHub の diff の形）をファイルごとに分け、上限（既定 200 KB）に収まるよう、
 * 大きいファイルから hunk を切り詰める。lockfile・生成物・バイナリ・画像は本文を省き、ファイル名と増減の行数だけにする。
 */

/** 差分全体の上限（UTF-8 のバイト数） */
export const REVIEW_DIFF_MAX_BYTES = 200 * 1024;

export interface DiffFile {
  /** 変更後のパス（削除されたファイルは変更前のパス） */
  path: string;
  /** このファイルの差分の全文（`diff --git` の行から次のファイルの手前まで） */
  text: string;
  added: number;
  removed: number;
  binary: boolean;
}

export type OmitReason = "lockfile" | "generated" | "binary";

export interface FittedDiff {
  /** モデルに渡す差分（上限以下） */
  text: string;
  /** 差分に現れるすべてのパス（省いた・切り詰めたファイルも含む。指摘のパスの照合に使う） */
  paths: string[];
  /** hunk を切り詰めたファイル */
  truncated: string[];
  /** 本文を省いたファイル（名前と増減の行数だけ） */
  omitted: { path: string; added: number; removed: number; why: OmitReason }[];
}

const encoder = new TextEncoder();
const byteLength = (s: string) => encoder.encode(s).length;

/** `diff --git a/X b/Y` の X / Y。引用符つきのパス（"a/..."）も読む */
function headerPaths(line: string): { a: string; b: string } | undefined {
  const quoted = /^diff --git "a\/(.*)" "b\/(.*)"$/.exec(line);
  if (quoted) return { a: quoted[1] as string, b: quoted[2] as string };
  const m = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
  return m ? { a: m[1] as string, b: m[2] as string } : undefined;
}

/** unified diff をファイルごとに分ける。`diff --git` で始まらない前置き（あれば）は捨てる */
export function parseDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  const lines = diff.split(/(?<=\n)/);
  let cur: { header: { a: string; b: string }; buf: string[] } | undefined;
  const flush = () => {
    if (!cur) return;
    const text = cur.buf.join("");
    let added = 0;
    let removed = 0;
    let binary = false;
    let deleted = false;
    let inHunk = false;
    for (const raw of cur.buf) {
      const l = raw.replace(/\n$/, "");
      if (l.startsWith("@@")) {
        inHunk = true;
        continue;
      }
      if (!inHunk) {
        if (/^Binary files .* differ$/.test(l) || l === "GIT binary patch") binary = true;
        if (l === "+++ /dev/null" || l.startsWith("deleted file mode")) deleted = true;
        continue;
      }
      if (l.startsWith("+")) added++;
      else if (l.startsWith("-")) removed++;
    }
    files.push({
      path: deleted ? cur.header.a : cur.header.b,
      text,
      added,
      removed,
      binary,
    });
  };
  for (const line of lines) {
    const header = line.startsWith("diff --git ")
      ? headerPaths(line.replace(/\n$/, ""))
      : undefined;
    if (header) {
      flush();
      cur = { header, buf: [line] };
    } else if (cur) cur.buf.push(line);
  }
  flush();
  return files;
}

const LOCKFILES = new Set([
  "pnpm-lock.yaml",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "bun.lockb",
  "bun.lock",
  "Cargo.lock",
  "go.sum",
  "poetry.lock",
  "uv.lock",
  "Pipfile.lock",
  "Gemfile.lock",
  "composer.lock",
  "mix.lock",
  "flake.lock",
]);
const GENERATED_RE = /(?:\.min\.(?:js|css)|\.map|\.snap)$/i;
const BINARY_RE =
  /\.(?:png|jpe?g|gif|webp|bmp|ico|tiff?|avif|heic|pdf|zip|gz|tgz|bz2|xz|7z|jar|wasm|woff2?|ttf|otf|eot|mp3|mp4|mov|webm|wav|ogg|exe|dll|so|dylib|bin)$/i;

/** 本文を省くファイルか（lockfile・生成物・バイナリ・画像）。省かないなら undefined */
export function omittedReason(path: string, binary = false): OmitReason | undefined {
  const name = path.split("/").at(-1) ?? path;
  if (LOCKFILES.has(name)) return "lockfile";
  if (binary || BINARY_RE.test(name)) return "binary";
  if (GENERATED_RE.test(name)) return "generated";
  return undefined;
}

/** ファイルの差分を、ヘッダ（最初の @@ の手前）と hunk に分ける */
function splitHunks(text: string): { head: string; hunks: string[] } {
  const parts = text.split(/(?=^@@ )/m);
  const [head, ...hunks] = parts;
  return { head: head ?? "", hunks };
}

const truncationNote = (n: number) =>
  `[... ${n} more hunk(s) of this file were truncated by rovo to fit the review limit ...]\n`;

/** 1 ファイルの差分を、maxBytes 以下になるよう後ろの hunk から切る。切ったら truncated が true */
function clipFile(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (byteLength(text) <= maxBytes) return { text, truncated: false };
  const { head, hunks } = splitHunks(text);
  let out = head;
  let kept = 0;
  for (const h of hunks) {
    const note = truncationNote(hunks.length - kept - 1);
    if (byteLength(out) + byteLength(h) + byteLength(note) > maxBytes) break;
    out += h;
    kept++;
  }
  const note = truncationNote(hunks.length - kept);
  if (byteLength(out) + byteLength(note) <= maxBytes) return { text: out + note, truncated: true };
  // ヘッダと注記だけでも入らない（極端に小さい上限）: バイト単位で切る（文字の途中では切らない）
  return { text: clipBytes(`${out}${note}`, maxBytes), truncated: true };
}

/** UTF-8 で maxBytes 以下になるよう先頭から残す（文字の途中では切らない） */
function clipBytes(text: string, maxBytes: number): string {
  const b = encoder.encode(text);
  if (b.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && ((b[end] ?? 0) & 0xc0) === 0x80) end--;
  return new TextDecoder().decode(b.subarray(0, end));
}

const omittedLine = (o: FittedDiff["omitted"][number]) =>
  `diff --git a/${o.path} b/${o.path}\n[content omitted by rovo (${o.why}): +${o.added} -${o.removed} lines]\n`;

/**
 * 差分を上限に収める。省く対象のファイルは 1 行の要約にし、残りが上限を超えるときは、ファイルごとの上限 c を
 * 「Σ min(大きさ, c) ≤ 残り」になる最大の値に決めて（大きいファイルから削られる）、c を超えるファイルの hunk を後ろから切る。
 */
export function fitDiff(files: DiffFile[], maxBytes = REVIEW_DIFF_MAX_BYTES): FittedDiff {
  const omitted: FittedDiff["omitted"] = [];
  const kept: DiffFile[] = [];
  for (const f of files) {
    const why = omittedReason(f.path, f.binary);
    if (why) omitted.push({ path: f.path, added: f.added, removed: f.removed, why });
    else kept.push(f);
  }
  const summaryText = omitted.map(omittedLine).join("");
  const budget = Math.max(0, maxBytes - byteLength(summaryText));
  const sizes = kept.map((f) => byteLength(f.text));
  const total = sizes.reduce((a, b) => a + b, 0);
  let cap = Number.POSITIVE_INFINITY;
  if (total > budget) {
    // 水位の計算: 小さい順に、残りを等分しても入るものは丸ごと入れ、入らないものの上限を決める
    const sorted = [...sizes].sort((a, b) => a - b);
    let rest = budget;
    for (let i = 0; i < sorted.length; i++) {
      const share = Math.floor(rest / (sorted.length - i));
      const size = sorted[i] as number;
      if (size <= share) {
        rest -= size;
        continue;
      }
      cap = share;
      break;
    }
  }
  const truncated: string[] = [];
  const parts = kept.map((f, i) => {
    if ((sizes[i] as number) <= cap) return f.text;
    const c = clipFile(f.text, cap);
    if (c.truncated) truncated.push(f.path);
    return c.text;
  });
  let text = parts.join("") + summaryText;
  if (byteLength(text) > maxBytes) text = clipBytes(text, maxBytes);
  return { text, paths: files.map((f) => f.path), truncated, omitted };
}
