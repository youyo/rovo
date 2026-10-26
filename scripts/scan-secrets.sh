#!/usr/bin/env bash
# 公開前の点検: HEAD と全履歴（全ブランチ・全タグ・削除された内容を含む）の秘密・個人の値を調べる。
# 使い方: scripts/scan-secrets.sh [--gitleaks-only] [repoDir]   （既定はこのリポジトリ）
# --gitleaks-only: 1) だけを流す（下流の private リポジトリの CI 用。2) は upstream を公開するための点検で、
#   下流では account id などを持つのが正しいので流さない）
# 1) gitleaks（HEAD は git archive で取り出した tree、履歴は git log -p --all 相当）
# 2) scripts/scan-patterns.mjs（gitleaks が見つけない account id・workers.dev・絶対パス・Claude-Session など）
# 見つけた値そのものは出力しない（gitleaks は --redact）。
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
gitleaks_only=0
if [ "${1:-}" = "--gitleaks-only" ]; then gitleaks_only=1; shift; fi
repo="$(cd "${1:-$here/..}" && pwd)"
config="${GITLEAKS_CONFIG:-$here/../.gitleaks.toml}"
rc=0

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "== gitleaks: HEAD =="
mkdir "$tmp/head"
git -C "$repo" archive HEAD | tar -x -C "$tmp/head"
gitleaks dir "$tmp/head" --config "$config" --no-banner --redact --exit-code 1 || rc=1

echo "== gitleaks: 全履歴 =="
gitleaks git "$repo" --config "$config" --log-opts="--all" --no-banner --redact --exit-code 1 || rc=1

if [ "$gitleaks_only" -eq 1 ]; then
  label="scan:gitleaks"
else
  label="scan:secrets"
  echo "== 自前の正規表現 =="
  node "$here/scan-patterns.mjs" "$repo" || rc=1
fi

if [ "$rc" -eq 0 ]; then echo "$label OK"; else echo "$label 失敗" >&2; fi
exit "$rc"
