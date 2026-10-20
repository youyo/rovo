#!/usr/bin/env bash
# 下流の wrangler 設定（ROVO_DEPLOY_DIR）で Worker をデプロイする。mise の deploy:* から呼ばれる。
#   使い方: scripts/deploy.sh <web|agent|gateway|all>   （gateway のデプロイの前に、ダッシュボード〔apps/dashboard〕をビルドする）
#           scripts/deploy.sh secrets [--pem <GitHub App の .pem>] [--skip-github-app] [--rotate <名前>]...
#   ROVO_DEPLOY_DIR/{gateway,agent,web}.wrangler.jsonc を使う（相対パスは実行したディレクトリから）。
# upstream の apps/*/wrangler.jsonc には本番の値が無いので、誤ってデプロイしないよう、
#   ROVO_DEPLOY_DIR が未設定・設定ファイルが無い・設定に <...> のプレースホルダが残っているときは何もせずに失敗する。必ず wrangler ... -c <下流の設定> の形で呼ぶ。
# secrets: 入っていない secret だけを入れる（既定。TOKEN_ENC_KEY を変えると全員が再ログインになるため、既存の secret は上書きしない）。
#   GITHUB_APP_CLIENT_SECRET   wrangler の対話（隠した入力）。人が入力するのはこれだけ
#   GITHUB_APP_PRIVATE_KEY     --pem（または env ROVO_GITHUB_APP_PEM）の .pem を openssl で PKCS#8 に変換して標準入力で渡す
#   CLOUDFLARE_API_TOKEN       terraform output -raw gateway_cloudflare_api_token を標準入力で渡す（Terraform の資格情報が要る）
#   TOKEN_ENC_KEY（gateway と agent）  openssl rand -base64 32 を別々に作って標準入力で渡す
#   入れ直すときは --rotate <client-secret|private-key|cloudflare-token|gateway-enc-key|agent-enc-key|all>。
#   値は引数・env・ログに載せない（標準入力のパイプだけ）。1 つでも事前の確認に失敗したら、何も put しない。
# secrets --github-app-stdin: mise run github-app（GitHub App の manifest フロー）が使う入口。標準入力から JSON
#   {"clientSecret": "...", "privateKey": "<GitHub が返した pem>"} を 1 つ受け取り、gateway の GITHUB_APP_CLIENT_SECRET と
#   GITHUB_APP_PRIVATE_KEY（pem は openssl pkcs8 で PKCS#8 に変換。標準入力から読むのでファイルにしない）だけを、入っていても入れ直す
#   （新しい App の資格情報なので）。secret list・terraform・ほかの secret には触れない。--pem / --rotate / --skip-github-app とは併用できない。
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
die() { echo "エラー: $*" >&2; exit 1; }

target="${1:-}"
case "$target" in
  web | agent | gateway | all | secrets) ;;
  *) die "対象は web / agent / gateway / all / secrets のどれか（指定: '${target}'）" ;;
esac
[ "$#" -gt 0 ] && shift

pem="${ROVO_GITHUB_APP_PEM:-}"
skip_github_app=0
github_app_stdin=0
rotate=" "
if [ "$target" != secrets ] && [ "$#" -gt 0 ]; then
  die "$target にオプションは渡せない（渡せるのは secrets だけ）: $*"
fi
while [ "$#" -gt 0 ]; do
  case "$1" in
    --pem) [ "$#" -ge 2 ] || die "--pem にはファイルのパスが要る"; pem="$2"; shift 2 ;;
    --skip-github-app) skip_github_app=1; shift ;;
    --github-app-stdin) github_app_stdin=1; shift ;;
    --rotate)
      [ "$#" -ge 2 ] || die "--rotate には名前が要る"
      case "$2" in
        client-secret | private-key | cloudflare-token | gateway-enc-key | agent-enc-key | all) rotate="$rotate$2 " ;;
        *) die "--rotate の名前は client-secret / private-key / cloudflare-token / gateway-enc-key / agent-enc-key / all のどれか（指定: '$2'）" ;;
      esac
      shift 2 ;;
    *) die "未知のオプション: $1" ;;
  esac
done

if [ "$github_app_stdin" -eq 1 ]; then
  [ "$target" = secrets ] || die "--github-app-stdin は secrets にだけ渡せる"
  [ -z "$pem" ] && [ "$rotate" = " " ] && [ "$skip_github_app" -eq 0 ] || die "--github-app-stdin は --pem / --rotate / --skip-github-app と併用できない（env ROVO_GITHUB_APP_PEM も外す）"
fi

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

# gateway の assets（apps/dashboard/dist。ダッシュボードの SPA）を作る。dist が無い・古いままデプロイしないよう、
# ビルドが失敗したら（set -e で）ここで止まり、wrangler は呼ばない。vite は成功時に dist を空にしてから書き出す（emptyOutDir）。
# 依存は pnpm install 済みを前提にする（今のデプロイもそう）。新しい secret・手順は無い。
build_dashboard() {
  echo "==> ダッシュボード（apps/dashboard）をビルドする"
  (cd "$root/apps/dashboard" && pnpm exec vite build)
}

deploy_one() { # deploy_one <web|agent|gateway>
  [ "$1" = gateway ] && build_dashboard
  echo "==> $1 をデプロイする（設定: $(cfg "$1")）"
  (cd "$root/apps/$1" && pnpm exec wrangler deploy -c "$(cfg "$1")")
}

put_secret() { # put_secret <app> <NAME>  （標準入力はそのまま wrangler に渡る。対話ならユーザーの入力）
  echo "==> $1 の secret $2 を入れる"
  (cd "$root/apps/$1" && pnpm exec wrangler secret put "$2" -c "$(cfg "$1")")
}

put_value() { # put_value <app> <NAME> <値>  値は標準入力のパイプで渡す（引数・env に載せない）
  echo "==> $1 の secret $2 を入れる（自動）"
  printf '%s' "$3" | (cd "$root/apps/$1" && pnpm exec wrangler secret put "$2" -c "$(cfg "$1")")
}

# 入っている secret の名前を返す。失敗（Worker が無いなど）を「無い」とみなさない
list_secrets() { # list_secrets <app>
  local out
  out="$(cd "$root/apps/$1" && pnpm exec wrangler secret list --format json -c "$(cfg "$1")")" \
    || die "$1 の secret 一覧を読めない（Worker がまだ無いか。先に deploy:all を実行する）"
  printf '%s' "$out" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{console.log(JSON.parse(d).map(x=>x.name).join("\n"))}catch(e){process.exit(1)}})' \
    || die "$1 の secret 一覧を解釈できない"
}

# 標準入力の JSON から文字列の項目を 1 つ取り出す（値は argv に載せない。項目名だけ渡す）
json_field() { # json_field <JSON> <項目名>
  printf '%s' "$1" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const v=JSON.parse(d)[process.argv[1]];if(typeof v!=="string"||v==="")process.exit(1);process.stdout.write(v)}catch(e){process.exit(1)}})' "$2"
}

github_app_stdin_main() {
  require gateway
  local input cs pem_text pk
  input="$(cat)"
  cs="$(json_field "$input" clientSecret)" || die "標準入力の JSON に clientSecret が無い"
  pem_text="$(json_field "$input" privateKey)" || die "標準入力の JSON に privateKey が無い"
  input=""
  pk="$(printf '%s\n' "$pem_text" | openssl pkcs8 -topk8 -nocrypt)" || die "pem を PKCS#8 に変換できない"
  pem_text=""
  case "$pk" in "-----BEGIN ""PRIVATE KEY-----"*) ;; *) die "変換した結果が PKCS#8 の PEM ではない" ;; esac
  put_value gateway GITHUB_APP_CLIENT_SECRET "$cs"
  echo "==> gateway の secret GITHUB_APP_PRIVATE_KEY を入れる（標準入力の pem を PKCS#8 に変換）"
  printf '%s\n' "$pk" | (cd "$root/apps/gateway" && pnpm exec wrangler secret put GITHUB_APP_PRIVATE_KEY -c "$(cfg gateway)")
}

secrets_main() {
  if [ "$github_app_stdin" -eq 1 ]; then github_app_stdin_main; return; fi
  require gateway agent
  local gw_have ag_have
  gw_have="$(list_secrets gateway)" || exit 1
  ag_have="$(list_secrets agent)" || exit 1

  # need <app> <NAME> <rotate の名前>: 入れるべきなら 0
  need() {
    case "$rotate" in *" $3 "* | *" all "*) return 0 ;; esac
    local have="$gw_have"; [ "$1" = agent ] && have="$ag_have"
    ! printf '%s\n' "$have" | grep -qx "$2"
  }
  local n_client=0 n_pk=0 n_cf=0 n_gk=0 n_ak=0
  if [ "$skip_github_app" -eq 0 ]; then
    need gateway GITHUB_APP_CLIENT_SECRET client-secret && n_client=1
    need gateway GITHUB_APP_PRIVATE_KEY private-key && n_pk=1
  fi
  need gateway CLOUDFLARE_API_TOKEN cloudflare-token && n_cf=1
  need gateway TOKEN_ENC_KEY gateway-enc-key && n_gk=1
  need agent TOKEN_ENC_KEY agent-enc-key && n_ak=1

  # 事前の確認と値の用意（ここで失敗したら、何も put しない）
  local pk="" cf="" gk="" ak=""
  if [ "$n_pk" -eq 1 ]; then
    [ -n "$pem" ] || die "GITHUB_APP_PRIVATE_KEY を入れるには --pem <GitHub App の .pem のパス>（または env ROVO_GITHUB_APP_PEM）が要る。GitHub App をまだ作っていないなら --skip-github-app、作るなら mise run github-app（manifest フローで作り、secret も入れる）"
    [ -f "$pem" ] || die "pem のファイルが無い: $pem"
    pk="$(openssl pkcs8 -topk8 -nocrypt -in "$pem")" || die "pem を PKCS#8 に変換できない: $pem"
    case "$pk" in "-----BEGIN ""PRIVATE KEY-----"*) ;; *) die "変換した結果が PKCS#8 の PEM ではない: $pem" ;; esac
  fi
  if [ "$n_cf" -eq 1 ]; then
    cf="$(terraform -chdir="$root/infra" output -raw gateway_cloudflare_api_token)" \
      || die "terraform output gateway_cloudflare_api_token を読めない（terraform apply が済んでいるか。Terraform の資格情報が要る）"
    [ -n "$cf" ] || die "terraform output gateway_cloudflare_api_token が空"
  fi
  if [ "$n_gk" -eq 1 ]; then gk="$(openssl rand -base64 32)" && [ "${#gk}" -eq 44 ] || die "TOKEN_ENC_KEY（gateway）を作れない"; fi
  if [ "$n_ak" -eq 1 ]; then ak="$(openssl rand -base64 32)" && [ "${#ak}" -eq 44 ] || die "TOKEN_ENC_KEY（agent）を作れない"; fi

  if [ $((n_client + n_pk + n_cf + n_gk + n_ak)) -eq 0 ]; then
    echo "==> 入れる secret は無い（すべて入っている。入れ直すときは --rotate <名前>）"
    return 0
  fi
  [ "$n_client" -eq 1 ] && put_secret gateway GITHUB_APP_CLIENT_SECRET
  [ "$n_pk" -eq 1 ] && { echo "==> gateway の secret GITHUB_APP_PRIVATE_KEY を入れる（$pem を PKCS#8 に変換）"; printf '%s\n' "$pk" | (cd "$root/apps/gateway" && pnpm exec wrangler secret put GITHUB_APP_PRIVATE_KEY -c "$(cfg gateway)"); }
  [ "$n_cf" -eq 1 ] && put_value gateway CLOUDFLARE_API_TOKEN "$cf"
  [ "$n_gk" -eq 1 ] && put_value gateway TOKEN_ENC_KEY "$gk"
  [ "$n_ak" -eq 1 ] && put_value agent TOKEN_ENC_KEY "$ak"
  return 0
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
    secrets_main
    ;;
esac
