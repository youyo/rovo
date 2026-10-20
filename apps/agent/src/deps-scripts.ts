// 依存関係のキャッシュ（D14）でコンテナ内で走らせる bash スクリプト。argv は `bash -c <script> <名前> <引数...>`。
// 純粋な文字列だけを持つ（Node の単体テスト scripts/deps-scripts.test.mjs が、本物の bash で動作を確かめる）。
// GNU / BSD のどちらの find・mv でも動く書き方にする。

/**
 * 作成用のコンテナで、base_sha の内容を /workspace に取り出す（clone ではなく、その 1 コミットだけを --depth 1 で fetch する）。
 * 認証は外側の OutboundGateway が付けるので、ここには資格が無い。
 * 引数: $1=作業ツリー $2=リポジトリの URL $3=base_sha
 */
export const DEPS_FETCH_SCRIPT = `
set -e
mkdir -p "$1"
find "$1" -mindepth 1 -delete
git -C "$1" init -q
git -C "$1" remote add origin "$2"
git -C "$1" fetch -q --depth 1 origin "$3"
git -C "$1" -c advice.detachedHead=false checkout -q FETCH_HEAD
`;

/**
 * 導入で出来た node_modules を、作業ツリーの外（キャッシュ用の場所）へ移す。同じファイルシステム内の mv なので速い。
 * 作業ツリーのルートと、ワークスペースの各パッケージ（apps/x/node_modules など）の node_modules が対象で、
 * node_modules の中は辿らない。相対パスの一覧を manifest に書く（復元はこの一覧どおりに戻す）。
 * 引数: $1=作業ツリー $2=キャッシュ用のディレクトリ
 */
export const DEPS_STASH_SCRIPT = `
set -e
ws=$1; cache=$2
rm -rf "$cache"
mkdir -p "$cache/nm"
: > "$cache/manifest"
cd "$ws"
find . -name .git -prune -o -type d -name node_modules -prune -print0 | while IFS= read -r -d '' p; do
  rel=\${p#./}
  case "$rel" in
    *"
"*) echo "unsupported path" >&2; exit 1;;
  esac
  mkdir -p "$cache/nm/$(dirname "$rel")"
  mv "$p" "$cache/nm/$rel"
  printf '%s\\n' "$rel" >> "$cache/manifest"
done
`;

/**
 * 退避した node_modules を、clone 済みの作業ツリーへ戻す。作業ツリーに同じ名前が既にあれば（リポジトリが持っているなど）
 * その分は戻さない。manifest の各行は、絶対パスや .. を含まない相対パスだけを受け付ける。
 * 戻した node_modules は .git/info/exclude に足す（このクローンだけの除外。コミットされない）: .gitignore が
 * node_modules を除外していないリポジトリでも、git_commit の `git add -A` が node_modules を巻き込まないようにする。
 * 途中で失敗したら、戻した分を消して失敗（終了コード 1）にする。
 * 引数: $1=作業ツリー $2=キャッシュ用のディレクトリ
 */
export const DEPS_RESTORE_SCRIPT = `
ws=$1; cache=$2
[ -f "$cache/manifest" ] || exit 1
moved=()
while IFS= read -r rel; do
  [ -n "$rel" ] || continue
  case "$rel" in
    /*|..|../*|*/..|*/../*) rc=1; break;;
  esac
  dest="$ws/$rel"
  if [ -e "$dest" ] || [ -L "$dest" ]; then continue; fi
  if mkdir -p "$(dirname "$dest")" && mv "$cache/nm/$rel" "$dest"; then
    moved+=("$dest")
  else
    rc=1; break
  fi
done < "$cache/manifest"
if [ "\${rc:-0}" != 0 ]; then
  for d in "\${moved[@]}"; do rm -rf "$d"; done
  exit 1
fi
# 除外の追記はベストエフォート（失敗しても復元は成功のまま）
if [ "\${#moved[@]}" -gt 0 ] && [ -d "$ws/.git" ]; then
  mkdir -p "$ws/.git/info" 2>/dev/null
  for d in "\${moved[@]}"; do printf '/%s/\\n' "\${d#"$ws"/}" >> "$ws/.git/info/exclude" 2>/dev/null; done
fi
exit 0
`;
