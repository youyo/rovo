# rovo (Claude Code の mod)

rovo のタスクを、Claude Code の会話の横のペインに出す mod。**読み取り専用**で、タスクの状態を見るだけ。タスクの取り消し・Ready 化・マージなどはしない。

## 何をするか

会話の横のペインに、rovo のタスクの進み具合を流れるコンソールとして出す。

- タスクの一覧（状態の印、題名、経過時間）。予算の延長の承認待ち（`task_console` の `awaiting` が `budget_extension`）のタスクは、状態を「入力待ち」ではなく「予算の承認待ち」と出し、入った時に 1 回トーストで知らせる。答えるのは利用者に確認してから（mod 自身は答えない）
- 選んだタスクの段階（準備・実行・検証など）と、今していること
- 子エージェントが実行中のコマンドの出力（末尾に追従し、スクロールで止められる）
- PR の番号と URL

実行中のタスクは約 4 秒ごとに `task_console` で取り直し、終わったタスクは開いたときに 1 回だけ取る。

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

rovo の MCP サーバーが Claude Code に接続されていること（ツール `task_start`・`task_status`・`task_console` を使う）。接続されていないと、ペインは何も出さない。

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
