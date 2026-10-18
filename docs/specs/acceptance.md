# Phase 1 受入試験（手動）

実環境（Cloudflare アカウント、GitHub App、MCP Server Portal）が必要なため自動化できない項目。
Phase 1 のコードが揃った後に、利用者と一緒に実施して結果を記録する。自動テスト（`mise run test`）は偽 GitHub を使うため、実 GitHub との結合はここで初めて確かめる。

## 前提

- [ ] GitHub App を作成した（権限・コールバック URL は [README](../../README.md#github-app-の設定) のとおり）
- [ ] App を対象 org / リポジトリに Install した（push できるリポジトリを 1 つ以上）
- [ ] Worker をデプロイした（`PUBLIC_BASE_URL` は実 URL。`ENVIRONMENT` は `production`）
- [ ] Secret を設定した: `GITHUB_APP_CLIENT_SECRET`、`TOKEN_ENC_KEY`
- [ ] 変数を設定した: `GITHUB_APP_CLIENT_ID`、`ALLOWED_ORG`、`ALLOWED_TEAM`
- [ ] MCP Server Portal に本 Worker の `/mcp` を登録した

## 1. ログイン

- [ ] Claude Code から Portal 経由で接続すると、まず rovo の同意画面が出る（redirect_uri のホストが表示される）。承認後に GitHub のログインへ進み、完了後に MCP が使える
- [ ] 同意画面で承認する前には GitHub へ進まない
- [ ] 同意画面で拒否すると、元のクライアントに `access_denied` で戻る
- [ ] Chrome で、承認と拒否のどちらのリダイレクトも CSP に妨げられない
- [ ] Cowork から Portal 経由で接続しても同様に使える
- [ ] 許可した team に所属しないアカウントではログインできない（`access_denied` で終わる）
- [ ] 2 回目以降の接続では GitHub 側の再承認が不要（または想定どおりの挙動）

## 2. ツール（Claude Code / Cowork の両方）

- [ ] `task_start` で push 権限のあるリポジトリのタスクを作れる。応答の `status` は `CREATING`、`draft_pr_url` は `null`、`note` に Phase 1 の制約が書かれている
- [ ] App 未導入のリポジトリ（公開リポジトリでも）は `forbidden` になる
- [ ] `task_status` で状態が確認できる
- [ ] 実行中のタスクがある状態で 2 件目を作ると `concurrency_limit` になる
- [ ] `task_cancel` で `CANCELLED` になり、その後 `task_start` で新しいタスクを作れる
- [ ] 同じ `idempotency_key` で `task_start` を繰り返すと同じ `task_id` が返る
- [ ] 他人の `task_id` を指定すると `not_found` になる

## 3. 待機（`task_wait`）

- [ ] バックグラウンドで `task_wait` を実行している間も、別の操作（`task_status`、`task_cancel`）ができる
- [ ] 待機中に `task_cancel` すると、待機が即座に終わり `cancelled` イベントが返る
- [ ] クライアントを途中で閉じても、同じ `cursor` で再試行すればイベントを取りこぼさない
- [ ] **Portal 経由で 30 秒・45 秒・60 秒の待機がタイムアウトせずに通るか** を実測する（既定値と上限を決める材料）

| `timeout_seconds` | Claude Code | Cowork | メモ |
|---|---|---|---|
| 30 | | | |
| 45 | | | |
| 60 | | | |

実測の結果、通らない値があれば `DEFAULT_WAIT_SECONDS` / `MAX_WAIT_SECONDS`（`apps/gateway/src/tasks/validation.ts`）を見直す。

## 4. GitHub 資格

- [ ] 8 時間以上経った後（または GitHub App の設定でトークンの期限を短くして）、ツールが自動リフレッシュで成功する
- [ ] GitHub 側で App の認可を取り消した後は `reauth_required` になり、再ログインで回復する
- [ ] team から外したアカウントは、最大 5 分後にすべてのツールで `forbidden` になる

## 結果

| 日付 | 実施者 | 環境 | 結果 | 備考 |
|---|---|---|---|---|
| | | | | |
