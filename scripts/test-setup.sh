#!/usr/bin/env bash
# setup.sh の自己確認。terraform / pnpm（wrangler）/ openssl / docker / mise をすべて偽物に差し替え、
# PATH を「偽物のディレクトリ + /usr/bin:/bin」だけにして、実際の terraform / wrangler / Docker に届かないようにする。Cloudflare には触れない。
#  (a) 前提（mise・docker・Terraform 用トークン・wrangler login・config）に欠けがあれば、terraform も wrangler も呼ばずに失敗する
#  (b) 順序: terraform init → apply → deploy:config → web → agent → gateway → secrets
#  (c) terraform apply の失敗（初回の Logpush の 401）は、再実行の案内を出して止まる。deploy は呼ばない
#  (d) GitHub App が未設定なら GitHub App の secret を飛ばし、Callback URL と権限を表示して成功する
#  (e) 秘密の値（Terraform 用トークン・鍵）を出力・引数に載せない
#  (h) GitHub App が空なら、deploy:all の後に manifest フロー（github-app.mjs）を実行する。偽の GitHub（conversions）と
#      偽のブラウザ（callback を叩く）を使う。secret は標準入力で入り、設定の更新・gateway の再デプロイが続く。失敗したら失敗で終わる
#  (i) 最後の案内に BYOK のコマンド（mise run byok）を出す（自動では実行しない）
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
setup="$here/setup.sh"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
fail=0
expect() { if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "NG   $1 (期待 [$2] / 実際 [$3])"; fail=1; fi; }

ACCOUNT_ID="$(printf '0123456789abcdef%.0s' 1 2)" # 32 桁の 16 進数のリテラルを置かない（scan:secrets）
mkdir -p "$work/bin" "$work/bin-nomise"

# node は本物を使う（生成器）。他は偽物
node_real="$(node -p process.execPath)"
ln -s "$node_real" "$work/bin/node"
ln -s "$node_real" "$work/bin-nomise/node"

export LOG="$work/calls.log"
export STDIN_LOG="$work/stdin.log"
export ENV_LOG="$work/env.log"
cat > "$work/bin/terraform" <<'F'
#!/usr/bin/env bash
echo "terraform $*" >> "$LOG"
echo "terraform ${CLOUDFLARE_API_TOKEN:+set}" >> "$ENV_LOG"
case "$*" in
  *" init "*) exit 0 ;;
  *" apply "*)
    [ -n "${FAKE_APPLY_FAIL:-}" ] && exit 1
    for a in "$@"; do case "$a" in -var-file=*) cp "${a#-var-file=}" "$work_vars" ;; esac; done
    exit 0 ;;
  *"output -raw kv_namespace_id") printf 'kv-namespace-id-example' ;;
  *"output -raw archive_bucket_name") printf 'acme-archive' ;;
  *"output -raw ai_gateway_id") printf 'acme-gateway' ;;
  *"output -raw ai_web_gateway_id") printf 'acme-web-gateway' ;;
  *"output -raw gateway_cloudflare_api_token") printf 'CFTOKEN-SENTINEL-ABC' ;;
  *) exit 9 ;;
esac
F
cat > "$work/bin/pnpm" <<'F'
#!/usr/bin/env bash
echo "$(basename "$PWD") $*" >> "$LOG"
echo "pnpm ${CLOUDFLARE_API_TOKEN:+set}" >> "$ENV_LOG"
case "$*" in
  *"wrangler whoami"*) if [ -n "${FAKE_NOT_LOGGED_IN:-}" ]; then echo "You are not authenticated. Please run wrangler login."; else echo "You are logged in."; fi ;;
  *"secret list"*) echo '[]' ;;
  *"secret put"*)
    nm="$(echo "$*" | sed -E 's/.*secret put ([A-Z_]+).*/\1/')"
    data="$(cat; echo x)"; data="${data%x}"
    echo "$(basename "$PWD") $nm len=${#data}" >> "$STDIN_LOG" ;;
esac
exit 0
F
cat > "$work/bin/openssl" <<'F'
#!/usr/bin/env bash
case "$1" in
  rand) n=$(( $(cat "$work_rand" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$work_rand"; printf 'K%042d=\n' "$n" ;;
  pkcs8) if [ "$*" != "${*/-in/}" ]; then :; else cat > /dev/null; fi; printf '%s\n%s\n%s\n' "-----BEGIN ""PRIVATE KEY-----" "BODY" "-----END ""PRIVATE KEY-----" ;;
  *) exit 9 ;;
esac
F
printf '#!/usr/bin/env bash\necho "docker $*" >> "$LOG"\n[ -n "${FAKE_DOCKER_DOWN:-}" ] && exit 1\nexit 0\n' > "$work/bin/docker"
# 偽の open / xdg-open: URL を記録し、手元のページ（127.0.0.1）なら偽のブラウザ（callback を叩く）を起動する。本物のブラウザは開かない
for o in open xdg-open; do
  cat > "$work/bin/$o" <<F
#!/usr/bin/env bash
echo "\$1" >> "$work/open.log"
case "\$1" in http://127.0.0.1:*) ( node "$here/fixtures/github-app/fake-browser.mjs" "\$1" >> "$work/browser.out" 2>&1 & ) ;; esac
exit 0
F
done
printf '#!/usr/bin/env bash\nexit 0\n' > "$work/bin/mise"
chmod +x "$work/bin/"*
for t in terraform pnpm openssl; do cp -P "$work/bin/$t" "$work/bin-nomise/$t"; done
printf '#!/usr/bin/env bash\necho "docker $*" >> "$LOG"\nexit 0\n' > "$work/bin-nomise/docker"; chmod +x "$work/bin-nomise/docker"
export work_vars="$work/vars.json" work_rand="$work/rand.count"

# 安全確認: 偽物に解決され、本物の terraform / wrangler / docker に届かないことを、何かを実行する前に確かめる
for t in terraform pnpm openssl docker mise open xdg-open; do
  r="$(PATH="$work/bin:/usr/bin:/bin" command -v "$t")"
  if [ "$r" != "$work/bin/$t" ]; then echo "中止: $t が偽物に解決されない（$r）" >&2; exit 2; fi
done

pem="$work/app.pem"; echo "FAKE" > "$pem"
cfg_ok="$work/rovo.config.json"
cfg_noapp="$work/rovo.noapp.json"
cat > "$cfg_ok" <<JSON
{
  "accountId": "$ACCOUNT_ID",
  "namePrefix": "acme",
  "workerNames": { "gateway": "acme-gateway", "agent": "acme-agent", "web": "acme-web" },
  "publicBaseUrl": "https://rovo.example.com",
  "githubApp": { "id": "123456", "clientId": "Iv1.exampleclientid" },
  "allowed": { "userIds": ["1001"] }
}
JSON
sed '/githubApp/d' "$cfg_ok" > "$cfg_noapp"

run() { # run <PATH のディレクトリ> <config> <引数...>   追加の環境変数は呼び出し側で前置する
  : > "$LOG"; : > "$STDIN_LOG"; : > "$ENV_LOG"; rm -f "$work_vars" "$work_rand"; rm -rf "$work/deploy"
  local bindir="$1" cfg="$2"; shift 2
  ( cd "$work" && PATH="$bindir:/usr/bin:/bin" ROVO_CONFIG="$cfg" ROVO_DEPLOY_DIR="$work/deploy" bash "$setup" "$@" ) > "$work/out.log" 2>&1 < /dev/null
}
calls() { cat "$LOG"; }
ncalls_tf() { grep -c '^terraform' "$LOG" || true; }
ncalls_pnpm_deploy() { grep -c 'wrangler deploy\|secret' "$LOG" || true; }
export CLOUDFLARE_API_TOKEN="TFTOKEN-SENTINEL-XYZ"

# (b) 通しの成功
run "$work/bin" "$cfg_ok" --pem "$pem" --yes; rc=$?
expect "(b1) 通しで成功する" 0 "$rc"
seq="$(calls | sed -E "s#-chdir=[^ ]+ ##; s#-var-file=[^ ]+#-var-file=VARS#; s#-c $work/deploy/#-c DEPLOY/#" | grep -v '^docker\|whoami')"
expect "(b2) 順序: init → apply → output ×4 → deploy web/agent/ダッシュボードのビルド/gateway → secret list ×2 → put ×5" "terraform init -input=false
terraform apply -var-file=VARS -auto-approve
terraform output -raw kv_namespace_id
terraform output -raw archive_bucket_name
terraform output -raw ai_gateway_id
terraform output -raw ai_web_gateway_id
web exec wrangler deploy -c DEPLOY/web.wrangler.jsonc
agent exec wrangler deploy -c DEPLOY/agent.wrangler.jsonc
dashboard exec vite build
gateway exec wrangler deploy -c DEPLOY/gateway.wrangler.jsonc
gateway exec wrangler secret list --format json -c DEPLOY/gateway.wrangler.jsonc
agent exec wrangler secret list --format json -c DEPLOY/agent.wrangler.jsonc
terraform output -raw gateway_cloudflare_api_token
gateway exec wrangler secret put GITHUB_APP_CLIENT_SECRET -c DEPLOY/gateway.wrangler.jsonc
gateway exec wrangler secret put GITHUB_APP_PRIVATE_KEY -c DEPLOY/gateway.wrangler.jsonc
gateway exec wrangler secret put CLOUDFLARE_API_TOKEN -c DEPLOY/gateway.wrangler.jsonc
gateway exec wrangler secret put TOKEN_ENC_KEY -c DEPLOY/gateway.wrangler.jsonc
agent exec wrangler secret put TOKEN_ENC_KEY -c DEPLOY/agent.wrangler.jsonc" "$seq"

expect "(b3) terraform apply には config から作った var-file を渡す（account_id / name_prefix / worker_names）" "$ACCOUNT_ID acme acme-agent" "$(node -e 'const v=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(v.account_id,v.name_prefix,v.worker_names.agent)' "$work_vars")"
for n in gateway agent web; do
  [ -f "$work/deploy/$n.wrangler.jsonc" ]; expect "(b4) deploy/$n.wrangler.jsonc が生成される" 0 $?
done
[ -f "$work/deploy/infra.json" ]; expect "(b4) deploy/infra.json（非秘密の出力）が生成される" 0 $?
expect "(b5) 生成物に Terraform 用トークン・gateway 用トークンの値が入らない" 0 "$(cat "$work/deploy/"* | grep -c 'TFTOKEN-SENTINEL\|CFTOKEN-SENTINEL')"
expect "(b6) 出力・引数・ログに秘密の値が出ない" 0 "$(cat "$work/out.log" "$LOG" | grep -c 'TFTOKEN-SENTINEL\|CFTOKEN-SENTINEL')"
grep -q "https://rovo.example.com/mcp" "$work/out.log"; expect "(b7) 最後に確認の URL と BYOK の手順を表示する" 0 $?
grep -q "BYOK" "$work/out.log"; expect "(b7) BYOK の案内" 0 $?
grep -q "mise run byok -- anthropic" "$work/out.log"; expect "(i1) BYOK のコマンドを案内する（anthropic）" 0 $?
grep -q "mise run byok -- openai" "$work/out.log"; expect "(i1) BYOK のコマンドを案内する（openai）" 0 $?
expect "(i2) BYOK は自動で実行しない（キーの入力が要る）" 0 "$(grep -c 'byok' "$LOG")"
grep -q "GitHub App: 設定済み" "$work/out.log"; expect "(b8) GitHub App 設定済みなら作成の手順は出さない" 0 $?
expect "(b9) TOKEN_ENC_KEY は 44 文字を標準入力で渡す" "2" "$(grep -c 'TOKEN_ENC_KEY len=44' "$STDIN_LOG")"

# Terraform 用のトークンは terraform にだけ渡す。wrangler は env の CLOUDFLARE_API_TOKEN があると login より優先して使うので、外す
run "$work/bin" "$cfg_ok" --pem "$pem" --yes
expect "(b12) Terraform 用トークンは terraform に渡る" 1 "$(grep -c '^terraform set' "$ENV_LOG" | awk '{print ($1>0)?1:0}')"
expect "(b12) wrangler（pnpm）には渡さない（Workers の権限が無いトークンで deploy しない）" 0 "$(grep -c '^pnpm set' "$ENV_LOG")"
expect "(b12) wrangler は呼ばれている" 1 "$(grep -c '^pnpm' "$ENV_LOG" | awk '{print ($1>0)?1:0}')"

# --yes が無ければ -auto-approve を付けない（対話で確認する）
run "$work/bin" "$cfg_ok" --pem "$pem"
expect "(b10) --yes 無しは -auto-approve を付けない" 0 "$(grep -c 'auto-approve' "$LOG")"

# env ROVO_GITHUB_APP_PEM でもよい
ROVO_GITHUB_APP_PEM="$pem" run "$work/bin" "$cfg_ok" --yes; rc=$?
expect "(b11) pem は env でも渡せる" "0 5" "$rc $(grep -c 'secret put' "$LOG")"

# (a) 前提の欠け: terraform も wrangler（deploy / secret）も呼ばない
check_aborted() { # check_aborted <名前> <rc>
  expect "$1: 失敗する" 1 "$([ "$2" -ne 0 ] && echo 1 || echo 0)"
  expect "$1: terraform を呼ばない" 0 "$(ncalls_tf)"
  expect "$1: deploy / secret を呼ばない" 0 "$(ncalls_pnpm_deploy)"
}
run "$work/bin-nomise" "$cfg_ok" --pem "$pem" --yes; rc=$?; check_aborted "(a1) mise が無い" $rc
grep -q "mise" "$work/out.log"; expect "(a1) 何が足りないかを表示する" 0 $?
FAKE_DOCKER_DOWN=1 run "$work/bin" "$cfg_ok" --pem "$pem" --yes; rc=$?; check_aborted "(a2) Docker が動いていない" $rc
( unset CLOUDFLARE_API_TOKEN; run "$work/bin" "$cfg_ok" --pem "$pem" --yes; rc=$?; check_aborted "(a3) Terraform 用トークンが無い" $rc; grep -q "CLOUDFLARE_API_TOKEN" "$work/out.log"; expect "(a3) 何が足りないかを表示する" 0 $? )
FAKE_NOT_LOGGED_IN=1 run "$work/bin" "$cfg_ok" --pem "$pem" --yes; rc=$?; check_aborted "(a4) wrangler にログインしていない" $rc
run "$work/bin" "$work/nonexistent.json" --pem "$pem" --yes; rc=$?; check_aborted "(a5) config が無い" $rc
echo '{"accountId":"x"}' > "$work/bad.json"
run "$work/bin" "$work/bad.json" --pem "$pem" --yes; rc=$?; check_aborted "(a6) config が不正" $rc
run "$work/bin" "$cfg_ok" --bogus; rc=$?; check_aborted "(a7) 未知のオプション" $rc

# (c) terraform apply の失敗
FAKE_APPLY_FAIL=1 run "$work/bin" "$cfg_ok" --pem "$pem" --yes; rc=$?
expect "(c1) apply の失敗は 0 以外で終わる" 1 "$([ $rc -ne 0 ] && echo 1 || echo 0)"
expect "(c2) apply が失敗したら deploy / secret を呼ばない" 0 "$(ncalls_pnpm_deploy)"
grep -q "401" "$work/out.log"; expect "(c3) Logpush の 401 は再実行で通る旨を案内する" 0 $?
expect "(c4) apply が失敗したら deploy/ を作らない" "no" "$([ -e "$work/deploy" ] && echo yes || echo no)"

# (d) GitHub App が未設定で、自動作成を使わない（--no-github-app）
run "$work/bin" "$cfg_noapp" --yes --no-github-app; rc=$?
expect "(d1) GitHub App が未設定でも成功する" 0 "$rc"
expect "(d2) GitHub App の secret（client secret・秘密鍵）を入れない。残りの 3 つは入れる" "gateway CLOUDFLARE_API_TOKEN
gateway TOKEN_ENC_KEY
agent TOKEN_ENC_KEY" "$(grep 'secret put' "$LOG" | sed -E 's/ exec wrangler secret put//; s/ -c .*//')"
grep -q "https://rovo.example.com/callback" "$work/out.log"; expect "(d3) Callback URL を表示する" 0 $?
grep -q "Pull requests = Read and write" "$work/out.log"; expect "(d4) 権限を表示する" 0 $?
grep -q "mise run setup -- --pem" "$work/out.log"; expect "(d5) 作ったあとの再実行の手順を表示する" 0 $?
grep -q "警告" "$work/out.log"; expect "(d6) 生成時に GitHub App 未設定の警告が出る" 0 $?

# (h) GitHub App が空: deploy:all の後に manifest フローを実行する（偽の GitHub と偽のブラウザ）
node "$here/fixtures/github-app/fake-github.mjs" "$work/gh.port" ok &
gh_pid=$!
trap 'kill "$gh_pid" 2>/dev/null; rm -rf "$work"' EXIT
for _ in $(seq 1 50); do [ -s "$work/gh.port" ] && break; sleep 0.1; done
[ -s "$work/gh.port" ] || { echo "中止: 偽の GitHub が起動しない" >&2; exit 2; }
export ROVO_GITHUB_URL="http://127.0.0.1:$(cat "$work/gh.port")" ROVO_GITHUB_API_URL="http://127.0.0.1:$(cat "$work/gh.port")"
export FAKE_BROWSER_LOG="$work/browser.log"
cfg_h="$work/rovo.h.json"
runh() { rm -f "$cfg_h" "$work/open.log" "$work/browser.log"; cp "$cfg_noapp" "$cfg_h"; run "$work/bin" "$cfg_h" --yes "$@"; }
runh; rc=$?
expect "(h1) GitHub App が空でも通しで成功する" 0 "$rc"
seq_h="$(calls | sed -E "s#-chdir=[^ ]+ ##; s#-var-file=[^ ]+#-var-file=VARS#; s#-c $work/deploy/#-c DEPLOY/#" | grep -v '^docker\|whoami')"
expect "(h2) 順序: …gateway の secret 3 つ（GitHub App なし）→ GitHub App の secret 2 つ → gateway の再デプロイ" "terraform init -input=false
terraform apply -var-file=VARS -auto-approve
terraform output -raw kv_namespace_id
terraform output -raw archive_bucket_name
terraform output -raw ai_gateway_id
terraform output -raw ai_web_gateway_id
web exec wrangler deploy -c DEPLOY/web.wrangler.jsonc
agent exec wrangler deploy -c DEPLOY/agent.wrangler.jsonc
dashboard exec vite build
gateway exec wrangler deploy -c DEPLOY/gateway.wrangler.jsonc
gateway exec wrangler secret list --format json -c DEPLOY/gateway.wrangler.jsonc
agent exec wrangler secret list --format json -c DEPLOY/agent.wrangler.jsonc
terraform output -raw gateway_cloudflare_api_token
gateway exec wrangler secret put CLOUDFLARE_API_TOKEN -c DEPLOY/gateway.wrangler.jsonc
gateway exec wrangler secret put TOKEN_ENC_KEY -c DEPLOY/gateway.wrangler.jsonc
agent exec wrangler secret put TOKEN_ENC_KEY -c DEPLOY/agent.wrangler.jsonc
gateway exec wrangler secret put GITHUB_APP_CLIENT_SECRET -c DEPLOY/gateway.wrangler.jsonc
gateway exec wrangler secret put GITHUB_APP_PRIVATE_KEY -c DEPLOY/gateway.wrangler.jsonc
dashboard exec vite build
gateway exec wrangler deploy -c DEPLOY/gateway.wrangler.jsonc" "$seq_h"
expect "(h3) rovo.config.json に githubApp の id と clientId が入る" "424242 Iv1.fakeclientid0001" "$(node -e 'const g=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).githubApp;console.log(g.id,g.clientId)' "$cfg_h")"
grep -q '"GITHUB_APP_ID": "424242"' "$work/deploy/gateway.wrangler.jsonc"; expect "(h4) 再生成した gateway の設定に GITHUB_APP_ID が入る" 0 $?
expect "(h5) GitHub App の secret（client secret・pem）は標準入力で入る（pem は変換後）" "gateway GITHUB_APP_CLIENT_SECRET len=26
gateway GITHUB_APP_PRIVATE_KEY len=$(printf '%s\n%s\n%s\n' "-----BEGIN ""PRIVATE KEY-----" "BODY" "-----END ""PRIVATE KEY-----" | wc -c | tr -d ' ')" "$(grep GITHUB_APP "$STDIN_LOG")"
if grep -q "CLIENTSECRET-SENTINEL\|WEBHOOKSECRET-SENTINEL\|FAKEPEMBODY\|TFTOKEN-SENTINEL" "$work/out.log" "$LOG" "$ENV_LOG" "$cfg_h" "$work/deploy/"*; then
  expect "(h6) 値（client secret・webhook secret・pem・Terraform 用トークン）が出力・引数・設定に出ない" ok ng
else expect "(h6) 値が出力・引数・設定に出ない" ok ok; fi
expect "(h7) wrangler（pnpm）には Terraform 用トークンを渡さない" 0 "$(grep -c '^pnpm set' "$ENV_LOG")"
grep -q "installations/new" "$work/open.log"; expect "(h8) Install のページを開く" 0 $?
grep -q "mise run byok -- anthropic" "$work/out.log"; expect "(h9) 最後に BYOK のコマンドを案内する" 0 $?
grep -q "User-to-server token expiration" "$work/out.log"; expect "(h10) expire user tokens の確認を案内する" 0 $?

# 設定済みの GitHub App は作り直さない（open も呼ばない）
cp "$cfg_ok" "$cfg_h"; rm -f "$work/open.log"
run "$work/bin" "$cfg_h" --pem "$pem" --yes; rc=$?
expect "(h11) 設定済みなら GitHub App を作らない（open を呼ばない）" "0 no" "$rc $([ -e "$work/open.log" ] && echo yes || echo no)"

# 失敗: conversions が失敗したら、setup は失敗で終わる。設定は変えない
kill "$gh_pid" 2>/dev/null; rm -f "$work/gh.port"
node "$here/fixtures/github-app/fake-github.mjs" "$work/gh.port" fail &
gh_pid=$!
for _ in $(seq 1 50); do [ -s "$work/gh.port" ] && break; sleep 0.1; done
export ROVO_GITHUB_URL="http://127.0.0.1:$(cat "$work/gh.port")" ROVO_GITHUB_API_URL="http://127.0.0.1:$(cat "$work/gh.port")"
runh; rc=$?
expect "(h12) GitHub App の作成に失敗したら setup も失敗する" 1 "$([ $rc -ne 0 ] && echo 1 || echo 0)"
expect "(h13) 失敗したら設定を変えない" "" "$(node -e 'const g=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).githubApp;console.log(g?g.id:"")' "$cfg_h")"
grep -q "mise run github-app" "$work/out.log"; expect "(h14) あとで mise run github-app で作れる旨を案内する" 0 $?
expect "(h15) GitHub App の secret は入れない" 0 "$(grep -c 'GITHUB_APP' "$STDIN_LOG")"

exit "$fail"
