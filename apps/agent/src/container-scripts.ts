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
 * HEAD の commit、未 commit の変更（追跡ファイルの差分と、追跡されていないファイル）をそれぞれハッシュにして出力する。
 * 出力が同じなら、昇格の前後で作業ツリーは同じ。ファイルの中身は出さない（ハッシュだけ）。
 * 引数: $1=作業ツリー。git が失敗したら（HEAD が無いなど）失敗する。argv は `bash -c <script> rovo-promote-state <作業ツリー>`。
 */
export const PROMOTE_STATE_SCRIPT = `
set -e
set -o pipefail
cd "$1"
git rev-parse HEAD
git status --porcelain --untracked-files=normal | sha256sum
git diff HEAD | sha256sum
`;
