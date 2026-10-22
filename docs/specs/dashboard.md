# ダッシュボード実装計画: 読み取り専用の運用画面

運用の状況（費用・タスク・コンテナの稼働）を、Cloudflare のダッシュボードを渡り歩かずに 1 か所で見るための、**読み取り専用**の画面を作る計画（**確定（ユーザー承認 2026-10-21）**。要件と設計は承認済み。Codex と advisor のレビュー反映済み）。

**この文書は確定した計画で、実装は M1〜M10 まで済み、本番で実機の確認も始まっている（2026-10-22。状態は下の「実装の状態」）。** 設計の判断が要ったものは「決めること」に選択肢・推奨・理由を並べ、各項目に「決定（2026-10-21）」の行を足した（却下した案は理由として残す）。決定は design.md の 15.9 に書き写した。承認済みの要件・設計から変えた点は「気づいた矛盾・提案」に書いた。**最初の版から何も外さない**（consult・Cloudflare の概要・構造化イベントも最初の版に入れる。advisor の「最小の版」への組み替えは不採用）。

### 実装の状態（2026-10-22）

| M | 状態 |
|---|---|
| M1 配信の土台 | 済み |
| M2 契約（DTO・fixtures） | 済み |
| M3a / M3b 索引（TaskDO の outbox・DirectoryDO・consult の索引） | 済み |
| M4 ブラウザのログインとセッション | 済み。localhost の Chromium で `__Host-` Cookie が通ることは 6b で確かめた（下の「M4 の未確認事項の結果」） |
| M5a / M5b 認可と読み取り API | 済み |
| M6a / M6b 一覧の画面・Playwright・書体 | 済み（書体の同梱方法は下の「書体の同梱」） |
| M7 構造化イベントと詳細の API | 済み |
| M8a / M8b 詳細の画面・Playwright | 済み |
| M9 Cloudflare の概要 | 済み。本番では AI Gateway の分だけ取れ、Workers・コンテナ・Workers AI はトークンの権限の反映待ち（`terraform apply`。acceptance.md の 27 節） |
| M10 `dashboard_url` | 済み |
| PR の状態（矛盾 #4 の決定） | 済み。本番で確認（acceptance.md の 27 節） |
| M11 通しと受入・docs | docs は済み（acceptance.md の 27 節、deploy.md の 18、README、SECURITY.md、design.md の 15.9）。実機の受入は一部だけ（private repo の権限の差・モバイル幅・キーボード・スクリーンリーダー・他の閲覧者は未実施）。Playwright の通しは 6b・8b で入れた分があり、「テスト方針」の通しのシナリオ全部との突き合わせは残り |

#### M4 の未確認事項の結果

「localhost で Chromium が `Secure` / `__Host-` の Cookie を受け付けるか」は、6b の Playwright（`127.0.0.1` の `wrangler dev`）で通った。接頭辞を外す仕組み（`ENVIRONMENT=test` で `__Host-` を外す案）は不要で、入れていない。

#### 書体の同梱

- 取得は npm の `@fontsource`（`@fontsource/m-plus-1-code` の 400 と 700。2026-10-22 の改装で、Familjen Grotesk・Zen Kaku Gothic New・JetBrains Mono から置き換えた）。`apps/dashboard/src/main.tsx` が CSS を読み、ビルドで `dist/assets/` に出る。外部の CDN は使わない（CSP は `font-src 'self'`）。ライセンスは SIL OFL 1.1 で、全文を `dist/assets/licenses/` に同梱する。
- Vite のプラグイン（`vite.config.ts`）で、woff2 だけにし（woff の予備は外す）、キリル・ギリシャ・ベトナム語の分割は同梱しない。unicode-range の分割は残し、ブラウザは使う文字を含む分割だけを読む。`assetsInlineLimit: 0` で `data:` URI に埋め込まない。
- 容量の上限は 2 つに分けた。書体（woff2 と `@font-face`）は別枠で 6 MB、書体以外は 400 KB のまま据え置く（`scripts/dashboard-dist.test.mjs`）。和文が大きいため、1 つの枠にすると、アプリ本体の肥大に気づけなくなる。

**デザインの正は、承認済みの見本**。2026-10-22 の改装で「制御卓」（https://claude.ai/artifact/MfPBzrNbEPWcxpJhvXHSEJ の `Console.dc.html`。配色はライト `paper`・ダーク `indigo`）に置き換えた。以前の見本（https://claude.ai/artifact/RPWqojr9ySJ7DvdBaqZG3m）は使わない。この文書の「画面」の節は、見本から読み取れる要点だけを書く。

## 目的と要件（承認済み）

- 運用の状況（費用・タスク・コンテナの稼働）を、Cloudflare のダッシュボードを渡り歩かずに見たい。**読み取り専用**（操作は MCP のまま）。
- 閲覧者: 組織の全員が全員のタスクを見てよい。ただし**閲覧者が GitHub で見られるリポジトリのタスクだけ**（private の名前・内容を権限の無い人に見せない。閲覧者の GitHub トークンで確かめる）。費用などの集計は全員分でよい。自分のタスクだけに簡単に絞り込める。
- 画面: 別の SPA（React）。Workers の static assets で gateway から `/dashboard` 配下に配信する。ビルドはデプロイの中で自動で、**デプロイの手順・secret を増やさない**（OSS として誰でもデプロイできる簡単さを崩さない）。過去分（索引を作る前のタスク）は出さない。
- `task_start` の応答に、そのタスクの詳細ページの URL（`dashboard_url`）を入れる。`task_status` / `task_result` にも入れる。

## 画面（見本から）

- 骨格（一覧と詳細で同じ）: 上にヘッダ（全員 / 自分、その日の要約）と今日のタイムラインの細い帯。左にタスクのレール（1 行 1 タスク、状態の印 ・ – ✕ ● ? と走行中の脈動）。中央にコンソール。下に tmux 風のステータスバー（今月の予算・全員の実績・モデル別・Cloudflare・クレジット）、「内訳」で詳しい表の引き出しを開く。広い画面はビューポートの高さいっぱいで、スクロールするのはレールとコンソールの中だけ。720px 以下は縦に積み、ページ全体がスクロールする。
- コンソール: 見出し（題名・モデルと選ばれ方・所要・費用・Draft PR）→ 準備→実行→検証→完了の帯（止まった段階は失敗色）→ 画面（構造化イベントを時刻つきの行で、コマンドは `$ コマンド`、実行中は `output.running` の経過時間と点滅カーソル。`prefers-reduced-motion` では点滅しない）。新しい行で末尾へ追従し、利用者が上にスクロールしている間は追従しない。一覧のコンソールは、最新の走行中のタスク（なければ最新のタスク）。
- 色: `:root` のトークンだけで持ち、`prefers-color-scheme` で切り替える。ライト `paper`（地 `#E3E6E9`、墨 `#1E2932`、藍 `#2D4BA0`、失敗 `#B83A1E`）、ダーク `indigo`（地 `#1B2238`、文字 `#DCE4EE`、白緑 `#7FD6B5`、失敗 `#FF8E72`）。文字のコントラストは全組み合わせで 4.5:1 以上（テストで計算して固定）。
- 文字: 全体を M PLUS 1 Code（和文が半角 2 文字分の等幅で、コンソールの桁がずれない）。
- 避けるもの: SaaS カード・影・グラデーション、クリーム＋テラコッタ、黒＋ネオン、全部大文字のラベル、「·」区切り、矢印付きリンク、**色だけの区別**（状態は形・文字でも区別する。アクセシビリティの受入条件にする）。

## 現状（調査で分かったこと）

path:line は 2026-10-21 時点の origin/main（`c1ddb06`）。

### 全体

- **`apps/web` は Web Research Service**（`apps/web/wrangler.jsonc:3` の `rovo-web`。`workers_dev: false`、公開ルートなし）で、**ダッシュボードの置き場ではない**。「apps/web に既に何があるか」の答えは「関係ない別物」。SPA は新しい `apps/dashboard` に作る（D1）。
- gateway は `OAuthProvider` が最外殻（`apps/gateway/src/index.ts:17-43`）。`apiRoute: "/mcp"`、`defaultHandler` が Hono アプリ（`apps/gateway/src/app.ts:25-39`。`/`、`/authorize`、`/callback`、test 用ルート）。`/oauth/token` と `/oauth/register` と well-known は OAuthProvider が処理する。**`/dashboard` 配下は defaultHandler に足せる**（OAuthProvider は自分のパス以外を defaultHandler に渡す）。
- gateway の `wrangler.jsonc` に `assets` は無い。DO は `TASK_DO` / `USER_DO` / `AGENT_DO`、migration は `v1` だけ（`apps/gateway/wrangler.jsonc:9-18`）。**DirectoryDO を足すには migration `v2` が要る**。
- `Env` の型の補い: `apps/gateway/src/env.d.ts`（`CLOUDFLARE_API_TOKEN?` は「Account / AI Gateway / Read だけ」）。`worker-configuration.d.ts` は `mise run typegen:gateway` の生成物。

### TaskDO（`apps/gateway/src/tasks/task-do.ts`、2851 行）

- テーブル（`migrate` `:448-579`）: `task`（`:450`。`repository`・`repository_id`・`installation_id`・`owner_id`・`owner_login`・`title`・`status`・`draft_pr_url`・`created_at`・`updated_at`。`merge_policy`・`model`・`effort` は後から列追加）、`events`（`:471`。`seq`・`type`・`payload`・`created_at`。`operation_id`・`agent_seq` は列追加）、`agent_link`（`:487`。`usage_micro`・`usage_public`〔JSON。`mergeUsagePublic` で単調に増える。`apps/gateway/src/tasks/summary.ts:259`〕・`archive_done` など）、`github_link`（`:508`。`pr_number`・`pr_url`・`pr_draft`・`pr_merged`・`branch`・`deps`）、`questions`（`:540`）・`steers`（`:548`）・`git_token`（`:556`）。
- **`repository_id` は NULL を許す列**（`:456`。型は `number | null` `:318`、`isNullableId` で検証 `:862`）。呼び出し側が渡さなかったタスクでは NULL。**ダッシュボードの認可は NULL を fail closed（誰にも見せない）にする**（D5）。
- 状態遷移は **`changeStatus`（`:796`）に集約**されている。`task` 行の更新と `status_changed` イベントの追加を同じ同期区間で行う。ここが索引の outbox を書く最適な 1 点（M3）。ただし**状態以外の更新は別の経路**にある: usage の更新（`applyPage` `:1710` が `agent_link.usage_micro` / `usage_public` を更新）、PR の作成・Ready・マージ（`github_link` の更新。`recordPrAction` `:1322` が `pr_draft` / `pr_merged` を更新）。**outbox は `changeStatus` だけでは足りず、これらの更新点にも立てる**。
- `alarm()`（`:1200`）は `advance()`（`:1187`）を呼び、`syncAlarm`（`:2710`）が `needsAlarm`（`:2667`）で次を決める。**終端後は `finished` / `finalize_done` / `archive_done` が済むと alarm が消える**。outbox の未配送を `needsAlarm` に足さないと、終端直前に立てた outbox が配送されずに残る（Phase 6 M4 のアーカイブと同じ形）。
- 公開 API は `ownerId` を引数に取り、所有者でなければ `not_found`（`getStatus` `:985`、`result` `:1215`、`notOwner`）。**ダッシュボードは所有者以外が読む**ので、専用の読み取り RPC が要る（`getStatus` 等は使えない）。
- イベントの取り込み: `ingest`（`:1694`）→ `applyPage`（`:1710`）。AgentDO のイベントは `mapAgentEvent` を通り、`appendAgentEvent` で `events` に積まれる。`events` / `questions` / `steers` は削除されない（phase7.md D1 案 B。`git_token` の暗号文だけ空にする `:570`）。**詳細ページの履歴の読み出し元として使える**（保持期限は無い）。
- 終端の `result`（`:1215`）は `isStopped()` を待つ（`not_ready`）。ResultView は `reason`・`failure_phase`（`"setup"` だけ）・`verification.results[].duration_ms`・`usage.{deps_cache, cache_build_ms, sandbox_runtime_ms}` を持つ（`:165-232`）。**`sandbox_instance`（`usage.sandbox_instance`）は main に無い**（作業中のブランチ。M7・M8 で取り込み時に合わせる）。

### UserDO（`apps/gateway/src/tasks/user-do.ts`、1003 行）

- **予算は利用者ごと**: `task_budget`（`:195`。task_id・month・reserved/settled micro・closed・`settled_estimated`）が**その利用者の分だけ**を持つ。`budgetStatus()`（`:562`）は**呼んだ利用者本人の分**を返す（`monthly_budget_usd` は利用者ごとの枠）。`UserDO.task_budget` は一覧の代わりにならない（所有者の分だけで、題名・リポジトリ・PR を持たない）。全員の合計は索引（DirectoryDO）から作る。
- 同時実行: `reservation_slot`（`:188`）、`concurrencyLimit`（`:264`。`MAX_CONCURRENT_TASKS`、既定 2）、`reserve`（`:393`）。`budget_status` の `concurrency_limit`（`:581`）。「あと何件始められるか」は `min(max_concurrent_tasks, concurrency_limit - 実行中の枠)` で、**閲覧者本人の分だけ**が定義できる（D8、矛盾の節）。
- consult: `reserveConsult`（`:592`）と `settleConsult`（`:646`）が `task_budget` に `consult-<ULID>` の行を足す。**consult の行にモデル名が無い**（モデルは `apps/gateway/src/consult.ts:109` の `resolveModel` の結果で、監査ログ `consult_started` に出るだけ）。時刻は ULID の時刻部分から分かる（`ulidTime`）。タイムラインの灰の点とモデル別の費用に consult を出すには、**UserDO 側にも outbox が要る**（D9）。UserDO には alarm が無い（`grep alarm` で `:487` のコメントだけ）。
- GitHub のユーザートークン: `github_credential`（`:228`）に **AES-GCM の暗号文**で 1 利用者 1 組（アクセス・リフレッシュ）。`saveCredential`（`:758`）は上書きし `loginEpoch` を進め、所属のキャッシュを捨てる。取り出しは `CredentialManager.withToken`（`apps/gateway/src/github/credentials.ts:108`。401 で 1 回だけ強制リフレッシュ。世代の CAS）だけで、**戻り値にトークンは出ない**。
- `ensureMember`（`:770`）は 5 分キャッシュ（`MEMBERSHIP_CACHE_TTL_MS` `:24`）で team 所属を確かめる。`authorizeStart`（`:806`）は `client.findWritableRepository` を呼ぶ。

### 認可・暗号・GitHub

- 許可ルール: `loadAllowRules`（`apps/gateway/src/auth/allowlist.ts:40`。org/team と user ID の OR。不正は null）、`isUserIdAllowed`（`:53`）。**ダッシュボードのログインも同じルールで拒否する**。
- `GitHubClient.findWritableRepository`（`apps/gateway/src/github/client.ts:155`）は `GET /user/installations?per_page=100`（`:175`）→ `GET /user/installations/{id}/repositories?per_page=100`（`:182`）を `paginate`（`:475`。`Link` ヘッダ）でたどる。**閲覧用に同じ列挙で repository id の集合を作れる**（push 権限の条件を外す）。
- 暗号: `encryptString` / `decryptString`（`apps/gateway/src/github/crypto.ts:29,44`）。`TOKEN_ENC_KEY` の AES-GCM で、**`aad`（用途ラベル）を引数に取る**。セッション Cookie には専用の AAD `dashboard-session-v1` で流用できる。
- ログイン: `/authorize`（`apps/gateway/src/auth/login.ts:88`。同意画面）→ GitHub → **`/callback`（`:154`）が `OAUTH_PROVIDER.finishUpstream`（`:161`）で MCP の認可の復元**（`completeAuthorization` `:216`）。state は OAuthProvider が管理し、開始したブラウザの `__Host-` Cookie に紐付く。`saveCredential`（`:212`）で資格を UserDO に保存する。
- **GitHub App のコールバック URL は `/callback` の 1 本だけ**（`scripts/github-app-lib.mjs:32` の manifest `callback_urls`。`redirectUrl` は manifest フローの受け口で別物）。**`/dashboard/...` を新しいコールバックにすると、既存の GitHub App の設定を手で直す手順が増える**（D2）。

### デプロイ

- 下流の設定は `ROVO_DEPLOY_DIR/*.wrangler.jsonc`。雛形は `deploy.example/gateway.wrangler.jsonc`（`main` は設定ファイルからの相対 `../apps/gateway/src/index.ts`）。生成器は `scripts/deploy-config-lib.mjs`（`APPS = ["gateway","agent","web"]` `:17`）で、`<...>` を `rovo.config.json` と terraform の出力で埋める。fixtures は `scripts/fixtures/deploy-config/`。
- `scripts/deploy.sh`: `deploy_one`（`wrangler deploy -c <下流の設定>`）。`all` は `web → agent → gateway`。`mise run deploy:gateway` も `deploy:all` も同じ `deploy.sh` を通る。**ビルドを `deploy.sh` の gateway 経路に入れれば、両方に効く**（D12）。現状 `deploy_one` はデプロイの直前に何もビルドしていない。
- `mise.toml`: `build:gateway` は `wrangler deploy --dry-run --outdir dist`（`:194-197`）。**`assets.directory` が存在しないとこの dry-run も失敗する**ので、`build:gateway` と gateway の E2E（wrangler dev）は `build:dashboard` に依存させる。
- Cloudflare API トークン: `infra/main.tf:135` の `cloudflare_api_token.ai_gateway_read`（権限は **AI Gateway Read だけ**）が `gateway_cloudflare_api_token` として出力され、`deploy:secrets` が `wrangler secret put CLOUDFLARE_API_TOKEN` する（`scripts/deploy.sh` の `secrets_main`）。**コンテナ・Workers の分析（GraphQL）やクレジット残高を読む権限は無い**（D13）。`vars.CLOUDFLARE_ACCOUNT_ID` / `AI_GATEWAY_ID` は gateway にある。

### agent のイベント

- `apps/agent/src/agent-do.ts`: `summarizeArgs`（`:177`。**マスクしたうえで先頭 200 字**）、`tail`（`:173`。末尾 N 字）。`tool_start`（`:1810`。`callId`・`name`・`summary`）、`tool_end`（`:1818`。`isError`・`summary` = **マスクした結果の末尾 200 字**。web_* は別の要約）。`usage` は `appendEvent("usage", ...)`（`:1577,1704,1963`）。イベントの全文字列は `maskEventStrings`（`:187`）で `maskSecrets`（`apps/agent/src/redact.ts:23`）を通る。
- gateway 側: `mapAgentEvent`（`apps/gateway/src/agent/agent-events.ts:145`）が既知の type だけを項目選択して通し、**未知の type は type 名だけ**（`agent_event`）にする。文字列は `MAX_PUBLIC_TEXT = 500`（`:9`）で切る。
- **現状では「完全な command」「編集したファイル一覧」「commit の履歴」は出せない**: `tool_start.summary` は引数の JSON の先頭 200 字、`tool_end.summary` は結果の末尾 200 字だけ。コマンド・パス・commit メッセージが構造化されていない。→ 構造化イベントを agent に足す（M7）。
- MCP への出し方: `task_wait` は `tool_start` / `tool_end` / `completion_report` 等を UNTRUSTED で囲んで返す（`apps/gateway/src/mcp/server.ts:55`）。**新しいイベントの型は MCP の応答に出さない**（D14）。

### 関連する最近の変更

- 同時実行数の設定化（`reservation_slot`、`concurrency_limit`）は main に入っている。
- usage の `sandbox_runtime_ms` / `cache_build_ms` / `deps_cache`（`agent-events.ts:81-110`）、task_result の `duration_ms` / `reason` / `failure_phase`（`task-do.ts:165-232`）は main に入っている。
- **`sandbox_instance` と、子の出力の整形（囲みの記号の除去・マルチバイトで切らない・ANSI の除去）は作業中で main に無い**。ダッシュボードの設定欄の「Sandbox の大きさ」と出力の枠は、これらが入るまで空/素のままになる。**M7・M8 の着手前に main へ入っているかを確かめる**（依存）。

## 範囲と、やらないこと

- 範囲: 上の要件。新しい package は `apps/dashboard`（SPA）と `packages/dashboard-contract`（DTO と fixtures）。gateway は DirectoryDO・ログイン・読み取り API・assets を足す。agent は構造化イベントを足す。
- やらないこと
  - **書き込み操作**（タスクの開始・キャンセル・回答・PR のマージ）。ダッシュボードは読み取り専用で、操作は MCP に残す。
  - 過去分の遡及索引（索引を作る前のタスクは出さない。`ensureCreated` から先を索引する）。
  - SSE / WebSocket（まずポーリング。後回し）。
  - Cloudflare の任意の GraphQL・AI Gateway のログ本文（prompt / body）の表示。
  - 通知、アラート、検索 UI、エクスポート。
  - 下流（デプロイ用の private リポジトリ、IaC のリポジトリ）のファイルの変更。Portal / Access への `/dashboard` の追加は下流の範囲（docs/deploy.md に書くだけ）。
  - ユーザー自身の環境（Access / Portal の設定など）は、インフラを管理する別のリポジトリに設定を足す**別作業**（この計画の範囲外。docs/deploy.md には OSS 利用者向けの内容だけを書く）。

## 設計の要点（承認済みの設計の写し。実装の前提）

- **索引**: シングルトンの `DirectoryDO`。**outbox 方式**: TaskDO のローカルのトランザクションで `index_dirty` と単調増加の `revision` を保存し、既存の alarm で配送・再試行する。Directory は古い revision を拒否する（冪等）。usage の更新・PR の更新も拾う。**索引の障害でタスク本体を失敗させない**（fail-open。配送の失敗は次の alarm で再試行）。費用は「タスクの費用」（TaskDO の `usage_micro`）と「consult 込みの予算の実績」（UserDO の `task_budget`）を**別の DTO**にする。
- **認可**: 閲覧者のユーザートークンで `GET /user/installations/{id}/repositories`（全ページ・複数 installation）を列挙し、repository id の集合を得る。一覧だけでなく**詳細・events・result・件数**にも同じ判定をかける。詳細は **TaskDO の今の `repository_id` で再認可**する（索引を権限の根拠にしない）。`repository_id` の欠落・GitHub の障害は **fail closed**。キャッシュは短く（詳細の開始時は GitHub で確認、401/403 で破棄、stale を延ばさない）。ダッシュボード専用の読み取り RPC を TaskDO / DirectoryDO / UserDO に置く。
- **ログイン**: 既存の `/callback` は MCP の認可の復元専用なので、**そのロジックを流用しない**。ブラウザ専用の短命・一回限りの state を、開始したブラウザの Cookie に紐付け、戻り先は固定。セッション Cookie には uid・セッション ID・version・iat/exp だけを入れ、GitHub トークンは入れない。`__Host-`（`Path=/`、Domain なし）。`TOKEN_ENC_KEY` の AES-GCM を専用 AAD `dashboard-session-v1` で流用する。サーバー側の失効・ログイン世代も照合する。読み取り API は same-origin・CORS なし。
- **進み具合**: マスク済みの**構造化イベント**（command、編集したパス、commit のメッセージなど）を agent に足す。React のエスケープは秘密の除去ではない。制御文字・危険な URL scheme・Markdown/HTML・外部画像は表示せず、テキストとして表示する。
- **配信**: SPA は `/dashboard` 配下に限定。assets の `run_worker_first` で Worker を優先し、OAuthProvider の経路・`/mcp`・`/api` を飲み込まない（未知の `/api` は JSON 404）。ビルドは `deploy:all` の依存ではなく `scripts/deploy.sh` の gateway のデプロイ経路に入れる（`deploy:gateway` にも効く）。`deploy.example`・生成器・fixtures・Env の型も更新する。
- **Cloudflare の概要**: サーバー側で rovo の Worker 名・container application・gateway id に固定した集計 DTO だけを返す（任意の GraphQL を出さない、AI Gateway の logs の prompt / body を返さない）。credit balance は残高だけ。`containersMetricsAdaptiveGroups`。取れない項目は「取得できない」と表示する。
- **自動更新**: まず 5 秒のポーリング（cursor・バックグラウンドのタブで停止・backoff・重複排除・継続的な再認可）。Cloudflare の集計は 30〜60 秒の共有キャッシュ。SSE は後回し。

## 決めること

各項目に、設計の判断を並べた。**D2・D7・D9・D13・D18 は 2026-10-21 にユーザーが個別に決定した。ほかの項目は推奨どおりで確定**（計画の承認に含む）。

### D1. SPA の置き場所とスタック

`apps/web` は Web Research Service で別物（現状の節）。

| 案 | 内容 | 長所 | 短所 |
|---|---|---|---|
| A | `apps/dashboard`（Vite + React + TypeScript）を新設し、ビルド成果物（`dist`）を gateway の `assets.directory` にする | 責務が分かれる。pnpm workspace（`apps/*`）に自動で入る。Worker のコードと依存が混ざらない | package が 1 つ増える |
| B | `apps/gateway` の中に SPA を置く | package が増えない | gateway の依存（workerd 向け）に React / Vite が混ざる。型・lint・テストの設定が衝突する |
| C | `apps/web` を SPA に転用し、Research Service を改名する | — | 名前の変更が多方面（`rovo-web`・service binding・docs・下流）に及ぶ。却下 |

- **推奨: A**。`apps/dashboard` に React + Vite + TypeScript。ルーターは 2 ルート（一覧・詳細）だけなので、依存を増やさず自前の最小実装にする（M6 で決める）。状態管理ライブラリは入れない（`fetch` + `useReducer` + 小さなポーリングのフック）。チャートは SVG を自前で描く（見本のタイムラインは棒と点だけで、チャートライブラリの重さに見合わない）。
- 理由: 見本の見た目（形で区別する、影を使わない）はライブラリの既定と合わない。依存が少ないほど、OSS としてのサプライチェーンの点検（`pnpm audit`・`licenses`）が軽い。
- フォントは **自前配信**（assets に同梱。見本の 3 書体はいずれも OFL と思われるが、**ライセンスは取り込み時に確認する**）。外部の Google Fonts に頼ると、CSP が緩くなり、閲覧が外部に漏れる。サブセット化して和文の容量を抑える。

**決定（2026-10-21）: 推奨どおり**（D1）。

### D2. ダッシュボードのログインのコールバック URL

GitHub App の `callback_urls` は `/callback` の 1 本だけ（manifest `scripts/github-app-lib.mjs:32`）。既存の App に callback を足すには手で App の設定を直してもらう必要がある（App の callback を更新する API は無いと見られるが、**未確認**。実装前に GitHub Docs で確かめる）。

| 案 | 内容 | 長所 | 短所 |
|---|---|---|---|
| A | 新しい URL `/dashboard/auth/callback` を使う。manifest の `callback_urls` に足す | 経路が分かれる。コードが単純 | **既存の GitHub App では手作業が前提**（API が無いと見られる）。deploy の簡単さの要件に反する。足し忘れるとログインできない |
| B | **URL は `/callback` のまま**にして、`/callback` の先頭で **state の接頭辞だけ**を見て、ダッシュボードのハンドラに振り分ける。接頭辞が無ければ今までどおり `finishUpstream` | **GitHub App の設定を変えない**。既存・新規のどちらも手順が増えない。不一致の失敗が MCP の経路に落ちない | `/callback` に分岐が 1 つ入る |
| C | A と B を両対応にする | — | 二重の経路。却下 |

- **推奨: B**。振り分けの鍵は **state の接頭辞だけ**（例 `rovo-dash.`）。
  - 接頭辞が付いていれば、**必ずダッシュボードのハンドラに入る**。KV の記録・専用 Cookie（`__Host-rovo_dash_login`）・期限・再使用の不一致は、そこで **400（fail closed）**。MCP の経路には落とさない。
  - 接頭辞が無ければ今までどおり `finishUpstream`（MCP の認可の復元）。
  - 理由: 「KV・Cookie・接頭辞の三重一致のときだけ振り分け、不一致は MCP に落とす」案だと、ダッシュボードの不一致が `login.ts:161-169` で `auth_failed` / `invalid_state` として **MCP 側の監査を汚す**。
  - **衝突しない根拠**: OAuthProvider の state は base64url（32 バイト）で、alphabet に `.` が無い（`workers-oauth-provider@1.2.3` の `oauth-provider.js:2292-2299`。**実装の最初に再確認する**）。接頭辞 `rovo-dash.` は OAuthProvider の state と衝突しない。これを固定する Unit: OAuthProvider が発行する state が `^[A-Za-z0-9_-]{43}$` に一致すること（将来のバージョンアップで形が変わったら落ちる）。
  - ダッシュボードの KV キーは OAuthProvider の `transaction:` と**別の接頭辞**（例 `dash-state:`）にする。
- **「流用しない」の対象を明文化する**: 流用しないのは **`finishUpstream` / `completeAuthorization`（MCP の認可の復元）**。一方、`login.ts:190-212` の**身元確認**（`exchangeCode` → `getUser` → 許可ルール〔`isUserIdAllowed` / `isActiveTeamMember`〕→ `saveCredential`）は、**共通の関数に切り出して両方から呼ぶ**（二重実装は許可ルールの判定のずれの原因になる）。監査は、ダッシュボード由来のログインの `reason` / `caller` を MCP と区別する（例 `caller: "dashboard"`。`@rovo/audit` の allowlist に追加が要るかを M4 で確かめる）。
- 承認済みの設計の文言（「既存の `/callback` を流用しない」）から外れる点は「気づいた矛盾・提案」に書いた。承認が得られなければ A（App の callback を手で足す手順を docs/deploy.md と `github-app` スクリプトの案内に足す）。

**決定（2026-10-21）: 案 B。** `/callback` の URL だけ共有し、state の接頭辞 `rovo-dash.` だけで振り分ける。処理・KV・Cookie は分離し、身元確認は共通関数に切り出す。却下: 案 A（既存の GitHub App に手作業が要り、デプロイの簡単さに反する）、案 C（二重の経路）。

### D3. セッションの保管・期限・失効

| 項目 | 選択肢 | 推奨 |
|---|---|---|
| セッションの記録の置き場所 | (a) UserDO の新テーブル `dashboard_session`（sid・version・created/expires・revoked）<br>(b) KV（`OAUTH_KV`）<br>(c) 状態を持たない署名 Cookie だけ | **(a)**。Cookie に `uid` が入っているので UserDO を引き当てられ、GitHub の資格と同じ DO にあるため、ログアウト・資格の失効と同じトランザクションで消せる。(b) は結果整合で失効が遅れる。(c) はサーバー側の失効ができず要件に反する |
| 期限 | 絶対期限と、無操作の期限 | **絶対 7 日 + 無操作 8 時間**（Cookie の `exp` は絶対期限。無操作は DO の `last_seen` で見て、更新は最大 5 分に 1 回）。短めに倒す（運用画面で、GitHub の権限が変わりうる） |
| ログイン世代 | UserDO に永続の `dashboard_epoch`（ログインのたびに進める）を持ち、Cookie の `version` と照合 | 採用。MCP の `loginEpoch`（メモリのみ。`user-do.ts` の `loginEpoch`）とは**別**にする（MCP の再ログインでダッシュボードを落とさない。ダッシュボードの再ログインは古いセッションを全部失効させる） |
| ログアウト | `POST /dashboard/api/logout` | 採用。sid を失効し、Cookie を `Max-Age=0` で消す。GitHub 側の取り消しはしない（MCP の資格が同居するため） |

- Cookie の中身: `{uid, sid, ver, iat, exp}` を JSON にして `encryptString(key, json, "dashboard-session-v1")`（`crypto.ts:29`）。属性は `__Host-rovo_dash`・`Path=/`・`Secure`・`HttpOnly`・`SameSite=Lax`・Domain なし。読み取り API は `GET` だけで状態を変えないので、`Lax` で許容する（CSRF の節）。**専用のログイン Cookie（`__Host-rovo_dash_login`）も `SameSite=Lax`**（`Strict` は不可）: GitHub からの戻りはクロスサイトのトップレベル `GET` で、`Strict` だと Cookie が送られず state の照合に失敗する。E2E の前提: `wrangler dev` の `http://localhost` で、Chromium が `Secure` / `__Host-` の Cookie を受け付けること（localhost は安全なコンテキストとして扱われると思われるが、**M4 の最初に実機で確かめる**。受け付けなければ E2E だけ `ENVIRONMENT=test` で接頭辞を外す等を検討）。
- 検証の失敗は一律 401（理由を出さない）。

**決定（2026-10-21）: 推奨どおり**（D3）。

### D4. ダッシュボードのログインで GitHub のユーザートークンを保存するか

閲覧のたびに GitHub で権限を確かめる（D5）には、閲覧者のユーザートークンが要る。トークンは UserDO の `github_credential`（利用者に 1 組）にしか置けない。

- 案 A（推奨）: ダッシュボードのログインでも `saveCredential` する（最新の資格が勝つ。`CredentialManager.save` は世代の CAS）。MCP の資格と同じ GitHub App のユーザートークンなので、同じものを共用する。副作用: `loginEpoch++` と所属キャッシュの破棄だけ。
- 案 B: ダッシュボード専用の資格を別に持つ（別テーブル）。トークンの保管場所が増え、リフレッシュ（refresh token は 1 回限りの回転）の管理が 2 系統になる。却下。
- 案 C: 資格を保存しない（ログイン時の 1 回だけ権限を確かめる）。要件（継続的な再認可）に反する。却下。
- 注意: 閲覧中に資格が `reauth_required`（リフレッシュ切れ）になりうる。その場合は 401 で再ログインを促す（セッションは失効させる）。
- **リスク（案 A の副作用）**: 資格は MCP と共用なので、**ダッシュボード側で資格が失効（`reauth_required` で `compareAndPut(…, null)`）すると、MCP も再ログインが必要になる**（逆も同じ）。また、ダッシュボードのログイン由来の `saveCredential` と、MCP の `withToken`（リフレッシュ）が同時に走ると、世代の CAS（`credentials.ts:144-185`）の勝ち負けで片方の結果が捨てられる。負けた側は勝った側の資格を使う設計だが、**テストで固定する**（安全のテストに追加。M4・M5）。別資格（案 B）は保管場所とリフレッシュが 2 系統になるので採らない。

**決定（2026-10-21）: 推奨どおり**（D4）。

### D5. 認可の判定単位とクエリ

- 閲覧者の「見えるリポジトリ」は **repository id の集合**（`GET /user/installations` → 各 `/repositories`、全ページ）。`UserDO.visibleRepositoryIds()` として、トークンを戻り値に出さず id の配列だけを返す。App がインストールされていないリポジトリのタスクは作られない（`authorizeStart`）ので、集合は「インストール済み ∩ 閲覧者が見える」で足りる。
- **一覧**: gateway が集合を DirectoryDO に渡し、Directory は `WHERE repository_id IN (SELECT value FROM json_each(?))` で絞る（SQLite の変数の上限を避けるため JSON 配列を 1 つ渡す）。件数・集計・ページングも**同じ集合で**数える（絞った後でページを切る。絞る前に切ると件数と中身が食い違う）。集合が大きすぎる（既定 10,000 件超）場合は fail closed（503）。
- **詳細・events・result（簡素化した案）**: `repository_id` は `task` 行の INSERT（`task-do.ts:893-901`）でしか書かれず、`UPDATE` が無い（`grep repository_id` で確認済み。実装時に再確認する）。したがって、**TaskDO の `dashboardRead()` が `repository_id` を含む view を 1 回返し、gateway が集合で判定する**だけでよい（RPC は 1 往復。`expectedRepositoryId` の照合は要らない）。「索引（Directory）ではなく、**TaskDO の今の値**で判定する」は保たれる。判定に通るまで、view は応答に出さない。不一致・NULL・集合に無い・存在しないは**同じ 404**（存在を漏らさない）。events も同じ（`repository_id` を含めて返すか、軽い RPC で先に取る）。
- fail closed の条件（すべて 404 または 503。中身は返さない）: `repository_id` が NULL、GitHub が 5xx / タイムアウト、列挙が途中で失敗（部分的な集合は使わない）、資格が無い / 失効、許可ルール（`loadAllowRules`）が不正。
- GitHub の呼び出し回数: 閲覧者 1 人あたり、集合の取得に installation 数 + ページ数の呼び出し。キャッシュは D6。
- **代替案（必須ではない）**: 閲覧者の全リポジトリを列挙する代わりに、Directory から**期間内（今日・今月）の distinct な `repository_id`** だけを取り、そのリポジトリだけを閲覧者のトークンで照合する。長所: リポジトリが多い組織で GitHub の呼び出しが減る。短所: 呼び出しが distinct な ID の数に比例し、1 件ごとの失敗の扱い（その 1 件だけ隠す）が増え、`installations/{id}/repositories` と「見える」の定義が揃うかの確認が要る。最小の版では全件の列挙を取り、遅い・多すぎるときにこの案へ切り替える。

**決定（2026-10-21）: 推奨どおり**（D5）。

### D6. キャッシュの TTL

| 対象 | 推奨 |
|---|---|
| 閲覧者の見えるリポジトリの集合 | UserDO のメモリに保持。**一覧は 30 秒**。**詳細は、開いた最初の 1 回は必ず GitHub で取り直し**（キャッシュを使わない）、以降のポーリングは 30 秒のキャッシュ。401 / 403 を受けたら破棄。取得に失敗したときは古い集合を**使わない**（stale を延ばさない）。進行中の取得は 1 本に束ねる（`memberInflight` と同じ作り） |
| セッション | D3 |
| Cloudflare の集計 | D13。30〜60 秒の共有キャッシュ（Cache API かメモリ） |
| 索引の一覧 | キャッシュしない（Directory の SQL は軽い） |

- 理由: 権限の取り消しの反映は最大 30 秒の遅れを許容し、詳細の開始時だけは厳密にする。メモリのみ（DO の退避で消える）にして、ディスクに権限を残さない。

**決定（2026-10-21）: 推奨どおり**（D6）。

### D7. 見えないタスクの扱い（レーン・表・集計）

要件: 「費用などの集計は全員分でよい」「private の名前・内容を権限の無い人に見せない」。

- **推奨**: タイムラインのレーンと表は**見えるタスクだけ**。今月の費用・モデル別の費用・予算の実績の**金額の合計は全員分**（見えないタスクを含む）。ただし、表の下に「権限の無いリポジトリのタスクが N 件、費用の合計に含まれます」と **件数だけ**を出す（0 件なら出さない）。リポジトリ名・題名・人の名前・時刻は出さない。
- 検討した案: (a) 見えないタスクも匿名の棒で描く（時刻・費用・人のレーンから存在とパターンが推測できる）。却下。(b) 集計も見えるものだけにする（承認済みの要件と食い違う）。却下。
- 「自分」に絞っても、**権限を後で失った場合は自分のタスクでも隠す**（同じ判定）。
- 件数を出すこと自体が存在を示す点は、要件が集計を全員分としているため許容する（「未決事項」）。
- **費用の推定（ユーザーの判断事項）**: 「合計は全員分」「見えるタスクの費用」「隠れた N 件」が並ぶと、**差し引きで隠れたタスクの費用が推定できる**（N=1 なら、その 1 件の費用そのもの）。private のタスクの存在・費用の規模が、権限の無い人に分かる。対策の選択肢: (a) 許容する（要件どおり。推奨）、(b) 隠れた件数を出さず、合計だけを出す（差し引きは残るが、件数は分からない）、(c) 合計を「見えるタスクの分」と「その他」に分け、「その他」の最小単位を丸める（例 $1 単位）、(d) 集計も見えるものだけにする（要件と食い違う）。**ユーザーが決める**（末尾の「ユーザーに判断を仰ぐ点」）。
- 漏れのテスト（M5）: 権限の無いタスクについて、`task_id`・`owner_login`・`repository`・`pr_url`・`model`・`title` が**応答のどこにも出ない**ことを、**応答の本文全体の検索**で固定する（フィールド単位の検査では足りない。エラー本文・ヘッダ・隠れた件数の周辺も含む）。

**決定（2026-10-21）: 案 (a)。** 見えないタスクはレーンと表から外し、「権限の無いタスク N 件」と全員分の合計を出す。**差し引きで隠れた費用が推定できる点（N=1 ならその 1 件の費用）は了承済み。** 却下: (b) 件数を出さない（差し引きは残るので利点が小さい）、(c) 「その他」を丸める（要件の「集計は全員分」から離れる）、(d) 集計も見えるものだけ（要件と食い違う）。

### D8. 「今月の予算」と「あと何件始められるか」

予算は利用者ごと（現状の節）。

- 「自分」: 閲覧者本人の `budgetStatus()`（`remaining_usd`・`max_concurrent_tasks`・`concurrency_limit`・実行中の枠）をそのまま。**あと何件 = `min(max_concurrent_tasks, concurrency_limit - 実行中の件数)`**。
- 「全員」: 全員の実費の合計（Directory の月合計。タスクの費用）と、consult の実績の合計。**「あと何件」は閲覧者本人の値だけ**を表示する（他人の枠は出さない。ラベルを「あなたの残り」にする）。
- 費用の 2 つの DTO: (1) `TaskCostDto`（タスク 1 件の `cost_usd` と内訳。TaskDO の `usage_micro`）、(2) `BudgetActualDto`（consult を含む月の実績。`spent` と `estimated` を分ける。`settled_estimated`）。画面で足し合わせない。
- 月の区切りは **UTC**（`budgetStatus` の `period` と同じ）。画面に「UTC の月」と明記する（矛盾の節）。

**決定（2026-10-21）: 推奨どおり**（D8）。

### D9. consult を索引に入れる方法

**最初の版に入れる（2026-10-21 の決定。後回しにしない）。** タイムラインの灰の点とモデル別の consult 費用を出す。M3 は M3a（TaskDO の outbox + DirectoryDO）と M3b（consult の outbox と UserDO の alarm）に分け、全体で L に戻す。

| 案 | 内容 | 推奨 |
|---|---|---|
| A | UserDO に outbox を足し（consult の settle のトランザクションで保存）、UserDO に alarm を足して Directory へ配送。モデル名を持つ新テーブルを足す | **採用** |
| B | consult の呼び出し側（`consult.ts`）から Directory を直接 fire-and-forget で呼ぶ | 取りこぼす。タイムラインの点とモデル別の費用が欠ける。却下 |
| C | consult は索引に入れず、画面の consult の点と consult 分の費用を出さない | 要件（灰の点、モデル別）を満たせない。却下（「最小の版」として一度提案したが、ユーザーが不採用） |

- 変更: consult 専用の新テーブル `consult_log`（consult_id・at・model・cost_micro・estimated・revision・index_dirty）を UserDO に足す。`reserveConsult` で行を作り（`model` は `consult.ts:109` で決まった値を渡す。**シグネチャの変更**）、`settleConsult` で確定。UserDO に alarm を足すのが大きい変更なので、手元でやる（M3b）。
- 表示は consult の ID・時刻・モデル・費用のみ（内容は保存しない）。consult の対象リポジトリは無いので、**権限の判定は不要**。consult の「誰が」は、**人のレーンに灰の点として見せる**（内容は無い）。

**決定（2026-10-21）: 案 A。** consult も最初の版に入れる。点は人のレーンに見せる。

### D10. 索引（DirectoryDO と outbox）の詳細

- 行（`task_index`）: task_id・owner_id・owner_login・repository・repository_id・title・status・model・effort・created_at・updated_at・started_at/ended_at（`status_changed` イベントの時刻から）・cost_micro・pr_number・pr_url・pr_draft・pr_merged・reason・failure_phase・deps_cache・sandbox_runtime_ms・**revision**。`task_id` が主キー、`(created_at DESC, task_id)` と `repository_id` に索引。
- outbox（TaskDO 側）: `meta` か新テーブルに `index_revision`（単調増加）と `index_sent_revision`。**行を変える同期区間の中で** `index_revision++`（`changeStatus` と usage の更新と PR の更新と `ensureCreated`）。`needsAlarm` に `index_revision > index_sent_revision` を足す。alarm で `Directory.upsert(snapshot, revision)` を呼び、成功したら `index_sent_revision = revision`。Directory は `revision <= 保存済み` を無視（冪等）。失敗しても `advance()` は例外にしない（索引の障害でタスクを失敗させない。`guard` と同じ流儀で fail-open）。
- 配送の頻度: usage は頻繁に更新される（`applyPage` ごと）ので、`index_revision` は上げるが**配送は alarm の周期（10 秒）にまとめる**（1 回の alarm で最新の snapshot を 1 回送る）。一覧は最大 10 秒遅れる。詳細の「状態」は TaskDO を直接読むので遅れない。
- 初期化: `ensureCreated`（`task-do.ts:855`）で最初の revision を立てる。デプロイ時点で実行中のタスクは、次に更新が来た時点で索引に入る（過去分は出さないので、遡及はしない）。**終端済みの古いタスクは索引に入らない**。
- Directory の保持: 削除しない（容量は 1 件 1 KB 未満の見積もり。**要確認**: DO の SQLite の上限）。古い行の掃除は後回し（未決事項）。
- 再構築用の管理操作は作らない（読み取り専用。壊れても次の更新で追いつく）。
- 単一の DO に全員の読み取りが集まる（組織の規模では問題ない見積もり。M3 の Unit に件数の上限の確認を入れる）。

**決定（2026-10-21）: 推奨どおり**（D10）。

### D11. 配信（assets・Worker の優先・API のパス）

- `assets`: `{ "directory": "../dashboard/dist"（upstream の設定からの相対）, "binding": "ASSETS", "run_worker_first": true }`。`not_found_handling` は使わない（Worker が SPA のフォールバックを自分で決める）。
- **推奨: `run_worker_first: true`** にして、Worker が `/dashboard/*` だけ `env.ASSETS.fetch` に渡す。それ以外は OAuthProvider（今までどおり）。理由: assets の自動配信に任せると、SPA のフォールバック設定（`not_found_handling: single-page-application`）が `/mcp` や `/.well-known/...` の GET を `index.html` で返しうる（OAuthProvider の経路を飲み込む）。Worker が 1 か所で決めれば、「未知の `/api/*` は JSON 404」「`/dashboard/` 以外の HTML は返さない」を 1 つのテストで固定できる。静的ファイルの取得が Worker の呼び出しとして課金対象になる点は許容する（アクセスは組織の内部だけ）。
- SPA のフォールバック（Worker 内）: `GET /dashboard`・`/dashboard/` と `/dashboard/tasks/<ULID>` → `index.html`。`/dashboard/assets/*` はファイルがあればそれ、無ければ 404（`index.html` を返さない。壊れたスクリプトが HTML で返るのを避ける）。
- API のパス: `/dashboard/api/*`（SPA と同じ prefix。Cookie は `Path=/` の `__Host-` なので届く）。`GET` のみ（logout の `POST` を除く）。未知の `/dashboard/api/*` は JSON 404。
- レスポンスヘッダ（HTML）: `Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`、`X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`、`Cache-Control: no-store`（HTML）。`style-src 'self'` に合わせ、**`<style>` 要素とマークアップの `style` 属性を作らない**（動的な値は SVG の属性や CSS クラスで表す。ビルド成果物の検査で `<style` と `style=` が `dist` の HTML に無いことを確かめる）。assets のハッシュ付きファイルは `immutable`。
- **API の JSON** にも `X-Content-Type-Options: nosniff` と `Cache-Control: no-store`（`Content-Type: application/json`）を付ける。**`Sec-Fetch-Site: cross-site`（および `same-site`）の API 呼び出しは 403** で拒否する（`same-origin` と、ヘッダの無い古いクライアントの扱いは M4 で決める。ヘッダが無い場合はナビゲーション以外の API では拒否を推奨）。CORS ヘッダは出さない。
- **実装メモ（base パス）**: Vite の `base: "/dashboard/"` は、出力先に `dashboard/` のディレクトリを掘らない（`dist/index.html`、`dist/assets/...`）。一方 assets のパスは `dist` 直下からなので、(i) Worker が `/dashboard/` の接頭辞を**剥がして** `ASSETS.fetch` に渡す、または (ii) `dist/dashboard/` 配下に出力する（`build.outDir` を `dist/dashboard` にして `assets.directory` は `dist`）のどちらかにする。M1 の最初に決める（推奨: (i)。assets のパスと URL が 1 対 1 でなくなる代わりに、`dist` の構造を素直に保てる）。
- OAuthProvider の `apiRoute: "/mcp"` と `/dashboard` は重ならない。ただし **`/dashboard/api` を OAuthProvider の `apiRoute` にしてはいけない**（Bearer 用）。

**決定（2026-10-21）: 推奨どおり**（D11）。

### D12. ビルドとデプロイへの組み込み

- `mise.toml` に `build:dashboard`（`dir = "apps/dashboard"`、`pnpm exec vite build`）を足す。`build:gateway` と、gateway の E2E / dev の前に `build:dashboard` を依存させる（`assets.directory` が無いと wrangler が失敗する）。`build` は dashboard も含める。
- **`scripts/deploy.sh` の gateway の経路**: `deploy_one gateway` の前に dashboard のビルド（`pnpm --filter` か `(cd apps/dashboard && pnpm exec vite build)`。`deploy.sh` は既に `pnpm exec wrangler` を呼んでいるので mise を経由しない）。`all` も `gateway` 単体も `deploy_one` を通るので、`deploy_one` の中で `gateway` のときだけビルドする。ビルドの失敗はデプロイの失敗として止める（古い `dist` をデプロイしない。ビルド前に `dist` を消す）。
- **`test:unit:gateway` も影響を受ける可能性（要確認）**: `apps/gateway/vitest.config.ts:17` は `wrangler.jsonc` をそのまま読む（`cloudflareTest` の `wrangler.configPath`）ので、`assets.directory` が存在しないと Unit が落ちるかもしれない。**M1 の最初の Red で確かめ**、(a) placeholder の `dist`（空の `index.html`）をコミットしない形で Unit の前に作る、(b) `test:unit:gateway` を `build:dashboard` に依存させる、(c) Unit 用の設定だけ `assets` を外す、のどれにするかを決める（推奨: (c)。Unit は実ファイルの配信を見ないので、偽の `ASSETS` で足りる。E2E と `build:gateway` は (b)）。
- 依存: ビルドは `pnpm install` 済みを前提にする（今のデプロイもそう）。**新しい secret・トークン・手順は無い**。
- 下流の設定: `deploy.example/gateway.wrangler.jsonc` に `assets`（`"directory": "../apps/dashboard/dist"`）を足す。生成器 `scripts/deploy-config-lib.mjs` はテンプレートの `<...>` を埋めるだけなので、`assets` は固定値で置換の追加は要らない見込み（要確認）。fixtures（`scripts/fixtures/deploy-config/`）の期待値と `deploy-config.test.mjs`、`test-deploy.sh`（`deploy.sh` の自己確認。**偽の pnpm がダッシュボードのビルドを呼ぶことを確かめる**）を更新する。
- `Env` の型: `ASSETS: Fetcher` を `env.d.ts` に補う。`DIRECTORY_DO` の binding と `migrations` に `v2`（`new_sqlite_classes: ["DirectoryDO"]`）。下流のテンプレートにも同じ。
- 注意: 既存のデプロイでは、migration `v2` を含む gateway のデプロイで DO クラスが追加される。`deploy:all` の順（web → agent → gateway）は変えない。
- `docs/deploy.md` に、`/dashboard` の説明（認証は GitHub、Portal / Access をかけるかは下流の判断）と、ビルドが自動であることを書く。

**決定（2026-10-21）: 推奨どおり**（D12）。

### D13. Cloudflare の概要を取るトークンの権限

必要な読み取り: (a) コンテナの稼働（`containersMetricsAdaptiveGroups`）、(b) AI Gateway の費用 / リクエスト数、(c) クレジット残高（取れるなら）。現在のトークンは **AI Gateway Read だけ**（`infra/main.tf:135`）。権限の名前と、各 API が要求する権限は、実装時に Cloudflare のドキュメントで確かめる（**この計画では断定しない**）。

| 案 | 内容 | 長所 | 短所 |
|---|---|---|---|
| A | 今の権限で取れる範囲に限る（AI Gateway の集計だけ。コンテナ・残高は「取得できない」） | 権限・手順が増えない | 要件の主目的（コンテナの稼働）が出ない |
| B | **既存のトークンに、読み取りの権限（Analytics 系）を Terraform で足す**。`terraform apply` で同じトークンの権限が増え、`deploy:secrets` の流れ（`terraform output -raw`）はそのまま | **新しい手順が増えない**（`mise run setup` の中に収まる。既存の環境は `terraform apply` が要り、トークンの値が変わる場合だけ `--rotate cloudflare-token`） | トークンの権限が広がる（読み取り専用だが「AI Gateway Read だけ」でなくなる）。既存の環境では apply までは「取得できない」。**トークンの `name`（`...-ai-gateway-read`、`infra/main.tf:135-143`）を実態に合わせて変えると、リソースが再作成されて値が変わる可能性がある（`--rotate cloudflare-token` が必須になる）**。名前は**変えずに**、リソースの上にコメントで実態（AI Gateway Read + 分析の読み取り）を書く案を併記する（推奨。リソースのアドレスも変えない）。名前を変える場合は、再作成されるかを `terraform plan` で確かめてから |
| C | 別の専用トークン（Analytics Read）と別の secret を足す | 権限が分かれる | secret と手順が増える。**要件に反する**。却下 |

- **推奨: B**（fail-soft つき）。トークンに権限が無い・API が失敗した項目は、画面に「取得できない（権限を確認）」と出し、**画面全体は壊さない**。権限が不足でも A の範囲が動くので、既存の環境は apply までの間 A と同じ表示になる。
- サーバー側の固定: Worker 名（`rovo.config.json` の `workerNames` から来る値を `vars` に足す）・container application・gateway id を**サーバー側に固定した集計 DTO**だけを返す（クライアントから GraphQL・ID・期間の式を受け取らない。期間は `1h / 24h / 7d` の列挙だけ）。AI Gateway の logs の prompt / body は取らない。credit balance は残高の数値だけ。
- 偽 Cloudflare: `CLOUDFLARE_API_BASE`（`env.d.ts`。ENVIRONMENT=test のときだけ有効）を GraphQL にも使う。`FAKE_CLOUDFLARE_TOKEN` を持つ偽サーバーが既にある（`apps/gateway/test/fake-github/server.ts`）。GraphQL のエンドポイントと、残高の API を足す。
- 「Cloudflare（開くリンク）」は、アカウント ID を含む URL をクライアントに渡すことになる（`CLOUDFLARE_ACCOUNT_ID` は公開しない値）。**閲覧者に見せてよい値か**を確かめる（未決事項。推奨: ダッシュボードにログインできる人はデプロイ側と同じ組織なので許容。ただし公開リポジトリのコード・ログには出さない）。

**決定（2026-10-21）: 案 B。** 既存の Terraform 管理の読み取りトークン（`cloudflare_api_token.ai_gateway_read`）に Analytics の Read を足す。**名前は変えず**（再作成で値が変わるのを避ける）、コメントで実態を書く。取れない項目は「取得できない」と表示する。却下: 案 A（要件の主目的のコンテナの稼働が出ない）、案 C（別 secret が増える）。権限の名前は M9 の最初に Cloudflare のドキュメントで確かめる。

### D14. 構造化イベント（agent → gateway → 詳細）

- agent に足す新しいイベントの型（名前は仮。`step` 系にまとめるか個別にするかは M7 の最初に決める）。いずれも**マスク済み**（`maskSecrets`）で、**制御文字・ANSI を除き、マルチバイトで切らない**（作業中の「子の出力の整形」を使う）。
  - `command`: `argv` を人間が読める 1 行に整形した文字列（最大 1,000 字。先頭と末尾を残す）、`cwd`（ワークスペースからの相対）、`exit_code`、`duration_ms`、`output_tail`（最大 2,000 字、マスク済み）。
  - `edit`: `path`（ワークスペースからの相対。`..`・絶対パス・制御文字を拒否。最大 300 字）、`op`（`create` / `modify` / `delete`）、`added` / `removed` の行数。**差分の本文は送らない**。
  - `commit`: `message` の 1 行目（最大 200 字）、`sha`（40 桁）、`files`（数）。
  - `web`: `kind`（`search` / `fetch` / `browse`）と host だけ（URL のパス・クエリは出さない。`@rovo/audit` と同じ方針）。
- gateway: `mapAgentEvent` の許可リストに型ごとに足す。**取り込み時に gateway でも再マスクと長さの制限**をかける（agent が壊れていても漏らさない二重の防御。gateway から使えるマスク関数は `packages/audit` にあるか、agent の `redact.ts` を共通化するかを M7 で確かめる）。`MAX_PUBLIC_TEXT = 500`（`agent-events.ts:9`）では足りない項目は型ごとの上限を持つ。
- **MCP の応答には出さない**: `task_wait` はこれらの型を除いて返す（MCP の利用者の応答の大きさと、非信頼データの囲みの範囲が変わらない）。`events` テーブルには保存するので、ダッシュボードの専用 RPC だけが読む。**既存の `tool_start` / `tool_end` は変えない**（後方互換）。
- 互換: 古い agent（新しいイベントを出さない）でも、詳細は `tool_start` / `tool_end` の要約から**動詞の無い素の一覧**に縮退して表示できること。gateway が新しい型を知らなくても `agent_event` に縮退するので、デプロイの順序の事故はない。
- 秘密の扱い: 「秘密を伏せた旨」は画面に常に出す（**常に伏せている**という表示）。マスクが取りこぼすもの（任意の文字列の秘密）は原理的に残るので、**表示は出力の枠の中だけ・外部送信なし**にし、既知の限界を SECURITY.md に書く。
- 表示の安全: React の `{text}` のエスケープに頼らない前提で、(1) 表示前に制御文字（改行・タブ以外の C0/C1、双方向の制御文字 `U+202A-202E`・`U+2066-2069`）を除去 / 可視化する純関数、(2) `dangerouslySetInnerHTML` を使わない（lint で禁止）、(3) Markdown / HTML を解釈しない、(4) `<a>` は GitHub の PR の URL（`https://github.com/<owner>/<repo>/pull/<n>` に厳密に一致するもの）だけに許可し、`rel="noopener noreferrer"`、(5) `<img>` を出さない（外部画像なし）。

**追加（2026-10-22）: 実行中のコマンドの途中の出力（`command_progress`）。**
- 子の bash ツールが `exec` の完了を待つ間、3〜5 秒ごとに SandboxDO の `peekOutput()`（`exec` の鎖の外の RPC。実行中の TailBuffer の中身を返す）を呼び、前回と違うときだけ `command_progress`（`command` / `cwd` / `startedAt` / `outputTail`）を onEvent の側路で積む。子の LLM に返る tool result には入れない。
- マスクの規則: stdout / stderr それぞれの窓（末尾 64KiB）の全体に `maskSecrets` をかけてから末尾 2,000 字へ切る（切ってからマスクしない）。最後の改行より後（未完の行）と、閉じていない `-----BEGIN` から先は出さない（`packages/audit/src/progress.ts`）。フィールド名は `outputTail` で、AgentDO の `maskEventStrings` と取り込み時の再マスクが効く。
- 保存は上書き: gateway の TaskDO は `events`（履歴）に積まず、`meta` の 1 行（`command_progress`）に最新の 1 件だけを書く。`dashboardLatest` が読み、`dashboardEvents` / `task_wait` / `task_status` / `task_result` には出ない（`mapAgentEvent` は専用の `progress` 種別に写し、汎用の `agent_event` に落とさない）。
- 後始末: 最後の `command` イベント、`ended: true` の進捗（`command` を出せずに終わったとき）、タスクの終端、cancel で消す。`dashboardLatest` は終端のタスクでは進捗を返さない。
- 契約: 詳細の `output` に `running: true` と `started_at`（ISO 8601）を任意で足した（後方互換）。

**決定（2026-10-21）: 推奨どおり**（D14）。

### D15. ポーリングと詳細の履歴

- 一覧: 5 秒ごとに `GET /dashboard/api/overview` を取り直す。詳細: `GET /dashboard/api/tasks/:id/events?cursor=<seq>` を 5 秒ごと（差分だけ。`cursor` は `events.seq`）。
- バックグラウンドのタブ（`document.visibilityState === "hidden"`）では止め、戻ったら即 1 回取り直す。失敗は指数的な backoff（5 → 10 → 20 → 最大 60 秒）で、成功で戻す。同時に 2 本走らせない（進行中の取得があればスキップ）。終端のタスクの詳細は、終端になってから 30 秒だけ追って止める。
- 重複排除: `seq` をキーにして、同じイベントを 2 回積まない。`401` は再ログインへ、`404` は「見られません」の画面へ（権限を失った場合もこれ）。
- ページング: events は 1 回 200 件まで（`LIMIT`）。最初の表示は**末尾（新しい側）から**取って、古い側は「さらに読む」で遡る（長いタスクは数千件になりうる）。
- 「自動更新のチェック」: 切ると止まる。状態は `localStorage` に保存してよい（try/catch で囲む）が、無くても動く。

**決定（2026-10-21）: 推奨どおり**（D15）。

### D16. `dashboard_url` の形

- `${PUBLIC_BASE_URL}/dashboard/tasks/<task_id>`。`PUBLIC_BASE_URL` は既に OAuthProvider の issuer に使っている（`index.ts:18`）。末尾の `/` は除く。
- 付ける場所: `task_start` の応答（`StartValue`、`apps/gateway/src/tasks/service.ts:66`）、`task_status`（`StatusValue` = `TaskView` から `owner_id` を除いたもの、同 `:82`）、`task_result`（`ResultValue`、同 `:92`）。MCP のツールの説明文（`server.ts` の description）と、`START_NOTE` に 1 文足す。`task_wait` には付けない（応答が大きくなるだけ）。
- 閲覧権限が無い人に URL を渡しても 404 になるだけで、URL 自体は秘密ではない。未ログインでアクセスすると、ログインに進み、**ログイン後に同じ詳細へ戻る**（戻り先は `/dashboard` か `/dashboard/tasks/<ULID>` の正規表現に一致するものだけ。オープンリダイレクトを防ぐ）。
- `PUBLIC_BASE_URL` が不正 / 空のとき: `dashboard_url` を**省略**する（`null` ではなくキーを付けない）。

**決定（2026-10-21）: 推奨どおり**（D16）。

### D17. ブラウザの E2E（Playwright）の構成

- `@playwright/test` は `apps/dashboard` の devDependency。ブラウザは `pnpm exec playwright install chromium`（mise のタスク `test:e2e:dashboard:install`。`test:e2e:dashboard` が依存する。**CI は置かない**ので、ローカルの初回だけブラウザのダウンロードが走ることを docs に書く）。Chromium だけで足りる。
- 起動: Playwright の `globalSetup`（または `webServer`）が、gateway の E2E の `global-setup.ts`（`apps/gateway/test/e2e/global-setup.ts`）と同じ作りで、偽 GitHub（`startFakeGitHub`）・偽の agent Worker・`wrangler dev`（ビルド済みの `dist` を `assets` から配信）を起動する。**既存の起動処理を共有するために `apps/gateway/test/support/` へ切り出す**か、dashboard の E2E から import する（M6 の最初に手元で決める）。
- データの作り方: 偽 GitHub のログイン（`/login/oauth/authorize` は偽サーバーが即承認）で実ブラウザのログインを通し、タスクは**実際の MCP 経路**（`task_start`）で作って、偽の agent の台本で終端まで進める（完了・失敗・キャンセル・consult を混ぜる）。時刻依存（「今日」のタイムライン）は、`ENVIRONMENT=test` のときだけ使える時計の差し替え（既存の `/__test/` ルートの流儀）で固定する。
- 偽の Cloudflare API: `CLOUDFLARE_API_BASE` を偽サーバーに向け、(1) 正常、(2) 一部の項目が 403 / 空、(3) 5xx を切り替える。画面の「取得できない」の表示と、他の項目が生きていることを確かめる。
- 前提（M4 の最初に確かめる）: `wrangler dev` の `http://localhost` で、Chromium が `Secure` / `__Host-` の Cookie を受け付けること（D3）。
- **Sandbox の外で動かす**: Playwright のブラウザの取得先（CDN）とフォントの配布元は、rovo の子エージェントの Sandbox の外向き通信の許可（`registry.npmjs.org` / `pypi.org` / `files.pythonhosted.org` と対象リポジトリの `github.com` だけ。`apps/agent/src/outbound-policy.ts:17,48-51`）に入らない。`wrangler dev` が Sandbox で立つかも未確認。したがって Playwright の E2E は**手元で実行・保守する**（委譲の基準の節）。
- 並列: 偽 GitHub の状態を共有するので `workers: 1`（既存と同じ）。
- `mise run test` に `test:e2e:dashboard` を**含める**（`test:e2e` の `depends` に足す。wrangler dev の dev registry の取り違えを避けるため、`test:e2e:gateway` 系の後に直列で走らせる）。Docker は要らない。

**決定（2026-10-21）: 推奨どおり**（D17）。

### D18. 時刻・タイムゾーン

- 「今日のタイムライン」は**閲覧者のブラウザのローカルの 0 時〜24 時**。クライアントが `from` / `to`（UTC のエポック ms）を渡し、サーバーは範囲を検証する（幅は最大 36 時間）。表示の時刻はローカル。
- 月の予算・費用は UTC の月（D8）。1 画面に 2 つの基準が並ぶので、ラベルに「UTC の月」と書く。

**決定（2026-10-21）: 推奨どおり。** 月の予算・費用は UTC のまま、画面に「UTC の月」と明記する。「今日」はブラウザのローカル日。

## マイルストーン

各 M は、先に失敗するテストを書いてから実装する（TDD。Unit と E2E の両方）。規模の目安は S（半日未満）/ M（1 日前後）/ L（数日）。

### 委譲の基準（rovo の子エージェントに任せてよい範囲）

rovo の子エージェントの Sandbox は、外向き通信が `registry.npmjs.org` / `pypi.org` / `files.pythonhosted.org` と対象リポジトリの `github.com` だけに限られる（`apps/agent/src/outbound-policy.ts:17,48-51`）。Playwright のブラウザの CDN やフォントの配布元には届かず、`wrangler dev` が Sandbox で立つかも未確認。そのため基準は次のとおり。

- **rovo に任せてよい**: `vitest`（jsdom）で閉じる、純関数・コンポーネント・契約（DTO）・ビルド成果物の検査（`dist` に外部ホストが無い等）まで。受入条件が観測でき、設計の判断・認可・移行を含まないもの。
- **手元でやる**: Playwright の E2E、`wrangler dev` を使うもの、実 API への接続、フォントの同梱（ライセンスの確認と取得）、認可・セッション・DO の変更と移行・デプロイの経路・安全に関わるもの。

### 順序（何も外さない最初の版）

最初の版にすべてを入れる。依存と、D2 が承認で覆る可能性・既存の auth E2E で早く確かめたい点を踏まえた順序は次のとおり。

| 順 | M | 内容 | 規模 | 担当 |
|---|---|---|---|---|
| 1 | M1 | 配信の土台（assets・Worker の優先・CSP・deploy 経路） | M | 手元 |
| 2 | M2 | 契約（DTO・fixtures。consult・構造化イベントの型も含む） | S | rovo 可 |
| 3 | M4 | ブラウザのログインとセッション（M3 より先） | L | 手元 |
| 4 | M3a | 索引: TaskDO の outbox + DirectoryDO + migration v2 | M | 手元 |
| 5 | M3b | 索引: consult（UserDO の `consult_log`・outbox・alarm、`reserveConsult` / `settleConsult` の変更） | M | 手元 |
| 6 | M5a | `visibleRepositoryIds` + `dashboardRead` の Unit（認可の核） | M | 手元 |
| 7 | M5b | API の組み立て（`overview` / `tasks/:id` / `events`（縮退）/ `budget`、出力検証、ヘッダ） | M | 手元 |
| 8 | M10 | `dashboard_url`（前倒し。M4 の後ならいつでもよい） | S | rovo 可 |
| 9 | M7 | 構造化イベント（agent・gateway）と詳細の events API（M8 の前） | M | 手元（agent 側の機械的な型の追加は rovo 可） |
| 10 | M6 | 一覧の画面。6a: 画面と Unit／6b: Playwright・実 API・フォント | 6a: M／6b: M | 6a は rovo 可、6b は手元 |
| 11 | M9 | Cloudflare の概要（サーバー側 + 画面の枠。M6 の枠に足す） | M | 手元（画面の枠は rovo 可） |
| 12 | M8 | 詳細の画面。8a: 画面と Unit／8b: Playwright E2E・実 API | 8a: M／8b: S | 8a は rovo 可、8b は手元 |
| 13 | M11 | ブラウザ E2E の通し（全シナリオ）・受入・docs | M | 手元 |

**後回しなし。** 範囲外にするのは、矛盾 #4 の「人が GitHub 上でマージしたことの検知」だけ（決定: 塗りは rovo 経由のマージだけ。注記つき）。

M6 / M8 は次の 2 つに分ける（番号は同じ M のまま）。

- **a（画面と Unit。rovo 可）**: コンポーネント、純関数（座標・状態の印・動詞・テキスト整形・リンク許可・ポーリングのフック）、`vitest`（jsdom）の Unit、fixtures で動く画面、`dist` の検査（外部ホスト無し、`<style` / `style=` 無し）。
- **b（Playwright E2E と実 API 接続。手元）**: Playwright の設定・起動の共通化、ブラウザ操作の E2E、実 API への接続、フォントの同梱、見本との見た目の突き合わせ。

進め方: M1 → M2 は先。M3〜M5（手元）と、M2 の後の 6a・8a・M9 の画面の枠（rovo 可。fixtures で動く）は並列にできる（触るファイルが重ならない: gateway と `apps/dashboard`）。

### 未確認の事項を、どの M の最初に確かめるか

| 未確認の事項 | 確かめる M（その最初） | 確かめ方 |
|---|---|---|
| `test:unit:gateway` が `assets.directory` 無しで落ちるか（`vitest.config.ts:17`） | **M1** | 最初の Red。結果で D12 の (a)(b)(c) を選ぶ |
| Vite の `base` と assets のパス（D11 の実装メモ） | **M1** | 最初の Red |
| OAuthProvider の state の形（base64url 32 バイト、`.` を含まない。`oauth-provider.js:2292-2299`） | **M4** | 実コードを読み、Unit で `^[A-Za-z0-9_-]{43}$` を固定 |
| GitHub App の callback URL を更新する API の有無 | **M4** | GitHub Docs。案 B を取るので影響は小さい（記録のため） |
| localhost で Chromium が `Secure` / `__Host-` の Cookie を受け付けるか | **M4**（M6b の前提） | `wrangler dev` に対する実機の確認。だめなら E2E だけ `ENVIRONMENT=test` で接頭辞を外す。**6b で確認済み（通った。接頭辞を外す仕組みは不要）** |
| `repository_id` が INSERT 後に変わらないこと（UPDATE が無い） | **M5a** | `grep` と Unit |
| DO の SQLite の容量の上限（Directory の保持） | **M3a**（確認済み: 10 GB） | ドキュメント |
| 見本の 3 書体のライセンスとサブセット化 | **M6b** | フォントの同梱の前にライセンスを確認。**確認済み（3 書体とも SIL OFL 1.1。@fontsource から woff2 だけ同梱）** |
| Cloudflare の権限名（Analytics の Read）と各 API の要求権限 | **M9** | Cloudflare のドキュメント。Terraform の `plan` で見つかること |
| `sandbox_instance`・子の出力の整形が main に入っているか | **M7** | main の状態の確認 |

### M1. 配信の土台

- 作るもの: `apps/dashboard`（Vite + React + TS。最小の「ダッシュボード」と書かれたページ）、gateway の `assets`（`ASSETS`、`run_worker_first: true`）、`/dashboard/*` の配信（D11）、CSP などのヘッダ、`mise run build:dashboard`、`build:gateway` / E2E の依存、`scripts/deploy.sh` の gateway 経路でのビルド（D12）、`deploy.example/gateway.wrangler.jsonc` と fixtures と `test-deploy.sh` の更新、`Env` の型。フォントの同梱（フォントは M6b で手元で同梱する）。
- 完了条件: `mise run test` と `mise run lint`。`/dashboard/`・`/dashboard/tasks/<ULID>` が HTML を返し、`/dashboard/assets/<存在しない>` が 404、`/mcp`・`/authorize`・`/.well-known/oauth-authorization-server` の挙動が変わらず、未知の `/dashboard/api/x` が JSON 404。`scripts/test-deploy.sh` が「gateway のデプロイの前にダッシュボードのビルドが 1 回走る」「ビルドが失敗したら wrangler を呼ばない」ことを確かめる。
- テスト: Unit（Hono アプリ。偽の `ASSETS`）: パスごとの振り分け、ヘッダ（CSP・nosniff・no-store）、`/dashboard` 以外の HTML を返さない。Node のテスト: `deploy.sh` の自己確認、`deploy-config` の fixtures（`assets` が出る）。E2E（既存の gateway E2E に追加）: wrangler dev で `fetch` して上のとおり。
- 触るファイル: `apps/dashboard/*`（新規）、`apps/gateway/wrangler.jsonc`、`apps/gateway/src/app.ts`（または新しい `src/dashboard/*.ts`）、`apps/gateway/src/env.d.ts`、`mise.toml`、`scripts/deploy.sh`、`scripts/test-deploy.sh`、`deploy.example/gateway.wrangler.jsonc`、`scripts/fixtures/deploy-config/*`、`pnpm-lock.yaml`。
- 最初の Red で確かめること: (1) `assets.directory` が無いときに `test:unit:gateway` が落ちるか（D12 の注）。(2) Vite の `base` と assets のパスの関係（D11 の実装メモ）。(3) `dist` のフォントは M6b で同梱する（M1 では system フォントで可）。
- 依存: D1・D11・D12 の承認。

### M2. 契約（DTO と fixtures）

- 作るもの: `packages/dashboard-contract`（`@rovo/dashboard-contract`）。zod のスキーマと型: `OverviewDto`（タイムライン用のタスク・consult の点・表・今月の予算 2 種・モデル別の費用・隠れた件数）、`TaskDetailDto`、`TaskEventDto`（型ごとの判別共用体）、`CloudflareSummaryDto`（各項目が `{ok: true, value} | {ok: false, reason}`）、`ErrorDto`。fixtures（見本に合わせた「今日」のデータ: 3 人・成功 / レビュー待ち / 失敗 / 実行中 / consult、Cloudflare は取得できない項目を含むもの）。時刻は固定の ISO 文字列で。
- 完了条件: `mise run test`（Unit）と `lint`。fixtures が全スキーマを通る。**スキーマに秘密になりうる項目（トークン、`instructions` の全文、`enc`）が無い**ことを、禁止項目の一覧のテストで固定する。
- テスト: Unit のみ（契約のパッケージなので E2E は M6 以降）。
- 触るファイル: `packages/dashboard-contract/*`（新規）、`mise.toml`（`test:unit:dashboard-contract`）。
- consult 関連（灰の点、consult 込みの実績）と構造化イベントの型（D14）も、最初の版で定義する。`TaskEventDto` は既存の `tool_start` / `tool_end` / 状態 / `usage` を含む判別共用体にし、古い agent の履歴（新しい型が無い）でも縮退して表示できる形にする。
- 依存: なし（D8・D14 の DTO の形はここで固める。形が変わったら M5・M7 に反映）。

### M3. 索引（DirectoryDO・outbox）

**全体で L。M3a と M3b に分ける。** **M3a** = TaskDO の outbox + DirectoryDO（`task_index`）+ migration `v2` + TaskDO / DirectoryDO の Unit と E2E。**M3b** = consult（UserDO の `consult_log`・alarm・outbox、`reserveConsult` / `settleConsult` のシグネチャ変更、`consult_index`、UserDO の Unit）。M3b は M3a の Directory に `upsertConsult` を足す。最初に確かめる: DO の SQLite の容量の上限（M3a）。

- 作るもの: `DirectoryDO`（`task_index`・`consult_index`、`upsertTask(snapshot, revision)`、`upsertConsult(...)`、読み取りは `list(filter, repoIds)` と集計）。TaskDO の outbox（`index_revision` / `index_sent_revision`、`changeStatus`・usage・PR の更新点・`ensureCreated` で上げる、alarm で配送、`needsAlarm` に追加）。UserDO の `consult_log` と alarm と outbox（D9）。`reserveConsult` / `settleConsult` のシグネチャ変更（model）。wrangler の `DIRECTORY_DO` binding と migration `v2`（upstream と `deploy.example`）。
- 完了条件: `mise run test` / `lint`。タスクの作成→実行→終端の間に、索引が収束する（最終の revision と一致）。Directory が止まっていても、`task_start` / `task_wait` / `task_result` が通常どおり動き、Directory が復旧したら追いつく。
- テスト（先に書く）:
  - Unit（TaskDO）: 状態遷移・usage 更新・PR の更新のたびに `index_revision` が上がる。**行の更新と revision の上昇が同じトランザクション**（途中で例外 → どちらも反映されない）。`needsAlarm` が未配送のあいだ true で、配送後に false。Directory の失敗（例外）が `advance()` を失敗させない。終端後に usage が遅れて届いても、最後の revision が配送される。
  - Unit（DirectoryDO）: 古い revision を拒否（順序の逆転・重複）。`repoIds` で絞った後の件数・ページ・集計が一致（絞る前に切らない）。`repository_id` が NULL の行は、どの `repoIds` にも現れない。タイムラインの範囲（`from` / `to`）。
  - Unit（UserDO）: consult の行（model・時刻・費用）が `settleConsult` と同じ同期区間で outbox に入る。
  - E2E（gateway）: 実 DO（wrangler dev）+ 偽 agent で、`task_start` → 終端 → Directory の行が最終状態・費用になる（`/__test/` で Directory の中身を読む。ENVIRONMENT=test のみ）。
- 触るファイル: `apps/gateway/src/directory/directory-do.ts`（新規）、`apps/gateway/src/tasks/task-do.ts`、`apps/gateway/src/tasks/user-do.ts`、`apps/gateway/src/consult.ts`、`apps/gateway/src/index.ts`（export）、`apps/gateway/wrangler.jsonc`、`deploy.example/gateway.wrangler.jsonc`、`apps/gateway/src/test-routes.ts`。
- 依存: M2、D9・D10。

### M4. ブラウザのログインとセッション

- 進める順: M2 の次、M3 より先（D2 の B が承認で覆る可能性が最も高く、既存の auth E2E で MCP のログインが壊れないことを早く確かめたい）。
- 作るもの: `GET /dashboard/auth/login`（`rovo-dash.` 付きの state と専用 Cookie を発行し GitHub へ）、`/callback` の振り分け（D2 の B。**接頭辞だけで振り分け**、不一致は 400）、**身元確認の共通関数への切り出し**（`login.ts:190-212`。`exchangeCode` → `getUser` → 許可ルール → `saveCredential`。MCP とダッシュボードの両方から呼ぶ）、ダッシュボード由来のログインの監査（`reason` / `caller` を MCP と区別）、callback の処理（セッション作成・Cookie 設定・固定の戻り先）、UserDO の `dashboard_session` と `dashboard_epoch`、セッション検証のミドルウェア（`requireSession`）、`POST /dashboard/api/logout`、`GET /dashboard/api/me`（`{login}` だけ）。SPA 側のログイン画面（最小。「GitHub でログイン」）。
- 完了条件: `mise run test` / `lint`。ブラウザなしの E2E（fetch）でログイン→`/me`→ログアウトが通り、MCP のログイン（既存の auth E2E）が壊れない。
- テスト（先に書く）:
  - Unit: state が一回限り・10 分で失効・別のブラウザ（Cookie 無し / 別の値）で拒否・再利用で拒否。戻り先は固定 / 正規表現に一致したものだけ（`//evil.com`・`\\`・`https://`・`/dashboard/../x` は既定に倒す）。許可ルール外のユーザーは拒否（セッションを作らない・資格も保存しない）。Cookie の暗号文の改ざん・AAD の違う暗号文（MCP の `access` の暗号文を流用）・期限切れ・`version` 不一致・失効済みの sid が 401。**Cookie の平文に GitHub のトークンが含まれない**（復号して項目を検査）。`Set-Cookie` の属性（`__Host-`・`Secure`・`HttpOnly`・`SameSite=Lax`・`Path=/`・Domain 無し）。ログイン後は**古い sid を全部失効**（セッション固定の対策: ログイン前の Cookie を引き継がず、常に新しい sid）。
  - Unit: `/callback` の振り分けが、MCP の state（OAuthProvider が発行したもの）をダッシュボードに誤って振り分けない。**OAuthProvider の state が `^[A-Za-z0-9_-]{43}$` に一致する**ことを固定する（`.` を含まないので `rovo-dash.` と衝突しない。D2）。接頭辞付きで KV・Cookie が不一致のとき 400 で、**MCP 側の監査（`auth_failed` / `invalid_state`）が出ない**。接頭辞が無い不正な state は今までどおり MCP の経路で拒否される。共通の身元確認関数が、許可ルール外・GitHub のエラーで MCP とダッシュボードのどちらでも同じ結果になる。
  - Unit（資格の競合）: ダッシュボード由来の `saveCredential` と MCP の `withToken`（リフレッシュ）が同時に走ったときの CAS の勝ち負け（`credentials.ts:144-185`）。負けた側が勝った側の資格を使い、どちらも壊れた資格を保存しない。ダッシュボード側の失効で MCP の資格も消える（D4 のリスク）ことを固定する。
  - Unit: `Sec-Fetch-Site: cross-site` の API 呼び出しが 403。
  - E2E: 偽 GitHub で、(1) 正常、(2) 許可外のユーザー、(3) GitHub がエラーを返す、(4) state の不一致、(5) 同じ callback の再送。
- 触るファイル: `apps/gateway/src/dashboard/auth.ts`・`session.ts`（新規）、`apps/gateway/src/auth/login.ts`（`/callback` の先頭の振り分けだけ）、`apps/gateway/src/tasks/user-do.ts`、`apps/gateway/src/app.ts`、`apps/dashboard/src/*`（ログイン画面）。
- 依存: M1、D2・D3・D4。

### M5. 読み取り API と認可

**2 つに分ける**: **5a** = `visibleRepositoryIds`（GitHub の列挙・キャッシュ・fail closed）+ TaskDO の `dashboardRead` の Unit（認可の核。先にやる）、**5b** = API の組み立て（`overview` / `tasks/:id` / `events` / `budget`、DTO の出力検証、ヘッダ、E2E）。

- 作るもの: `GET /dashboard/api/overview`（from / to / scope = `all` | `me`）、`GET /dashboard/api/tasks/:id`、`GET /dashboard/api/tasks/:id/events?cursor=`（骨組み。中身は M7）、`GET /dashboard/api/budget`。UserDO の `visibleRepositoryIds()`（GitHub の列挙・短いキャッシュ・inflight の束ね・fail closed）。TaskDO の `dashboardRead()`（所有者以外が読める。`repository_id` を含む view を 1 回返す。判定は gateway が集合で行う。D5。NULL は拒否）。DirectoryDO の集計。レスポンスの DTO は M2 のスキーマで**出力を検証**してから返す（余分な項目を落とす）。エラーは 401（未ログイン）/ 404（権限なし・存在しない・NULL）/ 503（GitHub 障害・集合が大きすぎ）の 3 種で、本文に理由を出さない。
- 完了条件: `mise run test` / `lint`。権限のあるリポジトリのタスクだけが、一覧・詳細・events・件数に出る。
- テスト（先に書く。**認可の抜けが最大のリスクなので最も厚く**）:
  - Unit（visibleRepositoryIds）: 複数 installation・複数ページ（`Link`）・`per_page` の境界・途中のページで 500（部分集合を返さず失敗）・401（リフレッシュ後にやり直す）・403 でキャッシュ破棄・TTL（一覧 30 秒 / 詳細の最初は必ず取り直す）・同時呼び出しが 1 本に束ねられる。
  - Unit（認可の表）: 同じタスクを「権限あり / なし / `repository_id` NULL / 集合の取得失敗 / 資格なし / 許可ルール外」の 6 通りで、**overview・tasks/:id・events・budget の件数**のすべてが期待どおり（権限なし = 404 で、存在しないタスクと見分けがつかない）。
  - Unit（再認可）: 詳細を開いた後に GitHub 側で権限が外れると、次のポーリングで 404（30 秒以内）。索引の `repository_id` が古くても（索引を偽装しても）TaskDO の値で判定される。
  - Unit（出力）: DTO のスキーマに無い項目（`instructions`・`git_token`・`enc`・トークン）が返らない。**権限の無いタスクの `task_id`・`owner_login`・`repository`・`pr_url`・`model`・`title` が、応答の本文全体の検索でどこにも現れない**（隠れた件数だけ。D7）。404 の本文・ヘッダにも出ない。
  - Unit（ヘッダ）: API の JSON に `X-Content-Type-Options: nosniff` と `Cache-Control: no-store`。`Sec-Fetch-Site: cross-site` の呼び出しは 403。CORS ヘッダが無い。
  - E2E: 偽 GitHub に 2 人（A は repo-1 と repo-2、B は repo-1 だけ）を作り、A のタスクを repo-2 で作る。B の `overview` に出ない・`tasks/:id` が 404・件数のみ「隠れた 1 件」。`scope=me` の絞り込み。
- 触るファイル: `apps/gateway/src/dashboard/api.ts`（新規）、`apps/gateway/src/dashboard/visibility.ts`（新規）、`apps/gateway/src/tasks/user-do.ts`、`apps/gateway/src/tasks/task-do.ts`、`apps/gateway/src/directory/directory-do.ts`、`apps/gateway/src/github/client.ts`（列挙のメソッド）、偽 GitHub（`test/fake-github/server.ts`: 2 人目のユーザー）。
- 依存: M2・M3・M4、D5・D6・D7・D8・D18。

### M6. 一覧の画面

**2 つに分ける**（委譲の基準の節）。**6a（rovo 可）**: コンポーネント・純関数・jsdom の Unit・fixtures で動く画面・`dist` の検査（下の「テスト」の Unit とビルド成果物の確認）。**6b（手元）**: Playwright の設定と起動の共通化、E2E、実 API への接続、フォントの同梱、見本との見た目の突き合わせ。最初の版の範囲: タイムライン・表・全員 / 自分・自分の予算・モデル別の費用（consult 込み）・consult の灰の点。Cloudflare 枠は M9 で足す。

- 作るもの: 見本 `Main.dc.html` の実装。今日のタイムライン（SVG。人ごとのレーン、開始時刻の棒、高さ = 費用、塗り / 中空 / オレンジ中空、consult の灰の点、いまの破線）、表（状態の印は図と同じ形 + 文字）、右の予算（あと何件）・モデル別の費用、「全員 / 自分」の切り替え、自動更新（D15）、読み込み・エラー・空・401 の各状態。デザインのトークン（色・文字）は CSS 変数 1 か所に。Cloudflare の枠は M9 で足す。
- 完了条件: `mise run test` / `lint`。Playwright（M6 で `test:e2e:dashboard` を足す）で、偽 API でも、実 API（M5 の後）でも、一覧が見本の構成で出る。**色だけに頼らない**: 状態が、色を無視（グレースケール）しても形と文字で区別できることを確かめる。
- テスト（先に書く）:
  - Unit（Vitest + jsdom / happy-dom）: タイムラインの座標の計算（純関数: 時刻 → x、費用 → 高さ、同時刻の重なり）、状態 → 印の対応が全 9 状態で漏れなし（網羅の型で）、表示前のテキスト整形（D14 の制御文字）、ポーリングのフック（visible / hidden・backoff・重複排除・401・404）、reduced-motion。
  - E2E（Playwright）: ログイン（偽 GitHub）→ 一覧、全員 / 自分の切り替え、行のクリックで詳細へ、自動更新を切ると取りに行かない、権限の無いタスクが画面にもネットワーク応答にも出ない、`prefers-reduced-motion` で脈動しない、状態の判別が DOM の属性・アクセシブルな名前で確かめられる（画像の差分ではなく。見た目の確認は手元のレビュー）。
  - ビルド成果物の確認（Node）: `dist` に外部ホストへの参照が無い（フォント・スクリプト・画像）。
- 触るファイル: `apps/dashboard/src/*`、`apps/dashboard/e2e/*`、`apps/dashboard/playwright.config.ts`、`mise.toml`（`test:unit:dashboard`、`test:e2e:dashboard`、`test:e2e:dashboard:install`、`test:e2e` の depends、`lint` に型検査）、`apps/gateway/test/support/*`（起動の共通化）。
- 依存: M2（fixtures）、M1。実 API につなぐのは M5。D17。

### M7. 構造化イベントと詳細の API

**最初の版に入れる。M8 の前（M5b の後）に作る。** 古い agent の履歴では、M8 は既存の `tool_start` / `tool_end` と状態のイベントで縮退して表示する。着手の前に、`sandbox_instance` と子の出力の整形が main に入っているかを確かめる。

- 作るもの: agent の新しいイベント（D14: `command` / `edit` / `commit` / `web`）と、マスク・整形・長さの制限、gateway の `mapAgentEvent` の許可リスト、取り込み時の再マスク、`task_wait` からの除外、TaskDO の `dashboardEvents(expectedRepositoryId, cursor, limit, direction)`、`GET .../events` の実装。`tool_start` / `tool_end` へのフォールバック。
- 完了条件: `mise run test` / `lint`。秘密（GitHub のトークン形式・Bearer・URL 内の資格・env の `KEY=value`・既存の `maskSecrets` が対象にするものすべて）を含む command / 出力 / commit メッセージ / パスが、**agent の出力・gateway の保存・API の応答のどの層でも**伏せられる。MCP の `task_wait` の応答が変わらない。
- テスト（先に書く）:
  - Unit（agent）: 各イベントの整形（長さ・マルチバイトの境界・ANSI・制御文字）。パスの検証（`..`・絶対パス・NUL を拒否）。マスクが先頭でない位置のトークンにも効く。
  - Unit（gateway）: 許可リストに無い項目は落ちる。agent が（バグで）マスクし忘れたトークンが、gateway で再マスクされる。上限を超える値が切られる。`task_wait` の応答に新しい型が出ない（既存のスナップショット）。古い agent（新しい型が無い）の `tool_start` / `tool_end` だけの履歴で詳細の DTO が縮退する。
  - E2E: 偽 agent が秘密入りの command を出す台本 → API の応答に平文の秘密が無い（応答全体を grep）、`events` のページング（末尾から / `cursor`）、権限なしは 404。
- 触るファイル: `apps/agent/src/agent-do.ts`（と新しい整形の関数・`redact.ts`）、`apps/agent/src/tools/*`（edit / commit の検出点）、`apps/gateway/src/agent/agent-events.ts`、`apps/gateway/src/agent/contract.ts`、`apps/gateway/src/tasks/task-do.ts`、`apps/gateway/src/mcp/server.ts`（除外）、`apps/gateway/src/dashboard/api.ts`、`packages/dashboard-contract`。
- 依存: M2・M5、D14。作業中の「子の出力の整形」と `sandbox_instance` が main に入っていること（入っていなければ、整形の関数をこの M で共通化する範囲を決める。ESCALATE の候補）。

### M8. 詳細の画面

**2 つに分ける**。**8a（rovo 可）**: コンポーネント・純関数（動詞・帯・テキスト整形・リンク許可）・jsdom の Unit・fixtures で動く画面。**8b（手元）**: Playwright E2E（XSS・秘密・権限）と実 API 接続。最初の版の範囲: M7 の構造化イベントで、動詞つきの進み具合と出力の末尾を出す。古い agent の履歴は動詞の無い素の一覧に縮退する（D14 の互換）。

- 作るもの: 見本 `Task.dc.html`。状態（脈動。reduced-motion で停止）、題名、「いまは X を実行中」（最新の `command` / `edit` から。無ければ「待機中」等）、準備 → 実行 → 検証 → 完了の帯（`failure_phase` が `setup` なら準備で止まった表示）、進み具合（人の言葉の動詞で時系列。いまの手順は青。**動詞への変換は純関数**）、出力の末尾（暗い枠・JetBrains Mono・「秘密を伏せています」を常に表示）、費用（タスクの費用の内訳）、設定（モデル・effort・merge_policy・deps_cache・`sandbox_instance`〔あれば〕）、Draft PR（URL は D14 の規則に合うものだけリンク）、自動更新のチェック。404 の画面。
- 完了条件: `mise run test` / `lint`。E2E で詳細が見本の構成で出て、実行中のタスクの手順が 5 秒ごとに増える。
- テスト（先に書く）:
  - Unit: 動詞への変換（全イベントの型 × 失敗 / 成功）、帯の状態の写像（`CREATING` → 準備、`RUNNING` → 実行、`VERIFYING` → 検証、終端 → 完了 / 失敗の印。`RECOVERING` / `INPUT_REQUIRED` の見せ方も）、テキスト整形（制御文字・双方向文字・長い 1 行・HTML 風の文字列・`javascript:` を含む文字列がそのまま文字として出る）、リンク許可の判定（PR の URL の正規表現。`javascript:`・`data:`・他のホスト・`github.com.evil.com` を拒否）。
  - E2E: 実行中 → 完了への遷移、失敗（準備の失敗: `base_sha_not_found`）、秘密入りの出力が画面に出ない、`<script>`・`<img src=x onerror=...>`・`[x](javascript:...)` を含むタスクの題名 / command / 出力が**文字として**表示され、実行されない（`window.__xss` が未定義のまま。ネットワークに外部への要求が出ない）、権限なしの詳細は 404 の画面でタイトルの断片も出ない。
- 触るファイル: `apps/dashboard/src/*`、`apps/dashboard/e2e/*`。
- 依存: M2・M7（実 API）。fixtures の段階では M6 と並列に着手できる。

### M9. Cloudflare の概要

**最初の版に入れる。M6 の後**（M6 の右の枠に足す。サーバー側は M5b の後ならいつでも作れる）。最初に Cloudflare のドキュメントで権限名と各 API の要求権限を確かめる。決定: 既存のトークンに Analytics の Read を足す（名前は変えない）。

- 作るもの: `GET /dashboard/api/cloudflare`（D13。サーバー側で固定した集計 DTO）、30〜60 秒の共有キャッシュ、項目ごとの `{ok, value | reason}`、Terraform の権限（B の承認後）、`deploy.example` / docs / `rovo.config.json` の Worker 名の受け渡し、偽 Cloudflare API の拡張、画面の Cloudflare 枠（開くリンク・取得できない表示）。
- 完了条件: `mise run test` / `lint`（Terraform を変えた場合は `infra:validate` と infra のテストも）。偽 API が 403 / 5xx / 空を返しても、一覧の他の部分が壊れない。
- テスト（先に書く）:
  - Unit: クエリ（GraphQL の文字列）が固定で、クライアントの入力（期間の列挙以外）が文字列に入らない。応答の整形（欠けた項目 → 「取得できない」）。キャッシュ（TTL 内は上流を呼ばない・同時呼び出しの束ね・失敗はキャッシュしない / 短く）。AI Gateway の応答に prompt / body があっても DTO に出ない。credit balance は数値だけ。
  - Terraform: 権限のグループの名前が見つからないときの plan の失敗（既存の `infra/tests/` の流儀）。
  - E2E: 偽 Cloudflare で、正常 / 部分的に 403 / 全面 5xx の 3 通りで画面が期待どおり。トークンが応答・ログ・エラーに出ない。
- 触るファイル: `apps/gateway/src/dashboard/cloudflare.ts`（新規）、`apps/gateway/src/dashboard/api.ts`、`infra/main.tf`・`infra/outputs.tf`・`infra/tests/*`（B の場合）、`scripts/deploy-config-lib.mjs`・`deploy.example/gateway.wrangler.jsonc`・fixtures、`apps/gateway/test/fake-github/server.ts`（偽 Cloudflare）、`apps/dashboard/src/*`、`docs/deploy.md`。
- 依存: M5、D13 の承認（**承認が無ければ A の範囲で進める**）。

### M10. `dashboard_url`

**前倒し**: M4 の後ならいつでもよい（M5b の後に置く）。

- 作るもの: `dashboardUrl(env, taskId)` の純関数（D16）、`StartValue` / `StatusValue` / `ResultValue` への追加、`task_start` / `task_status` / `task_result` の description と `START_NOTE` の更新。
- 完了条件: `mise run test` / `lint`。3 つの応答に `dashboard_url` が入り、開くとログイン → 詳細に着く（E2E）。
- テスト（先に書く）: Unit（純関数）: 末尾の `/`、不正 / 空の `PUBLIC_BASE_URL` でキーが無い、task_id が ULID でないときは作らない。E2E（gateway）: `task_start` の応答の URL が `${PUBLIC_BASE_URL}/dashboard/tasks/<task_id>`。E2E（Playwright）: 未ログインで開く → ログイン → 同じ詳細に戻る。他人の private のタスクの URL → 404 の画面。
- 触るファイル: `apps/gateway/src/tasks/service.ts`、`apps/gateway/src/mcp/server.ts`、`apps/gateway/src/dashboard/url.ts`（新規）。
- 依存: M4（ログインの戻り先）、D16。

### M11. ブラウザの E2E の通しと受入

**最初の版の全シナリオ**（(1)〜(9)）と docs。docs/deploy.md には OSS 利用者向けに、Access を前に置く場合の `/dashboard` と `/callback` の扱い（`/callback` は GitHub が戻る先なので Access を通さない、`/dashboard` の SPA と API の扱い、Portal の外に出す必要があるか）を書く。

- 作るもの: 通しのシナリオ（下の「テスト方針」）、`acceptance.md` に「ダッシュボード」の節（実機の確認項目: 実 GitHub のログイン、private repo の権限の差、実 Cloudflare の集計、モバイル幅、キーボード操作、スクリーンリーダーの名前）、`docs/deploy.md`（`/dashboard` の節、トークンの権限、Portal / Access をかけるか）、README、design.md の 15.9（決定の写し）、SECURITY.md の追記（マスクの限界）。
- 完了条件: `mise run test` と `mise run lint` と `mise run build`。`docs:check` が通る。実機の受入はユーザーと一緒に行い、結果を acceptance.md に書く（秘密・実 URL・アカウント ID は書かない）。
- 触るファイル: `docs/*`、`README.md`、`SECURITY.md`、`apps/dashboard/e2e/*`。
- 依存: M6・M8・M9・M10。

## テスト方針

- 共通: TDD（先に失敗するテスト）。完了条件は `mise run test`（Unit + E2E）と `mise run lint`。実装した人とは別の `verifier` が最後に差分とテスト結果を確認する。
- Unit
  - gateway・agent: 既存の vitest（workerd）。DO の Unit は既存の `test/unit/` の流儀（`now`・`githubFetch` の差し替え）。新しい `mise run test:unit:dashboard-contract` / `test:unit:dashboard`（SPA。Vitest + jsdom / happy-dom）を `test:unit` の `depends` に足す。
  - SPA の純関数（座標・状態の印・動詞・テキスト整形・リンクの許可・ポーリング）は DOM なしで試せる形に分ける。
- E2E
  - gateway 側（HTTP）: 既存の `test:e2e:gateway` の仕組み（wrangler dev + 偽 GitHub + 偽 agent）に、ダッシュボードの E2E を足す（ブラウザ不要の検証は fetch で）。
  - ブラウザ: **Playwright（Chromium）**。`mise.toml` に `test:e2e:dashboard:install`（`playwright install chromium`）と `test:e2e:dashboard`（依存: `build:dashboard`、`install`）を足し、`test:e2e` の `depends` に `test:e2e:dashboard` を入れる（D17。直列。`test:e2e:gateway:userids` の後）。
  - 偽の GitHub: 既存の `apps/gateway/test/fake-github/server.ts` を使う（`/user`・`/user/installations`・`/user/installations/{id}/repositories`・`/login/oauth/*` は既にある）。足すもの: 2 人目以降のユーザー（即承認のログインをユーザーごとに切り替える）、ユーザーごとの repository の可視性、途中で権限を外す操作、5xx / 401 / 403 の注入、ページング（`Link` ヘッダ）。
  - 偽の Cloudflare API: `CLOUDFLARE_API_BASE`（ENVIRONMENT=test のときだけ有効）に向ける。GraphQL（containers）と AI Gateway の集計と残高の応答を足し、正常 / 部分的な失敗 / 全面的な失敗を切り替える。
  - 通しのシナリオ（M11）: (1) A がログイン → タスクを MCP で開始 → 一覧に出る → 詳細の手順が増える → 完了。(2) B（repo-1 だけ見える）が同じ組織でログイン → A の repo-2 のタスクが一覧・詳細・API に出ず、集計と「隠れた 1 件」だけ。(3) B の権限を repo-1 から外す → 30 秒以内に消える。(4) セッションの失効（ログアウト / 別のブラウザでの再ログイン）→ 401 → ログイン画面。(5) Cloudflare が 403 → 枠だけ「取得できない」。(6) 自動更新を切る / タブを隠す → リクエストが止まる。(7) reduced-motion。(8) 秘密入りの出力が画面と API に出ない。(9) XSS の入力が文字のまま。
- 見た目: 画像の差分テストは入れない（フォントや OS でぶれる）。構造（DOM・属性・アクセシブルな名前）で確かめ、見本との見た目の突き合わせは手元のレビューで行う（受入の項目）。
- ビルドの確認: `mise run build`（`build:dashboard` を含む）で、`dist` の容量の上限と、外部ホストへの参照が無いことを Node のテストで確かめる（上限の値は M1 で実測してから決める）。
- 不安定さの管理: 時刻は固定の時計で、ポーリングは Playwright のクロックの操作（`page.clock`）で進める（実時間で 5 秒を待たない）。

## 安全上の論点と、確かめる場所

| 論点 | 対策 | 確かめる M | テスト |
|---|---|---|---|
| 認可の抜け（権限の無いリポジトリのタスクが見える） | 一覧・詳細・events・result・件数の**すべて**に同じ判定。詳細は TaskDO の現在の `repository_id` で再認可。NULL・GitHub 障害は fail closed。404 で存在を漏らさない | M5・M7・M11 | M5 の認可の表（6 通り × 4 つの API）、再認可（権限を外した後）、索引の偽装、E2E の 2 ユーザー |
| 隠れたタスクの内容が集計や件数から漏れる | 件数と金額の合計だけを出す。名前・題名・人・時刻は出さない | M5・M6 | 応答に `title` が現れない（権限なし）。DTO のスキーマ |
| 権限の取り消しの遅れ（stale） | 詳細の最初は GitHub で確認、キャッシュ 30 秒、401/403 で破棄、失敗時は古い集合を使わない | M5 | TTL・失敗時の挙動の Unit、E2E の権限の取り消し |
| XSS（題名・command・出力・パス・commit メッセージ・PR の URL） | テキスト表示のみ。`dangerouslySetInnerHTML` を使わない（lint）。Markdown / HTML を解釈しない。リンクは PR の URL の正規表現に一致するものだけ。外部画像なし。CSP（`script-src 'self'`、インライン無し） | M1・M6・M8 | 悪意のある入力を入れた E2E（`window.__xss` が未定義、外部への要求なし）、リンク許可の Unit、CSP のヘッダの Unit、`dist` に外部ホストが無い |
| 制御文字・双方向文字による偽装 | 表示前に除去 / 可視化する純関数 | M6・M8 | Unit（双方向の制御文字、ANSI、`\r` 上書き） |
| 秘密の漏れ（出力の末尾・command・commit メッセージ・パス） | agent でマスク + gateway で再マスク + 型ごとの許可リストと上限。差分の本文は送らない。Web は host だけ。トークンは Cookie にもログにも出さない | M7・M8・M9 | 秘密入りの台本の E2E（応答全体を grep）、再マスクの Unit、Cookie の平文の検査、Cloudflare のトークンが応答・ログに出ない |
| CSRF | 読み取り API は `GET` のみで状態を変えない。ログアウトは `POST` で、`Origin` / `Sec-Fetch-Site` が same-origin のときだけ。CORS ヘッダを出さない。ログイン開始は state + 専用 Cookie（ログイン CSRF の対策） | M4 | 別 Origin の `POST /logout` が 403、CORS ヘッダが無い、state の無い callback が拒否 |
| セッション固定・ハイジャック | ログインのたびに新しい sid、古い sid を全部失効。`__Host-`・`HttpOnly`・`Secure`・`SameSite=Lax`。暗号化 + AAD で別用途の暗号文を拒否。サーバー側の失効・世代 | M4 | M4 の Unit |
| オープンリダイレクト（戻り先） | 戻り先は固定 / 厳密な正規表現 | M4・M10 | `//evil.com`、`\\evil`、`https:`、`/dashboard/../` の Unit |
| `/callback` の振り分けの誤り（MCP のログインを壊す / 混ざる） | 振り分けは state の接頭辞だけ。接頭辞付きの不一致（KV・Cookie・期限・再使用）はダッシュボード側で 400 とし、MCP の監査を汚さない。身元確認は共通関数 | M4 | MCP の既存の auth E2E がそのまま通る、OAuthProvider の state の形（`^[A-Za-z0-9_-]{43}$`）の Unit、不一致で MCP の監査が出ない Unit |
| OAuthProvider の経路・`/mcp` が assets に飲まれる | `run_worker_first: true` + Worker が `/dashboard/*` だけを assets に渡す | M1 | `/mcp`・`/authorize`・well-known が不変の E2E、未知の `/api` が JSON 404 |
| Cloudflare のトークンの権限の拡大 | 読み取りのみ。Terraform で最小の権限。サーバー側で固定した集計だけ（任意の GraphQL なし）。prompt / body を取らない | M9 | クエリの固定の Unit、DTO のスキーマ |
| 資格の競合・共用（ダッシュボードの失効で MCP も再ログイン） | CAS の世代で勝った側の資格を使う。共用のリスクを docs に書く | M4 | `saveCredential` と `withToken` の同時実行の Unit |
| 隠れた費用の推定（合計 − 見える分、N=1） | D7 の選択肢。ユーザーが決める | M5 | 応答全体の検索で `task_id`・`owner_login`・`repository`・`pr_url`・`model` が出ない Unit |
| API 応答の型の取り違え・クロスサイトからの呼び出し | JSON に `nosniff` と `no-store`、`Sec-Fetch-Site: cross-site` は 403、CORS なし | M5 | ヘッダの Unit |
| 索引の障害がタスクを壊す | outbox + fail-open。タスクの状態遷移は Directory に依存しない | M3 | Directory が例外のとき `task_start` / `task_result` が通る |
| DoS（ポーリング、GitHub の API 枯渇） | 5 秒 + backoff + hidden で停止、inflight の束ね、キャッシュ。Cloudflare の集計は共有キャッシュ。集合が大きすぎるときは 503 | M5・M6・M9 | キャッシュ・束ねの Unit、ポーリングのフックの Unit |
| 秘密・個人の値が公開リポジトリに入る | fixtures に実値を入れない。スクリーンショットや記録に実 URL・アカウント ID を入れない | 全 M | `scan:secrets`（`release:check`） |

## 未決事項

決まっていない設計の判断は無い（D1〜D18 は確定）。実装の中で確かめる事項は「未確認の事項を、どの M の最初に確かめるか」の表にある。残っているのは次のとおり。

- Cloudflare の「開くリンク」にアカウント ID を含めてよいか（D13。推奨は許容: ダッシュボードにログインできる人はデプロイ側と同じ組織。ただし公開リポジトリのコード・ログには出さない）。M9 の最初に確かめる。
- Directory の行の保持期間・容量（D10。年単位で増える。掃除は後回しだが、いつ入れるかの基準が要る）。**M3a で確認済み**: SQLite の DO は 1 つあたり 10 GB（Cloudflare Docs「SQLite in Durable Objects GA」2025-04-07）。1 件 1 KB 未満の見積もりで約 1,000 万件、1 日 1,000 件でも 27 年分なので、掃除は入れない（`DirectoryDO` の先頭コメントにも記録）。年間の件数が 100 万を超える規模になったら見直す。
- SSE への移行の時期（ポーリングの負荷が問題になったとき）。

## 気づいた矛盾・提案

1. **`apps/web` はダッシュボードではない。** 要件・設計の「apps/web に既に何があるか」の問いに対し、`apps/web` は Web Research Service（`workers_dev: false`）。SPA は新設の `apps/dashboard`（D1）。名前の混同を避けるため、docs では「ダッシュボード」と「Web Research Service」を使い分ける。
2. **「既存の `/callback` は流用しない」と「デプロイの手順を増やさない」が衝突する。** GitHub App のコールバック URL は `/callback` の 1 本だけで、増やすには既存の App を手で直してもらう必要がある（更新 API は無いと見られる）。提案（D2 の B）: **URL だけ共有**し、振り分けの鍵は state の接頭辞だけ。ハンドラ・KV・Cookie は分離し、`finishUpstream` / `completeAuthorization`（MCP の認可の復元）は流用しない。一方、身元確認（`exchangeCode` → `getUser` → 許可ルール → `saveCredential`）は共通関数にして両方から呼ぶ（判定のずれを防ぐ）。承認済みの設計の趣旨（MCP の復元と混ぜない）は保つが、「URL を分ける」は採れない。
3. **予算は利用者ごと**（`UserDO.task_budget`）。要件の「今月の予算（あと何件始められるか）」は、閲覧者本人の分としてしか定義できない。「全員」を選んだときは、全員の実費の合計と、**自分の残り**を別に出す（D8）。
4. **「マージ済み」を rovo が知るのは、rovo が `task_pr_merge` でマージしたときだけ**（`github_link.pr_merged`。`recordPrAction` `task-do.ts:1322`）。`human_review` のタスクを人が GitHub 上でマージしても、TaskDO は知らない（`head_sha` は終端の一度だけ読む）。タイムラインの「塗り = マージ済み」が、人のマージでは付かない。提案: (a) 詳細を開いたとき、閲覧者のトークンで PR の状態を読み（`getPull`）、`merged` を表示する（読み取りのみ。索引は更新しない）、(b) 一覧は索引の `pr_merged` のままで、「rovo 経由のマージ」と注記する、(c) TaskDO の alarm に PR の状態の定期取得を足す（終端後も alarm が残り続ける。負荷とコストの割に価値が小さいと思われる）、(d) GitHub の webhook で PR のマージを受ける（`scripts/github-app-lib.mjs:35` の manifest は `hook_attributes.active: false`。有効にすると webhook の secret の管理と受け口の署名検証が増え、**手順と secret を増やす**ので却下）。推奨は (a)+(b)。**一覧で人のマージを塗りにするには (c) が要る**ので、要件として必要か確認したい。
   **決定（2026-10-22）: GitHub から PR の状態を取る**（上の (a)(b) を置き換える。(c)(d) は採らない）。閲覧時に gateway が、閲覧者本人のユーザートークンで GraphQL（`repository(owner,name){ pullRequest(number){ state merged } }` を alias で 40 件ずつ・同時 3 本まで）を呼び、`pr.state`（`open` / `merged` / `closed` / `unknown`）を overview と詳細に付ける。owner/name と番号は GraphQL の変数で渡す。照会するのは **COMPLETED で `pr_merged` が未記録の PR だけ**で、**権限の判定（見える集合・`readAuthorizedTask`）に通ったタスクの分だけ**（権限のないタスクの PR は聞かない）。キャッシュは閲覧者本人の UserDO のメモリ（open 30 秒・merged / closed 10 分・取れなかったもの 10 秒）で、同じ PR の同時の呼び出しは 1 本に束ねる。失敗（401・403・404・レート制限・タイムアウト・5 秒の締め切り）は `unknown` で、他の部分は 200 のまま。`pr_merged` が真なら GitHub に聞かず `merged`。画面は COMPLETED + `pr.state` で、merged=マージ済み（塗り青）・open=レビュー待ち（中空青）・closed=閉じた（灰の中空）・unknown=`pr_merged` があればマージ済み、なければ「PR あり」。events のポーリング（5 秒）では GitHub を叩かない。
5. **月の区切りは UTC**（`budgetStatus` の `period`）。画面の「今日」はブラウザのローカル（D18）。日本の利用者には 9 時間の差がある。ラベルで明示する（提案）。UTC 以外にするのは、予算の仕組み自体を変えるので範囲外。
6. **consult にモデルが残っていない**（D9）。モデル別の費用に consult を入れるには、UserDO 側の変更（`reserveConsult` のシグネチャ、新テーブル、alarm）が要る。承認済みの設計は索引（TaskDO の outbox）だけに触れていたが、UserDO の outbox と alarm が増える。M3 の規模が L になる主因（決定: 最初の版に入れ、M3a / M3b に分ける）。
7. **Directory の outbox の配送は alarm の周期（10 秒）にまとめる**ので、一覧は最大約 10 秒遅れ、詳細の状態は遅れない。5 秒のポーリングの「更新」が一覧では 2 回に 1 回は変わらない。許容する前提で書いた（改善するなら、状態遷移だけ即時に配送する）。
8. **`dashboard_url` は、権限の無い人の画面では 404**。作った本人でも、リポジトリの権限が後で外れると見えなくなる。仕様として許容（D7）。
9. **作業中の 2 つの変更**（`sandbox_instance`、子の出力の整形）が main に入る前に M7・M8 を始めると、設定欄と出力の枠が不完全になる。着手の前に main の状態を確認する（M7 の依存）。
10. **`deploy:config` の生成器は `APPS = ["gateway","agent","web"]`**（`deploy-config-lib.mjs:17`）で、ダッシュボードは Worker ではないので追加しない（gateway の assets として同梱）。`deploy.example/gateway.wrangler.jsonc` の `assets.directory` は `main` と同じく設定ファイルからの相対で、`ROVO_DEPLOY_DIR=deploy` のとき `../apps/dashboard/dist`。別の場所に置く下流は直す必要がある（docs に書く）。

## 前提・注意

- 本番相当の環境へのデプロイ、GitHub App の変更、Terraform の apply は、ユーザーと一緒に行う（エージェントが単独で行わない）。この計画の実装でも、実デプロイをさせない（偽の wrangler で確かめる）。
- 公開リポジトリに秘密・個人の値を入れない。fixtures・スクリーンショット・受入の記録に実 URL・account id・org / team の名前を書かない。
- コミットに `Claude-Session` 行を付けない（公開リポジトリ。`scan:secrets` の上限は 0）。
- 見本の URL は計画の根拠。見本が変わったら、この文書の「画面」の節を更新する。

## ユーザーの決定（2026-10-21。決定済み）

以前「判断を仰ぐ点」としていた事項は、2026-10-21 に次のとおり決まった。各 D の「決定」の行にも書いた。

1. **D2**: 案 B。`/callback` を共有し、state の接頭辞 `rovo-dash.` だけで振り分ける。処理・KV・Cookie は分離し、身元確認は共通関数。
2. **D7**: 案 (a)。見えないタスクは表・レーンから外し、「権限の無いタスク N 件」と全員分の合計を出す。差し引きで隠れた費用が推定できる点は了承。
3. **矛盾 #4**: 案 (a)。「塗り = マージ済み」は rovo 経由のマージだけ。注記を付ける。人のマージの検知は範囲外。
4. **範囲**: 最初の版から何も外さない。consult（D9）、Cloudflare の概要（M9）、構造化イベント（M7）も入れる。advisor の「最小の版」の組み替えは不採用。順序の工夫（M4 を M3 より先、M5 の 5a / 5b、M10 の前倒し）、M6・M8 の a / b 分割、委譲の基準（rovo は vitest で閉じる範囲まで）は残す。
5. **D13**: 案 B。既存の Terraform 管理の読み取りトークンに Analytics の Read を足す。名前は変えない。取れない項目は「取得できない」。
6. **月**: UTC のまま「UTC の月」と明記。「今日」はブラウザのローカル日（D18）。
7. **Access / Portal**: docs/deploy.md には OSS 利用者向けの内容（Access を前に置く場合の `/dashboard` と `/callback` の扱いなど）を書く（M11）。ユーザー自身の環境への設定は、インフラを管理する別のリポジトリで行う**別作業**で、この計画の範囲外（記載だけ）。
