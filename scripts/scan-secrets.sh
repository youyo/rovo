#!/usr/bin/env bash
# 公開前の点検: HEAD と全履歴（全ブランチ・全タグ・削除された内容を含む）の秘密・個人の値を調べる。
# 使い方: scripts/scan-secrets.sh [repoDir]   （既定はこのリポジトリ）
# 1) gitleaks（HEAD は git archive で取り出した tree、履歴は git log -p --all 相当）
# 2) scripts/scan-patterns.mjs（gitleaks が見つけない account id・workers.dev・絶対パス・Claude-Session など）
# 見つけた値そのものは出力しない（gitleaks は --redact）。
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
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

echo "== 自前の正規表現 =="
node "$here/scan-patterns.mjs" "$repo" || rc=1

if [ "$rc" -eq 0 ]; then echo "scan:secrets OK"; else echo "scan:secrets 失敗" >&2; fi
exit "$rc"
