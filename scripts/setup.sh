#!/usr/bin/env bash
# mise run setup の本体。初回のデプロイを 1 本にまとめる（既存の部品の薄い組み合わせ）。何度でも再実行できる。
#   使い方: scripts/setup.sh [--pem <GitHub App の .pem>] [--yes]
#     --pem  GitHub App の秘密鍵（GITHUB_APP_PRIVATE_KEY になる。PKCS#8 への変換はスクリプトの中で行う）。env ROVO_GITHUB_APP_PEM でもよい
#     --yes  terraform apply の確認を省く（-auto-approve）
#   環境変数: ROVO_CONFIG（既定 rovo.config.json）/ ROVO_DEPLOY_DIR（既定 deploy）/ CLOUDFLARE_API_TOKEN（Terraform 用のトークン）
#
# 流れ: 前提の確認 → terraform init / apply → deploy:config → deploy:all → deploy:secrets → GitHub App と BYOK の案内
#   順序は web → agent → gateway のあとに secret（本番で実績のある順。secret が入るまで gateway は fail-closed）。
#   env の CLOUDFLARE_API_TOKEN は Terraform 用のトークン。wrangler は env にあると wrangler login より優先して使い、
#   Workers の権限が無いと失敗するので、wrangler を呼ぶ手順（whoami・deploy・secret）には渡さない（wrangler login の資格情報を使う）。
#   前提に 1 つでも欠けていたら、何も実行しない（terraform も wrangler も呼ばない）。
#   GitHub App は PUBLIC_BASE_URL（Callback URL）が決まってから作る。作る前は githubApp が空のまま進め、
#   作ったら rovo.config.json に id / clientId を入れて、もう一度 setup する（入っている secret は上書きしない）。
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
die() { echo "エラー: $*" >&2; exit 1; }

pem="${ROVO_GITHUB_APP_PEM:-}"
auto_approve=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --pem) [ "$#" -ge 2 ] || die "--pem にはファイルのパスが要る"; pem="$2"; shift 2 ;;
    --yes) auto_approve=1; shift ;;
    *) die "未知のオプション: $1（使えるのは --pem <path> / --yes）" ;;
  esac
done

export ROVO_DEPLOY_DIR="${ROVO_DEPLOY_DIR:-deploy}"
config_cli() { node "$root/scripts/deploy-config.mjs" "$@"; }

# ---- 1. 前提の確認（何も実行する前に） ------------------------------------------
echo "==> 前提を確認する"
missing=0
need_fail() { echo "  NG $*" >&2; missing=1; }
command -v mise > /dev/null 2>&1 || need_fail "mise が無い（https://mise.jdx.dev）"
command -v terraform > /dev/null 2>&1 || need_fail "terraform が無い（mise install）"
command -v pnpm > /dev/null 2>&1 || need_fail "pnpm が無い（mise install）"
if command -v docker > /dev/null 2>&1; then
  docker info > /dev/null 2>&1 || need_fail "Docker が動いていない（agent のコンテナイメージのビルドに要る）"
else
  need_fail "docker が無い（agent のコンテナイメージのビルドに要る）"
fi
[ -n "${CLOUDFLARE_API_TOKEN:-}" ] || need_fail "env の CLOUDFLARE_API_TOKEN が未設定（Terraform 用のトークン。権限は infra/README.md）"
if command -v pnpm > /dev/null 2>&1; then
  who="$(cd "$root/apps/gateway" && env -u CLOUDFLARE_API_TOKEN pnpm exec wrangler whoami 2>&1 < /dev/null)" || who="not authenticated"
  case "$who" in *"not authenticated"* | *"Not logged in"* | *"not logged in"*) need_fail "wrangler にログインしていない（pnpm exec wrangler login）" ;; esac
fi
if ! config_cli get githubAppConfigured > /dev/null; then
  need_fail "rovo.config.json が不正、または無い（rovo.config.example.json をコピーして値を入れる）"
fi
[ "$missing" -eq 0 ] || exit 1
github_app="$(config_cli get githubAppConfigured)"
base_url="$(config_cli get publicBaseUrl)"
echo "  OK"

# ---- 2. Terraform ---------------------------------------------------------------
tfvars="$(mktemp)"
trap 'rm -f "$tfvars"' EXIT
config_cli tfvars > "$tfvars"
echo "==> terraform init / apply（infra/）"
terraform -chdir="$root/infra" init -input=false
apply_args=(-var-file="$tfvars")
[ "$auto_approve" -eq 1 ] && apply_args+=(-auto-approve)
if ! terraform -chdir="$root/infra" apply "${apply_args[@]}"; then
  cat >&2 <<'MSG'

エラー: terraform apply に失敗した。
  初回は、Logpush のジョブの作成が「error validating destination ... 401 Unauthorized」で失敗することがある
  （Logpush 用トークンを作った直後でまだ使えないため）。そのときは、もう一度 mise run setup を実行すると通る。
  Terraform の state は infra/backend.tf を足さない限りローカル（infra/terraform.tfstate）に置かれる。
MSG
  exit 1
fi

# ---- 3. 設定の生成 → デプロイ → secret --------------------------------------------
echo "==> deploy:config（deploy/ に wrangler 設定を生成する）"
config_cli generate

echo "==> deploy:all（web → agent → gateway）"
env -u CLOUDFLARE_API_TOKEN bash "$root/scripts/deploy.sh" all

echo "==> deploy:secrets"
secret_args=()
if [ "$github_app" = true ]; then
  [ -z "$pem" ] || secret_args+=(--pem "$pem")
else
  secret_args+=(--skip-github-app)
fi
env -u CLOUDFLARE_API_TOKEN bash "$root/scripts/deploy.sh" secrets ${secret_args[@]+"${secret_args[@]}"}

# ---- 4. 画面の作業の案内 ----------------------------------------------------------
cat <<MSG

==> 残りは画面の作業
MSG
if [ "$github_app" != true ]; then
  cat <<MSG

[1] GitHub App を作る（GitHub の Settings > Developer settings > GitHub Apps。OAuth App は使わない）
    Callback URL                 : ${base_url}/callback
    Webhook                      : 無効
    Repository permissions       : Metadata = Read-only / Contents = Read and write / Pull requests = Read and write
    Organization permissions     : Members = Read-only（org / team で認可するときだけ）
    作ったら「Install App」で対象の org / リポジトリに入れ、App ID・Client ID・Client secret・秘密鍵（.pem）を控える。
    rovo.config.json の githubApp.id と githubApp.clientId に App ID と Client ID を入れ、次を実行する
    （入力するのは Client secret だけ。.pem は変換して流し込む）:
      mise run setup -- --pem <ダウンロードした .pem のパス>
MSG
else
  cat <<MSG

[1] GitHub App: 設定済み。Callback URL が ${base_url}/callback になっていることを確かめる。
MSG
fi
cat <<MSG

[2] AI Gateway に BYOK を登録する（Cloudflare ダッシュボード > AI > AI Gateway > ゲートウェイ > Provider keys）
    Anthropic の API キーを、エイリアス default で登録する（OpenAI を使うなら同様に default で）。キーは Terraform にも Worker にも入れない。
    詳細: docs/deploy.md の 7

[3] 初回デプロイの確認: ${base_url}/mcp が認証なしで 401 を返す。詳細: docs/deploy.md の 13
MSG
