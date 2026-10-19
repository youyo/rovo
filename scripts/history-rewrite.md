# 履歴の書き換え手順（公開直前に 1 回だけ行う）

`Claude-Session:` トレーラーだけを全履歴から消す。`Co-Authored-By:` は残す。author / committer のメールは書き換えない。
**破壊的な操作（コミット ID が全部変わる）。リポジトリの持ち主が決め、実行する。点検用のスクリプトは、この手順を実行しない。**

## 0. 前提

- `git filter-repo` が要る: `mise use -g pipx:git-filter-repo`（または `pipx install git-filter-repo`）。`git filter-repo --version` で確かめる。
- 作業ツリーがきれいで、公開する内容がすべてコミット済みであること（`git status` が空）。
- 先に `mise run release:check` を実行し、`scan:secrets` が通ること（Claude-Session は既知として表示される）。
- 文書の中に、古いコミット ID を参照する箇所が無いこと。書き換えるとすべての ID が変わる。見つかったら、件名・タグ・Phase 名に直してからコミットする。

## 1. バックアップ

元のリポジトリは書き換えない。ミラーを 2 つ取る（1 つは元に戻す用、もう 1 つは作業用の元）。

```bash
SRC=~/src/github.com/youyo/rovo
BK=~/rovo-backup-$(date +%Y%m%d)
git clone --mirror "$SRC" "$BK.git"
git -C "$BK.git" log --all --format=%H > "$BK.old-commits.txt"   # 書き換え前のコミット一覧
git -C "$BK.git" for-each-ref > "$BK.old-refs.txt"
```

## 2. 新しいクローンで書き換える

filter-repo は新しいクローンでの実行を前提にしている。`--no-local` で本物のコピーを作る。

```bash
WORK=~/rovo-rewrite
git clone --no-local "$SRC" "$WORK"
cd "$WORK"
git filter-repo --message-callback '
lines = message.split(b"\n")
kept = [l for l in lines if not l.startswith(b"Claude-Session:")]
return b"\n".join(kept)
'
```

- 全ブランチ・全タグが対象になる（クローンに入っている ref すべて）。
- filter-repo は `origin` を外す。公開先の URL は書き換えた後に自分で設定する（`git remote add origin <URL>`）。
- トレーラーを消した後の本文の末尾に空行が余る場合は、callback の最後で `.rstrip(b"\n") + b"\n"` を足す。

## 3. 検証（すべて満たすこと）

```bash
cd "$WORK"

# (1) Claude-Session が 0 件
git log --all --format=%B | grep -c 'claude.ai/code/session_'          # 0 になる（grep の終了コードは 1 でよい）

# (2) Co-Authored-By が残っている（書き換え前と同じ件数）
git log --all --format=%B | grep -c '^Co-Authored-By:'
git -C "$BK.git" log --all --format=%B | grep -c '^Co-Authored-By:'    # 上と同じ数

# (3) コミット数が同じ
git rev-list --all --count
git -C "$BK.git" rev-list --all --count                                 # 上と同じ数

# (4) 各コミットの tree が変わっていない（commit-map は filter-repo が .git/filter-repo/ に書く）
tail -n +2 .git/filter-repo/commit-map | while read old new; do
  [ "$new" = "0000000000000000000000000000000000000000" ] && continue
  a=$(git -C "$BK.git" rev-parse "$old^{tree}"); b=$(git rev-parse "$new^{tree}")
  [ "$a" = "$b" ] || echo "tree が違う: $old -> $new"
done                                                                    # 何も出力されない

# (5) 現在の tree が元と同じ
git rev-parse HEAD^{tree}; git -C "$SRC" rev-parse HEAD^{tree}          # 同じ値

# (6) 点検を再実行（0 件。Claude-Session は 0 コミットと表示される）
mise run release:check   # $WORK で実行する。pnpm install が要る場合は先に mise run install
```

## 4. 公開

検証が通ったら、`$WORK` を公開用のリポジトリとして使う（push と Visibility の変更はユーザーの操作）。
`$SRC` の `.claude/handover/` など、追跡されていない手元のファイルは `$WORK` に入らない。必要なら手でコピーする。

## 5. 元に戻す

書き換えたのは `$WORK`（新しいクローン）だけで、`$SRC` と `$BK.git` は変わらない。

- 公開前に取りやめる: `rm -rf "$WORK"`。`$SRC` はそのまま使える。
- `$SRC` を誤って書き換えてしまった場合: `$BK.git` から復元する。
  ```bash
  git clone "$BK.git" ~/rovo-restored       # 書き換え前の全 ref が入ったクローン
  # または、同じ場所に戻す: git -C "$SRC" fetch "$BK.git" '+refs/*:refs/*'
  ```
- 書き換え後の履歴を push 済みで取り消したい場合は、リモート側の履歴を `$BK.git` から強制的に戻す（`git -C "$BK.git" push --mirror <URL>`）。公開後は、すでに他者が取得した履歴を取り消せない点に注意する。

## 6. 書き換えの後

- 他のクローン・下流のリポジトリなど、この履歴を upstream として共有しているものは、書き換え後の履歴と整合しない。再クローンまたは再設定が要る。
- 文書内のコミット ID の参照を、もう一度点検する。
