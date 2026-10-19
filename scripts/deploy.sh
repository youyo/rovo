#!/usr/bin/env bash
# 下流の wrangler 設定（ROVO_DEPLOY_DIR）で Worker をデプロイする。mise の deploy:* から呼ばれる。
#   使い方: scripts/deploy.sh <web|agent|gateway|all|secrets>
#   ROVO_DEPLOY_DIR/{gateway,agent,web}.wrangler.jsonc を使う（相対パスは実行したディレクトリから）。
# upstream の apps/*/wrangler.jsonc には本番の値が無いので、誤ってデプロイしないよう、
#   ROVO_DEPLOY_DIR が未設定・設定ファイルが無い・設定に <...> のプレースホルダが残っているときは何もせずに失敗する。必ず wrangler ... -c <下流の設定> の形で呼ぶ。
# secret の値はこのスクリプトを通さない（wrangler secret put が対話で受け取る。引数・env・ログに載せない）。
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
die() { echo "エラー: $*" >&2; exit 1; }

target="${1:-}"
case "$target" in
  web | agent | gateway | all | secrets) ;;
  *) die "対象は web / agent / gateway / all / secrets のどれか（指定: '${target}'）" ;;
esac

dir="${ROVO_DEPLOY_DIR:-}"
[ -n "$dir" ] || die "ROVO_DEPLOY_DIR が未設定。下流の wrangler 設定のディレクトリを指定する（docs/deploy.md の 4。雛形は deploy.example/）"
[ -d "$dir" ] || die "ROVO_DEPLOY_DIR がディレクトリではない: $dir"
dir="$(cd "$dir" && pwd)"

cfg() { echo "$dir/$1.wrangler.jsonc"; }

# 使う設定がすべてあることを、何かを実行する前に確かめる（半端なデプロイをしない）
require() {
  local missing=0 n
  for n in "$@"; do
    if [ ! -f "$(cfg "$n")" ]; then
      echo "エラー: 設定ファイルが無い: $(cfg "$n")" >&2
      missing=1
    fi
  done
  [ "$missing" -eq 0 ] || exit 1

  # upstream の apps/*/wrangler.jsonc（シンボリックリンク・ハードリンクを含む）は、本番の値が無いので使わない
  local same=0 a
  for n in "$@"; do
    for a in gateway agent web; do
      if [ "$(cfg "$n")" -ef "$root/apps/$a/wrangler.jsonc" ]; then
        echo "エラー: upstream の設定は使えない: $(cfg "$n") -> apps/$a/wrangler.jsonc" >&2
        same=1
      fi
    done
  done
  [ "$same" -eq 0 ] || exit 1

  # 雛形の <...> のプレースホルダが残っていないことを確かめる（コメント行は対象外）
  local bad=0 hits
  for n in "$@"; do
    hits="$(awk '{ t = $0; sub(/^[ \t]+/, "", t) } t !~ /^\/\// && $0 ~ /<[A-Za-z_][A-Za-z0-9_]*>/ { print FILENAME ":" FNR ": " $0 }' "$(cfg "$n")")"
    if [ -n "$hits" ]; then
      echo "エラー: プレースホルダ（<...>）が残っている:" >&2
      echo "$hits" >&2
      bad=1
    fi
  done
  [ "$bad" -eq 0 ] || exit 1
}

deploy_one() { # deploy_one <web|agent|gateway>
  echo "==> $1 をデプロイする（設定: $(cfg "$1")）"
  (cd "$root/apps/$1" && pnpm exec wrangler deploy -c "$(cfg "$1")")
}

put_secret() { # put_secret <app> <NAME>
  echo "==> $1 の secret $2 を入れる（値は対話で入力する）"
  (cd "$root/apps/$1" && pnpm exec wrangler secret put "$2" -c "$(cfg "$1")")
}

case "$target" in
  web | agent | gateway)
    require "$target"
    deploy_one "$target"
    ;;
  all)
    # 参照される側が先: web → agent → gateway
    require web agent gateway
    deploy_one web
    deploy_one agent
    deploy_one gateway
    ;;
  secrets)
    require gateway agent
    put_secret gateway GITHUB_APP_CLIENT_SECRET
    put_secret gateway GITHUB_APP_PRIVATE_KEY
    put_secret gateway TOKEN_ENC_KEY
    put_secret agent TOKEN_ENC_KEY
    ;;
esac
