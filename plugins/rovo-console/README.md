# rovo-console (Claude Code の mod)

rovo のタスクを、Claude Code の会話の横のペインに出す mod。**読み取り専用**で、タスクの状態を見るだけ。タスクの取り消し・Ready 化・マージなどはしない。

スキル（`/rovo:create-task`・`/rovo:consult`）は別のプラグイン `rovo`（[plugins/rovo/README.md](../rovo/README.md)）にある。0.7.0 で、ペインの mod をスキルから分けた。ペインが要る人だけ、この `rovo-console` を入れる。

## 何をするか

会話の横のペインに、rovo のワーカーの進み具合を「パイプラインの列」として出す。上の段がワーカーの一覧（1 行目が列見出し）、下の段が選んだワーカーのコンソール。

```
rovo  作業中 2 · 質問待ち 1 · 完了 3
  タイトル                         準備 実行 検証 PR モデル     経過
▎ task_console: 作業の記録を差…    ●━━━━◐┈━▶┈○┈┈┈┈○  sonnet-5.5   3分51秒
▎   rovo  $ git status --short | head; pnpm --filter ./apps/gateway exe…
  gateway: 自分のタスクを数える…   ●━━━━●━━━━?┈┈┈┈○  opus-5.5    12分4秒
    rovo  ? 質問に答えてください（会話で task_answer）
    task_list: 途中で止まったワ…     ✓ PR #83          sonnet-5.5   3分前
    docs: README を英語にする        ✕ 失敗            haiku-5.5    8分前
  他 2 件（完了。終わって 1 時間で消えます）
─ task_console: 作業の記録を差分で返す log_after…          PR #84 · ダッシュボード
┌ コンソール（残りの行いっぱい。末尾に追従）┐
```

- 見出しは `作業中 n · 質問待ち n · 完了 n`（費用は出さない）。2 行目の列見出しに、駅の名前を 1 回だけ出す（task は 準備・実行・検証・PR）。review のワーカーがいるときだけ、review をまとめた直前に `レビュー … 取出 調査 投稿` の見出しを足す
- 並びは 質問待ち → 作業中（開始が新しい順）→ 終端（終了が新しい順）。状態が変わったときだけ動く
- 作業中・質問待ちのワーカーは 2 行。1 行目は選択の帯（`▎`）・タイトル・線路・モデル（`anthropic/claude-sonnet-5-5` は `sonnet-5.5`）・経過時間。タイトルは、ペインの幅から他の列を引いた残りを使う。線路は、済んだ駅が緑の `●━━`、いまの駅がスピナー、次の駅への線路に光（`▶`）が流れる。駅に着いた直後は `◉` が白く光る。質問待ち（INPUT_REQUIRED）は流れを止めて `?` を点滅する。2 行目は字下げの後に、リポジトリ名（`owner/` を落とした名前だけ）といまの動き（`$ コマンド`。検証中は `[2/4]` が前に付く。質問待ちは warning 色で `? 質問に答えてください（会話で task_answer）`）
- 終端のワーカーは 1 行で薄い色: タイトル・結果（線路の位置に `✓ PR #n` / `✓ 完了` / `✕ 失敗` / `✕ 予算超過` / `– 取り消し`。状態色）・モデル・終わってからの時間（`3分前`）。タイトルの前に記号は付けない。結果以外は薄くし、失敗の行は薄くしない。終端の行は最大 5 行で、それ以上は `他 n 件（完了。終わって 1 時間で消えます）`
- 作業中の行は最大 4 件。出しているワーカーは必ず入れる。行が足りないときは、終端の行 → 作業中の行の順に減らし、出力の窓に 6 行は残す
- 出しているワーカー（`▎` の付いた行）のタイトルを全文で `─ タイトル` の行に出し、右端に `PR #n · ダッシュボード` のリンクを寄せる（タイトルはリンクを優先して切る）
- リポジトリとモデルは、`task_list` で分かっていれば常に出す
- どのワーカーを出すかは、描くたびには選び直さない。動くのは、クリックしたときと、次のイベントのときだけ: 新しい作業中のタスクを拾った、またはあるワーカーが質問待ちに入った。そのとき、いま出しているワーカーが終端か、一覧から消えているときだけ、質問待ち > 最新の実行中 > 最新の順で移る（作業中や質問待ちのワーカーを見ているときは奪わない。出しているワーカーが完了しても動かさないので、最後の出力と PR を読める）。起動直後は同じ優先で自動で決める
- 行を選ぶと（どの行を押してもよい）、下の段のコンソール（出力の窓、スクロール）がそのワーカーに替わる。枠はペインの下まで伸びる（行が足りないときは最小の高さ）
- コンソールは、選んだワーカーのログが**積み上がる**。`task_console` に `log_after`（カーソル。最初は `"0"`）を付けて呼び、返った `log.entries` を、ワーカーごとに最大 500 行まで足していく（古い行から捨てる）。行は `$ pnpm test` とその出力の末尾、`✎ edit apps/x.ts (+12 -4)`、`⎇ commit …`、`🔍 search …`、薄い色の状態の変化。末尾に追従し、上へスクロールすると止まる（末尾まで戻すと再開）。実行中のコマンドの出力は、ログの末尾に「いま流れている出力」として続け、終わるとログの側に入る
- `log` を返さないサーバー（`log_after` を知らない `task_console`）では、これまでどおり最新のコマンド 1 本だけを、`$ コマンド` を枠の先頭に固定して出す。`log_after` を受け付けないサーバーは、付けずに呼び直し、1 分間は付けない
- ログの最後の 100 行とカーソルは `$.store` に残し、再起動後は続きから積む
- 予算の延長の承認待ち（`task_console` の `awaiting` が `budget_extension`）のワーカーは「予算の承認待ち」と出し、入った時に 1 回トーストで知らせる。答えるのは利用者に確認してから（mod 自身は答えない）
- 流れは約 0.7 秒ごとに描き直す。動いているワーカーがいなければ止まる

並べるのは「呼んだ人の全タスク」。このセッションで Claude が始めたタスクも、別のセッションや Cowork から始めたワーカーも、`task_list`（`scope: "recent"`、終わってから 1 時間で隠す）で拾って並べる。作業中のワーカーがいる間と「タスクを作成中…」の間は約 4 秒ごと、それ以外は 20 秒ごとに取り直す。mod は `task_start` を呼ばず、Claude のツール呼び出しも見ない（`tool.call` の hook を持たないので、Code Mode を妨げない）。

`task_list` を呼ぶ先（接続先）は、`$.tool.list()` に出ている MCP のツールの名前から探す。同じサーバー・同じ接頭辞の下に `task_start`・`task_list`・`task_console` の 3 つが揃うものだけを接続先にする（直結の `mcp__rovo-direct__task_list`、Portal 経由の `mcp__claude_ai_portal__team-rovo_task_list` など。候補が複数なら最大 4 つまで全部読む）。探すときは名前を見るだけで、揃っていないサーバーのツールは呼ばない。見つけた接続先は `$.store` に残す。MCP の接続は起動から数十秒〜数分遅れることがあるので、接続先がまだ無いときは、最初の 1 分は 5 秒ごと、5 分までは 15 秒ごと、10 分までは 1 分ごとに探し直し、10 分で止める。`/rovo-console`・`/rovo:create-task` を打ったときと次の起動のときにも探し直す。

**`task_list` の無い rovo（古いサーバー）は非対応。** `task_start` と `task_console` はあるが `task_list` が無いサーバーや、`task_list` が unknown tool を返すサーバーでは、タスクを追跡できない。そのときペインに「… には task_list が無く、タスクを追跡できません」と出す。rovo のサーバーを更新する。

いまの動きは、出しているワーカーと実行中のワーカーについて `task_console` から取る（約 4 秒ごと。一度に取るのは最大 6 件で、選んだものを先に回す）。終わったワーカーは開いたときに 1 回だけ取る。

### コマンド

| コマンド | 内容 |
|---|---|
| `/rovo-console` | ペインを開く・閉じる（打つたびに切り替え。他のタブの裏で見えていないときは前に出す）。mod 自身のコマンドで、作業中に打っても処理を止めずその場で動く |

`rovo` のスキル `/rovo:create-task` を打ったときも、この mod が「タスクを作成中…」を出すためにペインを開く（`rovo` も入れているとき）。作成中は `task_list` を約 4 秒ごとに読み、新しいタスクを拾うと表示が消える（10 分たっても拾えなければ、前の表示に戻る）。

### ペインの開き方

新しいタスクが `task_list` に現れても（このセッションで Claude が始めたものも、別のセッションのものも）、ペインは自動では開かない。代わりにトーストで「rovo のタスクが始まりました。/rovo-console で開けます」と案内する（ペインがすでに開いて見えているときは出さない。起動して最初に `task_list` を読んだときにすでにあったタスクと、見えた時点で終わっていたタスクには出さない）。開くのは `/rovo-console` を打ったときだけ。`/rovo:create-task`（`rovo` のスキル）は利用者の操作がきっかけなので、「タスクを作成中…」の表示のためにペインを開く。端末が狭いなどで描かれないときは、Claude Code の決まりで表示されない。

## 前提

rovo の MCP サーバーが Claude Code に接続されていること（ツール `task_start`・`task_list`・`task_console` が揃っていること。`task_status` は `task_console` が使えないときに読む）。接続されていないと、ペインは何も出さない。`task_list` の無い古い rovo は非対応（上を参照）。

## インストール

ペインは `rovo`（スキル）とは別のプラグインで、同じ marketplace `youyo/rovo` にある。ターミナルのプロンプトで:

```
/plugin marketplace add youyo/rovo
/plugin install rovo-console@rovo
```

シェルから:

```sh
claude plugin marketplace add youyo/rovo
claude plugin install rovo-console@rovo
```

デスクトップアプリでは、プロンプト横の + → Plugins → Add marketplace に `youyo/rovo` を入れて、`rovo-console` を Add plugin する。スキルも要るなら `rovo` も入れる（[plugins/rovo/README.md](../rovo/README.md)）。入れたあとは Claude Code を再起動する。

### 0.6.x の `rovo` から移る

0.7.0 で、ペインの mod は `rovo` から外れて `rovo-console` になった（Claude Code の Code Mode は、`tool.call` の JS hook を持つプラグインがあると無効になる。スキルだけを入れたい人のために分けた）。あわせて `rovo-console` も `tool.call` の hook をやめ、新しいタスクは `task_list` で拾うようにした（入れていても Code Mode は無効にならない）。`rovo` を 0.7.0 に更新すると、ペインは消える。ペインが要る人は `rovo-console` を追加で入れる:

1. marketplace を更新する: `claude plugin marketplace update rovo`
2. `rovo` を更新する: `claude plugin update rovo@rovo`
3. ペインが要るなら入れる: `claude plugin install rovo-console@rovo`
4. Claude Code を再起動する

保存済みの状態（`$.store`）はプラグイン名ごとなので、`rovo` のときに残した「タスク一覧・ログの最後の 100 行」は `rovo-console` に引き継がれない。`task_list` で取り直せるので、実害は小さい。

## 開発

```sh
claude --plugin-dir plugins/rovo-console     # 手元の mod を読み込んで起動
claude plugin test plugins/rovo-console      # テスト
claude plugin validate plugins/rovo-console  # 検査
```

リポジトリのルートからは `mise run test:plugin`（スキルの `plugins/rovo` と marketplace の検査も含む）。型（`.claude-plugin/types/`）は Claude Code が自動で作るので、コミットしない。
