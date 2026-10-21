/**
 * コンテナ内で走らせる bash スクリプト（argv: mode [baseline...]）。
 * 判定にコンテナ内のファイル（pidfile など）は使わない。/proc を走査し、次の 2 つ以外を対象にする。
 *   - 基準プロセス（起動直後に記録した "pid:starttime" の集合。PID 1 など）
 *   - このスクリプト自身とその祖先
 * これは正常に終わったコマンドの後の「ベストエフォートの片付け」であり、停止の保証ではない
 * （コンテナ内の処理は root で動き、偽装できる。保証が要る場面は container.destroy() で止める）。
 *
 * /proc/<pid>/stat は全体を読み、最後の ") " より後ろを厳密に解析する（comm には改行や ") " を入れられる）。
 * 解析できない・欠けているプロセスは「止める対象」として扱う（fail-closed）。
 *
 * mode:
 *   list: 基準にするプロセスの一覧を "pid:starttime" で標準出力へ。解析できないものがあれば失敗（終了コード 1）
 *   kill: 対象をすべて SIGKILL し、残っていないことを確かめて "clean" を出力（終了コード 0）。止まらなければ "stuck"（1）
 */
export const PROCESS_SCRIPT = `
mode=$1; shift
baseline=" $* "
# $1=/proc/<pid>/stat を厳密に解析して state / ppid / start を設定する。
# 戻り値 0: 解析できた / 1: 解析できない・不完全 / 2: 読めない（プロセスが消えた）
readstat() {
  l=
  { IFS= read -r -d '' l; } 2>/dev/null < "$1"
  [ -n "$l" ] || return 2
  rest=\${l##*) }
  [ "$rest" != "$l" ] || return 1
  set -f; set -- $rest; set +f
  [ $# -ge 20 ] || return 1
  state=$1; ppid=$2; start=\${20}
  case "$state" in [A-Za-z]) ;; *) return 1;; esac
  case "$ppid" in ""|*[!0-9]*) return 1;; esac
  case "$start" in ""|*[!0-9]*) return 1;; esac
  return 0
}
anc=" "
p=$$
while [ -n "$p" ] && [ "$p" != 0 ]; do
  anc="$anc$p "
  readstat /proc/$p/stat || break
  p=$ppid
done
bad=
scan() {
  # kill では対象があれば 1 を返す
  found=0
  for d in /proc/[0-9]*; do
    pid=\${d#/proc/}
    case "$anc" in *" $pid "*) continue;; esac
    readstat $d/stat
    rc=$?
    [ $rc = 2 ] && continue
    if [ $rc = 0 ]; then
      [ "$state" = Z ] && continue
      id="$pid:$start"
    else
      if [ "$mode" = list ]; then bad=1; continue; fi
      id="$pid:?"
    fi
    if [ "$mode" = list ]; then echo "$id"; continue; fi
    case "$baseline" in *" $id "*) continue;; esac
    kill -KILL "$pid" 2>/dev/null
    found=1
  done
  return $found
}
if [ "$mode" = list ]; then
  scan
  [ -z "$bad" ] || { echo "unparsable process" >&2; exit 1; }
  exit 0
fi
n=0
while [ $n -lt 200 ]; do
  scan
  if [ $? = 0 ]; then echo clean; exit 0; fi
  n=$((n+1))
  sleep 0.05
done
echo stuck
exit 1
`;

/**
 * 作業ツリーの状態の指紋（Sandbox の昇格の前後で、作業ツリーがそのまま残っていることを比べる）。
 * HEAD の commit、未 commit の変更（追跡ファイルの差分）、追跡されていないファイルの名前一覧と中身をそれぞれハッシュにして出力する。
 * 出力が同じなら、昇格の前後で作業ツリーは同じ。ファイルの中身は出さない（ハッシュだけ）。
 * 追跡されていないファイルは gitignore 済み（node_modules・ビルド成果物）を除く。名前は NUL 区切りで扱うので、空白・非 ASCII・改行があっても壊れない。0 個でも成功する。
 * 引数: $1=作業ツリー。git や sha256sum が失敗したら（HEAD が無い・読めないファイルがあるなど）失敗する（呼び出し側は昇格を見送る）。argv は `bash -c <script> rovo-promote-state <作業ツリー>`。
 */
export const PROMOTE_STATE_SCRIPT = `
set -e
set -o pipefail
cd "$1"
git rev-parse HEAD
git status --porcelain --untracked-files=normal | sha256sum
git diff HEAD | sha256sum
git ls-files -z --others --exclude-standard | xargs -0 -r sha256sum | sha256sum
`;

/**
 * Sandbox の昇格の判断（Clef。docs/specs/design.md）に渡す「リポジトリの事実」を集める node のスクリプト（`node -e <script> <cwd> [最大文字数]`）。
 * コマンドの cwd と、その上の git のルート（.git のあるディレクトリ）から、決まったファイル（package.json・テストランナーの設定・Makefile・
 * Cargo や Gradle や Bazel の設定など）を生のテキストのまま読んで、標準出力へ出す。ロックファイルなどの有無も 1 行で出す。
 *
 * これは事実の収集だけで、判断はしない（どのファイルが大事か・重いかは Clef が決める。ファイルの一覧は「何を読むか」で、
 * 「何が重いか」の規則ではない）。リポジトリの中身は非信頼のデータで、Clef の質問の側には混ぜず state にだけ入れる。
 * 読むのは通常のファイルだけ（シンボリックリンクは辿らない）。package.json は packageManager / workspaces / scripts だけにする。
 * 1 ファイル 1,500 文字、全体は引数（既定 6,000 文字）までに切り詰める。失敗しても終了コードは 0（事実が無いだけ）。
 */
export const SCALE_FACTS_SCRIPT = `
const fs = require("fs");
const path = require("path");
const start = path.resolve(process.argv[1] || "/workspace");
const limit = Number(process.argv[2]) > 0 ? Number(process.argv[2]) : 6000;
const PER_FILE = 1500;
const FILES = [
  "package.json", "pnpm-workspace.yaml", "lerna.json", "turbo.json", "nx.json",
  "vitest.config.ts", "vitest.config.mts", "vitest.config.cts", "vitest.config.js", "vitest.config.mjs", "vitest.config.cjs",
  "vitest.workspace.ts", "vitest.workspace.js", "vitest.workspace.json",
  "jest.config.js", "jest.config.ts", "jest.config.cjs", "jest.config.mjs", "jest.config.json",
  "playwright.config.ts", "playwright.config.js", "playwright.config.mjs",
  ".mocharc.json", ".mocharc.js", ".mocharc.cjs", ".mocharc.yml", ".mocharc.yaml",
  "cypress.config.ts", "cypress.config.js",
  "pyproject.toml", "pytest.ini", "setup.cfg", "tox.ini",
  "Cargo.toml", ".cargo/config.toml", ".cargo/config",
  "Makefile", "makefile", "GNUmakefile", "justfile",
  "gradle.properties", ".bazelrc",
];
const PRESENT = [
  "pnpm-lock.yaml", "yarn.lock", "package-lock.json", "bun.lockb", "bun.lock", "uv.lock", "poetry.lock", "Pipfile.lock",
  "Cargo.lock", "go.mod", "go.sum", "Gemfile.lock", "composer.lock", "gradlew", "mvnw", "pom.xml", "build.gradle",
  "build.gradle.kts", "WORKSPACE", "MODULE.bazel",
];
const isFile = (p) => { try { return fs.lstatSync(p).isFile(); } catch (e) { return false; } };
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch (e) { return false; } };
const head = (p, n) => {
  const fd = fs.openSync(p, "r");
  try {
    const b = Buffer.alloc(n);
    const k = fs.readSync(fd, b, 0, n, 0);
    return b.toString("utf8", 0, k);
  } finally {
    fs.closeSync(fd);
  }
};
let root;
let up = start;
for (let i = 0; i < 8; i++) {
  if (fs.existsSync(path.join(up, ".git"))) { root = up; break; }
  const parent = path.dirname(up);
  if (parent === up) break;
  up = parent;
}
const dirs = [];
if (isDir(start)) dirs.push(start);
if (root !== undefined && !dirs.includes(root)) dirs.push(root);
const base = root !== undefined ? root : start;
let out = "";
const share = Math.floor(limit / Math.max(dirs.length, 1));
for (const dir of dirs) {
  const label = path.relative(base, dir) || ".";
  let part = "# " + label + ": files present: ";
  const present = PRESENT.filter((f) => isFile(path.join(dir, f)));
  part += (present.length > 0 ? present.join(", ") : "(none)") + "\\n";
  for (const f of FILES) {
    const p = path.join(dir, f);
    if (!isFile(p)) continue;
    let text;
    try {
      text = head(p, 8192);
      if (f === "package.json") {
        try {
          const j = JSON.parse(text.length >= 8192 ? "" : text);
          const pick = {};
          for (const k of ["packageManager", "workspaces", "scripts"]) if (j[k] !== undefined) pick[k] = j[k];
          text = JSON.stringify(pick, null, 1);
        } catch (e) {
          // 壊れている・大きすぎる: 先頭を生のまま渡す
        }
      }
    } catch (e) {
      continue;
    }
    part += "## " + (label === "." ? "" : label + "/") + f + "\\n" + text.slice(0, PER_FILE) + "\\n";
  }
  out += part.slice(0, share);
}
process.stdout.write(out.slice(0, limit));
`;
