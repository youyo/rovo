# Phase 3 実装計画: GitHub App（Installation Token / push / Draft PR）

設計書 `design.md` の 6章と Phase 3 を具体化したもの（2026-10-18、advisor レビュー反映済み）。

GitHub App のユーザー認可（ログイン）は Phase 1 で済んでいる。Phase 3 では、App 自身の権限（Installation Access Token）を使って push と Draft PR を扱う。

## ゴール

- `task_start` で、作業ブランチ `agent/task-<id>` と Draft PR が作られる（6.5）。`task_status`・`task_result`・イベントで、Draft PR の URL を返す。
- 子エージェントの commit が作業ブランチに push され、Draft PR に反映される。
- タスクの終端で、PR 本文が状態・検証結果・未解決事項で更新される。
- PR は Draft のまま。マージはしない（design 1.3）。（D9 で変更: rovo 自身は Ready にもマージにもしないが、呼び出し元の AI が `task_pr_ready` / `task_pr_merge` で行える。design 15.8）

## 保証の範囲（正確に書く）

- 外向きの proxy（OutboundGateway）が保証すること
  - push できるのは、対象リポジトリの `refs/heads/agent/task-<id>` だけ。
  - 次のものは拒否する: 削除、タグ、他の ref、複数コマンド、push-options、shallow、sha256。
- 保証しないこと
  - **non-fast-forward（force push）は proxy では止められない。** wire protocol に force の印は無く、GitHub が確かめるのは old の CAS 一致だけで、祖先関係は確かめないため。ただし、送れるのは自動の push（許可証つき）だけで、モデルは送れない（下記）。
- モデルの `git push` の扱い
  - **モデルが bash から `git push` しても通らない。** receive-pack は、SandboxDO が自動の push の exec の間だけ預かる許可証（ref と newSha）が、本文のコマンドと一致するときだけ認証を付けて転送する。許可証が無い・違うときは 403（`push_not_permitted`）。
  - 許可証を渡すのは自動の push（`git_commit`・WIP・完了時の同期）だけで、どれも push の前に秘密の検査を通している。bash ツールと検証コマンドには渡さない。
  - 自動の push は、子の gitconfig（global・system・`core.hooksPath`・`credential.helper`・`origin` の URL）の影響を受けないよう切り離す。
- そのため、真偽は信頼できる側で確かめる。
  - 完了時に、AgentDO が検証済みの SHA をブランチの先頭に揃え、`ls-remote` で確かめる。
  - 終端で、TaskDO が GitHub 上の PR の head SHA を読み、検証済みの SHA と比べる。違えば警告する。
- 運用の推奨: 対象リポジトリの既定ブランチにブランチ保護（ruleset）を入れる。Installation Token の `contents: write` はすべてのブランチに効くので、proxy の不具合に対する二重の防御になる。

## トークンの発行と配送（一方向 RPC を維持）

- **TaskDO が Installation Token を発行し、AgentDO に渡す（push 型）。** Agent → Gateway の呼び出しは作らない。
  - 理由1: 一方向 RPC の原則（phase2.md）を守れる。
  - 理由2: 失効の持ち主が決まる。トークンの有効期限は1時間固定で短くできないので、失効（`DELETE /installation/token`）が唯一の短縮手段になる。TaskDO が持っていれば、終端で失効できる。
- 発行
  - secret は `GITHUB_APP_ID` と `GITHUB_APP_PRIVATE_KEY`（PKCS#8）。GitHub がダウンロードさせる鍵は PKCS#1 なので、`openssl pkcs8 -topk8 -nocrypt` で変換して投入する（docs/deploy.md に書く）。
  - JWT は RS256。`iat` は 60 秒前にずらし、`exp` は 9 分後にする。
  - `POST /app/installations/{installation_id}/access_tokens` に、`repository_ids: [repository_id]` と `permissions: {contents: write, pull_requests: write, metadata: read}` を付ける。
  - トークンはログに出さない。TaskDO の storage には暗号化して保存する（`TOKEN_ENC_KEY` を再利用）。
- 配送
  - `AgentDO.start(taskSpec)` の taskSpec にトークンと期限を入れる。
  - RUNNING の間は TaskDO の alarm（10秒）が動いている。期限の15分前になったら新しいトークンを発行し、`AgentDO.setGitCredential({token, expiresAt})` で渡す。配送は冪等で、成功するまで再送する。
- AgentDO は、受け取ったトークンを SandboxDO の storage に暗号化して保存する。コンテナには入れない。terminate のときに削除する。
- OutboundGateway は、受理したリクエスト（判定を通ったもの）にだけ、SandboxDO から読んだトークンを注入する（`Authorization: Basic base64("x-access-token:<token>")`）。トークンが無い・期限切れなら 401 を返し、コンテナ側の git は失敗する。
- 失効: 終端を確定して停止を確かめた後、TaskDO が最後に発行したトークンを失効させる。
  - 進行中の upstream への転送は止まらない。これは受け入れるリスクとする。
- 非公開リポジトリの clone（upload-pack）にも、同じトークンを注入する。Phase 2 は公開リポジトリだけだった。

## Draft PR の作成（6.5）

TaskDO の CREATING で、AgentDO.start の前に行う。各ステップは冪等で、途中で落ちても alarm で再開する。

1. 初期コミットを決定的に作る。
   - `GET /repos/{o}/{r}/git/commits/{base_sha}` で tree を得る。404 なら FAILED（`base_sha_not_found`）。
   - `POST /repos/{o}/{r}/git/commits` で、tree = base の tree、parents = [base_sha]、メッセージ「rovo: start task <id>」の空コミットを作る。
   - author と committer の date を、TaskDO の `created_at` に固定する。こうすると SHA が決定的になり、再試行しても同じ SHA になる。
   - 初期コミットの SHA は、ref を作る前に TaskDO に永続化する。
2. 作業ブランチ `refs/heads/agent/task-<id>` を作る（`POST /git/refs`）。
   - 既にあれば、`GET /compare/{initialSha}...{head}` の status で確かめる。`identical` か `ahead` なら使う。`behind` か `diverged` なら FAILED（`branch_conflict`）。
   - 削除や force はしない。
3. Draft PR を作る（`POST /pulls`、`draft: true`、head は作業ブランチ、base は base_ref）。
   - 先に `GET /pulls?head=<owner>:agent/task-<id>&state=open` で既存の PR を探す。あれば、base が base_ref と一致するかを確かめてから使う。
   - `POST` が 422（already exists）なら、もう一度 GET する。
   - Draft PR を作れない場合（Free プランの private リポジトリなどで 422）の扱いは、env `DRAFT_PR_FALLBACK` で切り替える。OSS として Free プランの利用者も対象にするため。
     - `fail`（既定）: FAILED（`draft_pr_unsupported`）にする。通常の PR はレビュー依頼や CI を起動しうるため。
     - `ready`: 通常の PR を作る。タイトルの先頭に `[WIP] ` を付け、本文の冒頭に「rovo が作業中。完了するまでマージしない」と明記する。イベントと `task_result` に警告 `draft_pr_unavailable` を付ける。
     - 不正な値は `fail` として扱う（fail-closed）。
     - 判定は、422 の応答本文が Draft に関するものである場合に限る。それ以外の 422 で通常の PR に切り替えない。
4. PR の番号・URL・初期コミットの SHA を保存し、イベント `draft_pr_created` を出す。
5. Installation Token を発行し、AgentDO.start を呼ぶ（taskSpec に branch・初期コミットの SHA・トークンを入れる）。

- エラーの分類
  - 403 / 404: FAILED（App の権限不足、リポジトリが見えない）。
  - 401: JWT の時計ずれや鍵の違い。警告を出して再試行する。
  - 422: 内容で分ける。already exists は上のとおり。それ以外は FAILED。
  - 429、secondary rate limit、5xx: `Retry-After` を尊重して再試行する。alarm の間隔は指数で延ばす（上限60秒）。
- CREATING の上限: 10分を超えたら FAILED（`setup_timeout`）にし、予約を返す。GitHub の障害で、同時実行の枠と予算を握り続けないようにするため。

- 互換性: Phase 2 で作られた TaskDO（`github_link` なし）は移行しない。AgentDO は `gitCredential` を必須にして `rejected` にするので、TaskDO は start を送らず、start の前に FAILED（`legacy_task`）で閉じる（本番データはまだ無い）。

## Sandbox の作業ツリー

- `prepareWorkspace` は、初回も含めて常に、リモートの `refs/heads/agent/task-<id>` を checkout する（TaskDO が AgentDO.start より前にブランチを作っているので、必ずある）。
- checkout の後、`git merge-base --is-ancestor <base_sha> HEAD` を確かめる。満たさなければ失敗にする（fail-closed）。
- コンテナを作り直したときのメッセージは「最後に push したチェックポイントから再 clone した」にする（`sandbox-do.ts` と `agent-do.ts` の文言を直す）。
- patch の基点は、引き続き base_sha とする（初期コミットは空なので diff を持たない）。

## push

- チェックポイント
  - AgentDO は、`git_commit` が成功するたびに `git push origin HEAD:refs/heads/agent/task-<id>` を実行する。
  - これは best-effort で、失敗しても `git_commit` を失敗にはしない（イベント `push_failed` を出す）。成功したらイベント `pushed {sha}` を出す。
- 完了時
  - 検証に合格したら、`git ls-remote` で現在の先頭を読み、`git push --force-with-lease=refs/heads/agent/task-<id>:<読んだ値> origin <検証済み SHA>:refs/heads/agent/task-<id>` でブランチを検証済みの SHA に揃える。ブランチはタスクの持ち物なので、信頼できる側（AgentDO）がそろえるのは問題ない。モデルが bash で履歴を書き換えていても、ここで正す。
  - その後、`ls-remote` で先頭が検証済みの SHA と一致することを確かめてから `completed` にする。
  - push が失敗した場合は、有限回（3回）再試行する。それでも失敗したら、`completed` に警告（`push_failed`）を付けて確定する。検証は通っていて、patch は結果に残るため。その場合、`pr.head_sha` は付けない。
- システムプロンプトの `no_push` の節は、「push は commit のたびに自動で行われる。手で push しない」に変える。

## receive-pack の判定（OutboundGateway）

- GET `info/refs?service=git-receive-pack`: 対象リポジトリだけ。query は `service` だけ。
- POST `git-receive-pack`
  - **本文のコマンド部を flush-pkt まで読んで検証してから、upstream への転送を始め、認証ヘッダを注入する。** packfile はストリームで流し、Worker のメモリに載せない。
  - 1行目は NUL で capabilities を切り離してから解析する。
  - コマンドは1本だけ許可する。形式は `<old 40hex> <new 40hex> refs/heads/agent/task-<id>`。
  - 次のものは拒否する: new が全0（削除）、`shallow` 行、`push-options` の capability、`object-format=sha256`、40桁以外の16進、ref の不正な文字、2本以上のコマンド。
  - `content-encoding` と `git-protocol` のヘッダは、receive-pack では転送しない（push は protocol v0 だけ。gzip も拒否する）。
  - 本文のサイズ上限（50MiB）と時間上限を設ける。

## PR の更新

- TaskDO は、終端を確定して停止を確かめた後に、次を行う。
  1. GitHub から PR の head SHA を読み、`verification.commit_sha` と比べる。違えば、PR 本文と `task_result` に「検証の後に head が動いた」と警告を書く。
  2. PR 本文の rovo の管理範囲（目印で囲んだ部分）を更新する。内容は状態、検証結果、警告、未解決事項。
  3. Installation Token を失効させる。
- 本文の扱い
  - 本文は 65,536 文字を上限とする。
  - モデルの要約、検証の出力、警告は信用しないデータなので、コードフェンスで囲み、長さを切る。
  - 費用は既定では本文に載せない（公開リポジトリでは誰でも見られるため）。env `PR_SHOW_COST=true` のときだけ載せる。
- PR は Draft のままにし、Ready for review にもしない。キャンセルされたタスクの PR は、閉じずに残す（design 4.7）。ただし、どの終端でも子の commit が 1 つも無い（作業ブランチの先頭が initial_sha のまま）ときは、空の Draft PR を閉じて作業ブランチを消す（2026-10-24 追加。`pr.closed_empty`）。
- 更新は冪等にし、失敗したら alarm で再試行する。

## MCP の変更

- `task_start` の応答の `draft_pr_url` は、作成前なら null のまま。URL は `task_status`・`task_result`・イベント `draft_pr_created` で返す。
- `task_result` に `pr: {number, url, head_sha, head_matches_verified}` を加える。

## テスト

- Unit
  - JWT の生成（RS256、iat / exp）、Installation Token の発行（repository_ids と permissions）、更新（期限の15分前）、失効。
  - Draft PR の作成
    - 決定的な初期コミット（同じ created_at なら同じリクエスト本文になる）
    - ブランチと PR が既にある場合
    - compare の各 status
    - 422（already exists / draft 不可）、`DRAFT_PR_FALLBACK` の `fail` / `ready` / 不正な値
    - 401 / 403 / 404 / 429 / 5xx の扱いと backoff
    - CREATING の上限
  - receive-pack の判定: 許可する更新、削除、タグ、別ブランチ、2本のコマンド、shallow、push-options、sha256、壊れた pkt-line、content-encoding。コマンド部を検証する前に、upstream へ転送しないこと。
  - PR 本文の管理範囲の書き換え、上限、非信頼データの囲み、費用の表示の切り替え。
  - head SHA の不一致による警告。
- E2E
  - 偽 GitHub に、App の API を足す。
    - JWT の RS256 署名を公開鍵で検証し、`iss` が App ID であることを確かめる。
    - installation token、git data、refs、compare、pulls、token の失効。
  - 偽 git（`git http-backend`）で receive-pack を有効にする（`http.receivepack=true`）。`Authorization: Basic x-access-token:<token>` を検証して、トークンの注入の経路そのものを確かめる。
  - 通しの E2E
    - task_start → Draft PR が作られる → commit が push される → 完了でブランチが検証済みの SHA になり、PR 本文が更新され、トークンが失効する。
    - 別ブランチへの push、ブランチの削除、別リポジトリへの push が拒否されること。
    - **bash からの push が通る**こと（保証の範囲外であることの確認）。
    - force push で履歴が差し替わっていても、完了時に検証済みの SHA へ揃うこと。
    - 完了の後に head が動いた場合に、警告が出ること。
    - コンテナを作り直した後、push 済みの commit から再開できること。
    - 非公開リポジトリを、トークン付きで clone できること。
- 手動の受入試験（acceptance.md に追加）
  - 本物の GitHub App（Contents RW、Pull requests RW、Metadata R、Members R）で、Draft PR が作られ、push と本文の更新が反映されること。
  - 既定ブランチのブランチ保護と併用できること。

## 前提・注意

- GitHub App の秘密鍵は Worker Secret（下流の private リポジトリから投入）。このリポジトリには置かない。
- Draft PR は、プラン（private リポジトリの場合）によって作れないことがある。最新の条件は受入試験で確かめる。

## Phase 3 でやらないこと

- PR のマージ、Ready for review への変更
- 親への質問と追加指示（Phase 4）
