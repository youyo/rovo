#!/usr/bin/env bash
# deploy.sh の自己確認。pnpm を偽物に差し替え、実際の wrangler は呼ばない（Cloudflare には触れない）。
#  (a) ROVO_DEPLOY_DIR が未設定・空・存在しない・設定ファイルが無いときは、0 以外で終わり、wrangler を呼ばない
#  (b) 呼ぶときは必ず下流の設定を -c で渡す（upstream の apps/*/wrangler.jsonc は渡さない）
#  (c) all は web → agent → gateway の順。設定が 1 つでも欠けていたら、1 つも実行しない。途中で失敗したら止まる
#  (d) secrets は入っていない secret だけ入れる（既定。TOKEN_ENC_KEY を誤って変えない）。値は引数・ログに載せず、標準入力で渡す。
#      TOKEN_ENC_KEY は gateway と agent で別の値を自動生成、CLOUDFLARE_API_TOKEN は terraform output -raw、
#      秘密鍵は .pem を PKCS#8 に変換して渡す。事前の確認（pem・terraform・secret list）に失敗したら 1 つも put しない
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
deploy="$here/deploy.sh"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
fail=0

expect() { # expect <名前> <期待> <実際>
  if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "NG   $1 (期待 [$2] / 実際 [$3])"; fail=1; fi
}

# 偽の pnpm: 呼ばれた cwd と引数を記録する。FAKE_FAIL_ON を含む呼び出しは失敗させる
mkdir -p "$work/bin"
# secret list は FAKE_SECRETS_<app>（空白区切りの名前）から JSON を返す。FAKE_LIST_FAIL があれば失敗。
# secret put は標準入力のハッシュと長さだけを FAKE_STDIN_LOG に記録する（値そのものは残さない）
cat > "$work/bin/pnpm" <<'F'
#!/usr/bin/env bash
echo "$(basename "$PWD") $*" >> "$FAKE_LOG"
case "$*" in *"${FAKE_FAIL_ON:-__none__}"*) exit 7 ;; esac
case "$*" in
  *"secret list"*)
    [ -n "${FAKE_LIST_FAIL:-}" ] && exit 1
    var="FAKE_SECRETS_$(basename "$PWD")"; printf '['; sep=""
    for n in ${!var:-}; do printf '%s{"name":"%s","type":"secret_text"}' "$sep" "$n"; sep=","; done
    printf ']\n' ;;
  *"secret put"*)
    nm="$(echo "$*" | sed -E 's/.*secret put ([A-Z_]+).*/\1/')"
    data="$(cat; echo x)"; data="${data%x}"
    echo "$(basename "$PWD") $nm $(printf '%s' "$data" | shasum | cut -c1-12) len=${#data}" >> "$FAKE_STDIN_LOG" ;;
esac
exit 0
F
chmod +x "$work/bin/pnpm"

# 偽の openssl: rand は呼ぶたびに別の 44 文字を返す。pkcs8 は .pem を読んで PKCS#8 の体裁の固定の文字列を返す（BADPEM を含むと失敗）
# 鍵のヘッダは scan:secrets に検出されないよう、実行時に組み立てる
cat > "$work/bin/openssl" <<'F'
#!/usr/bin/env bash
echo "openssl $*" >> "$FAKE_OPENSSL_LOG"
case "$1" in
  rand)
    n=$(( $(cat "$FAKE_RAND_COUNTER" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$FAKE_RAND_COUNTER"
    printf 'K%042d=\n' "$n" ;;
  pkcs8)
    pem=""; while [ $# -gt 0 ]; do [ "$1" = "-in" ] && pem="$2"; shift; done
    grep -q BADPEM "$pem" && exit 1
    printf '%s\n%s\n%s\n' "-----BEGIN ""PRIVATE KEY-----" "CONVERTED-FAKE-BODY" "-----END ""PRIVATE KEY-----" ;;
  *) exit 9 ;;
esac
F
chmod +x "$work/bin/openssl"
# 偽の terraform: gateway_cloudflare_api_token だけ答える（秘密のダミー）。FAKE_TF_FAIL があれば失敗
cat > "$work/bin/terraform" <<'F'
#!/usr/bin/env bash
echo "terraform $*" >> "$FAKE_TF_LOG"
[ -n "${FAKE_TF_FAIL:-}" ] && exit 1
case "$*" in
  *"output -raw gateway_cloudflare_api_token") printf 'CFTOKEN-SENTINEL-ABC' ;;
  *) exit 9 ;;
esac
F
chmod +x "$work/bin/terraform"

export FAKE_LOG="$work/calls.log"
export FAKE_STDIN_LOG="$work/stdin.log"
export FAKE_OPENSSL_LOG="$work/openssl.log"
export FAKE_TF_LOG="$work/terraform.log"
export FAKE_RAND_COUNTER="$work/rand.count"
# 安全確認: PATH の差し替えが効いていて、pnpm が偽物に解決されることを、何かを実行する前に確かめる
for tool in pnpm openssl terraform; do
  resolved="$(PATH="$work/bin:$PATH" command -v "$tool")"
  if [ "$resolved" != "$work/bin/$tool" ]; then
    echo "中止: $tool が偽物に解決されない（$resolved）。実際の wrangler / terraform を呼ぶ恐れがあるので、何も実行しない" >&2
    exit 2
  fi
done
run() { # run <ROVO_DEPLOY_DIR を設定するか: set|unset> <値> <引数...>
  : > "$FAKE_LOG"; : > "$FAKE_STDIN_LOG"; : > "$FAKE_OPENSSL_LOG"; : > "$FAKE_TF_LOG"; rm -f "$FAKE_RAND_COUNTER"
  local mode="$1" val="$2"; shift 2
  if [ "$mode" = set ]; then
    ( cd "$work" && ROVO_DEPLOY_DIR="$val" PATH="$work/bin:$PATH" bash "$deploy" "$@" ) >"$work/out.log" 2>&1 </dev/null
  else
    ( cd "$work" && env -u ROVO_DEPLOY_DIR PATH="$work/bin:$PATH" bash "$deploy" "$@" ) >"$work/out.log" 2>&1 </dev/null
  fi
}
calls() { cat "$FAKE_LOG"; }
ncalls() { wc -l < "$FAKE_LOG" | tr -d ' '; }
nputs() { grep -c 'secret put' "$FAKE_LOG" || true; }
stdin_of() { grep "^$1 " "$FAKE_STDIN_LOG" | sed -E 's/^[a-z]+ [A-Z_]+ //'; } # stdin_of "<app> <NAME>"

mkdir -p "$work/full" "$work/partial" "$work/empty"
for n in gateway agent web; do echo '{}' > "$work/full/$n.wrangler.jsonc"; done
echo '{}' > "$work/partial/web.wrangler.jsonc"
echo '{}' > "$work/partial/gateway.wrangler.jsonc"

# (a) 失敗するべき場合: 0 以外で終わり、wrangler を 1 回も呼ばない
for t in web agent gateway all secrets; do
  run unset "" "$t"; rc=$?
  expect "(a1) $t: ROVO_DEPLOY_DIR 未設定は失敗" 1 "$([ $rc -ne 0 ] && echo 1 || echo 0)"
  expect "(a1) $t: 未設定では wrangler を呼ばない" 0 "$(ncalls)"
  run set "" "$t"; rc=$?
  expect "(a2) $t: ROVO_DEPLOY_DIR が空は失敗" 1 "$([ $rc -ne 0 ] && echo 1 || echo 0)"
  expect "(a2) $t: 空では wrangler を呼ばない" 0 "$(ncalls)"
  run set "$work/nonexistent" "$t"; rc=$?
  expect "(a3) $t: 存在しないディレクトリは失敗" 1 "$([ $rc -ne 0 ] && echo 1 || echo 0)"
  expect "(a3) $t: 存在しないディレクトリでは wrangler を呼ばない" 0 "$(ncalls)"
  run set "$work/empty" "$t"; rc=$?
  expect "(a4) $t: 設定ファイルが無いと失敗" 1 "$([ $rc -ne 0 ] && echo 1 || echo 0)"
  expect "(a4) $t: 設定ファイルが無いと wrangler を呼ばない" 0 "$(ncalls)"
done
run set "$work/full" bogus; rc=$?
expect "(a5) 未知の対象は失敗" 1 "$([ $rc -ne 0 ] && echo 1 || echo 0)"
run set "$work/full"; rc=$?
expect "(a6) 対象なしは失敗" 1 "$([ $rc -ne 0 ] && echo 1 || echo 0)"
expect "(a5,a6) 未知の対象・対象なしでは wrangler を呼ばない" 0 "$(ncalls)"

# (b) 単体のデプロイ: 下流の設定を -c で渡す。cwd は apps/<name>
run set "$work/full" web; rc=$?
expect "(b1) web: 成功する" 0 "$rc"
expect "(b2) web: apps/web で wrangler deploy -c <下流の設定>" "web exec wrangler deploy -c $work/full/web.wrangler.jsonc" "$(calls)"
run set "$work/full" agent; expect "(b3) agent" "agent exec wrangler deploy -c $work/full/agent.wrangler.jsonc" "$(calls)"
run set "$work/full" gateway; expect "(b4) gateway" "gateway exec wrangler deploy -c $work/full/gateway.wrangler.jsonc" "$(calls)"
# 相対パスは実行したディレクトリからの相対として絶対パスにして渡す
run set "full" web
expect "(b5) 相対パスは絶対パスにして渡す" "web exec wrangler deploy -c $work/full/web.wrangler.jsonc" "$(calls)"
# upstream の wrangler.jsonc を渡していない
if grep -q "apps/.*/wrangler.jsonc" "$FAKE_LOG"; then expect "(b6) upstream の設定を渡さない" ok ng; else expect "(b6) upstream の設定を渡さない" ok ok; fi

# (c) all
run set "$work/full" all; rc=$?
expect "(c1) all: 成功する" 0 "$rc"
expect "(c2) all: web → agent → gateway の順" "web exec wrangler deploy -c $work/full/web.wrangler.jsonc
agent exec wrangler deploy -c $work/full/agent.wrangler.jsonc
gateway exec wrangler deploy -c $work/full/gateway.wrangler.jsonc" "$(calls)"
run set "$work/partial" all; rc=$?
expect "(c3) all: 設定が 1 つ欠けたら失敗" 1 "$([ $rc -ne 0 ] && echo 1 || echo 0)"
expect "(c4) all: 設定が 1 つ欠けたら 1 つも実行しない（半端なデプロイをしない）" 0 "$(ncalls)"
grep -q "agent.wrangler.jsonc" "$work/out.log"; expect "(c5) 欠けた設定の名前を表示する" 0 $?
FAKE_FAIL_ON="agent.wrangler" run set "$work/full" all; rc=$?
expect "(c6) all: 途中で失敗したら 0 以外で終わる" 1 "$([ $rc -ne 0 ] && echo 1 || echo 0)"
expect "(c7) all: 途中で失敗したら後続を実行しない" "web exec wrangler deploy -c $work/full/web.wrangler.jsonc
agent exec wrangler deploy -c $work/full/agent.wrangler.jsonc" "$(calls)"

# (d) secrets
pem="$work/app.pem"; echo "FAKE-PEM-CONTENT" > "$pem"
badpem="$work/bad.pem"; echo "BADPEM" > "$badpem"
BEGIN_L="-----BEGIN ""PRIVATE KEY-----"; END_L="-----END ""PRIVATE KEY-----"
converted_hash="$(printf '%s\n%s\n%s\n' "$BEGIN_L" "CONVERTED-FAKE-BODY" "$END_L" | shasum | cut -c1-12)"
token_hash="$(printf '%s' 'CFTOKEN-SENTINEL-ABC' | shasum | cut -c1-12)"
put_seq="gateway exec wrangler secret put GITHUB_APP_CLIENT_SECRET -c $work/full/gateway.wrangler.jsonc
gateway exec wrangler secret put GITHUB_APP_PRIVATE_KEY -c $work/full/gateway.wrangler.jsonc
gateway exec wrangler secret put CLOUDFLARE_API_TOKEN -c $work/full/gateway.wrangler.jsonc
gateway exec wrangler secret put TOKEN_ENC_KEY -c $work/full/gateway.wrangler.jsonc
agent exec wrangler secret put TOKEN_ENC_KEY -c $work/full/agent.wrangler.jsonc"
list_seq="gateway exec wrangler secret list --format json -c $work/full/gateway.wrangler.jsonc
agent exec wrangler secret list --format json -c $work/full/agent.wrangler.jsonc"

run set "$work/full" secrets --pem "$pem"; rc=$?
expect "(d1) secrets: 何も入っていなければ 5 つを入れる（成功）" 0 "$rc"
expect "(d2) secrets: secret list で確かめてから、順に put する" "$list_seq
$put_seq" "$(calls)"
expect "(d3) 秘密鍵は PKCS#8 に変換して標準入力で渡す" "$converted_hash" "$(stdin_of 'gateway GITHUB_APP_PRIVATE_KEY' | cut -d' ' -f1)"
grep -q "pkcs8 -topk8 -nocrypt -in $pem" "$FAKE_OPENSSL_LOG"; expect "(d4) openssl pkcs8 -topk8 -nocrypt で変換する" 0 $?
expect "(d5) CLOUDFLARE_API_TOKEN は terraform output -raw の値を標準入力で渡す" "$token_hash" "$(stdin_of 'gateway CLOUDFLARE_API_TOKEN' | cut -d' ' -f1)"
expect "(d6) terraform は output -raw gateway_cloudflare_api_token だけ呼ぶ" "1" "$(grep -c 'output -raw gateway_cloudflare_api_token' "$FAKE_TF_LOG")"
expect "(d6) terraform は -json を使わない" 0 "$(grep -c -- '-json' "$FAKE_TF_LOG")"
gk="$(stdin_of 'gateway TOKEN_ENC_KEY')"; ak="$(stdin_of 'agent TOKEN_ENC_KEY')"
expect "(d7) TOKEN_ENC_KEY は gateway と agent で別の値" 1 "$([ -n "$gk" ] && [ -n "$ak" ] && [ "$gk" != "$ak" ] && echo 1 || echo 0)"
expect "(d8) TOKEN_ENC_KEY は 44 文字（base64 の 32 バイト。改行なし）" "len=44 len=44" "$(echo "${gk##* } ${ak##* }")"
expect "(d9) 鍵は openssl rand -base64 32 で作る" "2" "$(grep -c 'rand -base64 32' "$FAKE_OPENSSL_LOG")"
if grep -q "CFTOKEN-SENTINEL\|CONVERTED-FAKE\|FAKE-PEM-CONTENT\|K0000" "$FAKE_LOG" "$work/out.log"; then
  expect "(d10) 値を引数・ログ・出力に載せない" ok ng
else expect "(d10) 値を引数・ログ・出力に載せない" ok ok; fi

# 既に入っているものは上書きしない（TOKEN_ENC_KEY を変えると全員が再ログインになる）
export FAKE_SECRETS_gateway="GITHUB_APP_CLIENT_SECRET GITHUB_APP_PRIVATE_KEY CLOUDFLARE_API_TOKEN TOKEN_ENC_KEY OTHER"
export FAKE_SECRETS_agent="TOKEN_ENC_KEY"
run set "$work/full" secrets --pem "$pem"; rc=$?
expect "(d11) 全部入っていれば put しない（成功）" "0 0 2" "$rc $(nputs) $(ncalls)"
export FAKE_SECRETS_gateway="TOKEN_ENC_KEY"
run set "$work/full" secrets --pem "$pem"; rc=$?
expect "(d12) TOKEN_ENC_KEY が入っていれば、足りない 3 つだけ入れる" "gateway exec wrangler secret put GITHUB_APP_CLIENT_SECRET -c $work/full/gateway.wrangler.jsonc
gateway exec wrangler secret put GITHUB_APP_PRIVATE_KEY -c $work/full/gateway.wrangler.jsonc
gateway exec wrangler secret put CLOUDFLARE_API_TOKEN -c $work/full/gateway.wrangler.jsonc" "$(calls | grep 'secret put')"
export FAKE_SECRETS_gateway="GITHUB_APP_CLIENT_SECRET GITHUB_APP_PRIVATE_KEY CLOUDFLARE_API_TOKEN TOKEN_ENC_KEY"
run set "$work/full" secrets --rotate gateway-enc-key; rc=$?
expect "(d13) --rotate gateway-enc-key は gateway の TOKEN_ENC_KEY だけ入れ直す" "0 gateway exec wrangler secret put TOKEN_ENC_KEY -c $work/full/gateway.wrangler.jsonc" "$rc $(calls | grep 'secret put')"
run set "$work/full" secrets --rotate private-key; rc=$?
expect "(d14) --rotate private-key で pem が無ければ失敗し、put しない" "1 0" "$([ $rc -ne 0 ] && echo 1 || echo 0) $(nputs)"
run set "$work/full" secrets --rotate nonsense; rc=$?
expect "(d15) --rotate の未知の名前は失敗し、put しない" "1 0" "$([ $rc -ne 0 ] && echo 1 || echo 0) $(nputs)"
unset FAKE_SECRETS_gateway FAKE_SECRETS_agent

run set "$work/full" secrets; rc=$?
expect "(d16) 秘密鍵が要るのに pem が無いと失敗し、1 つも put しない" "1 0" "$([ $rc -ne 0 ] && echo 1 || echo 0) $(nputs)"
grep -q -- "--pem" "$work/out.log"; expect "(d16) --pem の使い方を表示する" 0 $?
run set "$work/full" secrets --pem "$work/nonexistent.pem"; rc=$?
expect "(d17) pem が無いファイルなら失敗し、put しない" "1 0" "$([ $rc -ne 0 ] && echo 1 || echo 0) $(nputs)"
run set "$work/full" secrets --pem "$badpem"; rc=$?
expect "(d18) pem を変換できなければ失敗し、put しない" "1 0" "$([ $rc -ne 0 ] && echo 1 || echo 0) $(nputs)"
FAKE_TF_FAIL=1 run set "$work/full" secrets --pem "$pem"; rc=$?
expect "(d19) terraform output を読めなければ失敗し、put しない" "1 0" "$([ $rc -ne 0 ] && echo 1 || echo 0) $(nputs)"
FAKE_LIST_FAIL=1 run set "$work/full" secrets --pem "$pem"; rc=$?
expect "(d20) secret list に失敗したら（Worker が無いなど）、無いとみなさず失敗し、put しない" "1 0" "$([ $rc -ne 0 ] && echo 1 || echo 0) $(nputs)"
grep -q "deploy:all" "$work/out.log"; expect "(d20) 先に deploy:all する案内を表示する" 0 $?
ROVO_GITHUB_APP_PEM="$pem" run set "$work/full" secrets; rc=$?
expect "(d21) pem は env ROVO_GITHUB_APP_PEM でも渡せる" "0 5" "$rc $(nputs)"
run set "$work/full" secrets --skip-github-app; rc=$?
expect "(d22) --skip-github-app は GitHub App の 2 つを入れず、pem も要らない" "0 3" "$rc $(nputs)"
expect "(d22) --skip-github-app の put の順" "gateway exec wrangler secret put CLOUDFLARE_API_TOKEN -c $work/full/gateway.wrangler.jsonc
gateway exec wrangler secret put TOKEN_ENC_KEY -c $work/full/gateway.wrangler.jsonc
agent exec wrangler secret put TOKEN_ENC_KEY -c $work/full/agent.wrangler.jsonc" "$(calls | grep 'secret put')"
run set "$work/full" secrets --bogus; rc=$?
expect "(d23) 未知のオプションは失敗し、何も呼ばない" "1 0" "$([ $rc -ne 0 ] && echo 1 || echo 0) $(ncalls)"
run set "$work/full" all --pem "$pem"; rc=$?
expect "(d24) secrets 以外にオプションは渡せない" "1 0" "$([ $rc -ne 0 ] && echo 1 || echo 0) $(ncalls)"
run set "$work/partial" secrets --pem "$pem"; rc=$?
expect "(d25) secrets: agent の設定が無いと失敗し、1 つも実行しない" "1 0" "$([ $rc -ne 0 ] && echo 1 || echo 0) $(ncalls)"

# (e) プレースホルダ（<...>）が残った設定は、何も実行せずに失敗する
mkdir -p "$work/ph-web" "$work/ph-agent" "$work/ph-gw" "$work/ph-comment" "$work/ph-url"
for d in ph-web ph-agent ph-gw ph-comment ph-url; do
  for n in gateway agent web; do printf '{\n  "name": "x"\n}\n' > "$work/$d/$n.wrangler.jsonc"; done
done
printf '{\n  "vars": {\n    "AI_GATEWAY_ID": "<AI_GATEWAY_ID>"\n  }\n}\n' > "$work/ph-web/web.wrangler.jsonc"
printf '{\n  "vars": {\n    "A": "<YOUR_ID>"\n  }\n}\n' > "$work/ph-agent/agent.wrangler.jsonc"
printf '{\n  "vars": {\n    "A": "<YOUR_ID>"\n  }\n}\n' > "$work/ph-gw/gateway.wrangler.jsonc"
printf '{\n  // <YOUR_ID> を置き換える（コメントは対象外）\n  "name": "x"\n}\n' > "$work/ph-comment/web.wrangler.jsonc"
printf '{\n  "vars": {\n    "U": "https://<YOUR_GATEWAY_HOST>"\n  }\n}\n' > "$work/ph-url/web.wrangler.jsonc"

run set "$work/ph-web" web; rc=$?
expect "(e1) web: プレースホルダが残っていたら失敗" 1 "$([ $rc -ne 0 ] && echo 1 || echo 0)"
expect "(e1) web: プレースホルダが残っていたら wrangler を呼ばない" 0 "$(ncalls)"
grep -q "web.wrangler.jsonc:3" "$work/out.log"; expect "(e2) ファイルと行番号を表示する" 0 $?
grep -q "<AI_GATEWAY_ID>" "$work/out.log"; expect "(e3) 残っているプレースホルダを表示する" 0 $?
run set "$work/ph-agent" all; rc=$?
expect "(e4) all: 1 つでも残っていたら失敗し、1 つも実行しない" "1 0" "$([ $rc -ne 0 ] && echo 1 || echo 0) $(ncalls)"
grep -q "agent.wrangler.jsonc:3" "$work/out.log"; expect "(e5) all: 残っているファイルと行を表示する" 0 $?
run set "$work/ph-gw" secrets --pem "$pem"; rc=$?
expect "(e6) secrets: 残っていたら失敗し、1 つも実行しない" "1 0" "$([ $rc -ne 0 ] && echo 1 || echo 0) $(ncalls)"
run set "$work/ph-url" web; rc=$?
expect "(e7) 文字列の途中の <...>（URL）も検出する" "1 0" "$([ $rc -ne 0 ] && echo 1 || echo 0) $(ncalls)"
run set "$work/ph-comment" web; rc=$?
expect "(e8) コメント行の <...> は対象外" "0 1" "$rc $(ncalls)"

# deploy.example/ をそのまま使うと失敗する。<...> を全部置き換えたコピーなら通る
example="$here/../deploy.example"
for t in web agent gateway all secrets; do
  run set "$example" "$t"; rc=$?
  expect "(e9) deploy.example/ のまま $t は失敗し、wrangler を呼ばない" "1 0" "$([ $rc -ne 0 ] && echo 1 || echo 0) $(ncalls)"
done
mkdir -p "$work/filled"
for n in gateway agent web; do
  sed -E 's/<[A-Za-z_][A-Za-z0-9_]*>/filled/g' "$example/$n.wrangler.jsonc" > "$work/filled/$n.wrangler.jsonc"
done
run set "$work/filled" all; rc=$?
expect "(e10) 全部置き換えた deploy.example/ のコピーは all が通る" "0 3" "$rc $(ncalls)"
run set "$work/filled" secrets --pem "$pem"; rc=$?
expect "(e11) 全部置き換えたコピーは secrets も通る（list 2 + put 5）" "0 7" "$rc $(ncalls)"

# upstream の apps/*/wrangler.jsonc へのシンボリックリンクは、本番の値が無いので拒否する
mkdir -p "$work/link"
for n in gateway agent; do cp "$work/filled/$n.wrangler.jsonc" "$work/link/$n.wrangler.jsonc"; done
ln -s "$here/../apps/web/wrangler.jsonc" "$work/link/web.wrangler.jsonc"
run set "$work/link" web; rc=$?
expect "(f1) upstream の apps/web/wrangler.jsonc へのリンクは失敗し、wrangler を呼ばない" "1 0" "$([ $rc -ne 0 ] && echo 1 || echo 0) $(ncalls)"
run set "$work/link" all; rc=$?
expect "(f2) all: 1 つでも upstream へのリンクなら、1 つも実行しない" "1 0" "$([ $rc -ne 0 ] && echo 1 || echo 0) $(ncalls)"

exit "$fail"
