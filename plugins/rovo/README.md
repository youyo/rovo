# rovo (Claude Code の mod)

rovo のタスクを、Claude Code の会話の横のペインに出す mod。**読み取り専用**で、タスクの状態を見るだけ。タスクの取り消し・Ready 化・マージなどはしない。

## 何をするか

会話の横のペインに、rovo のワーカーの進み具合を「パイプラインの列」として出す。上の段がワーカーの一覧、下の段が選んだワーカーのコンソール。

```
rovo  作業中 2 · 質問待ち 1 · 完了 3
▸ fix-auth   repo   sonnet   2分14秒
  ●━━━━●━━━━◓▶┈┈┈○   $ pnpm test
  準備 実行 検証 PR
```

- 見出しは `作業中 n · 質問待ち n · 完了 n`（費用は出さない）
- ワーカー 1 件は 3 行。1 行目は選択の印（`▸`）・題名・リポジトリ（`owner/` を落として名前だけ）・モデル（`anthropic/claude-sonnet-5-5` は `sonnet-5.5`）・経過時間。題名は、ペインの幅から他の列を引いた残りを使う。リポジトリとモデルは、`task_list` か `task_start` で分かっていれば常に出す。2 行目は駅と線路で、済んだ駅は緑の `●━━`、いまの駅はスピナー、次の駅への線路に光（`▶`）が流れる。駅に着いた直後は `◉` が白く光る。質問待ち（INPUT_REQUIRED）は流れを止めて `?` を点滅し、完了は全部 `●` で `✓ PR #n`。右にいまの道具と対象。3 行目が駅の名前（task は 準備・実行・検証・PR、review は 取出・調査・投稿）
- 行を選ぶと、下の段のコンソール（出力の窓、スクロール、PR とダッシュボードのリンク）がそのワーカーに替わる。枠はペインの下まで伸びる（行が足りないときは最小の高さ）
- コンソールは、選んだワーカーのログが**積み上がる**。`task_console` に `log_after`（カーソル。最初は `"0"`）を付けて呼び、返った `log.entries` を、ワーカーごとに最大 500 行まで足していく（古い行から捨てる）。行は `$ pnpm test` とその出力の末尾、`✎ edit apps/x.ts (+12 -4)`、`⎇ commit …`、`🔍 search …`、薄い色の状態の変化。末尾に追従し、上へスクロールすると止まる（末尾まで戻すと再開）。実行中のコマンドの出力は、ログの末尾に「いま流れている出力」として続け、終わるとログの側に入る
- `log` を返さないサーバー（`log_after` を知らない `task_console`）では、これまでどおり最新のコマンド 1 本だけを、`$ コマンド` を枠の先頭に固定して出す。`log_after` を受け付けないサーバーは、付けずに呼び直し、1 分間は付けない
- ログの最後の 100 行とカーソルは `$.store` に残し、再起動後は続きから積む
- 予算の延長の承認待ち（`task_console` の `awaiting` が `budget_extension`）のワーカーは「予算の承認待ち」と出し、入った時に 1 回トーストで知らせる。答えるのは利用者に確認してから（mod 自身は答えない）
- 流れは約 0.7 秒ごとに描き直す。動いているワーカーがいなければ止まる

並べるのは「呼んだ人の全タスク」。`task_list` がある rovo では、別のセッションや Cowork から始めたワーカーも数秒ごとに取って並べる（`scope: "recent"`、終わってから 1 時間で隠す）。`task_list` が無いサーバーでは、このセッションで `task_start` を拾ったタスクだけに戻る（1 分に 1 回 `task_list` を試し直す）。`task_list` を呼ぶ先は、rovo のツール（`task_*`）を呼んだ MCP サーバーから覚える。

いまの道具と対象は、選んだワーカーと実行中のワーカーについて `task_console` から取る（約 4 秒ごと。一度に取るのは最大 6 件で、選んだものを先に回す）。終わったワーカーは開いたときに 1 回だけ取る。

### コマンド

| コマンド | 内容 |
|---|---|
| `/rovo:create-task <依頼>` | 依頼を rovo のタスクにする（`task_start`）。リポジトリ・ブランチ・SHA は作業ディレクトリの git から求める |
| `/rovo:consult <相談>` | 別のモデルに意見を聞く（`consult`）。Claude が会話の文脈と質問をまとめて 1 回相談し、答えを確かめてから伝える |
| `/rovo:open-console` | ペインを開く |
| `/rovo:close-console` | ペインを閉じる |

### 自動で開く条件

新しいタスクが始まるたびに、ペインを開こうとする。`/rovo:create-task` で始めたときは、利用者の操作がきっかけなので、端末の幅に関係なく開く。Claude が自分の判断で rovo を使ったときは、Claude Code の決まりで、端末の幅が 144 桁以上（このセッションで一度自分でペインを開いていれば 110 桁以上）のときだけ表示される。足りないときは開かず、トーストで `/rovo:open-console` を案内する。

## 前提

rovo の MCP サーバーが Claude Code に接続されていること（ツール `task_start`・`task_status`・`task_console`、あれば `task_list` を読む）。接続されていないと、ペインは何も出さない。

## インストール

ターミナルのプロンプトで:

```
/plugin install rovo --marketplace youyo/rovo
```

シェルから:

```sh
claude plugin install rovo --marketplace youyo/rovo
```

デスクトップアプリでは、プロンプト横の + → Plugins → Add marketplace に `youyo/rovo` を入れて Add plugin する。

## 開発

```sh
claude --plugin-dir plugins/rovo     # 手元の mod を読み込んで起動
claude plugin test plugins/rovo      # テスト
claude plugin validate plugins/rovo  # 検査
```

リポジトリのルートからは `mise run test:plugin`。型（`.claude-plugin/types/`）は Claude Code が自動で作るので、コミットしない。
