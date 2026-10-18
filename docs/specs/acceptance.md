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
  - Portal と Access の設定は、このリポジトリではなく `cloudflare-infra`（Terraform）で管理する。登録もそちらから行う。
  - 登録に必要な情報: MCP の URL `https://<PUBLIC_BASE_URL>/mcp`、ユーザーごとの OAuth（Portal の「Require user auth」を有効にする）。DCR は `/oauth/register`、認可は `/authorize`、トークンは `/oauth/token`。protected resource metadata は Worker が公開する。

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

# Phase 3 受入試験（手動）

本物の GitHub App（Contents: Read and write、Pull requests: Read and write、Metadata: Read-only、Members: Read-only）と、本物の GitHub リポジトリで確かめる。自動テスト（偽 GitHub・偽 git）では確かめられない、GitHub 側の実際の挙動が対象。

## 前提

- gateway に `GITHUB_APP_ID` / `GITHUB_APP_PRIVATE_KEY`（PKCS#8）/ `TOKEN_ENC_KEY` を投入済み。agent に `TOKEN_ENC_KEY` と `AI_GATEWAY_ID` を投入済み
- App を対象リポジトリにインストール済み。検証用のリポジトリを使う（本番のリポジトリで試さない）

## 5. Draft PR・push・本文の更新

- [ ] `task_start` すると、作業ブランチ `agent/task-<id>` と Draft PR が作られる。`draft_pr_created` イベントと `task_status` / `task_result` の PR の URL が実際の PR を指す
- [ ] 初期コミット（「rovo: start task <id>」の空コミット）がブランチの根元にある。同じ `idempotency_key` で再実行しても二重に PR が作られない
- [ ] 子エージェントが `git_commit` するたびに、作業ブランチが進む（GitHub 上のコミット一覧で確認）
- [ ] 完了時、PR の head が `task_result` の `verification.commit_sha` と一致し、`pr.head_matches_verified` が `true`
- [ ] PR 本文の rovo の管理範囲（目印の間）が、状態・検証結果・未解決事項に更新される。目印の外側に手で書いた文章は残る
- [ ] PR は Draft のまま。マージ・Ready for review は行われない
- [ ] 実行中に `task_cancel` すると、PR は閉じずに残り、本文が `CANCELLED` で更新される
- [ ] 終端の後、Installation Token が失効している。トークンの値はログにも出ないので、通常は確認できない。確認が必要なら、検証用に一時的にログへ出す改造をして、終端の後にそのトークンで GitHub API を呼び 401 になることを見る（省略可）
- [ ] 完了の後に作業ブランチへ別のコミットを手で push してから終端の処理を行わせると、`head_moved_after_verification` の警告が出る（再現が難しければ省略可）
- [ ] 1 時間を超えるタスクで、トークンの更新（期限の 15 分前に再発行）後も push が続く

## 6. ブランチ保護との併用

- [ ] 既定ブランチ（main）にブランチ保護（ruleset）を入れた状態で、タスクが問題なく完了する（作業ブランチ `agent/task-*` への push は保護の対象外）
- [ ] 子エージェントが bash で `git push origin HEAD:main` を試みても、OutboundGateway が拒否する。仮に通っても、ブランチ保護で拒否される（二重の防御）

## 7. Free プランの private リポジトリ（DRAFT_PR_FALLBACK）

Draft PR を作れないリポジトリ（Free プランの private リポジトリなど）で確かめる。最新の条件は GitHub のドキュメントで確認する。

- [ ] `DRAFT_PR_FALLBACK` 未設定（`fail`）: `task_start` のタスクが `draft_pr_unsupported` で FAILED になり、通常の PR は作られない
- [ ] `DRAFT_PR_FALLBACK=ready`: タイトルの先頭が `[WIP] ` の通常の PR が作られ、本文の冒頭に「rovo が作業中。完了するまでマージしない」旨の注記が入る。`draft_pr_unavailable` の警告がイベントと `task_result` に出る

## Phase 3 の結果

| 日付 | 実施者 | 環境（App / リポジトリのプラン） | 結果 | 備考 |
|---|---|---|---|---|
| | | | | |
