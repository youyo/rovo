# Phase 3 実装計画: GitHub App（Installation Token / push / Draft PR）

設計書 `design.md` の 6章と Phase 3 を具体化したもの（下書き、2026-10-18）。GitHub App のユーザー認可（ログイン）は Phase 1 で済んでいる。Phase 3 では、App 自身の権限（Installation Access Token）で push と Draft PR を扱う。

## ゴール

- `task_start` で、作業ブランチ `agent/task-<id>` と Draft PR が作られる（6.5）。`task_status` と `task_result` が Draft PR の URL を返す。
- 子エージェントの commit が作業ブランチに push され、Draft PR に反映される。
- タスクの終端で、PR 本文が状態・検証結果・未解決事項で更新される。
- PR は Draft のまま。マージはしない（design 1.3）。

## 構成

```
apps/gateway
  TokenBroker (WorkerEntrypoint, service binding で agent に公開)
    - GitHub App の JWT（App ID + 秘密鍵）で Installation Access Token を発行
    - 発行の前に TaskDO で「そのタスクが実行中で、repository / installation が一致する」ことを確かめる
  TaskDO
    - CREATING の間に: 作業ブランチ作成 → 初期コミット → Draft PR 作成（冪等）→ AgentDO.start
    - 終端で: PR 本文を更新
apps/agent
  SandboxDO / OutboundGateway
    - github.com の git-receive-pack を、対象リポジトリの agent/task-<id> への更新だけ許可
    - 認証ヘッダは OutboundGateway が TokenBroker から取って注入（コンテナにトークンは入らない）
  AgentDO
    - git_commit のたびに作業ブランチへ push（チェックポイント）
    - Sandbox を作り直すときは、base_sha ではなく作業ブランチの先頭から clone する
```

- 呼び出しの向き: Agent → TokenBroker（service binding）は新しい経路になる。TokenBroker は状態を持たず、TaskDO の読み取り（同期で終わる確認）だけを行うので、Gateway → Agent の呼び出しと循環待ちにはならない。
- 6.4 の Credential Helper は使わない（Phase 2 で廃止）。トークンはコンテナに入らない。

## TokenBroker

- secret: `GITHUB_APP_ID`、`GITHUB_APP_PRIVATE_KEY`（PKCS#8 PEM）。JWT は RS256、有効期限は 9 分（GitHub の上限は 10 分）、`iat` は 60 秒前にずらす。
- `mint({taskId, purpose})`
  - TaskDO から repository_id・installation_id・状態を読み、終端のタスクには発行しない。
  - `POST /app/installations/{installation_id}/access_tokens` に `repository_ids: [repository_id]` と、用途に応じた最小の permissions を付ける。
    - git の push: `contents: write`
    - PR の作成・更新: `pull_requests: write`、`contents: write`（ブランチ作成）
  - 有効期限（最大1時間）の手前5分まで、メモリにキャッシュしてよい（DO の外には保存しない）。
  - トークンはログに出さない。
- 呼べるのは agent Worker（service binding）と Gateway 内部だけ。公開のルートは作らない。

## Draft PR の作成（6.5）

TaskDO の CREATING で、AgentDO.start の前に行う。各ステップは冪等で、途中で落ちても alarm で再開する。

1. 作業ブランチ `refs/heads/agent/task-<id>` が無ければ、初期コミットを作る。
   - 初期コミット: base_sha の tree をそのまま使い、親を base_sha にした空コミット（Git Data API: `POST /repos/{o}/{r}/git/commits`）。メッセージは「rovo: start task <id>」。
   - `POST /repos/{o}/{r}/git/refs` でブランチを作る。既にあれば、先頭が初期コミットか子孫であることを確かめて使う。
2. Draft PR が無ければ作る（`POST /repos/{o}/{r}/pulls`、`draft: true`、head は作業ブランチ、base は base_ref）。
   - 既にあるか（`GET /repos/{o}/{r}/pulls?head=<owner>:agent/task-<id>&state=all`）を先に確かめ、あればそれを使う。
   - タイトル: タスクの title。本文: Task ID、目的（instructions の先頭）、受け入れ条件、状態、テスト結果、未解決事項（6.5）。本文には rovo が管理する範囲の目印を入れ、更新ではその範囲だけを書き換える。
3. PR の番号と URL を TaskDO に保存し、イベント `draft_pr_created` を出す。
4. AgentDO.start を呼ぶ（taskSpec に branch を含める）。

- 失敗の扱い: GitHub が 5xx / 429 なら alarm で再試行する。403 / 404（App の権限不足、リポジトリが見えない）なら FAILED にする。

## push

- AgentDO は、`git_commit` が成功するたびに `git push origin HEAD:refs/heads/agent/task-<id>` を実行する（チェックポイント）。モデルには push のツールを渡さない。
- 完了時（検証に合格した後）にも push し、リモートの先頭が検証済みの SHA と一致することを確かめてから `completed` にする。
- OutboundGateway の receive-pack の判定
  - POST `/<owner>/<repo>.git/git-receive-pack` と GET `info/refs?service=git-receive-pack` を、対象リポジトリに限って許可する。
  - 本文の先頭の pkt-line（`<old> <new> <ref>`）を解析し、更新先がすべて `refs/heads/agent/task-<id>` であることを確かめる。削除（new が 0）、タグ、他のブランチは拒否する。
  - non-fast-forward の push は許可しない（`old` がリモートの現在値と一致することは GitHub が検証する。`--force` を使わないことを AgentDO 側で守る）。
  - 本文のサイズ上限（例: 50MiB）と時間上限を設ける。
- 認証ヘッダは、OutboundGateway が TokenBroker から取って注入する（`Authorization: Basic x-access-token:<token>`）。

## Sandbox の作り直し（9.3 の改善）

- ensureReady は、作業ブランチがリモートにあれば、その先頭から clone する（base_sha ではなく）。push 済みの commit は失われず、失われるのは最後の push 以降の変更だけになる。

## PR の更新

- TaskDO は、終端を確定して停止を確かめた後、PR 本文の rovo 管理範囲を更新する（状態、検証結果、警告、未解決事項、費用）。冪等にし、失敗したら alarm で再試行する。
- PR は Draft のままにし、Ready for review にもしない（親が判断する）。
- キャンセルされたタスクの PR は閉じずに残す（design 4.7）。

## MCP の変更

- `task_start` の応答の `draft_pr_url` は、作成前なら null のまま。`task_status`・`task_result`・イベント `draft_pr_created` で URL を返す。
- `task_result` に `pr: {number, url, head_sha}` を加える。

## テスト

- Unit
  - JWT の生成（RS256、iat / exp）、Installation Token の発行（repository_ids と permissions）、キャッシュ、終端のタスクには発行しないこと。
  - Draft PR 作成の各ステップの冪等性（ブランチ・PR が既にある、途中で失敗して再開する）、403 / 404 で FAILED、5xx で再試行。
  - receive-pack の pkt-line 解析（許可するブランチ、削除、タグ、別ブランチ、複数の更新、壊れた入力）。
  - PR 本文の管理範囲の書き換え。
- E2E
  - 偽 GitHub に App の API（installation token、git data、refs、pulls）と、git の smart HTTP の receive-pack を足す。
  - 通しの E2E で、task_start → Draft PR が作られる → commit が push される → 完了で PR 本文が更新される、を確かめる。
  - 別ブランチへの push、ブランチの削除、別リポジトリへの push が拒否されること。
  - コンテナを作り直した後、push 済みの commit から再開できること。
- 手動の受入試験（acceptance.md に追加）
  - 本物の GitHub App（Contents RW、Pull requests RW、Metadata R、Members R）で Draft PR が作られ、push と本文の更新が反映されること。

## 前提・注意

- GitHub App の秘密鍵は Worker Secret（`rovo-mcp` から投入）。このリポジトリには置かない。
- 非公開リポジトリの clone も、この Phase で TokenBroker 経由の認証付きになる（Phase 2 は公開リポジトリだけ）。

## Phase 3 でやらないこと

- PR のマージ、Ready for review への変更
- 親への質問と追加指示（Phase 4）
