# rovo (Claude Code のスキル)

rovo のタスクを Claude Code から頼む・別のモデルに相談するためのスキル。hooks や mod は持たない（スキルだけ）。

| コマンド | 内容 |
|---|---|
| `/rovo:create-task <依頼>` | 依頼を rovo のタスクにする（`task_start`）。リポジトリ・ブランチ・SHA は作業ディレクトリの git から求める |
| `/rovo:consult <相談>` | 別のモデルに意見を聞く（`consult`）。Claude が会話の文脈と質問をまとめて 1 回相談し、答えを確かめてから伝える。答えが 50 秒以内に出なければ `pending` が返り、`consult_result` で受け取る（待つ間は会話を止めない） |

タスクの進み具合を会話の横のペインに出す mod は、別のプラグイン `rovo-console`（[plugins/rovo-console/README.md](../rovo-console/README.md)）。0.7.0 でスキルから分けた。ペインが無くても、ダッシュボードで進み具合を見られる。

## 前提

rovo の MCP サーバーが Claude Code に接続されていること（ツール `task_start`・`consult` など）。

## インストール

ターミナルのプロンプトで:

```
/plugin marketplace add youyo/rovo
/plugin install rovo@rovo
```

シェルから:

```sh
claude plugin marketplace add youyo/rovo
claude plugin install rovo@rovo
```

デスクトップアプリでは、プロンプト横の + → Plugins → Add marketplace に `youyo/rovo` を入れて Add plugin する。ペインも要るなら `rovo-console` を追加で入れる（`/plugin install rovo-console@rovo`）。入れたあとは Claude Code を再起動する。

### 0.6.x から移る

0.7.0 で、`rovo` はスキルだけになり、ペインの mod は `rovo-console` に分かれた。更新するとペインが消える。要る人は `rovo-console` を追加で入れる:

1. marketplace を更新する: `claude plugin marketplace update rovo`
2. `rovo` を更新する: `claude plugin update rovo@rovo`
3. ペインが要るなら入れる: `claude plugin install rovo-console@rovo`
4. Claude Code を再起動する

`rovo-console` は保存済みのタスク一覧・ログを引き継がない（取り直せる）。

## 開発

```sh
claude plugin validate plugins/rovo  # 検査（スキルだけなので plugin test は無い）
```

リポジトリのルートからは `mise run test:plugin`。
