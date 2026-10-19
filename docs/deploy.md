# デプロイ手順（下流向け）

rovo を upstream として取り込み、自分の Cloudflare アカウントにデプロイするための手順。環境固有の値はすべてプレースホルダ（`<YOUR_...>`）で書く。

**印について**: コードを読んで確かめられないこと（Cloudflare の画面操作、料金、実機での挙動）には「**【実機で確認して追記】**」と印を付けてある。実機での受入（[acceptance.md](specs/acceptance.md)）で確かめるまでは、この印の箇所を事実として扱わない。

## 1. この文書の位置づけ

- rovo は公開リポジトリ（upstream）。汎用のコードとドキュメントだけを置き、本番の値（account id、KV の id、AI Gateway の ID、許可する org / team、公開 URL、secret）は持たない。`wrangler.jsonc` はローカル開発とテスト用の設定。
- デプロイは、rovo を upstream に登録した**自分の private リポジトリ（下流）**から行う。下流は、新しいファイルを足すだけでデプロイできる構成にする。upstream のファイルは書き換えない（更新を衝突なく取り込むため）。
- 次の 2 つは、この文書の範囲外。
  - MCP Server Portal と Access の登録: Terraform など、下流のインフラ管理側で行う。登録に必要な情報だけを 8 に書く。
  - 下流のリポジトリ自体の中身（rovo には書かない）。
- upstream には**デプロイ用の mise タスクを置かない**（[design.md の 15.8](specs/design.md)）。デプロイの順序・承認・変更の管理は下流の運用なので、下流がタスクを足す（4）。

## 2. 前提

必要な Cloudflare の機能は次のとおり。

| 機能 | 使うところ | 備考 |
|---|---|---|
| Workers | 3 つの Worker（gateway・agent・web） | |
| Durable Objects（SQLite） | `TaskDO` / `UserDO`（gateway）、`AgentDO` / `SandboxDO`（agent） | |
| Containers | agent の `SandboxDO`（コーディング用の Sandbox） | `apps/agent/Dockerfile` からイメージをビルドする。デプロイするマシンで Docker が動く必要がある |
| KV | gateway の `OAUTH_KV`（OAuth の状態） | |
| Workers AI | web の `AI`（Web Search API、HTML の Markdown 変換、Clef-flash）、agent の `AI`（AI Gateway 経由で Claude を呼ぶ） | |
| AI Gateway | Claude、Web Search API、Clef-flash の呼び出し | Anthropic の API キーは AI Gateway に保管する。Worker には置かない |
| R2 | gateway の `LOGS`（任意。9） | |
| Browser Run | web の `BROWSER`（`web_browse` を使う場合だけ。12） | |

- 必要なプラン、Containers や Web Search API の提供状況: **【実機で確認して追記】**
- 課金されるもの: Workers / Durable Objects / Containers / KV / R2 の利用料、Workers AI（Web Search API、Clef-flash）、AI Gateway 経由の Claude の利用料、Browser Run（有効にした場合）。単価と見積もりは **【実機で確認して追記】**（推定の単価の上書きは 11）。
- ローカルに必要なもの: mise（`mise install` で node と pnpm が入る）、Docker、`wrangler login` 済みのアカウント。

## 3. 構成とデプロイの順序

| Worker | ディレクトリ | 役割 | 公開 |
|---|---|---|---|
| `rovo-web` | `apps/web` | Web Research Service（`web_search` / `web_fetch` / `web_browse`）。状態を持たない | しない（`workers_dev: false`。service binding からだけ呼ぶ） |
| `rovo-agent` | `apps/agent` | 子エージェント（`AgentDO`）と Sandbox（`SandboxDO`） | しない（`workers_dev: false`。gateway の DO バインディングからだけ呼ぶ） |
| `rovo-gateway` | `apps/gateway` | MCP サーバー（`/mcp`）、OAuth、`TaskDO` / `UserDO` | する |

依存関係:

- gateway と agent は、web を service binding（`WEB`、`WebResearch` エントリポイント）で呼ぶ。呼び出し元の種別は binding の `props.caller`（gateway は `parent`、agent は `child`）で固定されている。
- gateway は、agent の `AgentDO` を `script_name: "rovo-agent"` 付きの DO バインディング（`AGENT_DO`）で呼ぶ。

したがって、**デプロイの順序は web → agent → gateway**。参照される側が先に存在している必要がある。Worker 名（`rovo-web` / `rovo-agent`）を変える場合は、参照している側の `services` と `script_name` も合わせて変える。

## 4. 下流のリポジトリの作り方

### upstream の取り込み

下流のリポジトリに rovo を upstream として登録し、更新を取り込む（`git remote add upstream <rovo の URL>`、`git fetch upstream`、`git merge upstream/main`）。下流が足すのは新しいファイルだけなので、通常は衝突しない。

### 下流が足すファイル

| ファイル（例） | 内容 |
|---|---|
| `deploy/gateway.wrangler.jsonc` / `deploy/agent.wrangler.jsonc` / `deploy/web.wrangler.jsonc` | 本番用の wrangler 設定。`main` などは upstream の `apps/<name>/` を指す |
| デプロイ用のタスク | 次の「デプロイ用タスクの足し方」 |
| secret の投入手順 | 下流の運用文書。値そのものはリポジトリに置かない |

本番用の wrangler 設定は、`apps/<name>/wrangler.jsonc` と同じ内容に、環境固有のもの（KV の id、`vars` の実値、gateway の `r2_buckets` と `observability` など）を足したものにする。wrangler の設定ファイル内のパスは、その設定ファイルからの相対パスで書く（例: `"main": "../apps/gateway/src/index.ts"`）。agent のコンテナの `dockerfile` も同様に、`apps/agent/Dockerfile` を指す相対パスにする。**【実機で確認して追記】**（`-c` で別の場所の設定を指定したときの `main` / `dockerfile` / `compatibility` の解決）

> rovo の `wrangler.jsonc` に本番の値を書かないこと。特に `r2_buckets` は下流の設定にだけ置く。

### デプロイ用タスクの足し方（upstream の `mise.toml` は書き換えない）

mise の公式ドキュメントで確かめた 2 つの方法がある。どちらも、下流が**新しいファイルを足す**だけで、upstream の `mise.toml` と衝突しない。

**方法 1（推奨）: `mise-tasks/` のファイルタスク**

確かめた範囲: 別のスクラッチのディレクトリで、実行権限のあるスクリプトが `deploy:web` のようなタスク名で一覧に出ること、`mise run` で実行できること、`MISE_PROJECT_ROOT` が使えることまでは実行して確かめた。下のスクリプト例のとおりに `wrangler deploy -c` を実行するところは確かめていない。**【実機で確認して追記】**

- 実行権限のある（`chmod +x`）スクリプトを `mise-tasks/` に置くと、タスクになる。パスがタスク名になり、`/` は `:` に置き換わる（`mise-tasks/deploy/web` は `deploy:web`）。`#MISE description="..."` のようなヘッダでメタデータを書く。
- 参考: <https://mise.jdx.dev/tasks/file-tasks.html>

```bash
#!/usr/bin/env bash
#MISE description="web をデプロイする（下流の設定を -c で指定）"
set -euo pipefail
cd "$MISE_PROJECT_ROOT/apps/web"
pnpm exec wrangler deploy -c ../../deploy/web.wrangler.jsonc
```

`mise-tasks/deploy/agent`、`mise-tasks/deploy/gateway` も同様に置く。まとめて順序を固定したい場合は、`mise-tasks/deploy/all` から `mise run deploy:web && mise run deploy:agent && mise run deploy:gateway` を呼ぶ。

**方法 2: `MISE_ENV` で読まれる `mise.<env>.toml`**

- `MISE_ENV=<env>`（または `-E <env>`、`.miserc.toml`）を指定すると、`mise.toml` の上に `mise.<env>.toml` が追加で読み込まれる。タスクを `mise.<env>.toml` に書けば、`mise.toml` のタスクと並んで使える（このリポジトリのバージョンで動作を確認済み）。ただし、`MISE_ENV` を毎回指定する必要がある。
- 参考: <https://mise.jdx.dev/configuration/environments.html>

```toml
# mise.prod.toml（下流が新規に足すファイル）
[tasks."deploy:web"]
description = "web をデプロイする"
dir = "apps/web"
run = "pnpm exec wrangler deploy -c ../../deploy/web.wrangler.jsonc"
```

実行は `MISE_ENV=prod mise run deploy:web`。

どちらの方法でも、誤って upstream の `wrangler.jsonc`（本番の値が無い）をデプロイしないよう、タスクは必ず `-c` で下流の設定を指定する。

> `mise.local.toml` は `.gitignore` に入っているので、チームで共有する手段としては使えない。

## 5. 下流が用意する値の一覧

名前は各 `wrangler.jsonc` の `vars`、`.dev.vars.example`、`apps/gateway/src/env.d.ts` と一致させてある。

### 変数（`vars`）

| 名前 | Worker | 必須 | 例 | 説明 |
|---|---|---|---|---|
| `ENVIRONMENT` | gateway / agent / web | 既定 `production` | `production` | `test` は E2E 専用。**本番で `test` にしない**（本番で GitHub の接続先の上書きを指定すると起動時に拒否される） |
| `PUBLIC_BASE_URL` | gateway | 必須 | `https://<YOUR_GATEWAY_HOST>` | 公開 URL。OAuth の issuer と `/mcp` の resource、GitHub のコールバック URL（`<PUBLIC_BASE_URL>/callback`）になる。本番は `https` |
| `GITHUB_APP_CLIENT_ID` | gateway | 必須 | `<YOUR_GITHUB_APP_CLIENT_ID>` | GitHub App の Client ID（秘密ではない）。空だとログインは失敗する（fail closed） |
| `ALLOWED_ORG` | gateway | org/team か `ALLOWED_USER_IDS` のどちらかが必須（org/team は対） | `<YOUR_ORG>` | ログインと全ツール呼び出しを許す org の slug。`ALLOWED_TEAM` と対で設定する。**片方だけ設定すると設定の誤りとしてログインできない**（`ALLOWED_USER_IDS` に切り替わらない） |
| `ALLOWED_TEAM` | gateway | 同上 | `<YOUR_TEAM>` | 許す team の slug。子 team のメンバーも許可される。`ALLOWED_ORG` と対 |
| `ALLOWED_USER_IDS` | gateway | org/team か `ALLOWED_USER_IDS` のどちらかが必須 | `<YOUR_GITHUB_USER_ID>`（複数はカンマ区切り） | ログインと全ツール呼び出しを許す GitHub の**数値の user ID**。個人アカウントには team が無いので、個人で使うときはこちらを使う。自分の ID は `gh api user --jq .id`。login（ユーザー名）は改名でき、空いた名前を他人が取れるので使わない。前後の空白は無視する。**1 つでも不正な要素（数字以外・0・重複・空要素）があれば、設定全体が不正としてログインできない**（不正な要素を読み飛ばさない）。org/team と両方を設定した場合は、どちらかを満たせば許可する。ID で許可する場合も、トークンの持ち主の確認（`GET /user`）は省略しない |
| `GITHUB_APP_ID` | gateway | 必須 | `<YOUR_GITHUB_APP_ID>` | GitHub App の App ID（秘密ではない）。Installation Token の発行に使う。未設定だとタスクは `github_app_not_configured` で FAILED になる |
| `DRAFT_PR_FALLBACK` | gateway | 任意 | `fail` | Draft PR を作れないリポジトリ（Free プランの private など）での扱い。`fail`（既定）/ `ready`。不正な値は `fail` |
| `PR_SHOW_COST` | gateway | 任意 | `false` | `true` のときだけ費用を PR 本文に載せる。公開リポジトリでは誰でも見られる |
| `MONTHLY_BUDGET_USD` | gateway | 任意 | `100` | ユーザーごとの月額の費用上限（USD）。1 タスクにつき `TASK_BUDGET_USD` を予約する |
| `TASK_BUDGET_USD` | gateway | 任意 | `10` | 1 タスクに予約する予算（USD）。子エージェントの `budgetUsd`（超えると `budget_exceeded` で止まる）にも同じ値を渡す。0 以下・不正な値は 10。`MONTHLY_BUDGET_USD` より大きいとタスクを始められないので、月額を 10 未満にするときはこれも下げる |
| `WEB_SEARCH_DAILY_LIMIT` | gateway | 任意 | `200` | 親の `web_search` の、ユーザーごと・UTC の 1 日あたりの上限 |
| `WEB_FETCH_DAILY_LIMIT` | gateway | 任意 | `500` | 親の `web_fetch` の同上 |
| `WEB_BROWSE_DAILY_LIMIT` | gateway | 任意 | `50` | 親の `web_browse` の同上 |
| `WEB_BROWSE_ENABLED` | gateway / agent / web | 任意 | `"false"` | `"true"` のときだけ `web_browse` が有効。3 つの Worker で揃える（12） |
| `SANDBOX_USD_PER_HOUR` | gateway | 任意 | `0.0073` | 推定費用の単価（11） |
| `WEB_USD_PER_1K_SEARCH` | gateway | 任意 | `0.25` | 同上 |
| `WEB_USD_PER_1K_FETCH` | gateway | 任意 | `0` | 同上 |
| `WEB_USD_PER_1K_BROWSE` | gateway | 任意 | `0.75` | 同上 |
| `AI_GATEWAY_ID` | agent / web | 必須 | `<YOUR_AI_GATEWAY_ID>` | AI Gateway の ID。agent で空だと `start` が `ai_gateway_not_configured` で拒否される。web で空だと `websearch` も Clef も呼ばず、web 内部では `misconfigured` として失敗する（fail closed）。MCP のツールからは `internal`（`web research service is not available`）に見える |
| `AGENT_MODEL` | agent | 任意 | `anthropic/claude-sonnet-5-5` | 子エージェントのモデル。`apps/agent/src/agent/pricing.ts` の単価表にあるものだけ使える |
| `TEST_UPSTREAM` | agent | 本番では不要 | （空） | `ENVIRONMENT=test` のときだけ有効。E2E 専用。本番では設定しない |
| `WEB_SEARCH_LIMIT_PER_TASK` | agent | 任意 | `50` | 子の `web_search` のタスクごとの回数の上限 |
| `WEB_FETCH_LIMIT_PER_TASK` | agent | 任意 | `100` | 子の `web_fetch` の同上 |
| `WEB_BROWSE_LIMIT_PER_TASK` | agent | 任意 | `20` | 子の `web_browse` の同上 |
| `WEB_SEARCH_PROVIDER` | web | 任意 | `ceramic` | 検索プロバイダ（`ceramic` / `exa` / `linkup`）。変えたら単価も合わせる |
| `SAFETY_BLOCK_THRESHOLD` | web | 任意 | `0.8` | Policy Engine の閾値（0〜1）。モデルのスコアがこれ以上なら block。**仮の値**で、受入で調整する |
| `SAFETY_CAUTION_THRESHOLD` | web | 任意 | `0.4` | 同上。caution |
| `TEST_FAKE_BASE` | web | 本番では不要 | （空） | `ENVIRONMENT=test` のときだけ有効。E2E 専用。本番では設定しない |

> **キャッシュの注意**: ツール呼び出しごとの認可の結果は、UserDO に最大 5 分（`membership_cache` の TTL）キャッシュされる。`ALLOWED_USER_IDS` から ID を外しても、team から外しても、再デプロイ後 TTL が切れるまでは、そのユーザーは有効なままになる（最大 5 分）。

### Secret（`wrangler secret put <NAME> -c <下流の設定>`）

| 名前 | Worker | 必須 | 説明 |
|---|---|---|---|
| `GITHUB_APP_CLIENT_SECRET` | gateway | 必須 | GitHub App の Client secret |
| `GITHUB_APP_PRIVATE_KEY` | gateway | 必須 | GitHub App の秘密鍵（**PKCS#8** の PEM）。変換は 6 |
| `TOKEN_ENC_KEY` | gateway | 必須 | GitHub のトークンと Installation Token を暗号化して保存する鍵。base64 の 32 バイト（`openssl rand -base64 32`）。変えると保存済みの資格は復号できず、全員が再ログインになる |
| `TOKEN_ENC_KEY` | agent | 必須 | Installation Token を SandboxDO に暗号化して保存する鍵。形式は同じだが、gateway とは別の Worker の値で、同じでも違ってもよい。未設定だと `start` は拒否される（fail closed） |

web に secret は無い（GitHub のトークンも Anthropic のキーも持たせない）。

### バインディング

| 名前 | Worker | 必須 | 説明 |
|---|---|---|---|
| `OAUTH_KV`（KV） | gateway | 必須 | KV namespace の id は下流の設定に書く（rovo の `wrangler.jsonc` には id が無い） |
| `LOGS`（R2） | gateway だけ | 任意 | アーカイブ先のバケット。無ければアーカイブはスキップされる（9） |
| `TASK_DO` / `USER_DO`（DO） | gateway | 必須 | 設定済み |
| `AGENT_DO`（DO、`script_name: "rovo-agent"`） | gateway | 必須 | 設定済み。agent を先にデプロイする |
| `SANDBOX_DO` / `AGENT_DO`（DO、コンテナ） | agent | 必須 | 設定済み。コンテナのイメージは `apps/agent/Dockerfile` |
| `WEB`（service binding） | gateway / agent | 必須 | `rovo-web` の `WebResearch`。`props.caller` は gateway が `parent`、agent が `child` |
| `AI`（Workers AI） | agent / web | 必須 | 設定済み |
| `BROWSER`（Browser Run） | web | `web_browse` を使う場合 | `remote` の設定は下流で行う（12） |

## 6. GitHub App の作成

GitHub の Settings > Developer settings > GitHub Apps で作る（OAuth App は使わない）。

- **Callback URL**: `<PUBLIC_BASE_URL>/callback`（ローカル開発用に `http://localhost:8787/callback` も追加できる）
- **Request user authorization (OAuth) during installation**: 不要。**Webhook**: 無効でよい
- **Expire user authorization tokens**: 有効にする（既定）。トークンは 8 時間で切れ、refresh token（約 6 か月）で自動更新される。無効にした場合も動く
- **Repository permissions**: Metadata: Read-only / Contents: Read and write / Pull requests: Read and write
- **Organization permissions**: Members: Read-only（team 所属の確認に使う。`ALLOWED_USER_IDS` だけで認可する個人利用では使わない）
- App を対象の org / リポジトリに **Install** する。個人アカウントのリポジトリでも、`task_start` の Installation と push 権限の確認はそのまま動く（`ALLOWED_USER_IDS` で認可した利用者は、org の Members 権限を使わない）。`task_start` は、利用者のトークンで見える Installation に対象リポジトリが含まれ、利用者に push 権限があるときだけ成功する（公開リポジトリでも App が未導入なら `forbidden`）

**秘密鍵の変換**: GitHub がダウンロードさせる鍵は PKCS#1（`BEGIN RSA PRIVATE KEY`）。gateway は PKCS#8 を受け付けるので、変換してから投入する。鍵のファイルはリポジトリに置かない。

```sh
openssl pkcs8 -topk8 -nocrypt -in app.private-key.pem -out app.pkcs8.pem
wrangler secret put GITHUB_APP_PRIVATE_KEY -c <YOUR_GATEWAY_CONFIG> < app.pkcs8.pem
```

## 7. AI Gateway の設定

- AI Gateway を 1 つ作り、その ID を agent と web の `AI_GATEWAY_ID` に設定する（5）。Anthropic の API キーは AI Gateway に保管する（BYOK）。Worker・Sandbox にはキーを置かない。
- 経路:
  - agent: `AI` バインディングが AI Gateway 経由で Claude を呼ぶ（子エージェントのモデル呼び出しは AI Gateway 経由だけ）。
  - web: `env.AI.websearch()`（Web Search API）と、安全性の評価（`env.AI.run` による Clef-flash）。どちらも AI Gateway を通る。
- Clef の呼び出しには、metadata として `userId` / `taskId` / `caller` が付く（誰がいくら使ったかの集計用）。
- AI Gateway の画面での設定項目（認証、レート制限、クレジット〔Unified Billing〕など）: **【実機で確認して追記】**

## 8. Portal / Access への登録に必要な情報

登録自体は、この文書の範囲外（下流のインフラ管理側）。登録に必要な情報は次のとおり。

- MCP の URL: `<PUBLIC_BASE_URL>/mcp`
- ユーザーごとの OAuth: Portal の「Require user auth」を有効にする。
- OAuth のエンドポイント: DCR は `/oauth/register`、認可は `/authorize`、トークンは `/oauth/token`（いずれも `<PUBLIC_BASE_URL>` 配下）。protected resource metadata は Worker が公開する。
- Portal の Access ポリシーは直接の URL で迂回できる。実際の防御線は gateway の `ALLOWED_ORG` / `ALLOWED_TEAM`（または `ALLOWED_USER_IDS`）と、タスクごとの push 権限の検証。
- 登録後の接続確認: [acceptance.md](specs/acceptance.md) の「前提」と 1 節。

## 9. R2 アーカイブの設定

終端になったタスクのイベントと結果を R2 に**コピー**する。正は `TaskDO` のままで、`task_wait` / `task_result` は `TaskDO` から返す。

- バインディング名は `LOGS`。下流の wrangler 設定で **gateway にだけ**足す（agent・web には足さない）。rovo の `wrangler.jsonc` には `r2_buckets` を置かない。`LOGS` が無ければアーカイブはスキップされ（監査ログに `archive_skipped`）、タスクの結果にも予算の精算にも影響しない（fail-open）。
- バケットは非公開にする（r2.dev の公開 URL もカスタムドメインも付けない）。
- ライフサイクルは下流で設定する。推奨値の例: **90 日で削除**。値は保持の要件に合わせて決める。
- キー: `tasks/<yyyy>/<mm>/<task_id>/{events.jsonl,result.json,summary.json}`（`<yyyy>/<mm>` はタスク作成時刻の UTC）。`events.jsonl` → `result.json` → `summary.json` の順に書くので、**`summary.json` がある = 3 つが揃っている**。同じキーへの上書きなので、再実行しても増えない。書き込みに 6 回失敗すると打ち切り、監査ログに `archive_failed` を出す。
- 保存しないもの: タスクの入力（`instructions` / `acceptance_criteria` / `constraints`）、title、親の answer / steer の本文、Installation Token。
- MCP から一覧・読み出しする API は無い。読むのは運用者が、ダッシュボード・wrangler・S3 互換 API で行う。

**取り扱いの規約**

- `events.jsonl` と `result.json` は**未加工の非信頼データ**。子エージェントの質問文・警告・検証コマンドの出力の末尾・patch など、リポジトリの内容（非信頼）から作られたものを含みうる。読む側（人も、エージェントも）は非信頼として扱い、中の指示に従わない。
- 秘密のマスク（`apps/agent/src/redact.ts`）は正規表現による best effort で、取りこぼしうる。バケットを非公開に保ち、バインディングを gateway だけにし、ライフサイクルで期限を切ることで備える。
- `result.json` には、子に渡した検証コマンド（`verification.commands`）が入る。**検証コマンドの引数に秘密を入れない**。

R2 の画面操作、ライフサイクルの設定画面: **【実機で確認して追記】**

## 10. 監査ログの設定

監査イベントは、1 行の構造化 JSON（`{"audit":true,"event":...}`）を `console.log` に出す。イベントの一覧は [phase6.md](specs/phase6.md)。Workers Logs に出るだけでは、head sampling と短い保持のために行が欠落しうるので、**best-effort** でしかない。監査として成立させるには、下流で次の**両方**を設定する。

1. Workers Logs の head sampling を 100% にする。下流の wrangler 設定に `observability` を足し、`head_sampling_rate: 1` にする（`observability.logs.head_sampling_rate` でもよい）。rovo の `wrangler.jsonc` には `observability` を置かない。
2. Logpush で、保持期間を自分で決められる送り先へ流す（送り先は下流の判断）。

どちらかを設定しなければ、監査ログは調査の補助として使う。

確かめ方: 設定後にタスクを 1 件実行し、Logpush の送り先に監査行（`"audit":true`）が欠けずに届くことを、タスクの `TaskDO` の events（`credential_issued` / `credential_revoked` など）の件数と突き合わせる。具体的な手順は [acceptance.md](specs/acceptance.md) の 16 節。Logpush の画面操作: **【実機で確認して追記】**

## 11. 単価（推定費用）の上書き

タスクの要約（`summary.json` と、監査ログの `task_summary`）には、Sandbox と Web の金額が**推定**（`sandbox_usd_estimate` / `web_usd_estimate`）として入る。回数・実行時間に単価をかけた値で、Claude の金額（AI Gateway の usage に基づく）とは別。タスクの予算（$10）には含めない。単価は gateway の `vars` の既定値で、下流が自分の `vars` で上書きする（未設定・不正な値は既定に戻る。0 は許す）。

| 変数 | 既定値 | 内容 |
|---|---|---|
| `SANDBOX_USD_PER_HOUR` | 0.0073 | Sandbox コンテナの 1 時間あたり。`lite`（1/16 vCPU、256 MiB、2 GB）で CPU を 100% 稼働とみなした値。`instance_type` を変えたら上書きする |
| `WEB_USD_PER_1K_SEARCH` | 0.25 | `web_search` 1,000 回あたり。既定のプロバイダ（ceramic）の値。`WEB_SEARCH_PROVIDER` を変えたら上書きする |
| `WEB_USD_PER_1K_FETCH` | 0 | `web_fetch` 1,000 回あたり |
| `WEB_USD_PER_1K_BROWSE` | 0.75 | `web_browse` 1,000 回あたり（1 回 30 秒を上限としたブラウザ時間） |

既定値の根拠（Cloudflare の公式料金表、取得日 2026-10-19）は `apps/gateway/wrangler.jsonc` のコメントと [phase6.md](specs/phase6.md) にある。料金改定で変わるので、下流で見直す。Web の回数は**子が使った分だけ**（親が MCP から使う分はタスクに紐付かない）。

## 12. web_browse の有効化

`web_browse`（JS を描画した後のページを Markdown で取得。Browser Run の Kitesurf）は**実験的で、既定で無効**。

- 有効にする前に、[acceptance.md](specs/acceptance.md) の 11 節「web_browse（有効化前のゲート）」の残存リスクを読み、受け入れるかを運用者が判断して記録する。保証するのは「禁止先・判定不能の取得結果を返さない」ことまでで、禁止先への通信の発生は防げない。実機のゲート（付録 A）は任意で、このリポジトリの作者は行わずに有効にしている。
- 有効にするには、3 つの Worker の `WEB_BROWSE_ENABLED` を `"true"` にする。順序は web → agent → gateway（4 の順序と同じ）。無効のままなら、親の `tools/list` にも子のツールにも出ない。
- web の `BROWSER` バインディングは、下流の設定で `remote` を指定する（ローカルの `BROWSER` は実際のブラウザを持たない）。設定の方法、wrangler の版と `compatibility_date`: **【実機で確認して追記】**
- 有効化後は、`tools/list` に `web_browse` が現れることを確かめる。

## 13. 初回デプロイの確認

最低限のスモークテスト:

1. 3 つの Worker が、web → agent → gateway の順にデプロイできた。
2. `<PUBLIC_BASE_URL>/mcp` が、認証なしで 401 を返す（protected resource metadata が参照できる）。
3. Portal 経由で Claude Code から接続し、同意画面 → GitHub のログイン → ツールの一覧（`task_start` / `task_status` / `task_wait` / `task_result` / `task_cancel` / `task_answer` / `task_steer` / `web_search` / `web_fetch`。`web_browse` は有効にした場合だけ）が出る。
4. 許可した team のメンバーで `task_start` → Draft PR ができ、`task_result` が返る。

詳しい受入は [acceptance.md](specs/acceptance.md)。実機での確認の結果: **【実機で確認して追記】**

## 14. 更新手順とロールバック

- 更新: upstream を取り込み（4）、`mise run test`（または自分の CI）で確認し、web → agent → gateway の順に再デプロイする。
- Durable Object のマイグレーション: gateway の `migrations`（`TaskDO` / `UserDO`）は upstream の `wrangler.jsonc` にある。下流の設定にも**同じ `migrations` を引き継ぐ**。クラス名の変更・削除は、保存済みのデータを失うので、upstream の更新で入った場合は内容を確認してから適用する。
- 公開 API を変える更新（ツールの入出力）は、接続中のクライアントに影響する。upstream の変更を確認する。
- ロールバック: Cloudflare の Worker のバージョン機能で前のバージョンに戻せるが、DO のマイグレーションと保存済みのデータは戻らない。**【実機で確認して追記】**（コンテナを含む agent のロールバック）
- 実行中のタスクがある間の再デプロイ（特に agent）の影響: **【実機で確認して追記】**

## 15. 運用の注意

- 予算: タスクごとに `TASK_BUDGET_USD`（既定 $10）を月額の枠（`MONTHLY_BUDGET_USD`、既定 100）から予約する。足りなければ `budget_exceeded`。ユーザーごとの同時実行は 1 件まで。
- 秘密のローテーション:
  - `TOKEN_ENC_KEY`（gateway）を変えると、保存済みの GitHub 資格は復号できなくなり、全員が再ログインになる。
  - `TOKEN_ENC_KEY`（agent）を変えると、実行中のタスクは次のトークン更新まで push / clone が 401 になる。実行中のタスクが無いときに変える。
  - GitHub App の Client secret / 秘密鍵は、GitHub で新しいものを発行して `wrangler secret put` で差し替える。
- Installation Token は、タスクの終端で失効する。失効に失敗した場合は、期限（最長 1 時間）まで有効。
- 障害時の見方: 監査ログ（10）、R2 の `summary.json`（9）、`task_status` / `task_result`。Sandbox の復旧の回数は要約の `restarts` / `bootRetries` に出る。
- R2 の中身は非信頼データとして扱う（9）。

## 16. トラブルシューティング

ツールのエラーの `code` と意味は、[README のエラーの節](../README.md#エラー)にある。よくある設定の誤り:

| 症状 | 原因 |
|---|---|
| ログインできない | `ALLOWED_ORG` / `ALLOWED_TEAM` / `ALLOWED_USER_IDS` のどのルールも設定されていない、`ALLOWED_ORG` と `ALLOWED_TEAM` の片方だけ、`ALLOWED_USER_IDS` に不正な要素がある、または許可されていない。`GITHUB_APP_CLIENT_ID` が空 |
| `task_start` が `github_app_not_configured` で FAILED | `GITHUB_APP_ID` または `GITHUB_APP_PRIVATE_KEY` が未設定 |
| `task_start` が `ai_gateway_not_configured` で拒否される | agent の `AI_GATEWAY_ID` が空 |
| `task_start` が `forbidden` | App が対象リポジトリに未導入、または push 権限が無い |
| `task_start` が `draft_pr_unsupported` で FAILED | Draft PR を作れないリポジトリ。`DRAFT_PR_FALLBACK=ready` にするか、リポジトリを変える |
| `web_search` / `web_fetch` が `internal`（`web research service is not available`） | 原因の候補は、web の `AI_GATEWAY_ID` が空（web 内部の名前は `misconfigured`。ツールの応答には出ない）。ほかに web 機能の無効・未実装も同じ応答になる |
| `web_browse` が tools/list に出ない | 3 つの Worker の `WEB_BROWSE_ENABLED` が揃っていない |
| デプロイで service binding が解決できない | 順序の誤り（web → agent → gateway） |
| アーカイブが作られない | `LOGS` が gateway に束ねられていない（監査ログに `archive_skipped`） |
