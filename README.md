# rovo

Claude Code / Cowork から Remote MCP 経由でコーディングタスクを委譲するための Task Gateway（Cloudflare Workers）。

- MCP サーバー（gateway）が、GitHub App のユーザー認可でログインした利用者のタスクを受け付ける。
- タスクは子エージェント（agent。Cloudflare Containers の隔離された Sandbox で動く）が実行し、作業ブランチへ push して Draft PR を作る。
- Web の検索・取得は、別の Worker（web）が非信頼データとして扱い、安全性を評価して返す。

**状態: 実験段階。** Phase 6 まで実装済みで、自動テスト（偽の GitHub・偽のモデルを使った E2E を含む）は通っている。実機（Claude Code / Cowork、GitHub、Cloudflare）での受入試験（[acceptance.md](docs/specs/acceptance.md)）が済むまでは、実験段階として扱ってほしい。`web_browse` は実験的で、既定では無効。

ライセンスは [MIT](LICENSE)。

設計は [docs/specs/design.md](docs/specs/design.md)、デプロイ手順（rovo を upstream にする下流向け）は [docs/deploy.md](docs/deploy.md)、手動の受入試験は [docs/specs/acceptance.md](docs/specs/acceptance.md)、Phase ごとの実装計画は `docs/specs/phase*.md`。

## 全体の構成

```
Claude Code / Cowork
   |  Remote MCP（OAuth）
   v
apps/gateway  --- service binding --->  apps/web   (Web Research Service: search / fetch / browse)
   |  Durable Object                        ^
   v                                        | service binding
apps/agent  (AgentDO -> SandboxDO + Container)
packages/audit  (監査ログの共通ライブラリ。3 つの Worker が使う)
```

| ディレクトリ | 役割 |
|---|---|
| `apps/gateway` | MCP サーバー、OAuth、タスクの状態（`TaskDO`）、利用者の資格と予算（`UserDO`） |
| `apps/agent` | 子エージェント（`AgentDO`）、Sandbox（`SandboxDO`）、外向き通信の制御（`OutboundGateway`） |
| `apps/web` | Web Research Service（状態を持たない別 Worker） |
| `packages/audit` | 監査イベントを 1 行の構造化 JSON で出す `audit()` |

## 提供するツール（Phase 6 まで実装済み。D9 で PR のツールを追加）

GitHub App のユーザー認可でログインし、`/mcp` から次のツールを使える。

| ツール | 内容 |
|---|---|
| `task_start` | タスクを作り、子エージェント（`apps/agent` の AgentDO）を起動する。`{task_id, status, draft_pr_url, note}`。`verification_commands`（任意）を渡すと、完了の申告後に Sandbox で実行される。`merge_policy`（任意。`human_review`（既定）| `agent_merge`）で、完了後の PR の扱いを選ぶ |
| `task_status` | 状態を返す |
| `task_wait` | 新しいイベントを最大 `timeout_seconds`（既定 30・上限 60）待つ（long polling）。待機中に子エージェントのイベントを取り込む |
| `task_result` | 終端になったタスクの成果（要約・検証結果・patch・費用・`merge_policy`・PR の `draft` / `merged`）を返す。終端でなければ `not_ready`。応答の `next_steps` が、状態に応じた次の一手（差分のレビュー → `task_pr_ready` → `task_pr_merge`、または人のレビュー待ち）を案内する |
| `task_cancel` | キャンセルする（終端状態でも冪等）。子エージェントの停止を確認するまで Gateway が再送する |
| `task_answer` | 子エージェントの質問（`INPUT_REQUIRED`）に答える |
| `task_steer` | 実行中の子エージェントに追加の指示を送る |
| `task_pr_ready` | COMPLETED のタスクの Draft PR を Ready for review にする（冪等）。`{task_id}` だけを受け、対象の PR はタスクの記録から決まる。利用者本人の GitHub トークンで行う |
| `task_pr_merge` | PR をマージする。`{task_id, merge_method?: squash \| merge \| rebase, delete_branch?}`。`merge_policy` が `agent_merge`、`head_matches_verified` が true、PR が Ready のときだけ。検証済みの head の sha を GitHub に渡し、ブランチ保護に拒否されたら `merge_blocked`（GitHub の理由つき）。利用者本人の GitHub トークンで行う |
| `web_search` | Web Search API の結果（url・title・description）を返す。詳細は下の「Web Research Service」 |
| `web_fetch` | 公開ページを取得して Markdown で返す（JS は実行しない） |
| `web_browse` | **実験的・既定で無効。** JS を描画した後のページを取得する |

**制約（ツールの応答にも明記している）**

- Phase 3（M1: Gateway 側）: `task_start` が作業ブランチ `agent/task-<id>` と Draft PR を作る。URL は `task_status`・`task_result`（`pr`）・イベント `draft_pr_created` で返る（`task_start` の応答の `draft_pr_url` は作成前なので `null`）。終端で PR 本文の rovo 管理範囲を更新し、Installation Token を失効する。成果は patch としても `task_result` で返る。
- PR のレビューと Ready 化・マージ（D9）: rovo 自身は PR を Ready にもマージにもしない（Draft のまま返す）。呼び出し元の AI が `task_result` の差分をレビューし、問題が無ければ `task_pr_ready` で Ready にする。そのあとは `task_start` の `merge_policy` による: `human_review`（既定）は人のレビューを待ち（`task_pr_merge` は `forbidden`）、`agent_merge` は `task_pr_merge` でマージまでできる。ポリシーはデプロイ全体の env ではなくタスクごとの入力で、組織としての強制は GitHub のブランチ保護に任せる（操作は利用者本人の GitHub トークンで行うため、保護に拒否されたら `merge_blocked`）。使い方の流れは MCP の `instructions` と `task_result` の `next_steps` にも書かれる。
- `idempotency_key` を省略すると、再試行の重複排除は保証されない。
- 利用者ごとの同時実行は 1 件まで。前のタスクの停止を確認できるまで、次のタスクは始められない。
- 1 タスクにつき既定で $10（env `TASK_BUDGET_USD`。0 以下・不正な値は 10）を月額の枠（env `MONTHLY_BUDGET_USD`、既定 100）から予約する。子エージェントの予算の上限（`budgetUsd`）にも同じ値を渡す。足りなければ `budget_exceeded`。月額の枠を 10 未満にするときは `TASK_BUDGET_USD` も下げる（受入試験で数ドルに抑えたいとき）。

### Web Research Service（`web_search` / `web_fetch` / `web_browse`）

親（MCP）の `web_search` / `web_fetch` の説明。子（`apps/agent` の Pi）にも同名のツールがある。どちらも `apps/web` を service binding で呼ぶ。

| ツール | 内容 |
|---|---|
| `web_search` | `{query, limit?}`。Web Search API の結果（url・title・description）を返す。private なアドレスなどを指す URL は結果から落とす |
| `web_fetch` | `{url}`。公開ページを取得して Markdown で返す（JS は実行しない）。`status: "blocked"` は取得できなかった（bot チャレンジ・robots.txt の Disallow・redirect で private に飛ぶ） |

- 本文（`content`）・`title`・検索の description は、Web 上の第三者が書いた**非信頼データ**。親には `<<<UNTRUSTED_WEB_CONTENT ...>>>` と `<<<END_UNTRUSTED_WEB_CONTENT>>>` で囲んで返し（本文中の `<<<` は全角に置き換える）、子には既存の `<<<BEGIN_UNTRUSTED_OUTPUT>>>` で囲んで渡す。
- `safety.verdict`: `allow`（問題なし）/ `caution`（不審な表現があるので慎重に）/ `block`（注入などを検出。本文は `null`）/ `unknown`（評価できなかった。本文は `null`）。検索は結果全体で 1 つの判定で、`block` / `unknown` のときは description を落とし、title も `(title withheld)` にして URL だけを返す。
- 回数の上限
  - 親: ユーザーごとに UTC の 1 日あたり search 200 回・fetch 500 回（`UserDO` が数える）。超えると `quota_exceeded`（`retry_after_seconds` は翌日 0 時 UTC まで）。env `WEB_SEARCH_DAILY_LIMIT` / `WEB_FETCH_DAILY_LIMIT` で変える。
  - web_browse は別枠: 親は 1 日 50 回（`WEB_BROWSE_DAILY_LIMIT`）、子はタスクごとに 20 回（`WEB_BROWSE_LIMIT_PER_TASK`）。
  - 子: タスクごとに search 50 回・fetch 100 回（`AgentDO` が数える）。超えるとツールのエラー。`apps/agent` の env `WEB_SEARCH_LIMIT_PER_TASK` / `WEB_FETCH_LIMIT_PER_TASK` で変える。回数は `usage` イベント（`web_search` / `web_fetch` / `web_browse`）と `task_result` の `usage.web` に出る。
  - 回数は呼び出しの前に数える（失敗しても戻さない）。web 自体には回数の上限を持たない（AI Gateway のレート制限とアカウントの上限に頼る）。
- `web_browse`（JS を描画した後のページを Markdown で取得。Browser Run の Kitesurf）は**既定で無効**。`apps/web`・`apps/agent`・`apps/gateway` の env `WEB_BROWSE_ENABLED` を `"true"` にした Worker だけが有効になる（無効なら親の tools/list にも子の Pi のツールにも出ない）。`{url}` だけを受け、`status` は `ok` / `blocked`（bot チャレンジ・robots・redirect や遷移先が private・許可外・https→http・private に解決される名前）/ `http_error`（4xx・5xx。本文なし）/ `unknown`（判定できなかった。本文なし）。保証するのは「禁止先・判定不能の取得結果を返さない」ことまでで、禁止先への通信の発生は防げない。**有効にする前に、`docs/specs/acceptance.md` の 11 節「web_browse（有効化前のゲート）」の残存リスクを読み、受け入れるかを判断してほしい。** 実機のゲートは任意で、作者は行わずに有効にしている。

## 構成

- `apps/web`（Phase 5）: Web Research Service の別 Worker。`WebResearch`（`WorkerEntrypoint`）の RPC `search` / `fetchUrl`（`fetch` は HTTP のハンドラ名なので使えない）。呼び出し元の種別は service binding の `props.caller`（gateway は `parent`、agent は `child`）から取り、props が無い・不正なら拒否する。状態を持たず、持つバインディングは `ai` だけ（GitHub のトークンや Anthropic のキーは持たない）。公開のルートは無い（`workers_dev: false`）
- `apps/gateway`: Cloudflare Worker。Hono でルーティングし、`@cloudflare/workers-oauth-provider` で全体を包む。
  - `/mcp`（要 OAuth）: `agents/mcp/server` の `createMcpHandler` + `@modelcontextprotocol/server`。リクエストごとに McpServer を作り、ユーザー情報は共有しない
  - `/authorize`（同意画面）→ GitHub App のユーザー認可 → `/callback`: defaultHandler。state（1 回限り・10 分）と、開始したブラウザへの Cookie 紐付けは OAuthProvider の `beginUpstream` / `finishUpstream` を使う
  - `UserDO`（ユーザーごと）: GitHub 資格（AES-GCM で暗号化）、team 所属のキャッシュ（TTL 5 分）、同時実行の予約、月額予算（タスクごとの予約・usage の冪等な精算・終了時の返却）。GitHub のトークンは DO の外へ返さない
  - `TaskDO`（タスクごと）: 状態とイベント。AgentDO への start / cancel の配送、イベントの取り込み、usage の精算を alarm で収束させる
- `apps/agent`: 子エージェントの別 Worker。`SandboxDO`（`ctx.container` を `enableInternet:false` で起動し、外向き通信を `OutboundGateway` に傍受させる）、`OutboundGateway`（許可判定は `src/outbound-policy.ts` の純粋関数）、`AgentDO`（`PiHarness` と台本付き fake モデルでの最小実装）。Gateway からは `script_name` 付きの DO バインディング `AGENT_DO` で呼ぶ

## 同意画面（confused deputy 対策）

DCR（動的クライアント登録）が有効なため、`/authorize` は GitHub へ行く前に必ず同意画面を表示する。悪意あるクライアントが利用者に認可を開始させても、利用者が承認しない限り MCP のアクセストークンは渡らない。

- 表示: クライアント名（`client_name`。自己申告で未検証）、**`redirect_uri` のホスト**（目立たせて表示）とフル URI、要求 scope、「このアプリにあなたの rovo タスクの作成・操作を許可しますか」。送り先のホストに見覚えがなければ拒否する。
- 承認すると GitHub のログインへ進む。拒否すると client の `redirect_uri` へ `error=access_denied` で戻る。
- CSRF 対策: フォームの値は 1 回限りの handle で、`__Host-` の Cookie（Secure・HttpOnly・SameSite=Lax）と突き合わせる。別のサイトや別のブラウザからの送信、再送は 400 になる。
- クリックジャッキング対策として `X-Frame-Options: DENY` と CSP（`default-src 'none'`・`frame-ancestors 'none'` など）を付ける。`form-action` は付けない（Chrome が POST 後の redirect 先にも適用し、承認・拒否後の redirect を壊すため）。
- 承認の記憶はしない。ログインのたびに同意画面が出る。

## 開発手順

ランタイム（node / pnpm）は [mise](https://mise.jdx.dev/) で固定している。コマンドはすべて `mise run` 経由で実行する。

**Docker が必要**: `apps/agent` の E2E（`mise run test:e2e:docker`、したがって `mise run test`）は `wrangler dev` が Docker でコンテナ（`apps/agent/Dockerfile`）をビルド・起動する。Docker Desktop など、ローカルで Docker が動いていること。初回はイメージのビルド（`cloudflare/sandbox:1.0.1` の取得を含む）に数分かかる。

**E2E の実行中は `mise run dev:all` を起動しない**: E2E の後始末は「その起動中に増えた `workerd-rovo-agent-*` コンテナ」を `docker rm -f` で消す。E2E 同士はロック（`$TMPDIR/rovo-e2e-docker.lock`）で直列化されるが、`dev:all` はロックを取らないため、並走すると開発セッションのコンテナが消えることがある。また E2E は `apps/*/.dev.vars` を起動中だけ書き換える（元のファイルは `.dev.vars.rovo-e2e-backup` に退避し、異常終了した場合も次の起動の冒頭で元に戻す）。

```sh
mise install          # node / pnpm を入れる
mise run install      # 依存パッケージ（pnpm install --frozen-lockfile）
mise run test         # Unit + 偽 GitHub + E2E
mise run lint         # Biome + 型検査
```

| タスク | 内容 |
|---|---|
| `mise run test:unit` | gateway・agent・web の Unit。vitest + `@cloudflare/vitest-plugin`（workerd 上で実行）。個別は `test:unit:gateway` / `test:unit:agent` / `test:unit:web`。agent の Unit ではコンテナが使えないので、`SandboxPort` を fake にする。web の Unit は `WebSearchSource` / fetch / `AI.run` をすべて fake にする（実アカウントは呼ばない）。Unit では `WEB` の service binding を差し替えている（gateway は env に fake を渡し、agent は `AgentTestOverrides.web`） |
| `mise run test:fake-github` | 偽 GitHub サーバーと GitHub クライアントの結合テスト（Node） |
| `mise run test:e2e` | `test:e2e:gateway` + `test:e2e:docker` |
| `mise run test:e2e:gateway` | `wrangler dev` で実 Worker と偽 GitHub を起動し、MCP SDK の Client から DCR → `/authorize` → 偽 GitHub → `/callback` → token(PKCE) → 4 つのツールまで通す |
| `mise run test:e2e:docker` | **Docker 必須**。`wrangler dev` で実コンテナを起動し、ローカルの偽サーバー（偽 GitHub の git smart HTTP と偽 npm レジストリ）を許可先にして、外向き通信の許可・拒否（非許可ホスト、push、内部 IP、非 80/443 ポート、IPv6、CONNECT、WebSocket、リダイレクト、ヘッダ除去、再起動後の傍受）と `npm install` / `git clone`、Gateway → Agent の DO RPC（`-c gateway -c agent` の同時起動）を検証する |
| `mise run test:e2e:full` | **Docker 必須**。gateway・agent・**web の 3 つの Worker を同時に** `wrangler dev` で起動し、MCP SDK の Client から Gateway → AgentDO → 実コンテナ、Phase 5 の `web_search` / `web_fetch`（親の MCP と子の台本）まで通しで検証する。偽なのは GitHub・git / npm の上流・モデル（台本）と、web の外側（Web Search API・Clef・toMarkdown・公開ページ。`apps/web/test/support/fake-web.ts`）だけ。web には `ENVIRONMENT=test` と `TEST_FAKE_BASE`（偽サーバーの URL）を `.dev.vars` で渡す |
| `mise run test:e2e:net` | **Docker 必須・実ネットワーク**。上の E2E の実ネットワーク版。実 registry.npmjs.org への GET / `npm install` が通ること、許可外のホストに出られないこと、github.com への通信はトークンが無ければ 401 で落ちる（認証なしの clone が通らない）ことだけを確かめる。git の clone / push の検証は偽 git の E2E が担う。CI で不安定になりうるため `test` には含めない。認証付きアクセスや push はしない |
| `mise run lint` / `mise run fmt` | Biome の lint / 整形、`tsc` の型検査 |
| `mise run typegen` | `wrangler.jsonc` を変えたら実行して両アプリの `worker-configuration.d.ts` を更新する |
| `mise run dev:all` | gateway・agent・web を同時にローカル起動する（Docker 必須）。`AGENT_DO` は `script_name` 付きなので、片方だけ起動すると本番の DO を参照してしまう（wrangler の known issue）。`WEB` の service binding も web が起動していないと解決できない。必ず全部を同時に起動する。web の `AI` バインディングは実アカウントに繋がるため、`web_search` / `web_fetch` を実際に呼ぶと課金される（`wrangler login` が必要）。それ以外の用途ではデプロイは不要 |
| `mise run build` | Worker のバンドル確認（`--dry-run`。デプロイはしない） |
| `mise run test:infra` | `infra/` の Terraform のテスト（`terraform test` + `mock_provider`。Cloudflare の資格情報もアカウントも要らない。provider の取得にネットワークが要る）。`mise run test` に含まれる |
| `mise run test:deploy` | `scripts/deploy.sh` の自己確認（偽の `pnpm` に差し替える。`ROVO_DEPLOY_DIR` が未設定・設定ファイルが無いときに失敗し、wrangler を呼ばないことを確かめる）。`test:unit` に含まれる |
| `mise run infra:fmt` / `mise run infra:validate` | `infra/` の整形 / 検証（`lint` は `terraform fmt -check` を含む） |
| `mise run deploy:web` / `deploy:agent` / `deploy:gateway` / `deploy:all` / `deploy:secrets` | **実際にデプロイする**（`ROVO_DEPLOY_DIR` の下流の wrangler 設定を使う。未設定なら何もせずに失敗する）。[デプロイ](#デプロイ)を見る |
| `mise run dev` | ローカル起動（`http://localhost:8787`）。`apps/gateway/.dev.vars` を読む |

E2E が失敗したときは `E2E_DEBUG=1 mise run test:e2e` で `wrangler dev` の出力も表示される。E2E は GitHub に接続しない（偽 GitHub を使う）。

**E2E の診断ログ**: E2E（Docker を使うもの）は、テストを流した場所の外に診断ログを常に残す。保存先は `$TMPDIR/rovo-e2e-logs/<タイムスタンプ>-xxxxxx/`（テストファイルごとに 1 つ。新しい 30 個を残して古いものは消える。`ROVO_E2E_LOG_DIR` でルートを変えられる）。
- `wrangler-<設定名>.log`: `wrangler dev` の出力（stdout / stderr）。E2E の終了時に `[rovo-e2e] wrangler のログ: <パス>` と表示される。起動に失敗したときのエラーにもパスが入る
- `timing.log`: 主要な段階（`wrangler ready` / `wrangler stop`、Sandbox の `ensure-ready` / `exec` / `stop`（reaper）/ `terminate` / `destroy`、Agent の各 RPC）の所要時間。失敗した段階は `failed` で記録される。`E2E_DEBUG=1` なら stderr にも出る（タイムアウトの値は変えていない）

## 設定

デプロイ時に用意する値の完全な一覧は [docs/deploy.md](docs/deploy.md) の 5 にある（食い違う場合は deploy.md を正とする）。

### 変数（`wrangler.jsonc` の `vars`、またはローカルは `.dev.vars`）

| 変数 | 内容 |
|---|---|
| `ENVIRONMENT` | `production`（既定）。`test` のときだけ `GITHUB_OAUTH_BASE` / `GITHUB_API_BASE` の上書きを許す。**本番で `test` にしないこと**（本番で上書きを指定すると起動時に拒否される） |
| `PUBLIC_BASE_URL` | 公開 URL。OAuth の issuer と `/mcp` の resource、GitHub のコールバック URL（`<PUBLIC_BASE_URL>/callback`）になる。本番は `https`、ローカルのみ loopback の `http` が許される |
| `GITHUB_APP_CLIENT_ID` | GitHub App の Client ID（秘密ではない） |
| `ALLOWED_ORG` / `ALLOWED_TEAM` | ログインと全ツール呼び出しを許す org と team の slug。子 team のメンバーも許可される。対で設定する（片方だけだとログインできない）。`ALLOWED_USER_IDS` のどちらかが必須 |
| `ALLOWED_USER_IDS` | ログインと全ツール呼び出しを許す GitHub の数値の user ID（カンマ区切り。`gh api user --jq .id` で分かる）。team の無い個人アカウントで使うときはこちらを使う。org/team と両方を設定した場合は、どちらかを満たせば許可する。不正な要素が 1 つでもあれば全体が不正になり、ログインできない（fail closed） |
| `GITHUB_APP_ID` | GitHub App の App ID（秘密ではない）。Installation Access Token の発行（JWT の `iss`）に使う。未設定だとタスクは `github_app_not_configured` で FAILED になる（fail closed） |
| `DRAFT_PR_FALLBACK` | Draft PR を作れないリポジトリ（Free プランの private リポジトリなど）での扱い。`fail`（既定。タスクを `draft_pr_unsupported` で FAILED にする）/ `ready`（`[WIP]` を付けた通常の PR を作り、本文冒頭に注記し、警告 `draft_pr_unavailable` を付ける）。**不正な値は `fail` として扱う**。判定は Draft に関する 422 のときだけ |
| `PR_SHOW_COST` | `true` のときだけ、費用を PR 本文に載せる（既定は載せない。公開リポジトリでは誰でも見られるため） |

### Secret（`wrangler secret put <NAME>`、ローカルは `.dev.vars`）

| Secret | 内容 |
|---|---|
| `GITHUB_APP_CLIENT_SECRET` | GitHub App の Client secret |
| `GITHUB_APP_PRIVATE_KEY` | GitHub App の秘密鍵（**PKCS#8** の PEM）。GitHub がダウンロードさせるのは PKCS#1（`BEGIN RSA PRIVATE KEY`）なので、`openssl pkcs8 -topk8 -nocrypt -in app.private-key.pem -out app.pkcs8.pem` で変換して投入する（`wrangler secret put GITHUB_APP_PRIVATE_KEY < app.pkcs8.pem`）。リポジトリには置かない |
| `TOKEN_ENC_KEY` | （gateway）GitHub のトークンを UserDO に暗号化して保存する鍵。base64 の 32 バイト（`openssl rand -base64 32`）。TaskDO が保存する Installation Token の暗号化にも使う。変えると保存済みの資格は復号できなくなり、全員が再ログインになる |

#### agent（`apps/agent`）の secret / 変数

| 名前 | 内容 |
|---|---|
| `TOKEN_ENC_KEY`（secret） | Installation Token を SandboxDO の storage に暗号化して保存する鍵。base64 の 32 バイト（`openssl rand -base64 32`）。`cd apps/agent && wrangler secret put TOKEN_ENC_KEY`。gateway の同名の secret とは別の Worker の値で、同じでも違ってもよい。未設定だと Installation Token を預けられず、`start` は拒否される（fail closed）。トークンはコンテナには入らない |
| `AI_GATEWAY_ID`（変数） | AI Gateway の ID。空だと `start` が `ai_gateway_not_configured` で拒否される |
| `AGENT_MODEL`（変数） | 子エージェントのモデル（既定 `anthropic/claude-sonnet-5-5`。単価表にあるものだけ） |
| `ENVIRONMENT`（変数） | `production`（既定）。E2E だけ `test` |

| `WEB_SEARCH_LIMIT_PER_TASK` / `WEB_FETCH_LIMIT_PER_TASK` / `WEB_BROWSE_LIMIT_PER_TASK`（変数） | 子の `web_search` / `web_fetch` / `web_browse` のタスクごとの回数の上限（既定 50 / 100 / 20）。0 以上の整数のみ。不正な値は既定に戻る |
| `WEB_BROWSE_ENABLED`（変数） | 子に `web_browse` を出すか（`"true"` のときだけ。既定 `"false"`） |
| `WEB`（service binding） | `apps/web` の `WebResearch`（`props: {caller: "child"}`）。デプロイは web → agent → gateway の順 |

ローカルは `apps/agent/.dev.vars.example` を `apps/agent/.dev.vars` にコピーして埋める（`mise run dev:all`）。

#### web（`apps/web`）の変数

secret は無い（GitHub のトークンも Anthropic のキーも持たせない）。バインディングは `ai`（Workers AI）だけ。

| 変数 | 内容 |
|---|---|
| `AI_GATEWAY_ID` | AI Gateway の ID。**必須**。空だと `websearch` も `AI.run`（Clef）も呼ばず、呼び出しは `misconfigured` のエラーになる（fail closed）。Clef の呼び出しには `userId` / `taskId` / `caller` を metadata に付ける |
| `WEB_SEARCH_PROVIDER` | 検索プロバイダ（`ceramic` / `exa` / `linkup`。既定 `ceramic`） |
| `SAFETY_BLOCK_THRESHOLD` / `SAFETY_CAUTION_THRESHOLD` | Policy Engine の閾値（既定 0.8 / 0.4）。モデルのスコアがこれ以上なら block / caution。**仮の値**で、受入試験で調整する |
| `ENVIRONMENT` / `TEST_FAKE_BASE` | E2E 専用。`ENVIRONMENT=test` のときだけ、`TEST_FAKE_BASE`（偽サーバーの URL）に AI（`run` / `websearch` / `toMarkdown`）と取得を向ける。本番は必ず `production` |

#### gateway の web 関連

| 名前 | 内容 |
|---|---|
| `WEB`（service binding） | `apps/web` の `WebResearch`（`props: {caller: "parent"}`） |
| `WEB_SEARCH_DAILY_LIMIT` / `WEB_FETCH_DAILY_LIMIT` / `WEB_BROWSE_DAILY_LIMIT`（変数） | 親の `web_search` / `web_fetch` / `web_browse` の、ユーザーごと・UTC の 1 日あたりの上限（既定 200 / 500 / 50） |
| `WEB_BROWSE_ENABLED`（変数） | 親の MCP に `web_browse` を出すか（`"true"` のときだけ。既定 `"false"`） |

**デプロイの順序**: web → agent → gateway。service binding は、参照される側の Worker（`rovo-web`）が先に存在している必要がある。agent は gateway から `script_name` で参照される。

### デプロイ

rovo は誰が clone しても、自分の値を渡せばデプロイできるようにしてある。upstream が次の 2 つを持つ。

- **`infra/`**: Cloudflare のリソース（R2 バケット 2 つ〔アーカイブ用・監査ログ用〕、KV、AI Gateway、監査ログの Logpush）を作る Terraform。使い方は [infra/README.md](infra/README.md)。
- **`deploy:*` の mise タスク**: `ROVO_DEPLOY_DIR`（下流の wrangler 設定のディレクトリ。雛形は [deploy.example/](deploy.example/)）を指定して `mise run deploy:all`（web → agent → gateway）。secret は `mise run deploy:secrets`。未設定なら何もせずに失敗する。

下流（デプロイする人の private リポジトリ）は、rovo を upstream として merge し、`deploy/` の wrangler 設定、tfvars、backend を**新しいファイルとして足す**だけで使う。手順の全体（Terraform apply → AI Gateway に BYOK → GitHub App → wrangler 設定 → `deploy:secrets` → `deploy:all`）は [docs/deploy.md](docs/deploy.md) の 4。MCP Server Portal と Access の登録はこの範囲外。

### 運用設定（下流向け: 監査ログ・R2 アーカイブ・単価）

rovo を upstream にする private リポジトリ（下流）が、自分の wrangler 設定とインフラで設定するもの。rovo の `wrangler.jsonc` は環境固有の値を持たない。まとまった手順は [docs/deploy.md](docs/deploy.md) にある。以下は要点で、食い違う場合は deploy.md を正とする。

#### 監査ログが「監査」として成立する条件

監査イベントは 1 行の構造化 JSON（`{"audit":true,"event":...}`）を `console.log` に出す（イベントの一覧は phase6.md）。Workers Logs に出るだけでは head sampling と短い保持のために行が欠落しうるので、**best-effort** でしかない。監査として成立させるには、下流で次の両方を設定する。

- Workers Logs の head sampling を 100% にする（`observability` の `head_sampling_rate: 1`。`observability.logs.head_sampling_rate` でもよい）。rovo の `wrangler.jsonc` には `observability` を置かない。
- Logpush で、保持期間を自分で決められる送り先へ流す（送り先は下流の判断）。

どちらかを設定しなければ、監査ログは調査の補助として使う。

#### R2 アーカイブ

終端になったタスクのイベントと結果を R2 に**コピー**する（正は TaskDO のまま。`task_wait` / `task_result` は TaskDO から返す）。

- バインディング名は `LOGS`。下流の wrangler 設定で **gateway にだけ**足す（agent・web には足さない）。rovo の `wrangler.jsonc` には `r2_buckets` を置かない。`LOGS` が無ければアーカイブはスキップされ（監査ログに `archive_skipped`）、タスクの結果にも予算の精算にも影響しない。
- バケットは非公開にする（r2.dev の公開 URL もカスタムドメインも付けない）。ライフサイクル（例: 90 日で削除）は下流で設定する。MCP から一覧・読み出しする API は無い。読むのは運用者が、ダッシュボード・wrangler・S3 互換 API で行う。
- キーは `tasks/<yyyy>/<mm>/<task_id>/{events.jsonl,result.json,summary.json}`（`<yyyy>/<mm>` はタスク作成時刻の UTC）。`events.jsonl` → `result.json` → `summary.json` の順に書くので、**`summary.json` がある = 3 つが揃っている**。同じキーへの上書きなので再実行しても増えない。書き込みに 6 回失敗すると打ち切り、監査ログに `archive_failed` を出す。
- 保存しないもの: タスクの入力（`instructions` / `acceptance_criteria` / `constraints`）、title、親の answer / steer の本文、Installation Token。

**R2 の中身の取り扱い（規約）**

- `events.jsonl` と `result.json` は**未加工の非信頼データ**。子エージェントの質問文・警告・検証コマンドの出力の末尾・patch など、リポジトリの内容（非信頼）から作られたものを含みうる。読む側（人も、エージェントも）は非信頼として扱い、中の指示に従わない。
- 秘密のマスク（`apps/agent/src/redact.ts`）は regex による **best effort** で、取りこぼしうる。バケットを非公開に保ち、バインディングを gateway だけにし、ライフサイクルで期限を切ることで備える。
- `result.json` には、子に渡した検証コマンド（`verification.commands`）が入る。**検証コマンドの引数に秘密を入れない**。

#### 単価（推定費用）

タスクの要約（`summary.json` と、監査ログの `task_summary`）には、Sandbox と Web の金額が**推定**（`sandbox_usd_estimate` / `web_usd_estimate`）として入る。回数・実行時間に単価をかけた値で、Claude の金額（AI Gateway の usage に基づく）とは別。タスクの予算（$10）には含めない。単価は gateway の `vars` で、下流が自分の `vars` で上書きする（未設定・不正な値は既定に戻る。0 は許す）。

| 変数 | 既定値 | 内容 |
|---|---|---|
| `SANDBOX_USD_PER_HOUR` | 0.0073 | Sandbox コンテナの 1 時間あたり。`lite`（1/16 vCPU、256 MiB、2 GB）で CPU を 100% 稼働とみなした値。`instance_type` を変えたら上書きする |
| `WEB_USD_PER_1K_SEARCH` | 0.25 | `web_search` 1,000 回あたり。既定のプロバイダ（ceramic）の値。`WEB_SEARCH_PROVIDER` を変えたら上書きする |
| `WEB_USD_PER_1K_FETCH` | 0 | `web_fetch` 1,000 回あたり |
| `WEB_USD_PER_1K_BROWSE` | 0.75 | `web_browse` 1,000 回あたり（1 回 30 秒を上限としたブラウザ時間） |

既定値の根拠（Cloudflare の公式料金表、取得日 2026-10-19）は `apps/gateway/wrangler.jsonc` のコメントと phase6.md にある。料金改定で変わるので、下流で見直す。Web の回数は**子が使った分だけ**（親が MCP から使う分はタスクに紐付かない）。

#### web_browse の有効化

`web_browse` は既定で無効（`WEB_BROWSE_ENABLED`）。有効にする前に、[docs/specs/acceptance.md](docs/specs/acceptance.md) の 11 節「web_browse（有効化前のゲート）」の残存リスクを読み、受け入れるかを判断して記録する。実機のゲート（付録 A）は任意。

### GitHub App の設定

GitHub の Settings > Developer settings > GitHub Apps で作る（OAuth App は使わない）。

- **Callback URL**: `<PUBLIC_BASE_URL>/callback`（ローカル開発用に `http://localhost:8787/callback` も追加できる）
- **Request user authorization (OAuth) during installation**: 不要。**Webhook**: 無効でよい
- **Expire user authorization tokens**: 有効にする（既定）。トークンは 8 時間で切れ、refresh token（約 6 か月）で自動更新される。有効期限を無効にした場合も動く
- **Repository permissions**
  - Metadata: Read-only
  - Contents: Read and write
  - Pull requests: Read and write
- **Organization permissions**
  - Members: Read-only（team 所属の確認に使う）
- App を対象の org / リポジトリに **Install** する。`task_start` は、利用者のトークンで見える Installation に対象リポジトリが含まれ、利用者に push 権限があるときだけ成功する（公開リポジトリでも App が未導入なら `forbidden`）

### ローカル開発

```sh
cp apps/gateway/.dev.vars.example apps/gateway/.dev.vars   # 値を埋める（.dev.vars は gitignore 済み）
mise run dev
```

`__Host-` 付きの Cookie（state の紐付け）は `Secure` なので、ブラウザは Chrome のように loopback の `http` で Secure Cookie を受け付けるものを使う。

## エラー

ツールのエラーは `isError: true` で、本文は `{"code", "message", "retry_after_seconds"?}` の JSON。`code` は
`not_found` / `conflict` / `expired` / `concurrency_limit` / `budget_exceeded`（月額の枠が足りず `task_start` を拒否。待っても空かない）/ `quota_exceeded`（web の1日の上限）/ `not_ready`（`task_result` の対象がまだ終端でない）/ `invalid_cursor` / `forbidden` / `reauth_required` / `upstream_unavailable` / `invalid_input` / `internal`。`task_pr_ready` / `task_pr_merge` では、GitHub の拒否を表す `merge_blocked`（ブランチ保護など。メッセージに GitHub の理由）/ `head_moved`（検証後にブランチが動いた）/ `github_rejected` も返る。
`reauth_required` は GitHub 資格を回復できないとき（MCP のトークンが有効でも）で、再ログインが必要。`internal` は想定外の失敗で、詳細は応答に含めない。

## セキュリティ

脆弱性は公開の Issue に書かず、GitHub の private vulnerability reporting で報告する。詳細は [SECURITY.md](SECURITY.md)。

## コントリビューション

個人プロジェクトとして公開している。Issue と Pull Request は歓迎するが、返信や取り込みの時期は約束できない。大きな変更は、先に Issue で相談してほしい。

## ライセンス

[MIT](LICENSE)
