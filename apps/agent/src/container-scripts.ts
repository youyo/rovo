/**
 * コンテナ内で走らせる bash スクリプト（argv: mode [baseline...]）。
 * 判定にコンテナ内のファイル（pidfile など）は使わない。/proc を走査し、次の 2 つ以外を対象にする。
 *   - 基準プロセス（起動直後に記録した "pid:starttime" の集合。PID 1 など）
 *   - このスクリプト自身とその祖先
 * mode:
 *   list: 基準にするプロセスの一覧を "pid:starttime" で標準出力へ
 *   kill: 対象をすべて SIGKILL し、残っていないことを確かめて "clean" を出力（終了コード 0）。止まらなければ "stuck"（1）
 */
export const PROCESS_SCRIPT = `
mode=$1; shift
baseline=" $* "
anc=" "
p=$$
while [ -n "$p" ] && [ "$p" != 0 ]; do
  anc="$anc$p "
  l=
  read -r l < /proc/$p/stat 2>/dev/null || break
  set -- \${l##*) }
  p=$2
done
scan() {
  # $1=list|kill。kill では対象があれば 1 を返す
  found=0
  for d in /proc/[0-9]*; do
    pid=\${d#/proc/}
    case "$anc" in *" $pid "*) continue;; esac
    l=
    read -r l < $d/stat 2>/dev/null || continue
    set -- \${l##*) }
    [ "$1" = Z ] && continue
    id="$pid:\${20}"
    if [ "$mode" = list ]; then echo "$id"; continue; fi
    case "$baseline" in *" $id "*) continue;; esac
    kill -KILL "$pid" 2>/dev/null
    found=1
  done
  return $found
}
if [ "$mode" = list ]; then scan; exit 0; fi
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
