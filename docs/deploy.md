# デプロイ手順（下流向け）

rovo を upstream として取り込み、自分の Cloudflare アカウントにデプロイするための手順。**急ぐ人は 4 のクイックスタート（`mise run setup`）だけでよい。** 以降は詳細の参照（値の一覧、GitHub App、AI Gateway、R2、監査ログなど）。環境固有の値はすべてプレースホルダ（`<YOUR_...>`）で書く。

**印について**: Cloudflare の公式文書で確かめられたことは、出典の URL を添えて事実として書いた（確認日 2026-10-24。文書は変わるので、迷ったら出典を見直す）。公式文書では確かめられないこと（画面操作の細部、実アカウントでの挙動）には「**【実機で確認して追記】**」と印を付けてある。実機での受入（[acceptance.md](specs/acceptance.md)）で確かめるまでは、この印の箇所を事実として扱わない。

## 1. この文書の位置づけ

- rovo は公開リポジトリ（upstream）。汎用のコードとドキュメントだけを置き、本番の値（account id、KV の id、AI Gateway の ID、許可する org / team、公開 URL、secret）は持たない。`wrangler.jsonc` はローカル開発とテスト用の設定。
- デプロイは、rovo を upstream に登録した**自分の private リポジトリ（下流）**から行う。下流は、新しいファイルを足すだけでデプロイできる構成にする。upstream のファイルは書き換えない（更新を衝突なく取り込むため）。
- 次の 2 つは、この文書の範囲外。
  - MCP Server Portal と Access の登録: Terraform など、下流のインフラ管理側で行う。登録に必要な情報だけを 8 に書く。
  - 下流のリポジトリ自体の中身（rovo には書かない）。
- upstream は、デプロイ用の mise タスク（`deploy:*`）と、Cloudflare のリソースを作る Terraform（`infra/`）を持つ（[design.md の 15.8](specs/design.md) の D3。2026-10-20 に見直した。理由は、誰でも clone して自分の値を渡せばデプロイできるようにするため）。下流が足すのは、`rovo.config.json`（秘密でない値）、そこから生成する `deploy/` の wrangler 設定、Terraform の backend だけ（secret の値は `deploy:secrets` が Worker に直接入れる）。デプロイの承認・変更の管理は下流の運用（4）。

## 2. 前提

必要な Cloudflare の機能は次のとおり。

| 機能 | 使うところ | 備考 |
|---|---|---|
| Workers | 3 つの Worker（gateway・agent・web） | |
| Durable Objects（SQLite） | `TaskDO` / `UserDO`（gateway）、`AgentDO` / `SandboxDO`（agent） | |
| Containers | agent の `SandboxDO`（コーディング用の Sandbox） | `apps/agent/Dockerfile` からイメージをビルドする。デプロイするマシンで Docker が動く必要がある |
| KV | gateway の `OAUTH_KV`（OAuth の状態） | |
| Workers AI | web の `AI`（Web Search API、HTML の Markdown 変換、Clef-flash）、agent の `AI`（AI Gateway 経由で Claude を呼ぶ。Sandbox の昇格の判断に Clef）、gateway の `AI`（task_start で model を省略したとき、Clef がモデルを選ぶ。新しい secret は無い） | gateway に `ai` バインディングが増えた。既存のデプロイは `mise run deploy:config` で設定を作り直してから deploy する（`deploy:config:check` で確かめる） |
| AI Gateway | Claude、Web Search API、Clef-flash の呼び出し | Anthropic の API キーは AI Gateway に保管する。Worker には置かない |
| R2 | gateway の `LOGS`（任意。9） | |
| Browser Run | web の `BROWSER`（宣言は常にある。コードが使うのは `WEB_BROWSE_ENABLED` が `"true"` のときだけ。12） | upstream の `wrangler.jsonc` も `deploy.example/` も `browser` を常に宣言している。`apps/web/src/service.ts` は `env.BROWSER` を `WEB_BROWSE_ENABLED` の確認より後でしか触らない（無効なら使われない）。Browser Run は Workers Free でも使える（1 日 10 分まで）ので、プランの面では宣言だけでデプロイが止まる理由は文書に無い（出典: [Browser Run の制限](https://developers.cloudflare.com/browser-run/limits/)）。ただし宣言だけのデプロイを実アカウントで通したことはない: **【実機で確認して追記】** |

- **必要なプラン**: **Workers Paid プラン（月 5 USD〜）が要る。** Containers の利用料は Workers Paid の枠（メモリ・CPU・ディスクの月ごとの含み量）に付いていて、Workers Free の欄は N/A（使えない）。出典: [Containers の料金](https://developers.cloudflare.com/containers/platform/pricing/)、[Workers の料金](https://developers.cloudflare.com/workers/platform/pricing/)。監査ログの Logpush（Workers Trace Events）も Workers Paid が要る（出典: [Logpush](https://developers.cloudflare.com/logs/logpush/)）。
- **Web Search API**: 2026-10-02 にベータとして提供開始。AI Gateway を通り、AI Gateway のクレジットか、Gateway に保管したプロバイダーのキーで払う（出典: [Web Search API](https://developers.cloudflare.com/web-search/how-to-use/)）。rovo の web は `env.AI.websearch()` を使う（7）。ベータなので仕様や提供状況は変わりうる。
- **課金されるもの**: Workers / Durable Objects / Containers / KV / R2 の利用料、Workers AI（Web Search API、Clef-flash）、AI Gateway 経由の Claude の利用料、Browser Run（有効にした場合）。文書にある単価（2026-10-24 の確認。変わりうるので出典を見る）: Containers は 10ms 単位で、含み量を超えるとメモリ 0.0000025 USD / GiB-秒・CPU 0.000020 USD / vCPU-秒・ディスク 0.00000007 USD / GB-秒（[出典](https://developers.cloudflare.com/containers/platform/pricing/)）。Workers AI は 1,000 Neuron あたり 0.011 USD、無料枠は 1 日 1 万 Neuron（[出典](https://developers.cloudflare.com/workers-ai/platform/pricing/)）。Browser Run は Workers Paid で月 10 時間を含み、超過は 1 ブラウザ時間あたり 0.09 USD（Workers バインディングは同時ブラウザ数の分が別途。[出典](https://developers.cloudflare.com/changelog/post/2025-07-28-br-pricing/)）。R2 は保存 0.015 USD / GB-月など（[出典](https://developers.cloudflare.com/workers/platform/pricing/)）。rovo が使う分の見積もりは、タスクの内容と Sandbox の大きさで大きく変わるので書かない（推定の単価の上書きは 11）。
- ローカルに必要なもの: mise（`mise install` で node・pnpm・terraform が入る）、Docker、`wrangler login` 済みのアカウント、Terraform 用の Cloudflare API トークン（env の `CLOUDFLARE_API_TOKEN`。権限は `infra/README.md`）。

## 3. 構成とデプロイの順序

| Worker | ディレクトリ | 役割 | 公開 |
|---|---|---|---|
| `rovo-web` | `apps/web` | Web Research Service（`web_search` / `web_fetch` / `web_browse`）。状態を持たない | しない（`workers_dev: false`。service binding からだけ呼ぶ） |
| `rovo-agent` | `apps/agent` | ワーカー（`AgentDO`）と Sandbox（`SandboxDO`） | しない（`workers_dev: false`。gateway の DO バインディングからだけ呼ぶ） |
| `rovo-gateway` | `apps/gateway` | MCP サーバー（`/mcp`）、OAuth、`TaskDO` / `UserDO`、ダッシュボード（`/dashboard`。18） | する |

依存関係:

- gateway と agent は、web を service binding（`WEB`、`WebResearch` エントリポイント）で呼ぶ。呼び出し元の種別は binding の `props.caller`（gateway は `parent`、agent は `child`）で固定されている。
- gateway は、agent の `AgentDO` を `script_name: "rovo-agent"` 付きの DO バインディング（`AGENT_DO`）で呼ぶ。

したがって、**デプロイの順序は web → agent → gateway**。参照される側が先に存在している必要がある。Worker 名（`rovo-web` / `rovo-agent`）を変える場合は、`rovo.config.json` の `workerNames` を変える（参照している側の `services` と `script_name`、Terraform の `worker_names`〔Logpush の filter〕に同じ値が入る）。

## 4. クイックスタート（`mise run setup`）と下流のリポジトリ

### 手順は 1 本

人が作るトークンは Terraform 用の 1 つだけ。**人が手で扱う secret は 0**（D12b）。GitHub App の Client secret と秘密鍵はブラウザの「Create GitHub App」を押すだけで作られて gateway の secret に直接入り、Anthropic のキーは `mise run byok` の隠した入力で AI Gateway に入る。wrangler の設定には手で書く値が無い（秘密でない値は `rovo.config.json` の 1 か所）。

| | 以前 | D12 | いま（D12b） |
|---|---|---|---|
| 人が作る Cloudflare のトークン | 2 | 1（Terraform 用） | **1**（Terraform 用） |
| 人が手で扱う secret | 5 | 2（Client secret、`.pem` のパス） | **0**（GitHub App は manifest フローで作られ、Client secret・秘密鍵はディスクを通らずに gateway へ。Anthropic のキーは `mise run byok` の隠した入力） |
| wrangler の設定に手で書く値 | 9 か所 | 0 | **0** |
| 手順 | 7 手順 | `mise run setup` 1 本 + 画面の作業 | トークン 1 つ → `rovo.config.json` → `mise run setup`（ブラウザで Create GitHub App を押す）→ Install → `mise run byok` |

```bash
# 1. Terraform 用のトークンを 1 つ作る（権限は infra/README.md）。wrangler login と Docker（agent のイメージのビルド）も用意する
mise install                              # node / pnpm / terraform
pnpm --filter ./apps/gateway exec wrangler login   # デプロイ用（OAuth）。wrangler は apps/ の各アプリにだけあるので、ルートの pnpm exec ではなくこの形で実行する
export CLOUDFLARE_API_TOKEN=...           # Terraform 用のトークン。wrangler には渡されない。byok でも使う

# 2. rovo.config.json に publicBaseUrl と許可する利用者だけ書く（あとは既定）
cp rovo.config.example.json rovo.config.json   # accountId / publicBaseUrl / allowed を埋める（下の表）

# 3. 実行（何度でも再実行できる）。途中でブラウザが開く: GitHub で「Create GitHub App」を押す
mise run setup                            # 前提の確認 → terraform → deploy:config → deploy:all → deploy:secrets → GitHub App の作成

# 4. GitHub App を Install する（setup が Install のページを開く。対象の org / リポジトリに入れる）

# 5. Anthropic のキーを AI Gateway に入れる（隠した入力。OpenAI を使うなら openai も）
mise run byok -- anthropic
```

`mise run setup` の流れ（`scripts/setup.sh`。既存のタスクの薄い組み合わせ）:

1. **前提の確認**（欠けていたら何も実行せずに止まる）: mise、Docker が動いている、`CLOUDFLARE_API_TOKEN`（Terraform 用）、`wrangler login` 済み、`rovo.config.json` が正しい。
2. **`terraform init` / `apply`**（`infra/`）。変数（`account_id` / `name_prefix` / `worker_names`）は `rovo.config.json` から渡すので、tfvars は要らない。apply の確認は対話（`--yes` で省く）。**初回は Logpush のジョブの作成が `401 Unauthorized` で失敗することがある**（Logpush 用トークンを作った直後のため）。そのときは `mise run setup` をもう一度実行すると通る。state は `infra/backend.tf` を足さない限りローカルに置かれる（`infra/README.md`）。
3. **`deploy:config`**: `deploy.example/` の雛形に、`rovo.config.json` と Terraform の非秘密の出力（`kv_namespace_id` / `archive_bucket_name` / `ai_gateway_id` / `ai_web_gateway_id`）を埋めて、`deploy/{gateway,agent,web}.wrangler.jsonc` を生成する。
4. **`deploy:all`**: web → agent → gateway の順にデプロイする（3）。
5. **`deploy:secrets`**: 入っていない secret だけを入れる（下の「secret」）。
6. **GitHub App の作成**（`githubApp` が空のとき。`--no-github-app` で飛ばせる）: 下の「GitHub App の自動作成」。
7. **残りの作業の案内**を表示する: Install、ユーザートークンの期限の確認、`mise run byok` のコマンド（キーの入力が要るので自動では実行しない）。

**GitHub App は `PUBLIC_BASE_URL` が決まってから作る**ので、`setup` は `deploy:all` と最初の `deploy:secrets`（GitHub App の secret を除く）のあとに作る。`githubApp` が設定済みなら何もしない（既存の App を使う `--pem <.pem>` も従来どおり使える）。

### GitHub App の自動作成（`mise run github-app`。`setup` からも呼ばれる）

GitHub の公式の manifest フロー（[Registering a GitHub App from a manifest](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest)）で作る。

| 手順 | 誰が | 内容 |
|---|---|---|
| 1 | スクリプト | `127.0.0.1` のランダムなポートに一時の HTTP サーバーを立て、ブラウザで手元のページを開く（開けなければ URL を表示）。ページは manifest と state（CSRF 用の乱数）を入れたフォームを GitHub（個人は `settings/apps/new`、org は `organizations/<org>/settings/apps/new`）へ POST する。org は `rovo.config.json` の `allowed.org` が既定で、`--org <名前>` / `--personal` で選べる |
| 2 | **人（ブラウザ）** | GitHub の画面で **「Create GitHub App」を押す** |
| 3 | スクリプト | GitHub が `http://127.0.0.1:<port>/callback?code=…&state=…` に戻す。state を照合し、`POST /app-manifests/{code}/conversions`（認証不要。応答 201 に `id` / `slug` / `client_id` / `client_secret` / `webhook_secret` / `pem`）を呼ぶ |
| 4 | スクリプト | `client_secret` と `pem` を **ディスクに書かず**、`deploy.sh secrets --github-app-stdin`（標準入力の JSON）で gateway の `GITHUB_APP_CLIENT_SECRET` / `GITHUB_APP_PRIVATE_KEY`（pem は `openssl pkcs8` で PKCS#8 に変換）に入れる。`webhook_secret` は使わないので捨てる |
| 5 | スクリプト | `id` と `client_id` を `rovo.config.json` の `githubApp` に書く（ほかの整形は保つ）→ `deploy:config --no-terraform` → gateway を再デプロイ（`GITHUB_APP_ID` / `GITHUB_APP_CLIENT_ID` を反映） |
| 6 | **人（ブラウザ）** | 開いた Install のページ（`https://github.com/apps/<slug>/installations/new`）で、対象の org / リポジトリに入れる |
| 7 | **人（ブラウザ）** | App の設定画面（Optional features）で **User-to-server token expiration**（「ユーザートークンに期限を付ける」）が有効なことを確かめる。manifest では指定できない（docs に記載が無い）。無効でも動く（6） |

manifest の内容: `name` は `rovo-<namePrefix>-<乱数>`（GitHub 全体で一意。`--name` で指定）、`url` は `publicBaseUrl`、`callback_urls` は `<publicBaseUrl>/callback`、`request_oauth_on_install: false`、`public: false`、`hook_attributes: { url: publicBaseUrl, active: false }`（Webhook は使わない）、`default_permissions` は Contents: write / Pull requests: write / Metadata: read（`allowed.org` を使うとき、org だけでも team 付きでも、Members: read を足す）、`default_events: []`、`setup_on_update: false`。

- **何も書かずに止まる場合**: 待ち時間切れ（既定 15 分。manifest の code は 1 時間で失効する）、state の不一致、`code` が無い、conversions の失敗や応答の欠け。止まるときは `rovo.config.json` も secret も変えない。GitHub 側に App が作られていたら、GitHub の画面で削除してやり直す。
- **secret の put に失敗した場合**: `rovo.config.json` を変えずに止まる（client secret と秘密鍵は保存していないので、その App は使えない。削除してやり直す）。
- **作り直し**: `mise run github-app -- --recreate`（古い App は GitHub の画面で削除する。secret は新しい App のもので上書きされる）。`--no-deploy` は secret と設定の更新までで、再生成と再デプロイをしない。
- **値の経路**: GitHub の応答 → `github-app.mjs` のメモリ → `deploy.sh` の標準入力（パイプ）→ `openssl`（標準入力）→ `wrangler secret put`（標準入力）。引数・env・ログ・ファイルには出ない。env の `CLOUDFLARE_API_TOKEN`（Terraform 用）は wrangler に渡さない。

### BYOK を CLI で登録する（`mise run byok -- <anthropic|openai>`）

AI Gateway にプロバイダーのキーを、エイリアス `default` で登録する（Cloudflare API の `POST /accounts/{accountId}/ai-gateway/gateways/{ai_gateway_id}/provider_configs`、body は `{ provider_slug, alias: "default", default_config: true, secret }`）。`accountId` は `rovo.config.json`、ゲートウェイの id は `deploy/infra.json`（Terraform の出力）、認証は env の `CLOUDFLARE_API_TOKEN`（Terraform 用）。

- キーは**表示されない入力**（TTY の echo を切る）で受け取る。引数では受け取らない（プロセス一覧に見える）。TTY でなければ標準入力の 1 行を読む。値は引数・env・ログ・ファイルに出さず、API の `body` にだけ渡す（エラー表示でも伏せる）。
- 既に同じプロバイダーの `default` のキーがあれば（list で確かめる）、上書き（`PUT .../provider_configs/{id}` = Rotate）するかを聞く。`--yes` で確認を省く。TTY でなければ、確認の答えは標準入力の先頭行、キーはその次の行。
- 403（権限不足）のときは必要な権限を案内して止まる: Terraform 用トークンに **Account / AI Gateway / Edit**。BYOK のキーは Secrets Store に保存されるので、**Secrets Store の編集権限が別に要る可能性がある（未確認）**。
- `setup` は最後にこのコマンドを案内するだけで、自動では実行しない（キーの入力が要るため）。

### `rovo.config.json`（下流が書く唯一の設定。秘密でない値だけ）

雛形は `rovo.config.example.json`。項目名の違い（未知のキー、`<...>` の残り、https でない URL など）は `deploy:config` / `setup` が理由つきで拒否する。

| 項目 | 必須 | 既定 | 内容（対応する var） |
|---|---|---|---|
| `accountId` | 必須 | | Cloudflare のアカウント ID（32 桁の 16 進数）。Terraform の `account_id` と gateway の `CLOUDFLARE_ACCOUNT_ID` になる |
| `namePrefix` | | `rovo` | Terraform のリソース名の接頭辞（R2 バケット・KV・AI Gateway） |
| `workerNames` | | `rovo-gateway` / `rovo-agent` / `rovo-web` | Worker の名前。各 wrangler 設定の `name`、gateway の `script_name` と `services`、Terraform の `worker_names`（Logpush の filter）に、1 か所から反映される |
| `publicBaseUrl` | 必須（`customDomain` があれば省略可） | `https://<customDomain>` | gateway の公開 URL（`https`）。`PUBLIC_BASE_URL`。`customDomain` と両方書くときはホストを一致させる（違えばエラー） |
| `customDomain` | | なし（workers.dev のまま） | 任意の独自ドメイン（ホスト名だけ。小文字で、スキーム・パス・ポート・末尾のドットなし、ドットを 1 つ以上含む。例 `rovo.example.com`）。gateway の `routes` に `[{ "pattern": "<host>", "custom_domain": true }]` が出る（未設定は `[]`）。既定では workers.dev の URL も使える（止めるなら `workersDev`）。agent・web には出ない。手順は下の「独自ドメインを使う」 |
| `workersDev` | | `true` | gateway の workers.dev の URL（と preview / version の URL）を有効にするか（boolean）。`false` で gateway の `workers_dev` と `preview_urls` が `false` になる。`false` には `customDomain` が要る（無いとエラー。gateway に届く URL が無くなるため）。agent・web は常に `false` で変わらない。手順は下の「独自ドメインを使う」 |
| `githubApp.id` / `.clientId` | 後で可 | 空 | `GITHUB_APP_ID` / `GITHUB_APP_CLIENT_ID`。空のあいだはログインできない（fail closed） |
| `allowed.org` / `.team` / `.userIds` | どちらか必須 | | `ALLOWED_ORG` / `ALLOWED_TEAM`（`org` だけなら org の全員を許可。`team` だけは不可）/ `ALLOWED_USER_IDS`（数値の ID の配列かカンマ区切り） |
| `budget.monthlyUsd` / `.taskUsd` / `.consultUsd` | | 100 / 10 / 0.5 | `MONTHLY_BUDGET_USD` / `TASK_BUDGET_USD` / `CONSULT_BUDGET_USD` |
| `concurrency.maxTasks` | | 2 | `MAX_CONCURRENT_TASKS`。利用者ごとに同時に実行できるタスクの上限（1 以上の整数。それ以外・未知のキーはエラー） |
| `models.default` / `.list` / `.efforts` | | 雛形のとおり | `AGENT_MODEL` / `AGENT_MODELS`（配列かカンマ区切り）/ `MODEL_EFFORTS`（`{モデルの id: レベル}` か文字列）。**gateway と agent の同名の var に同じ値が入る** |
| `sandbox.instance` | | `standard-2` | agent の `SANDBOX_INSTANCE` と、gateway の `SANDBOX_USD_PER_HOUR`（その大きさの上限側の単価を計算して入れる。`vars.gateway.SANDBOX_USD_PER_HOUR` を書けばそれを優先）。5 種類以外はエラー（11） |
| `sandbox.maxInstance` | | `standard-4` | agent と gateway の `SANDBOX_MAX_INSTANCE`。Clef（Workers AI の決定モデル）が Sandbox を自動で上げる上限。`standard-1`〜`standard-4` のどれか、または `null`（Clef を呼ばず、昇格しない）。`lite`・その他の値・未知のキーはエラー。**旧 `sandbox.heavyInstance` と `sandbox.agentMaxInstance` はこの 1 つにまとめた（廃止。書くと `maxInstance` に移るよう案内するエラーになる）**（11） |
| `depsCache.enabled` | | `true` | agent の `DEPS_CACHE_ENABLED`。依存関係のキャッシュ（Containers のスナップショット。public beta）を使うか。`false` で無効（17） |
| `webBrowseEnabled` | | `false` | `WEB_BROWSE_ENABLED`。**3 つの Worker に同じ値が入る**（12） |
| `vars.gateway` / `.agent` / `.web` | | `{}` | 雛形にあるほかの var（上限・単価・`SAFETY_*` など）の上書き。雛形に無い名前、専用の項目で設定する名前、secret は拒否する |

AI Gateway の ID・KV の id・アーカイブのバケット名は Terraform の出力から入る（`deploy/infra.json` に保存される）ので、手で書かない。

### 生成物はコミットする（`deploy:config`）

`deploy/` の 4 つのファイル（`gateway|agent|web.wrangler.jsonc` と `infra.json`）は**生成物**で、下流のリポジトリにコミットする。デプロイの時に Terraform を読まないので、普段のデプロイ（`deploy:all` / `deploy:secrets` の一部以外）や CI に、Terraform 用の強いトークンは要らない。

| 実行 | 内容 |
|---|---|
| `mise run deploy:config` | `terraform -chdir=infra output -raw <名前>` で非秘密の出力 4 つ（`kv_namespace_id` / `archive_bucket_name` / `ai_gateway_id` / `ai_web_gateway_id`）だけを読み、`deploy/infra.json` に保存して生成する。Terraform の資格情報が要る |
| `mise run deploy:config -- --no-terraform` | 保存済みの `deploy/infra.json` から作り直す（`rovo.config.json` を直したとき） |
| `mise run deploy:config:check`（`deploy:config -- --check`） | Terraform を読まず、`rovo.config.json` + `infra.json` + 雛形から作り直した結果と、コミット済みの生成物を比べる。差分があれば 1。ファイルは書かない |

下流の CI では `mise run deploy:config:check` を流し、`rovo.config.json` を直したのに生成し直していない、生成物を手で書き換えた、upstream の雛形が変わったのに取り込んでいない、を検出する。`-json` は sensitive の値も出すので使わず、名前指定の `-raw` で読む。生成物のどこにも秘密は入らない。生成物には `deploy.sh` の検査（`<...>` の残り・upstream の設定への symlink）がそのままかかる。

`main` などのパスは設定ファイルからの相対パスで、`deploy/` がリポジトリ直下にある前提（`../apps/...`）。出力先を変えるときは `ROVO_DEPLOY_DIR` を指定する（`setup` の既定は `deploy`）。

### secret（`deploy:secrets`）

既定は「**入っていないものだけ入れる**」。`TOKEN_ENC_KEY`（gateway）を変えると保存済みの GitHub 資格が復号できず全員が再ログインになるので、再実行で既存の鍵を上書きしない。まず `wrangler secret list` で確かめ、Worker が無いなどで読めないときは「無い」とみなさず止まる（先に `deploy:all`）。事前の確認（`.pem`・Terraform の出力・`secret list`）に 1 つでも失敗したら、何も `put` しない。

| secret | 入れ方 |
|---|---|
| `GITHUB_APP_CLIENT_SECRET` | wrangler の対話（隠した入力）。**人が入力するのはこれだけ** |
| `GITHUB_APP_PRIVATE_KEY` | `--pem`（または env `ROVO_GITHUB_APP_PEM`）の `.pem` を `openssl pkcs8 -topk8 -nocrypt` で PKCS#8 に変換して標準入力で渡す |
| `CLOUDFLARE_API_TOKEN`（gateway） | `terraform output -raw gateway_cloudflare_api_token` を標準入力で渡す。Terraform が作る「AI Gateway Read」だけのトークン |
| `TOKEN_ENC_KEY`（gateway） | `openssl rand -base64 32` で自動生成して標準入力で渡す |
| `TOKEN_ENC_KEY`（agent） | 同上。**gateway とは別の値**（結合が無く、分けたほうが漏えい時の影響が狭い） |

値は引数にも env にもログにも載せない。`mise run deploy:secrets -- --rotate <client-secret|private-key|cloudflare-token|gateway-enc-key|agent-enc-key|all>` で入れ直せる（`--rotate gateway-enc-key` は全員の再ログインになる）。GitHub App をまだ作っていないときは `--skip-github-app`。

### 下流のリポジトリの作り方

下流（private リポジトリ）に rovo を upstream として登録し、更新を取り込む（`git remote add upstream <rovo の URL>`、`git fetch upstream`、`git merge upstream/main`）。upstream のファイルは書き換えず、**新しいファイルを足す**だけで使う。

| ファイル | 内容 |
|---|---|
| `rovo.config.json` | 上の設定。コミットする（秘密は無い。account id は秘密ではないが公開しないほうがよいので、公開リポジトリには置かない） |
| `deploy/*.wrangler.jsonc`、`deploy/infra.json` | `deploy:config` の生成物。コミットする |
| `infra/backend.tf` | Terraform の state の置き場所（任意。upstream は `backend` を持たない。`infra/README.md`） |

> rovo の `apps/*/wrangler.jsonc` に本番の値を書かないこと。特に `r2_buckets` は下流の設定にだけ置く。

upstream 専用のワークフローは `github.repository == 'youyo/rovo'` のときだけ動くので、下流では何もせず自動で止まる（architecture の解析、`ci.yml` の公開のための点検 `patterns`。下流は account id などを持つのが正しく、コードを外部へ送らないため）。gitleaks（`ci.yml` の `secrets`、`mise run scan:gitleaks`）は下流でも動く。本物の秘密の検出は下流にも要るため。

**下流を GitHub Actions からデプロイするとき**は [deploy-ci.md](deploy-ci.md) を見る（トークンの分け方、state の資格情報、ワークフローの雛形 `deploy.example/deploy.workflow.yml`）。

確かめた範囲（2026-10-20）: `deploy.example/` の gateway と web を `wrangler deploy --dry-run -c <設定>`（`apps/<name>` で実行）でバンドルし、`main` が設定ファイルからの相対パスで解決されることを確かめた。agent も `--containers-rollout=none` で通った。コンテナのイメージのビルド（`dockerfile` の相対パスの解決）は、実際のデプロイでしか確かめられない。**【実機で確認して追記】** D12 の生成器を使った `setup` の通し（実アカウント）も未確認。**【実機で確認して追記】** D12b の manifest の受理（GitHub が manifest を受け付けるか、`redirect_url` が loopback で通るか）、User-to-server token expiration の既定、`byok` の権限（Secrets Store）と PUT（Rotate）の形も未確認。**【実機で確認して追記】**

### 独自ドメインを使う（任意。`customDomain`）

既定は workers.dev。独自ドメインを当てるなら `rovo.config.json` に `"customDomain": "rovo.example.com"` を足して `mise run deploy:config` を実行する（`publicBaseUrl` は省略でき、`https://rovo.example.com` になる）。

- そのゾーンが gateway と同じ Cloudflare アカウントにあること。wrangler が DNS レコードと証明書を作る
- GitHub App の Callback URL に `https://rovo.example.com/callback` を追加する（複数持てるので、古い workers.dev のものは残してよい）
- MCP クライアントの URL を `https://rovo.example.com/mcp` に変える。OAuth の issuer が変わるので、再接続が要る
- ダッシュボードの Cookie はホスト単位なので、新しいホストでは再ログインになる
- workers.dev の URL も残る（`workers_dev: true` を明示しているため。routes があると既定は false になる）
- 独自ドメインに移ったら `"workersDev": false` で workers.dev を止められる（gateway の `workers_dev` と `preview_urls` が `false` になる。`customDomain` が要る）。止める前に、MCP クライアントとブラウザが新しい URL に移っていることを確かめる。GitHub App の古い callback は、止めたあとで消してよい

### 個別のタスク

| タスク | 内容 |
|---|---|
| `setup` | 上の流れを 1 本で行う。`-- --yes` / `-- --no-github-app` / `-- --pem <既存の App の .pem>` |
| `github-app` | GitHub App を manifest フローで作る（上の「GitHub App の自動作成」）。`-- --recreate` / `--org <名前>` / `--personal` / `--name <名前>` / `--no-deploy` |
| `byok` | AI Gateway にプロバイダーのキーを登録する（上の「BYOK を CLI で登録する」）。`-- <anthropic\|openai> [--yes]` |
| `deploy:config` / `deploy:config:check` | 設定の生成 / 差分の確認 |
| `deploy:web` / `deploy:agent` / `deploy:gateway` | 1 つの Worker をデプロイする（gateway は、デプロイの前にダッシュボード〔`apps/dashboard`〕を自動でビルドする。18） |
| `deploy:all` | web → agent → gateway の順にデプロイする。3 つの設定のどれかが欠けていたら、何も実行しない。途中で失敗したら後続は実行しない |
| `deploy:secrets` | 上の「secret」 |

実体は `scripts/deploy.sh`（`wrangler deploy -c <下流の設定>` の形でだけ呼ぶ）。設定の場所は env の `ROVO_DEPLOY_DIR`（相対パスは実行したディレクトリから）。

```bash
ROVO_DEPLOY_DIR=deploy mise run deploy:all
```

**`ROVO_DEPLOY_DIR` が未設定、またはディレクトリ・設定ファイルが無いときは、何もせずに失敗する。** upstream の `apps/*/wrangler.jsonc`（本番の値が無い）を誤ってデプロイしないため。**設定に `<...>` のプレースホルダが残っているときも、何も実行せずに失敗する**（コメント行は除く。`deploy.example/` をそのまま使えない）。失敗するときは、ファイル名と行番号を表示する。`all` と `secrets` は、対象の設定を全部確かめてから実行する。

テスト: `mise run test:github-app`（manifest フロー。偽の GitHub・偽のブラウザ・偽の `pnpm` / `openssl` / `open`）、`mise run test:byok`（偽の Cloudflare API）、`mise run test:deploy`（`deploy.sh`。偽の `pnpm` / `openssl` / `terraform`）、`mise run test:deploy:config`（生成器。本番相当の架空の入力から手書き相当の設定が出ることを固定）、`mise run test:setup`（`setup.sh`。偽物だけ。PATH から本物を外す）。いずれも Cloudflare に触れない。

### 手作業で行う場合（参考）

`setup` を使わずに、次の順で行ってもよい（`setup` の各段階を個別に実行するのと同じ）: Terraform（`infra/README.md`）→ `deploy:config` → `deploy:all` → `deploy:secrets -- --pem ...` → GitHub App（6）→ BYOK（7）→ Portal / Access への登録（範囲外。8 の情報を渡す）→ 初回デプロイの確認（13）。**secret は Worker のデプロイの後に入れる**（secret が入るまで gateway は fail-closed）。

## 5. 下流が用意する値の一覧

**この節は参照。** `vars` は `deploy:config` が `deploy.example/` の雛形から生成するので、手で書かない（`rovo.config.json` に無い値は `vars.<app>` で上書きできる。4）。名前は各 `wrangler.jsonc` の `vars`、`.dev.vars.example`、`apps/gateway/src/env.d.ts` と一致させてある。

### 変数（`vars`）

| 名前 | Worker | 必須 | 例 | 説明 |
|---|---|---|---|---|
| `ENVIRONMENT` | gateway / agent / web | 既定 `production` | `production` | `test` は E2E 専用。**本番で `test` にしない**（本番で GitHub の接続先の上書きを指定すると起動時に拒否される） |
| `PUBLIC_BASE_URL` | gateway | 必須 | `https://<YOUR_GATEWAY_HOST>` | 公開 URL。OAuth の issuer と `/mcp` の resource、GitHub のコールバック URL（`<PUBLIC_BASE_URL>/callback`）になる。本番は `https` |
| `GITHUB_APP_CLIENT_ID` | gateway | 必須 | `<YOUR_GITHUB_APP_CLIENT_ID>` | GitHub App の Client ID（秘密ではない）。空だとログインは失敗する（fail closed） |
| `ALLOWED_ORG` | gateway | `ALLOWED_ORG` か `ALLOWED_USER_IDS` のどちらかが必須 | `<YOUR_ORG>` | ログインと全ツール呼び出しを許す org の slug。**`ALLOWED_TEAM` を空にすると、その org の active メンバー全員を許可する**（招待中・外部コラボレーターは不可）。`ALLOWED_TEAM` だけ設定する（org なし）と設定の誤りとしてログインできない（`ALLOWED_USER_IDS` に切り替わらない） |
| `ALLOWED_TEAM` | gateway | 同上 | `<YOUR_TEAM>` | 許す team の slug（任意）。設定すると org 全員ではなく、この team の active メンバーだけを許す。ワーカー team のメンバーも許可される。`ALLOWED_ORG` が要る |
| `ALLOWED_USER_IDS` | gateway | org/team か `ALLOWED_USER_IDS` のどちらかが必須 | `<YOUR_GITHUB_USER_ID>`（複数はカンマ区切り） | ログインと全ツール呼び出しを許す GitHub の**数値の user ID**。個人アカウントには team が無いので、個人で使うときはこちらを使う。自分の ID は `gh api user --jq .id`。login（ユーザー名）は改名でき、空いた名前を他人が取れるので使わない。前後の空白は無視する。**1 つでも不正な要素（数字以外・0・重複・空要素）があれば、設定全体が不正としてログインできない**（不正な要素を読み飛ばさない）。org/team と両方を設定した場合は、どちらかを満たせば許可する。ID で許可する場合も、トークンの持ち主の確認（`GET /user`）は省略しない |
| `GITHUB_APP_ID` | gateway | 必須 | `<YOUR_GITHUB_APP_ID>` | GitHub App の App ID（秘密ではない）。Installation Token の発行に使う。未設定だとタスクは `github_app_not_configured` で FAILED になる |
| `DRAFT_PR_FALLBACK` | gateway | 任意 | `fail` | Draft PR を作れないリポジトリ（Free プランの private など）での扱い。`fail`（既定）/ `ready`。不正な値は `fail` |
| `PR_SHOW_COST` | gateway | 任意 | `false` | `true` のときだけ費用を PR 本文に載せる。公開リポジトリでは誰でも見られる |
| `MONTHLY_BUDGET_USD` | gateway | 任意 | `100` | ユーザーごとの月額の費用上限（USD）。1 タスクにつき `TASK_BUDGET_USD` を予約する |
| `TASK_BUDGET_USD` | gateway | 任意 | `10` | 1 タスクに予約する予算（USD）。ワーカーの `budgetUsd` にも同じ値を渡す。超えそうになると、`task_start` の `budget_policy` が `stop` なら `budget_exceeded` で止まり、`ask`（既定）ならクライアントに「あと同じ額を使って続けるか」を聞く（承認のたびに同じ額を月の枠から予約する。1 タスク 2 回まで）。0 以下・不正な値は 10。`MONTHLY_BUDGET_USD` より大きいとタスクを始められないので、月額を 10 未満にするときはこれも下げる |
| `MAX_CONCURRENT_TASKS` | gateway | 任意 | `2` | 利用者ごとに同時に実行できるタスクの上限（1 以上の整数。不正な値・未設定は 2）。上限に達すると `task_start` は `concurrency_limit` で断られる。月額の枠（`MONTHLY_BUDGET_USD` と `TASK_BUDGET_USD`）とは別で、両方を満たすときだけ始められる。値は `budget_status` の `concurrency_limit` で見える。UserDO の状態は利用者ごとなので、値を変えても実行中のタスクには影響しない（下げたときは、件数が上限を下回るまで新しいタスクを断る） |
| `CONSULT_BUDGET_USD` | gateway | 任意 | `0.5` | `consult`（セカンドオピニオン）1 回に月額の枠から予約する額（USD）。終わったら実費で精算する。`max_output_tokens` もこの額に収まるよう上限が掛かり、入力だけでこの額を超えるときは拒否される。0 以下・不正な値は 0.5 |
| `AGENT_MODEL` | gateway / agent | 任意 | `anthropic/claude-sonnet-5-5` | 既定のモデル（`task_start` の `model` を省略したとき）。許可リスト（`packages/models`）にあるものだけ使える。**gateway と agent で同じ値にする** |
| `AGENT_MODELS` | gateway / agent | 任意 | `anthropic/claude-haiku-5-5,anthropic/claude-sonnet-5-5,anthropic/claude-opus-5-5,workers-ai/@cf/openai/gpt-oss-120b,workers-ai/@cf/openai/gpt-oss-20b` | `task_start` の `model` と `consult` の `model` に使えるモデル（カンマ区切り。`models_list` に出る）。空・未設定なら `AGENT_MODEL` だけ（fail closed）。許可リスト（`packages/models` の `MODEL_CATALOG_IDS`: Claude の haiku-5-5 / sonnet-5-5 / opus-5-5 / fable-5-1、OpenAI の gpt-6-luna / sol / astra、Workers AI の `workers-ai/@cf/openai/gpt-oss-120b` / `gpt-oss-20b` / `qwen/qwen3.8-27b` / `nvidia/nemotron-3-120b-a12b` / `zai-org/glm-4.7-flash` / `google/gemma-4-26b-a4b-it`）に無い id は無視する（起動はエラーにしない。`agent_models_ignored` がログに出る）。`AGENT_MODEL` は許可リストにあれば常に含まれる。**gateway と agent で同じ値にする**（食い違うと、gateway が通したモデルを agent が `unknown_model` で拒否する）。OpenAI のモデルを足す前に 7 の BYOK を登録する |
| `AI_GATEWAY_ID` | gateway | 任意（D10b） | `<YOUR_AI_GATEWAY_ID>` | agent と同じ値。secret の `CLOUDFLARE_API_TOKEN` と `CLOUDFLARE_ACCOUNT_ID` とあわせて、AI Gateway に BYOK 登録されたプロバイダーキーを読むのに使う（7）。どれかが空なら判定せず、従来どおり `AGENT_MODELS` だけで決める |
| `CLOUDFLARE_ACCOUNT_ID` | gateway | 任意（D10b） | `<YOUR_ACCOUNT_ID>` | Cloudflare の account id。**公開の upstream には書かない**（`deploy.example` はプレースホルダ。下流の `rovo.config.json` の `accountId` から入る）。`GET /accounts/{account_id}/ai-gateway/gateways/{AI_GATEWAY_ID}/provider_configs` の URL に使う |
| `WORKER_NAMES` | gateway | 任意（ダッシュボードの Cloudflare の概要） | `<GATEWAY_WORKER_NAME>,<AGENT_WORKER_NAME>,<WEB_WORKER_NAME>` | rovo の 3 つの Worker 名のカンマ区切り（秘密ではない）。ダッシュボードの Workers のリクエスト数の対象。`deploy:config` が `rovo.config.json` の `workerNames` から入れる。空なら Workers の項目は「未設定」と表示される |
| `MODEL_EFFORTS` | gateway / agent | 任意 | `anthropic/claude-sonnet-5-5=medium,anthropic/claude-haiku-5-5=off` | モデルごとの思考レベル（thinking / reasoning の effort）の上書き。`<モデルの id>=<レベル>` のカンマ区切りで、レベルは `off` / `minimal` / `low` / `medium` / `high` / `xhigh` / `max`（そのモデルが受け付けるものだけ）。空・未設定なら upstream の初期値（`packages/models` の `EFFORTS`: haiku=low、sonnet=high、opus=medium、fable=low、gpt-6-luna=low、gpt-6-sol=medium、gpt-6-astra=low）。思考レベルはタスクごとではなく**モデルごと**に固定で、`models_list` の `effort` と `task_status` / `task_result` の `effort` に出る。**思考のトークンは出力として課金される**ので、レベルが高いほど費用が増える。不正な項目（書式の誤り・許可リストに無いモデル・知らないレベル・そのモデルが受け付けないレベル。例: fable-5-1 や gpt-6-astra の `off`、gpt-6-luna / sol の `minimal`）は、起動時のエラーにせず無視して初期値にする（`model_efforts_ignored` がログに出る）。**gateway と agent で同じ値にする**（agent の値が実際に使われ、gateway の値は表示になる） |
| `CONSULT_EFFORT` | gateway | 任意 | `medium` | `consult` で `effort` を省略したときの思考レベル（`off` / `minimal` / `low` / `medium` / `high` / `xhigh` / `max`）。未設定・空は `medium`。不正な値は起動時に無視して `medium`（`consult_effort_ignored` がログに出る。エラーにはしない）。そのモデルが受け付けないレベル（例: Workers AI の gemma は `low` / `medium` 不可）のときは、モデルごとの既定（`MODEL_EFFORTS`）に戻る。`consult` の `effort` で呼び出しごとに上書きでき（対応外は `invalid_input`）、使った値は応答と `consult_result` の `effort` に出る。思考のトークンは `max_output_tokens`（予約額から計算した上限）の中に収まる。タスク（`task_start`）の既定は変えない。gateway が解決して agent に渡すので、agent には設定不要 |
| `WEB_SEARCH_DAILY_LIMIT` | gateway | 任意 | `200` | クライアントの `web_search` の、ユーザーごと・UTC の 1 日あたりの上限 |
| `WEB_FETCH_DAILY_LIMIT` | gateway | 任意 | `500` | クライアントの `web_fetch` の同上 |
| `WEB_BROWSE_DAILY_LIMIT` | gateway | 任意 | `50` | クライアントの `web_browse` の同上 |
| `WEB_BROWSE_ENABLED` | gateway / agent / web | 任意 | `"false"` | `"true"` のときだけ `web_browse` が有効。3 つの Worker で揃える（12） |
| `SANDBOX_INSTANCE` | gateway | 任意 | `standard-2` | `sandbox_instances_list` の `default`（`task_start` で `sandbox_instance` を省略したときの大きさ）。agent の同名の var と同じ値にする。`deploy:config` が `sandbox.instance` から両方に入れる。単価の計算には使わない |
| `SANDBOX_MAX_INSTANCE` | gateway | 任意 | `standard-4` | `sandbox_instances_list` の `auto_scale_max`（Clef が Sandbox を自動で上げる上限）。agent の同名の var と同じ値にする。空・`off`・不正な値は上限なし（どれも `false`）。`deploy:config` が `sandbox.maxInstance` から両方に入れる。**旧 `SANDBOX_HEAVY_INSTANCE` / `SANDBOX_AGENT_MAX_INSTANCE` は廃止**（取り除く）（11） |
| `AUTO_MODEL_CANDIDATES` | gateway | 任意 | `anthropic/claude-haiku-5-5,anthropic/claude-sonnet-5-5,anthropic/claude-opus-5-5` | task_start で model を省略したとき、Clef（Workers AI の決定モデル）が内容から選ぶモデルの候補（カンマ区切り）。`AGENT_MODELS` にあり、プロバイダーのキーが使えるものだけが候補になる（費用の安い順に並べ替える）。候補が 1 つ以下なら Clef を呼ばず既定のモデル。anthropic の haiku / sonnet / opus / fable だけで、openai/*・workers-ai/* は書いても候補にならない。fable は既定に入れていない（使うなら `vars.gateway.AUTO_MODEL_CANDIDATES` に足し、`models.list` にも入れる）。空文字は自動選択をしない。`rovo.config.json` の `vars.gateway` で上書きできる |
| `AUTO_MODEL_CLEF_THRESHOLDS` | gateway | 任意 | （空 = 既定の閾値） | 自動選択の閾値。`up=0.5,band=0.3-0.7` の形で、書いたキーだけ上書きする（`up`: 「その段以上」の確率がこれ以上のうち、いちばん重い段を選ぶ / `band`: 確率がこの帯（下端を含み上端を含まない）にある段があれば clef で聞き直す）。不正な値は既定に戻す。実験の根拠は docs/specs/design.md の「モデルの自動選択」 |
| `SANDBOX_USD_PER_HOUR` | gateway | 任意 | `0.1291`（`standard-2`） | 推定費用の単価（11）。`deploy:config` が `sandbox.instance` から計算する。agent が使った大きさを報告したタスクは、その大きさの単価（表の値）で計算するので、この値は大きさが分からないタスク（Sandbox を起動しなかった・古い agent）にだけ効く |
| `WEB_USD_PER_1K_SEARCH` | gateway | 任意 | `5.00` | 同上 |
| `WEB_USD_PER_1K_FETCH` | gateway | 任意 | `0` | 同上 |
| `WEB_USD_PER_1K_BROWSE` | gateway | 任意 | `0.75` | 同上 |
| `AI_GATEWAY_ID` | agent / web | 必須 | `<YOUR_AI_GATEWAY_ID>` | AI Gateway の ID。**agent は `ai_gateway_id`（Claude 用。byok_only）、web は `ai_web_gateway_id`（Web Search と Clef 用。byok_only なし）で、別の Gateway**（5）。agent で空だと `start` が `ai_gateway_not_configured` で拒否される。web で空だと `websearch` も Clef も呼ばず、web 内部では `misconfigured` として失敗する（fail closed）。MCP のツールからは `internal`（`web research service is not available`）に見える |
| `TEST_UPSTREAM` | agent | 本番では不要 | （空） | `ENVIRONMENT=test` のときだけ有効。E2E 専用。本番では設定しない |
| `WEB_SEARCH_LIMIT_PER_TASK` | agent | 任意 | `50` | ワーカーの `web_search` のタスクごとの回数の上限 |
| `WEB_FETCH_LIMIT_PER_TASK` | agent | 任意 | `100` | ワーカーの `web_fetch` の同上 |
| `WEB_BROWSE_LIMIT_PER_TASK` | agent | 任意 | `20` | ワーカーの `web_browse` の同上 |
| `SANDBOX_INSTANCE` | agent | 任意 | `standard-2` | Sandbox コンテナの大きさ（`lite` / `standard-1` / `standard-2` / `standard-3` / `standard-4`）。不正な値は `standard-2` に戻る（警告のログ）。性能と上限の費用は 11。`rovo.config.json` の `sandbox.instance` で設定する |
| `SANDBOX_MAX_INSTANCE` | agent | 任意 | （空 = Clef を呼ばず昇格しない。`deploy:config` は `standard-4` を入れる） | Sandbox を自動で上げる上限（`standard-1`〜`standard-4`）。Sandbox は小さく始まり、ワーカーのコマンド（と検証コマンド）の前に Clef が「今の大きさで足りるか」を判断し、足りなければ 2 → 3 → 4 と上がる（上げるだけ）。空・`off`・`none`・不正な値（`lite` を含む。警告のログ）は無効。`task_start` で `sandbox_instance` を明示したタスクは、この設定にかかわらず固定で、Clef も呼ばない。Clef やスナップショットが失敗してもタスクは失敗しない（今の大きさのまま続ける）。既存の `ai` バインディングと `AI_GATEWAY_ID` を使い、新しいバインディングも secret も要らない。`rovo.config.json` の `sandbox.maxInstance` で設定する（11） |
| `SANDBOX_CLEF_THRESHOLDS` | agent | 任意 | （空 = 既定の閾値。`deploy:config` は空を入れる） | Clef の判断の閾値。`heavy=0.5,four=0.4,heavy_band=0.2-0.7,four_band=0.2-0.5` の形で、書いたキーだけ上書きする（`heavy`: 重い確率がこれ未満なら上げない / `four`: 重いとき、4 vCPU で速い確率がこれ以上なら `standard-4` / `heavy_band`・`four_band`: flash の確率がこの帯なら clef で聞き直す）。実験で調整した既定値を変えられるようにしてある。不正な値は既定に戻して警告のログ。変えるなら `rovo.config.json` の `vars.agent.SANDBOX_CLEF_THRESHOLDS` に書く（11） |
| `DEPS_CACHE_ENABLED` | agent | 任意 | `true` | 依存関係のキャッシュ（17）を使うか。`false` / `0` / `off` で無効（`task_result` の `usage.deps_cache` は `disabled`）。それ以外・未設定は有効。スナップショットが使えなくても失敗はしない（image から普通に起動する）。`rovo.config.json` の `depsCache.enabled` で設定する |
| `WEB_SEARCH_PROVIDER` | web | 任意 | `linkup` | 検索プロバイダ（`ceramic` / `exa` / `linkup`）。変えたら単価も合わせる（linkup $5.00・exa $7.00・ceramic $0.25 / 1,000 回）。選び方は下の「検索プロバイダの選び方」 |
| `SAFETY_BLOCK_THRESHOLD` | web | 任意 | `0.8` | Policy Engine の閾値（0〜1）。モデルのスコアがこれ以上なら block。**仮の値**で、受入で調整する |
| `SAFETY_CAUTION_THRESHOLD` | web | 任意 | `0.4` | 同上。caution |
| `TEST_FAKE_BASE` | web | 本番では不要 | （空） | `ENVIRONMENT=test` のときだけ有効。E2E 専用。本番では設定しない |

> **検索プロバイダの選び方**（`WEB_SEARCH_PROVIDER`。2026-10-22 の本番での比較、29 語 × 3 プロバイダ）: 既定は **linkup**。29/29 成功・日本語だけの検索語 6/6・関連 1.41/2・Zero Data Retention あり・$5.00 / 1,000 回。**exa** は質が最良（関連 1.97）だが、Zero Data Retention がなく（Cloudflare の providers の表）$7.00 / 1,000 回。検索語を保持させたくないなら linkup、質を優先して保持を許せるなら exa。**ceramic** は安い（$0.25）が、日本語だけの検索語のほとんどと「the」「a」で HTTP 502 になる（成功率 76%、日本語だけは 1/6）ので、日本語で使うなら選ばない。Tavily は Web Search API のプロバイダでなく、規約で検索語の学習利用と取り消せないライセンスがあるので採らない。変えるときは `WEB_USD_PER_1K_SEARCH` も合わせる。

> **キャッシュの注意**: ツール呼び出しごとの認可の結果は、UserDO に最大 5 分（`membership_cache` の TTL）キャッシュされる。`ALLOWED_USER_IDS` から ID を外しても、team から外しても、再デプロイ後 TTL が切れるまでは、そのユーザーは有効なままになる（最大 5 分）。

### Secret（`mise run deploy:secrets`が入れる。4）

| 名前 | Worker | 必須 | 入れ方 / 説明 |
|---|---|---|---|
| `GITHUB_APP_CLIENT_SECRET` | gateway | 必須 | GitHub App の Client secret。`mise run setup` / `github-app` で App を作ったときは、manifest フローが標準入力で直接入れる（人は入力しない）。App を手で作ったときだけ、`deploy:secrets` が隠した入力で聞く |
| `GITHUB_APP_PRIVATE_KEY` | gateway | 必須 | GitHub App の秘密鍵（**PKCS#8** の PEM）。`--pem` の `.pem`（GitHub がダウンロードさせる PKCS#1）をスクリプトが変換して渡す。変換は 6 |
| `TOKEN_ENC_KEY` | gateway | 必須 | GitHub のトークンと Installation Token を暗号化して保存する鍵。base64 の 32 バイト。**自動生成**。変えると保存済みの資格は復号できず、全員が再ログインになる（だから既定は上書きしない） |
| `TOKEN_ENC_KEY` | agent | 必須 | Installation Token を SandboxDO に暗号化して保存する鍵。形式は同じで、**gateway とは別の値を自動生成**する。未設定だと `start` は拒否される（fail closed） |
| `CLOUDFLARE_API_TOKEN` | gateway | 任意（D10b） | AI Gateway のプロバイダーキー（BYOK）の一覧を読むための Cloudflare API トークン。**読み取り専用**で、権限は **Account / AI Gateway / Read** と **Account / Account Analytics / Read**（ダッシュボードの Cloudflare の概要が GraphQL Analytics API とクレジット残高を読む。18）。**Terraform が作り**（`infra/` の `cloudflare_api_token.ai_gateway_read`）、`terraform output -raw gateway_cloudflare_api_token` を `deploy:secrets` が流し込む（7）。未設定なら判定せず、従来どおり `AGENT_MODELS` だけで決める。値はログにも応答にもエラーにも出さない |

web に secret は無い（GitHub のトークンも Anthropic のキーも持たせない）。

### バインディング

| 名前 | Worker | 必須 | 説明 |
|---|---|---|---|
| `ASSETS`（assets） | gateway | 必須 | ダッシュボードの静的ファイル（`apps/dashboard/dist`）。`run_worker_first: true` で、Worker が `/dashboard/*` だけを渡す。下流の設定は `deploy.example/` の雛形に入っている（18） |
| `OAUTH_KV`（KV） | gateway | 必須 | KV namespace の id は下流の設定に書く（rovo の `wrangler.jsonc` には id が無い） |
| `LOGS`（R2） | gateway だけ | 任意 | アーカイブ先のバケット。無ければアーカイブはスキップされる（9） |
| `TASK_DO` / `USER_DO`（DO） | gateway | 必須 | 設定済み |
| `AGENT_DO`（DO、`script_name: "rovo-agent"`） | gateway | 必須 | 設定済み。agent を先にデプロイする |
| `SANDBOX_DO` / `AGENT_DO`（DO、コンテナ） | agent | 必須 | 設定済み。コンテナのイメージは `apps/agent/Dockerfile` |
| `DEPS_CACHE_DO`（DO） | agent | 必須 | 設定済み。依存関係のキャッシュ（17）の状態を鍵ごとに持つ。**コンテナは持たない**（`containers` の項目は `SandboxDO` の 1 つのまま） |
| `WEB`（service binding） | gateway / agent | 必須 | `rovo-web` の `WebResearch`。`props.caller` は gateway が `parent`、agent が `child` |
| `AI`（Workers AI） | agent / web | 必須 | 設定済み |
| `BROWSER`（Browser Run） | web | 宣言は常にある（使うのは `web_browse` が有効なときだけ） | `remote` の設定は下流で行う（12） |

## 6. GitHub App の作成

`mise run github-app`（`setup` からも呼ばれる。4）が manifest フローで自動で作る。下の設定は、その manifest の内容と同じ（手で作るときの参考。GitHub の Settings > Developer settings > GitHub Apps で作る。OAuth App は使わない）。

- **Callback URL**: `<PUBLIC_BASE_URL>/callback`（ローカル開発用に `http://localhost:8787/callback` も追加できる）
- **Request user authorization (OAuth) during installation**: 不要。**Webhook**: 無効でよい
- **Expire user authorization tokens**: 有効にする（既定）。manifest では指定できない（docs に記載が無い）ので、自動作成のあと App の設定画面（Optional features）で確かめる。トークンは 8 時間で切れ、refresh token（約 6 か月）で自動更新される。無効にした場合も動く
- **Repository permissions**: Metadata: Read-only / Contents: Read and write / Pull requests: Read and write / Checks: Read-only（任意） / Commit statuses: Read-only（任意）
  - 完了時の自動の Ready（`review_policy` が `client_review`。タスクが `COMPLETED` になったとき、rovo が PR を Ready for review にする）は、**GitHub App の Installation Token**で GraphQL の `markPullRequestReadyForReview` を呼ぶ。**Pull requests: write** が要る。失敗してもタスクは `COMPLETED` のままで、PR は Draft のまま残り（warning イベント `auto_ready_failed`）、`next_steps` が `task_pr_ready` を案内する
  - `task_pr_merge` は、マージの前に PR の head の commit に付いた GitHub の check を読む（`GET .../commits/{sha}/check-runs` と `GET .../commits/{sha}/status`）。これに **Checks: Read-only** と **Commit statuses: Read-only** が要る（manifest で自動で付く。すでに作った App は、App の設定で権限を足して、Install した org / アカウントで承認する）。この 2 つの権限は**任意**: 無い・読めない（403・5xx・ネットワークの失敗）ときは、マージを止めずに通し、応答の `warnings` に `checks_unreadable` を入れる（止めるかどうかは GitHub のブランチルールの責務）。足すと CI の結果を確かめられる。失敗している check があれば `merge_blocked`（`checks_failing`）、実行中・保留なら `merge_blocked`（`checks_pending`）。**check が 1 つも無ければ通る**（厳しくしたいときは GitHub のブランチ保護を使う）
  - `task_pr_ready` / `task_pr_merge`（D9）は、**Installation Token ではなく、利用者の GitHub のユーザートークン**で行うので、有効な権限は「App の権限」と「利用者本人の権限」の共通部分になる。Draft → Ready（GraphQL の `markPullRequestReadyForReview`）とマージ（`PUT .../pulls/{n}/merge`）には **Pull requests: write** と **Contents: write** が、`delete_branch`（`DELETE .../git/refs/heads/{branch}`）には **Contents: write** が要る。App の権限が read になっていると `forbidden` になる。利用者にそのリポジトリへの書き込み権限が無い場合も同じ。権限の表は GitHub の記述に基づくので、実機の受入（[acceptance.md](specs/acceptance.md) の 21 節）で確かめる
  - ブランチ保護（必須レビュー・必須チェック・ruleset）は GitHub が利用者のトークンに対して適用する。`review_policy` によらず、保護に拒否されたら `merge_blocked` になり、マージされない（組織としての強制は GitHub に任せる）
- **Organization permissions**: Members: Read-only（org 単独（org の全員を許可）でも team 付きでも、所属の確認に使う。権限は同じ。`ALLOWED_USER_IDS` だけで認可する個人利用では使わない）
- App を対象の org / リポジトリに **Install** する。個人アカウントのリポジトリでも、`task_start` の Installation と push 権限の確認はそのまま動く（`ALLOWED_USER_IDS` で認可した利用者は、org の Members 権限を使わない）。`task_start` は、利用者のトークンで見える Installation に対象リポジトリが含まれ、利用者に push 権限があるときだけ成功する（公開リポジトリでも App が未導入なら `forbidden`）

**秘密鍵の変換**: GitHub がダウンロードさせる鍵は PKCS#1（`BEGIN RSA PRIVATE KEY`）。gateway は PKCS#8 を受け付ける。`mise run deploy:secrets -- --pem <.pem>`（または `setup`）が、`openssl pkcs8 -topk8 -nocrypt` で変換して標準入力で `wrangler secret put` に流す（変換後のファイルは作らない）。鍵のファイルはリポジトリに置かない。手で行うなら:

```sh
openssl pkcs8 -topk8 -nocrypt -in app.private-key.pem | wrangler secret put GITHUB_APP_PRIVATE_KEY -c deploy/gateway.wrangler.jsonc
```

## 7. AI Gateway の設定

- AI Gateway を 2 つ作る（`terraform output ai_gateway_id` は agent と gateway の `AI_GATEWAY_ID`、`terraform output ai_web_gateway_id` は web の `AI_GATEWAY_ID`。`deploy:config` が埋める）。**web 専用の Gateway を分ける理由**: Web Search API（`env.AI.websearch`）は、Gateway に provider のキーが無いと AI Gateway のクレジットで払う。byok_only の Gateway ではクレジットへ流さず `web_search_byok_not_configured`（400）で断られ、`web_search` が必ず失敗する。そこで、Claude 用の Gateway は byok_only のまま（キーだけで払う）にし、web 専用の Gateway は byok_only なし（ほかの設定は同じ）にする。web が呼ぶのは Web Search API と Clef（Workers AI。キーは要らない）だけで、Claude は呼ばない。以降の記述（認証あり・Require provider credentials あり・BYOK）は Claude 用の Gateway のこと。`infra/` の Terraform が作る（認証あり、Require provider credentials あり、ログ収集あり、キャッシュとレート制限なし。`terraform output ai_gateway_id`）。BYOK はゲートウェイの認証が前提（認証が無いと、プロバイダー キーの画面で保存できない）。Anthropic の API キーは AI Gateway に保管する（BYOK）。**BYOK の登録は `mise run byok -- anthropic`（4。隠した入力）か AI Gateway の画面で行い、Terraform には入れない。** Worker・Sandbox にはキーを置かない。
- agent と web は `AI` バインディングと `AI_GATEWAY_ID`（それぞれ上の Gateway）だけで呼ぶ。バインディングからの呼び出しは認証済みとして扱われるので、`cf-aig-authorization` と gateway token の secret は要らない。
- Require provider credentials（`byok_only`）をオンにしている。BYOK のキーが無い・外れたときに、Claude の呼び出しが Unified Billing（Cloudflare のクレジット）へ流れず、400 で止まる（Anthropic Console の利用上限が効く経路だけを使う）。Workers AI（Clef-flash）は対象外で、課金にも影響しない。
  - Anthropic のキーは、エイリアスを **`default`** にして登録する。AI バインディングの経路では `default` のキーだけが使われ、別名のキーは参照されない（byok_only なので 400 になる）。
  - **Web Search API（`env.AI.websearch()`。既定のプロバイダは Linkup）は、Unified Billing のクレジットで課金される（15.6）。** byok_only の Gateway では、プロバイダのキーが無いと `web_search_byok_not_configured`（400）で断られる（2026-10-22 に確認）。そのため web は専用の Gateway（`<prefix>-web-gateway`、byok_only なし。terraform output `ai_web_gateway_id`）を使い、Claude 用の Gateway は byok_only のままにしている。検索プロバイダのキーの登録は要らない。
- **プロバイダーキーの有無で使えるモデルを決める（D10b）**: byok_only なので、Anthropic / OpenAI のキーが AI Gateway に登録されていないと、そのプロバイダーのモデルは 400 で失敗する。gateway が Cloudflare API の List provider keys（`GET /accounts/{account_id}/ai-gateway/gateways/{AI_GATEWAY_ID}/provider_configs`）で登録済みのキーを読み、**alias が `default` のキーがあるプロバイダー**のモデルだけを `models_list` で `available: true` にする（キーが無いモデルは `available: false`・`unavailable_reason: "no_provider_key"` で、`task_start` / `consult` は `model_unavailable` で拒否する）。Workers AI のモデルはキー不要で常に available。どちらのキーも無ければ Workers AI のモデルだけが使え、`model` を省略したときの既定は `workers-ai/@cf/openai/gpt-oss-120b`（`AGENT_MODELS` に入っていること）。結果は 5 分キャッシュする（KV）。API が失敗したときは直前のキャッシュ（24 時間まで）を使い、無ければ判定せず従来どおり `AGENT_MODELS` だけで決める。キーを登録・削除しても、反映まで最大 5 分かかる。
  - **`CLOUDFLARE_API_TOKEN` は Terraform が作る**: `infra/` の `cloudflare_api_token.ai_gateway_read`（権限グループ「AI Gateway Read」と「Account Analytics Read」の 2 つ、どちらも読み取りだけ。対象はこのアカウント〔`com.cloudflare.api.account.<account_id>`〕だけ）。値は sensitive の output `gateway_cloudflare_api_token` で、`deploy:secrets` が `terraform output -raw` で `wrangler secret put` に流す（画面にも引数にも出さない）。値は Terraform の state に平文で残る（Logpush 用トークンと同じ扱い。`infra/README.md`）。手で作るなら、Cloudflare ダッシュボードの「アカウント API トークン」で Account / AI Gateway / Read と Account / Account Analytics / Read のカスタムトークンを作り、`wrangler secret put CLOUDFLARE_API_TOKEN` で gateway に入れる。**`CLOUDFLARE_ACCOUNT_ID`** と `AI_GATEWAY_ID` は gateway の vars に `deploy:config` が入れる（`CLOUDFLARE_ACCOUNT_ID` は秘密ではないが、公開の upstream には書かない）。
  - **Workers AI のモデルと料金**: 許可リストに入れたのは、Workers の**無料プランでも使える**モデルだけ（`gpt-oss-120b`・`gpt-oss-20b`・`qwen3.8-27b`・`nemotron-3-120b-a12b`・`glm-4.7-flash`・`gemma-4-26b-a4b-it`）。kimi-k2.7-code・glm-5.2 / 5.3 / 5.3-flash・deepseek-v4 は有料プラン専用なので入れていない（無料プランの運用者が選んでも失敗しないように）。Workers AI の課金は Neurons で、無料枠は **1 日 1 万 Neuron**（超えると、無料プランでは当日はそのモデルの呼び出しが失敗する）。rovo の予算（`budget_status`）は pi-ai のカタログの USD 単価で管理するので、実際の Neuron の使用量とは一致しない（Cloudflare の画面で見る）。Workers AI は顧客データを学習に使わない（Workers AI の docs の Data usage）。Workers AI のモデルは AI バインディング（`env.AI.run`）経由で AI Gateway を通り、BYOK のキーは要らない。
- **OpenAI のモデルを使うとき（任意。`AGENT_MODELS` に `openai/gpt-6-*` を入れる前に）**: AI Gateway の画面の「プロバイダー キー」で、OpenAI の API キーをエイリアス **`default`** で登録する（Anthropic と同じ。BYOK なので Terraform には入れない）。**利用上限は OpenAI 側（OpenAI の画面の usage limit）で設定する**。rovo の `budget_status` は rovo の月の枠だけで、OpenAI の残高は取得できない。**OpenAI を使うタスクでは、対象リポジトリのコード（ワーカーが読んだファイルの内容、`consult` の messages）が OpenAI にも送られる。** 組織のポリシー上、コードの送り先が Anthropic に限られるなら `AGENT_MODELS` に OpenAI のモデルを入れない。キーを登録していない OpenAI のモデルを `AGENT_MODELS` に入れると、そのモデルの呼び出しは byok_only により 400 で失敗する（Claude には影響しない）。
- 経路:
  - agent: `AI` バインディングが AI Gateway 経由で Claude（と、登録していれば OpenAI の Responses API）を呼ぶ（ワーカーのモデル呼び出しは AI Gateway 経由だけ）。
  - web: `env.AI.websearch()`（Web Search API）と、安全性の評価（`env.AI.run` による Clef-flash）。どちらも AI Gateway を通る。
- Clef の呼び出しには、metadata として `userId` / `taskId` / `caller` が付く（誰がいくら使ったかの集計用）。ワーカーの呼び出しは `userId` / `taskId`、`consult` の呼び出しは `userId` / `consultId` / `caller: "consult"`。
- AI Gateway の設定項目（文書で確かめたもの）。画面は **AI > AI Gateway > 対象の Gateway > Settings**（プロバイダーキーは同じ Gateway の **Provider Keys**）:
  - 認証（Authenticated Gateway）: Settings で認証トークンを作り（`Run` の権限。値は一度しか表示されない）、認証を有効にする。BYOK は Gateway の認証が前提（[出典](https://developers.cloudflare.com/ai-gateway/configuration/authentication/)）。**AI Gateway のトークンの権限（Read / Run / Edit）は Gateway 単位に絞れず、アカウント全体に効く**。`Run` を持つトークンは、BYOK のキーを持つ Gateway も含めてアカウントのすべての Gateway で使える。Gateway どうしを分けたいならアカウントを分けるか、Worker の AI バインディングを使う。
  - レート制限: Settings の Rate-limiting で、回数・期間・方式を決める（既定はその Gateway の全リクエストに効く。[出典](https://developers.cloudflare.com/ai-gateway/features/rate-limiting/)）。rovo の Terraform は付けない。
  - クレジット（Unified Billing）: Cloudflare のアカウントにクレジットを入れ、プロバイダーのキーがリクエストにも BYOK にも無いときに、Cloudflare 管理の資格情報で処理して残高から引く。優先順位は「リクエストのキー、BYOK のキー、Unified Billing」。Workers AI を Unified Billing で払うかは Settings の **Workers AI Billing** で選ぶ（既定は通常の請求。[出典](https://developers.cloudflare.com/ai-gateway/features/unified-billing/)、[出典](https://developers.cloudflare.com/ai-gateway/configuration/manage-gateway/)）。
  - BYOK: Provider Keys の **Add API Key** でプロバイダーを選んでキーを入れる。API で作るときは先に Secrets Store に `{gateway_id}_{provider_slug}_{alias}` の名前でシークレットを作る必要がある（[出典](https://developers.cloudflare.com/ai-gateway/configuration/bring-your-own-keys/)）。`mise run byok` が Secrets Store の権限を要するかは **【実機で確認して追記】**（4）。

## 8. Portal / Access への登録に必要な情報

登録自体は、この文書の範囲外（下流のインフラ管理側）。登録に必要な情報は次のとおり。

- MCP の URL: `<PUBLIC_BASE_URL>/mcp`
- ユーザーごとの OAuth: Portal の「Require user auth」を有効にする。
- OAuth のエンドポイント: DCR は `/oauth/register`、認可は `/authorize`、トークンは `/oauth/token`（いずれも `<PUBLIC_BASE_URL>` 配下）。protected resource metadata は Worker が公開する。
- Portal の Access ポリシーは直接の URL で迂回できる。実際の防御線は gateway の `ALLOWED_ORG` / `ALLOWED_TEAM`（または `ALLOWED_USER_IDS`）と、タスクごとの push 権限の検証。
- 登録後の接続確認: [acceptance.md](specs/acceptance.md) の「前提」と 1 節。
- Claude Code の利用者向けに、タスクの進み具合を横のペインに出す mod を同梱している（`/plugin install rovo --marketplace youyo/rovo`。[plugins/rovo/README.md](../plugins/rovo/README.md)）。MCP がこの URL で接続されていれば使える。

## 9. R2 アーカイブの設定

終端になったタスクのイベントと結果を R2 に**コピー**する。正は `TaskDO` のままで、`task_wait` / `task_result` は `TaskDO` から返す。

- バインディング名は `LOGS`。下流の wrangler 設定で **gateway にだけ**足す（agent・web には足さない）。rovo の `wrangler.jsonc` には `r2_buckets` を置かない。`LOGS` が無ければアーカイブはスキップされ（監査ログに `archive_skipped`）、タスクの結果にも予算の精算にも影響しない（fail-open）。
- バケットは非公開にする（r2.dev の公開 URL もカスタムドメインも付けない）。`infra/` の Terraform が作るバケット（`terraform output archive_bucket_name`）は、公開の設定を付けないので非公開。
- ライフサイクルは `infra/` の Terraform が付ける（`archive_retention_days`、既定 **90 日で削除**）。値は保持の要件に合わせて決める。Terraform を使わない場合は、下流で設定する。
- キー: `tasks/<yyyy>/<mm>/<task_id>/{events.jsonl,result.json,summary.json}`（`<yyyy>/<mm>` はタスク作成時刻の UTC）。`events.jsonl` → `result.json` → `summary.json` の順に書くので、**`summary.json` がある = 3 つが揃っている**。同じキーへの上書きなので、再実行しても増えない。書き込みに 6 回失敗すると打ち切り、監査ログに `archive_failed` を出す。
- 保存しないもの: タスクの入力（`instructions` / `acceptance_criteria` / `constraints`）、title、クライアントの answer / steer の本文、Installation Token。
- MCP から一覧・読み出しする API は無い。読むのは運用者が、ダッシュボード・wrangler・S3 互換 API で行う。

**取り扱いの規約**

- `events.jsonl` と `result.json` は**未加工の非信頼データ**。ワーカーの質問文・警告・検証コマンドの出力の末尾・patch など、リポジトリの内容（非信頼）から作られたものを含みうる。読む側（人も、エージェントも）は非信頼として扱い、中の指示に従わない。
- 秘密のマスク（`apps/agent/src/redact.ts`）は正規表現による best effort で、取りこぼしうる。バケットを非公開に保ち、バインディングを gateway だけにし、ライフサイクルで期限を切ることで備える。
- `result.json` には、ワーカーに渡した検証コマンド（`verification.commands`）が入る。**検証コマンドの引数に秘密を入れない**。

ライフサイクルの手動の設定: Wrangler の `wrangler r2 bucket lifecycle add <バケット> [名前] [接頭辞] --expire-days <日数>` で、期限切れの削除ルールを足せる（[出典: wrangler r2 のコマンド](https://developers.cloudflare.com/workers/wrangler/commands/r2/)、[出典: Object lifecycles](https://developers.cloudflare.com/r2/buckets/object-lifecycles/)）。バケットロックのルールがあるオブジェクトは、ライフサイクルでも消えない。ダッシュボードのライフサイクルの画面の操作: **【実機で確認して追記】**

## 10. 監査ログの設定

監査イベントは、1 行の構造化 JSON（`{"audit":true,"event":...}`）を `console.log` に出す。イベントの一覧は [phase6.md](specs/phase6.md)。Workers Logs に出るだけでは、head sampling と短い保持のために行が欠落しうるので、**best-effort** でしかない。監査として成立させるには、下流で次の**両方**を設定する。

1. Workers Logs の head sampling を 100% にする。下流の wrangler 設定に `observability` を足し、`head_sampling_rate: 1` にする（`observability.logs.head_sampling_rate` でもよい）。rovo の `wrangler.jsonc` には `observability` を置かない。
2. Logpush で、保持期間を自分で決められる送り先へ流す（送り先は下流の判断）。`infra/` の Terraform は、データセット `workers_trace_events` を、監査用の R2 バケット（`audit_retention_days`、既定 365 日で削除）へ送るジョブを作る。**ジョブの filter で `ScriptName` を rovo の 3 つの Worker（`worker_names`）に絞る**ので、アカウントの他の Worker のログは入らない。各 Worker の wrangler 設定に `"logpush": true` が要る（`deploy.example/` にある）。

どちらかを設定しなければ、監査ログは調査の補助として使う。

Terraform の State には Logpush の宛先の資格情報（R2 の S3 互換の鍵）が平文で残る。state は非公開の場所に置く（`infra/README.md`）。

確かめ方: 設定後にタスクを 1 件実行し、Logpush の送り先に監査行（`"audit":true`）が欠けずに届くことを、タスクの `TaskDO` の events（`credential_issued` / `credential_revoked` など）の件数と突き合わせる。具体的な手順は [acceptance.md](specs/acceptance.md) の 16 節。手動で作る場合の画面操作（文書による）: ダッシュボードの **Logpush** ページ（アカウントのレベル）> **Create a Logpush job** > 送り先（R2）> データセットに **Workers trace events** を選ぶ > フィールドを選ぶ > 画面の指示に従って送り先の所有を確かめて完了（[出典](https://developers.cloudflare.com/workers/observability/logs/logpush/)、R2 の送り先は[出典](https://developers.cloudflare.com/logs/logpush/logpush-job/enable-destinations/r2/)）。Workers Trace Events の Logpush は Workers Paid が要る。通常は Terraform が作るので、この画面操作は要らない。

## 11. 単価（推定費用）の上書き

タスクの要約（`summary.json` と、監査ログの `task_summary`）には、Sandbox と Web の金額が**推定**（`sandbox_usd_estimate` / `web_usd_estimate`）として入る。回数・実行時間に単価をかけた値で、Claude の金額（AI Gateway の usage に基づく）とは別。タスクの予算（$10）には含めない。単価は gateway の `vars` の既定値で、下流が自分の `vars` で上書きする（未設定・不正な値は既定に戻る。0 は許す）。

| 変数 | 既定値 | 内容 |
|---|---|---|
| `SANDBOX_USD_PER_HOUR` | 0.1291 | Sandbox コンテナの 1 時間あたり。既定の大きさ `standard-2`（1 vCPU、6 GiB、12 GB）で CPU を 100% 稼働とみなした値。`deploy:config` を使うなら `sandbox.instance` から自動で計算される。`SANDBOX_INSTANCE` を手で変えたら、下の表の値に合わせるか上書きする |
| `WEB_USD_PER_1K_SEARCH` | 5.00 | `web_search` 1,000 回あたり。既定のプロバイダ（linkup）の値。`WEB_SEARCH_PROVIDER` を変えたら上書きする |
| `WEB_USD_PER_1K_FETCH` | 0 | `web_fetch` 1,000 回あたり |
| `WEB_USD_PER_1K_BROWSE` | 0.75 | `web_browse` 1,000 回あたり（1 回 30 秒を上限としたブラウザ時間） |

### Sandbox の大きさ（`SANDBOX_INSTANCE`）

`scheduling_policy: durable_object` では wrangler の `instance_type` が効かず、SandboxDO が `start()` に渡す `instance` が大きさを決める。以前は未指定で `lite`（256 MiB）になり、`npm ci` が遅く、メモリ不足で落ちることがあった。既定は `standard-2`。単価は CPU $0.000020 / vCPU 秒、メモリ $0.0000025 / GiB 秒、ディスク $0.00000007 / GB 秒を、CPU 100% 稼働として 1 時間分（上限側。月の無料枠は差し引かず、小数 4 桁に切り上げ）。表は `packages/models/src/sandbox.ts` が 1 か所で持つ。

| `SANDBOX_INSTANCE` | vCPU | メモリ | ディスク | 1 時間あたりの上限（USD） | 向き不向き |
|---|---|---|---|---|---|
| `lite` | 1/16 | 256 MiB | 2 GB | 0.0073 | 軽いコマンドだけ。`npm ci` や依存の多いテストは遅く、メモリ不足で落ちうる |
| `standard-1` | 1/2 | 4 GiB | 8 GB | 0.0741 | 小さなプロジェクトの `npm ci` / テスト |
| `standard-2`（既定） | 1 | 6 GiB | 12 GB | 0.1291 | 一般的なプロジェクトのビルドとテスト |
| `standard-3` | 2 | 8 GiB | 16 GB | 0.2201 | 並列のテスト、大きめのビルド |
| `standard-4` | 4 | 12 GiB | 20 GB | 0.4011 | 重いビルド。費用も最大 |

**タスクごとの大きさ**: `rovo.config.json` の `sandbox.instance` は既定で、`task_start` の `sandbox_instance`（`standard-1` / `standard-2` / `standard-3` / `standard-4`。`lite` は選べない）でタスクごとに変えられる。クライアントは `sandbox_instances_list` で選べる大きさと単価を確かめて選ぶ。指定したタスクは、その間ずっとその大きさで動き、下の昇格もしない（動いているコンテナの大きさは変えられない。Clef も呼ばない）。省略したタスクは既定の大きさで小さく始まり、コマンドの前に Clef が必要と判断すると自動で昇格する。依存キャッシュを作るコンテナの大きさは、指定に依らず既定のまま（昇格もしない）。`task_result` の `usage.sandbox_instance` に最初に起動した大きさが出る。

**小さく始めて、必要なときに大きくなる（昇格。`sandbox.maxInstance`）**: 動いているコンテナの大きさは変えられないので、ワーカーのコマンド（`bash` ツール）と検証コマンドを実行する前に、**Clef**（Workers AI の決定モデル `@cf/cloudflare/clef-flash`。曖昧なときだけ `@cf/cloudflare/clef`）が、コマンド・今の大きさ・リポジトリの並列の設定・直近のコマンドから「今の大きさで足りるか」を判断する。足りなければ、今のコンテナのスナップショット（Containers の `snapshotContainer`。依存キャッシュ（17）と同じ仕組み）を取り、コンテナを止め、同じスナップショットから大きい大きさで起動し直す。スナップショットは大きさに結び付かないので、小さいコンテナで作ったものを大きいコンテナで戻せる（`node_modules` のネイティブのバイナリも動く）。作業ツリー（HEAD と未 commit の変更）がそのまま残っていることを確かめてから、元のコマンドを実行する。**上げるだけで下げない**（コンテナが落ちて作り直されても最終の大きさで起動する）。**何回でも上がる**（2 → 3 → 4）。昇格の間（数十秒）は、そのコマンドの開始が遅れる。判断そのものは 1 回あたり 1 秒前後（flash の往復は中央値 約 350 ms・p95 約 1 秒）で、ワーカーのコマンドのたびにかかる。

- **判断は Clef だけ（規則は無い）**: コマンドの種類を表で判定する規則（旧 `heavy-command.ts`）・ワーカーが呼ぶ `sandbox_scale_up`・検証コマンドの強制昇格は削除した。判断の入力（state）は、コマンド・argv・cwd・今の大きさ・各大きさの vCPU とメモリ・リポジトリの文脈・直近 3 件のコマンド（コマンド・所要秒・終了コード）・**並列の手がかり**（コンテナ内で、cwd とその上のリポジトリのルートから、`package.json` の `packageManager` / `workspaces` / `scripts`、vitest / jest / playwright / mocha の設定、`pyproject.toml` / `pytest.ini` / `setup.cfg`、`Cargo.toml` / `.cargo/config.toml`、`Makefile`、`gradle.properties`、`.bazelrc`、`turbo.json`、`nx.json` などを生のテキストのまま読んだもの。事実の収集だけで、どれが大事かの判断は Clef に任せる）。**リポジトリの中身は非信頼のデータ**として state にだけ入れる。悪意のある設定が判断を歪めても、影響は大きさの選択だけで、上限（既定 `standard-4`）が費用を抑える。判断の閾値は env `SANDBOX_CLEF_THRESHOLDS` で変えられる（既定: 重い確率 < 0.5 は上げない。重いなら 4 vCPU で速い確率 >= 0.4 で `standard-4`、そうでなければ `standard-3`。flash が曖昧なときだけ clef で聞き直す）。
- **聞く対象と聞かない場合**: ワーカーの `bash` ツールと検証コマンドだけ（`exec` の `origin`）。Sandbox 自身の内部の `exec`（git など）は聞かない。`task_start` で `sandbox_instance` を明示したタスク（固定）、`sandbox.maxInstance` が `null`（`SANDBOX_MAX_INSTANCE` が空）、今の大きさがすでに上限、`AI_GATEWAY_ID` が空・`ai` バインディングが無い（警告のログ）のときは Clef を呼ばない。
- **Clef の呼び出し**: agent の既存の `ai` バインディングと `AI_GATEWAY_ID`（Claude 用。BYOK 専用の Gateway でも Workers AI は通る）を使う。**新しいバインディングも secret も増えない**。AI Gateway の metadata は `caller: "sandbox_scale"` と `taskId`。Workers AI の利用料は Clef の料金（`clef-flash` は入力が安価で、1 回の判断で入力は数千 tokens 以内）で、AI Gateway の usage に出る。
- **失敗しても止まらない（fail-soft）**: Clef が失敗（例外・時間切れ・想定外の応答）→ 1 回 5 秒・最大 3 回・合計 20 秒まで再試行し、それでも駄目なら今の大きさのまま実行する（`usage.sandbox_scale_clef_failures` に数え、判断の記録に `failed: true`）。スナップショットに対応しない環境・失敗した・時間切れ（2 分）→ 昇格せず小さいまま続ける。スナップショットのあと昇格先の起動・確認（CA 証明書、作業ツリーの HEAD と未 commit の変更が元と同じこと）に失敗 → 同じスナップショットで今の大きさに起動し直す（作業ツリーは失わない）。それも失敗 → image から起動し直し（作業ツリーは最後に push したチェックポイントから作り直され、ワーカーには「再起動した」と伝わる）、既存の起動の失敗の扱い（3 回で `sandbox_setup_failed`）に乗る。見送り・失敗の理由は固定コードで `usage.sandbox_promotion_reason` とログ（`sandbox_promotion_skipped` / `sandbox_promotion_failed` / `sandbox_scale_decision_failed`）に残る。
- **結果に出る項目**: `task_result` の `usage.sandbox_promoted_to`（最終の大きさ）、`usage.sandbox_promoted_at`（最初の昇格の時刻。epoch ms）、`usage.sandbox_runtime_ms_before_promotion`（最初の昇格までの Sandbox の時間。ms）、`usage.sandbox_promotions`（成功した昇格の履歴。`{to, at, trigger, runtime_ms_before}`。`trigger` は `clef`。古いタスクは `agent` / `rule` / `verification` と `rule_match`）、`usage.sandbox_promotion_reason`（`fixed_instance` / `state_unreadable` / `snapshot_unsupported` / `snapshot_failed` / `start_failed` / `cert_missing` / `workspace_mismatch` / `fallback_failed`。古いタスクは `already_large` も）、`usage.sandbox_promotion_failures`（`[{trigger, reason}]`。最大 8 件）。`usage.sandbox_instance` は**最初に起動した大きさ**で、昇格しても変わらない。最終の大きさは `usage.sandbox_promoted_to`。`task_wait` の usage イベントでも、`sandbox_promotions` / `sandbox_promotion_failures` は `task_result` と同じ配列で出る。
- **振り返り（Clef の精度。usage）**: `usage.sandbox_scale_decisions`（判断の回数）・`sandbox_scale_raised`（上げた回数）・`sandbox_scale_clef_failures`（Clef の失敗の回数）・`sandbox_scale_slow_not_raised`（上げなかったのに 60 秒を超えたコマンドの数）・`sandbox_scale_skipped_light`（明らかに軽いコマンド＝ls・cat・git status など、読み取り系だけの `bash -c` を、Clef を呼ばずに今の大きさで実行した回数。迷う形は聞くので数えない）の集計と、判断ごとの記録 `usage.sandbox_scale_log`（直近 50 件。`{at, from, to, heavy, fast4, choice, model, failed?, clef_ms, cmd_ms, exit_code, cmd}`。`to` は上げた先で、変えなければ `null`。`heavy` / `fast4` / `choice` は確率、`model` は `flash` / `clef`、`cmd` はコマンドの先頭の語だけ（`bash -c "<コマンド>"` / `sh -c` の形なら、環境変数の代入・`cd <dir> &&`・`env` / `timeout` などの前置きを読み飛ばした先頭の語。そうでなければ `argv[0]` の basename）で、argv の全体・コマンド文字列・リポジトリの内容は残らない）。集計は `task_wait` の usage イベントと `task_summary` の `sandbox.scale` にも出る。**記録の一覧は `task_result` の usage にだけ**出る（TaskDO の storage を増やさないため）。読み方は design.md の 15.8。
- **推定費用の按分**: `task_summary` の `sandbox_usd_estimate` は、大きさごとの区間（`sandbox_segments`）の時間 × その大きさの単価の合計（`unit_prices.sandbox_promoted_usd_per_hour` に最終の大きさの単価）。`sandbox_segments` は要約（`summary.json`）だけの項目で、`task_result` の usage・usage イベントには出ない（区間は `usage.sandbox_promotions` と `sandbox_runtime_ms` から導ける）。Sandbox の費用は予算に含めない扱いは変わらない。
- **スナップショットの名前**: `promote-<task_id>-<回数>`（回数ごとに別）。Cloudflare のドキュメントはスナップショットを不変で、識別は `id` と説明し、名前は人が見るためのもの。名前の重複の扱いに頼らないよう、回数を付けている。
- **`standard-4` の使いどころ**: 本番のベンチマークで、CPU だけの並列処理は `standard-3` で 2.0 倍、`standard-4` で 3.5〜3.9 倍速くなった。一方、gateway の vitest のように 1 つの workerd を共有するテストは、`standard-3` で 1.42 倍、`standard-4` でも 1.48 倍で頭打ちになる。**`standard-4` が速くなるかは負荷の並列の仕方による**（以前の「4 vCPU にしても速くならない」は vitest 固有の結果だった）。CPU は使った分だけ課金されるので、4 に上げ損ねる損は小さい。費用を抑えたいときは上限（`sandbox.maxInstance`）を `standard-3` にする。
- **残るもの**: 昇格のスナップショットは昇格のたびに 1 つ残る（一覧・削除の API が無い。30 日で期限切れになる。保管の費用は Cloudflare の Containers の料金表を確認する）。無効にするには `sandbox.maxInstance` を `null` にして `deploy:config` を再生成し、agent と gateway を再デプロイする。
- **旧設定からの移行（下流）**: `rovo.config.json` の `sandbox.heavyInstance` と `sandbox.agentMaxInstance` を削除し、必要なら `sandbox.maxInstance` を書く（書かなければ既定の `standard-4`）。`deploy:config` を作り直して生成物をコミットし、agent と gateway を再デプロイする（`deploy:config:check` が通ること）。手書きの wrangler 設定を使っているなら、agent と gateway の `SANDBOX_HEAVY_INSTANCE` と `SANDBOX_AGENT_MAX_INSTANCE` を削除して `SANDBOX_MAX_INSTANCE` を足す（**足し忘れると、昇格は黙って無効になる**。確認は `sandbox_instances_list` の `auto_scale_max`）。新しい secret・バインディングは要らない。

**Sandbox は必要になるまで起動しない**: ワーカーが最初に Sandbox を使うツール（ファイルの読み書き・コマンドの実行・git）を呼んだときに起動する。`web_search` / `web_fetch` だけで進むタスク（検証コマンドも無い）は起動せず、`sandbox_runtime_ms` は 0 で、`usage.sandbox_instance` も付かない。起動の失敗は 3 回で `sandbox_setup_failed`。この変更でデプロイ手順・secret は増えない（gateway に `SANDBOX_INSTANCE` の var が増えるが、`deploy:config` が入れる。手書きの設定を使っているなら 11 の表のとおり足す）。

実際の費用は CPU の使用率とコンテナを動かした時間で決まり、この表は常に CPU 100% の上限。タスクは最長 2 時間なので、`standard-2` で 1 タスクの上限は約 $0.26。変えるのは `rovo.config.json` の `sandbox.instance`（`deploy:config` が agent の `SANDBOX_INSTANCE` と gateway の `SANDBOX_USD_PER_HOUR` に反映する）。Cloudflare の料金が変わったら `packages/models/src/sandbox.ts` の `SANDBOX_PRICE` を直す。コンテナが止まって作り直された理由（メモリ不足など）は、Workers の API が終了コードを返さないので記録できない。再起動が続くなら大きさを上げる。

既定値の根拠（Cloudflare の公式料金表、取得日 2026-10-19）は `apps/gateway/wrangler.jsonc` のコメントと [phase6.md](specs/phase6.md) にある。料金改定で変わるので、下流で見直す。Web の回数は**ワーカーが使った分だけ**（クライアントが MCP から使う分はタスクに紐付かない）。

## 12. web_browse の有効化

`web_browse`（JS を描画した後のページを Markdown で取得。Browser Run の Kitesurf）は**実験的で、既定で無効**。

- 有効にする前に、[acceptance.md](specs/acceptance.md) の 11 節「web_browse（有効化前のゲート）」の残存リスクを読み、受け入れるかを運用者が判断して記録する。保証するのは「禁止先・判定不能の取得結果を返さない」ことまでで、禁止先への通信の発生は防げない。実機のゲート（付録 A）は任意で、このリポジトリの作者は行わずに有効にしている。
- 有効にするには、3 つの Worker の `WEB_BROWSE_ENABLED` を `"true"` にする。順序は web → agent → gateway（4 の順序と同じ）。無効のままなら、クライアントの `tools/list` にもワーカーのツールにも出ない。
- web の `BROWSER` バインディングの `remote` は、**ローカル開発（`wrangler dev`）で本物のヘッドレスブラウザに繋ぐための設定**（`"browser": { "binding": "BROWSER", "remote": true }`）。ローカルには Browser Run の模擬が無い（出典: [Local development](https://developers.cloudflare.com/workers/local-development/)、[Browser Run の Wrangler](https://developers.cloudflare.com/browser-run/reference/wrangler/)）。デプロイした Worker は `remote` が無くても Browser Run を使う。`deploy.example/` の `browser` には `remote` を入れていない。`quickAction()` を使うなら `compatibility_date` は `2026-03-24` 以降（雛形は `2026-10-12`）。Puppeteer を使うコードなら `nodejs_compat` が要る（`compatibility_date` が `2026-08-04` 以降なら既定で有効）。rovo の web がどちらの API を使うかと、実際に `web_browse` が動くか: **【実機で確認して追記】**
- 有効化後は、`tools/list` に `web_browse` が現れることを確かめる。

## 13. 初回デプロイの確認

最低限のスモークテスト:

1. 3 つの Worker が、web → agent → gateway の順にデプロイできた。
2. `<PUBLIC_BASE_URL>/mcp` が、認証なしで 401 を返す（protected resource metadata が参照できる）。
3. Portal 経由で Claude Code から接続し、同意画面 → GitHub のログイン → ツールの一覧（`task_start` / `task_status` / `task_wait` / `task_result` / `task_cancel` / `task_answer` / `task_steer` / `task_pr_ready` / `task_pr_merge` / `web_search` / `web_fetch`。`web_browse` は有効にした場合だけ）が出る。
4. 許可した team のメンバーで `task_start` → Draft PR ができ、`task_result` が返る。

詳しい受入は [acceptance.md](specs/acceptance.md)。

## 14. 更新手順とロールバック

- 更新: upstream を取り込み（4）、`mise run test`（または自分の CI）で確認する。`deploy.example/` が変わったら `mise run deploy:config -- --no-terraform` で `deploy/` を作り直してコミットし（`deploy:config:check` が差分を検出する）、`infra/` が変わったら `terraform apply`（または `mise run setup`）してから、web → agent → gateway の順に再デプロイする（`ROVO_DEPLOY_DIR=deploy mise run deploy:all`）。
- 新しい Durable Object クラス `DepsCacheDO`（agent。依存関係のキャッシュ。17）: agent の設定は `exports`（`SandboxDO` / `AgentDO` と同じ書き方）でクラスを宣言していて、`migrations` の項目は無い。`deploy.example/` の雛形（`deploy:config` の生成物）には `durable_objects.bindings` の `DEPS_CACHE_DO` と `exports` の `DepsCacheDO` が入っているので、**再生成して（`deploy:config:check` が差分を示す）コミットし、agent を再デプロイする**。`exports` は新しいクラスの作成を宣言できる（Wrangler がデプロイ時に作成・更新・削除を報告する）。**クラスの作成・削除・名前変更を含む変更は、バージョンのアップロードや段階的デプロイでは適用できず、`wrangler deploy`（rovo では `deploy:*`）で行う**（出典: [Durable Object class exports](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/)）。既存の Worker を `exports` に切り替えても、作成済みの namespace とデータはそのまま残る。また、1 つの Worker で `exports` の Durable Object と `migrations` は併用できない（rovo は agent が `exports`、gateway が `migrations`）。状態は鍵ごとのスナップショットの参照だけ（失っても、次のタスクが作り直すだけ）。
- Durable Object のマイグレーション: gateway の `migrations`（`TaskDO` / `UserDO`）は upstream の `wrangler.jsonc` にある。下流の設定にも**同じ `migrations` を引き継ぐ**（`deploy.example/` の雛形に入っているので、`deploy:config` の生成物に入る）。クラス名の変更・削除は、保存済みのデータを失うので、upstream の更新で入った場合は内容を確認してから適用する。
- 公開 API を変える更新（ツールの入出力）は、接続中のクライアントに影響する。upstream の変更を確認する。
- ロールバック: `wrangler rollback`（または ダッシュボードの Worker > Deployments > バージョンの「Rollback」）で、直近 100 件の公開済みバージョンのどれかに戻せる。戻すと、そのバージョンで新しいデプロイができ、全ルートに即座に効く。**Durable Object のクラスの作成・削除・名前変更（`exports` または `migrations` による）をはさんだバージョンへは戻せない**（拒否される）。KV・R2・キューなどのリソースが消えている・変わっているときも戻せない。つまり DO のクラスを変えた更新は、戻る道が無い前提で行う。Rollbacks は Worker のコードと設定のバージョンを切り替える機能で、Durable Object の保存済みのデータを書き戻すものではない（出典: [Rollbacks](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/)、[段階的デプロイと Durable Objects](https://developers.cloudflare.com/workers/versions-and-deployments/gradual-deployments/with-durable-objects/)）。コンテナを含む agent のロールバック（イメージの扱い）: **【実機で確認して追記】**
- 再デプロイとコンテナ: `wrangler deploy` は先に Worker のコードを有効にし、そのあとでイメージの公開とコンテナの入れ替え（rollout）を始める。既定は段階的で、入れ替え対象のインスタンスには `SIGTERM` が送られ、最長 15 分で終了しなければ `SIGKILL` になる。ただし rollout が入れ替えるのは既定のスケジューリングポリシーのコンテナで、Sandbox SDK の文書は「Worker のデプロイは実行中のインスタンスを止めない（ファイルとプロセスは残る。新しいイメージは新しく起動するインスタンスにだけ効く）」と書いている（出典: [Rollouts](https://developers.cloudflare.com/containers/configuration/rollouts/)、[Sandbox の寿命](https://developers.cloudflare.com/sandbox/concepts/lifetime/)）。rovo の agent の SandboxDO で、実行中のタスクがこのどちらの動きになるか、タスクが途中で切れるか: **【実機で確認して追記】**

## 15. 運用の注意

- 予算: タスクごとに `TASK_BUDGET_USD`（既定 $10）を月額の枠（`MONTHLY_BUDGET_USD`、既定 100）から予約する。足りなければ `budget_exceeded`。タスクの予算に近づいたときは `budget_policy`（既定 `ask`）でクライアントに延長を聞く（承認のたびに月の枠から予約。月の枠はハードリミット）。ユーザーごとに同時に実行できるタスクの数にも上限がある（`MAX_CONCURRENT_TASKS`。`budget_status` の `concurrency_limit`）。GitHub やモデルのプロバイダーの API には利用者の合計の呼び出しが集まるので、上限を大きくするときはそれぞれのレート制限（429）に注意する。
- 秘密のローテーション:
  - `TOKEN_ENC_KEY`（gateway）を変えると、保存済みの GitHub 資格は復号できなくなり、全員が再ログインになる。
  - `TOKEN_ENC_KEY`（agent）を変えると、実行中のタスクは次のトークン更新まで push / clone が 401 になる。実行中のタスクが無いときに変える。
  - GitHub App の Client secret / 秘密鍵は、GitHub で新しいものを発行して `wrangler secret put` で差し替える。
- Installation Token は、タスクの終端で失効する。失効に失敗した場合は、期限（最長 1 時間）まで有効。
- 障害時の見方: 監査ログ（10）、R2 の `summary.json`（9）、`task_status` / `task_result`。Sandbox の復旧の回数は要約の `restarts` / `bootRetries` に出る。
- R2 の中身は非信頼データとして扱う（9）。

## 16. トラブルシューティング

ツールのエラーの `code` と意味は、[README のエラーの節](../README.ja.md#エラー)にある。よくある設定の誤り:

| 症状 | 原因 |
|---|---|
| ログインできない | `ALLOWED_ORG` / `ALLOWED_TEAM` / `ALLOWED_USER_IDS` のどのルールも設定されていない、`ALLOWED_TEAM` だけで `ALLOWED_ORG` が無い、`ALLOWED_USER_IDS` に不正な要素がある、または許可されていない。`GITHUB_APP_CLIENT_ID` が空 |
| `task_start` が `github_app_not_configured` で FAILED | `GITHUB_APP_ID` または `GITHUB_APP_PRIVATE_KEY` が未設定 |
| `task_start` が `ai_gateway_not_configured` で拒否される | agent の `AI_GATEWAY_ID` が空 |
| `task_start` が `forbidden` | App が対象リポジトリに未導入、または push 権限が無い |
| `task_pr_ready` / `task_pr_merge` が `forbidden` | App の権限が Pull requests / Contents の write でない、利用者に書き込み権限が無い（メッセージに GitHub の理由が入る） |
| `task_pr_merge` の応答の `warnings` に `checks_unreadable` | CI の結果を読めずに確かめないままマージした。App に Checks / Commit statuses の read 権限を足すと確かめられる（任意） |
| タスクが `COMPLETED` なのに PR が Draft のまま | 完了時の自動の Ready が失敗した（warning イベント `auto_ready_failed`。App の Pull requests: write が無い、GitHub の障害など）。`task_pr_ready` で Ready にできる |
| `task_pr_merge` が `merge_blocked` | ブランチ保護（必須レビュー・必須チェック・ruleset）に拒否された。メッセージの GitHub の理由を満たしてから再実行する |
| `task_start` が `draft_pr_unsupported` で FAILED | Draft PR を作れないリポジトリ。`DRAFT_PR_FALLBACK=ready` にするか、リポジトリを変える |
| `web_search` が `internal`（`web research is misconfigured on the operator side; retrying will not help ...`。再試行の目安〔`retry_after_seconds`〕は付かない） | web の AI Gateway が byok_only（`web_search_byok_not_configured`）、または Web Search の認証・クレジットの不足。`terraform apply` で `ai_web_gateway_id` を作り、`deploy:config` → `deploy:web` で web の `AI_GATEWAY_ID` をそれに向ける（web の Worker のログに上流のコードが出る） |
| `web_search` / `web_fetch` が `internal`（`web research service is not available`） | 原因の候補は、web の `AI_GATEWAY_ID` が空（web 内部の名前は `misconfigured`。ツールの応答には出ない）。ほかに web 機能の無効・未実装も同じ応答になる |
| `web_browse` が tools/list に出ない | 3 つの Worker の `WEB_BROWSE_ENABLED` が揃っていない |
| デプロイで service binding が解決できない | 順序の誤り（web → agent → gateway） |
| アーカイブが作られない | `LOGS` が gateway に束ねられていない（監査ログに `archive_skipped`） |

## 17. 依存関係のキャッシュ（Containers のスナップショット。D14）

タスクの Sandbox は、毎回 `npm ci` などで依存関係を導入すると、Sandbox の時間の大半を使う（`standard-2` で x-mcp のタスクが約 67 秒）。そこで、リポジトリのルート直下の lockfile（`pnpm-lock.yaml` / `package-lock.json` / `yarn.lock`）が同じなら、導入済みの `node_modules` を **Containers のスナップショット**（public beta）として使い回す。設計は design.md の 15.8（D14）。

- **効き方**: 最初のタスク（その lockfile の blob SHA で初めて）はキャッシュを作る（導入と同じ時間がかかる。`task_result` の `usage.deps_cache` が `built`、`cache_build_ms` に所要時間）。同じ lockfile・package.json の 2 回目以降は、導入済みの状態で起動する（`hit`）。キャッシュの鍵には lockfile に加えて、ルートの `package.json`・`pnpm-workspace.yaml`・入れ子の `package.json`（workspace の各パッケージ）の内容も入る（scripts を差し替えたブランチと共有しない。大きなリポジトリで tree が切り詰められた・取得に 10 秒以上かかったときはキャッシュなし）。鍵から漏れるのは `.npmrc`・`.yarnrc.yml`・`.pnpmfile.cjs`、install スクリプトが読むファイルの中身、patch ファイルそのものの中身（パスが同じで中身だけ変わる場合）で、影響は同じリポジトリの別ブランチに古い依存が混ざる正確性の問題までです（リポジトリをまたぐことは無い。`packageManager`・`patchedDependencies` は package.json にあるので鍵に入っている）。lockfile を変えたブランチ・リポジトリごと・イメージの更新ごとに別のキャッシュになる。`miss` はキャッシュが使えず今までどおり動いた（ログに `deps_cache_miss: <理由>`）、`disabled` は対象外（lockfile が無い、ルート以外にしかない、`DEPS_CACHE_ENABLED=false`）。
- **費用**: キャッシュを作るコンテナの時間は、作ったタスクの `sandbox_runtime_ms`（推定費用）に足される。スナップショットの保管の費用は Cloudflare の Containers の料金表を確認する（このリポジトリは単価を持たない）。スナップショットは 30 日で期限切れになる（復元で延長される）。一覧と削除の API は無いので、rovo は消さない。
- **前提**: `scheduling_policy: durable_object`（agent の `containers` で設定済み）。スナップショットは beta の機能なので、アカウントで使えない・上限に達したときは、タスクは失敗せず `miss` になる（キャッシュなしで今までどおり動く）。
- **無効にする**: `rovo.config.json` の `depsCache.enabled` を `false` にして `deploy:config` を再生成し、agent を再デプロイする（agent の var `DEPS_CACHE_ENABLED`）。
- **安全性**: GitHub のトークンは、作成用のコンテナにもスナップショットにも入らない（外向きの転送時に Worker が付ける）。スナップショットにはリポジトリの作業状態が入らず（`node_modules` とパッケージマネージャのキャッシュだけ）、`repository_id` ごとに別なので他のリポジトリとは共有されない。作成用のコンテナが実行するのは、base_sha のコミット済みのコードだけ。
- **pnpm / yarn**: Dockerfile で `corepack enable` した shim を使う（素の `pnpm` が呼べる。本体は package.json の `packageManager` に従う。pnpm と yarn classic の本体は、イメージのビルド時に corepack のキャッシュ（`COREPACK_HOME=/opt/corepack`）へ入れてあり、`apps/agent/Dockerfile` の `ARG PNPM_VERSION` / `YARN_VERSION` の版なら実行時に取りに行かない。違う版でも、packageManager のハッシュ固定（`+sha512.<hex>`）は守る: pm-prepare は完全な spec を `corepack install` に渡して wrapper のハッシュを corepack に検証させ、一致しなければ何も置かず失敗にする（タスクは続き、corepack が従来どおり自分で取って検証する）。native バイナリは npm の integrity で検証される。形が不正なハッシュは何もしない。違う版は、clone のあとに `pm-prepare.mjs` が npm の経路（取得先は `registry.npmjs.org`。外向きの許可に既にある）で先に用意する。実行時に取らせない理由: pnpm 11 以降は native バイナリ（約 44 MB）を初回の実行時に Node の fetch（undici）で取り、外向き通信の中継越しだと Node 24 が `assert(!this.paused)` で落ちた。イメージは圧縮前で約 100 MB 増える）。python3 もイメージに入っている。yarn の berry（`yarn.lock` が `__metadata:` で始まる）は `--frozen-lockfile` を受け付けず、キャッシュの作成が失敗する（`miss`。60 秒のクールダウンの後に作り直す）。その場合は `depsCache.enabled` を `false` にするか、classic にする。
- **対象外**: Python / PyPI、ルート以外の lockfile（モノレポの入れ子）、pnpm store のキャッシュ、スナップショットの削除。
- **実機での確認**: acceptance.md の 24。

## 18. ダッシュボード（`/dashboard`）

gateway は、読み取り専用のダッシュボード（`apps/dashboard`。Vite + React + TypeScript の SPA）を `/dashboard` で配信する。設計は `docs/specs/dashboard.md`。GitHub でログインした利用者が、権限のあるリポジトリのタスクの一覧（今日のタイムライン・表・予算・全員の実績・モデル別の費用・Cloudflare の枠）と詳細（進み具合・出力の末尾・費用・Draft PR）を見られる。状態を変える操作は、ログアウトを除いて無い。

- **ビルドは自動**: `mise run deploy:gateway`（`deploy:all` を含む）と `mise run setup` が、gateway のデプロイの前に `pnpm exec vite build`（`apps/dashboard`）を実行して `apps/dashboard/dist` を作る。ビルドが失敗したら、古い `dist` をデプロイしないよう `wrangler deploy` を呼ばずに止まる。新しい secret・トークン・手順は要らない（`pnpm install` 済みであれば足りる）。手元で `wrangler dev` を使う場合は `mise run dev`（先にビルドする）。
- **配信の仕組み**: gateway の `assets` は `run_worker_first: true`。すべてのリクエストが先に Worker に届き、`/dashboard` と `/dashboard/*` だけを SPA として扱う。それ以外（`/mcp`・`/authorize`・`/.well-known/...` など）は今までどおり OAuthProvider が処理する。`/dashboard/api/*` は JSON の API の置き場所で、未知のパスは JSON の 404。
- **下流の設定**: `deploy.example/gateway.wrangler.jsonc` の `assets`（`"directory": "../apps/dashboard/dist"`）を `deploy:config` がそのまま出す。`deploy/` にコミット済みの設定は、`mise run deploy:config` で再生成する（`deploy:config:check` で差分を確かめる）。
- **配信されるもの**: `/dashboard`（一覧）と `/dashboard/tasks/<task_id>`（詳細）の SPA、`/dashboard/assets/*`（JS・CSS・書体・ライセンス文）、`/dashboard/auth/login`（ログインの開始。戻りは既存の `/callback`）、`/dashboard/api/*`（読み取りの JSON API と、`POST /dashboard/api/logout`）。ほかのパスは増えない。
- **`PUBLIC_BASE_URL` と `dashboard_url`**: ログインの戻り先と、`task_start` / `task_status` / `task_result` の `dashboard_url`（`<PUBLIC_BASE_URL>/dashboard/tasks/<task_id>`）は、`PUBLIC_BASE_URL`（`publicBaseUrl`）から作る。空・不正なら `dashboard_url` は付かない。URL を変えたら、GitHub App の callback（下）も合わせる。権限の無い人が `dashboard_url` を開くと 404（URL 自体は秘密ではない）。
- **ログイン（GitHub App の callback）**: ダッシュボードのログインも GitHub App のユーザー認可で、**callback は今までの `<PUBLIC_BASE_URL>/callback` のまま**（GitHub App の設定の変更も、新しい secret も要らない）。MCP のログインとの振り分けは、state の接頭辞（`rovo-dash.`）だけで行う。許可の判定（`ALLOWED_ORG` / `ALLOWED_TEAM` / `ALLOWED_USER_IDS`）は MCP のログインと同じ。セッションは暗号化した Cookie（`__Host-` 付き、`HttpOnly`・`Secure`）で、GitHub のトークンは Cookie に入れない。ブラウザで使うので `https` が前提（ローカルの `wrangler dev` の `127.0.0.1` では、E2E で通ることを確かめている）。
- **Access を前に置く場合**: Cloudflare Access をゲートウェイのホストの前に置くときは、次のようにする。
  - **`/callback` は Access を通さない**。GitHub がブラウザを戻す先で、Access のログインを挟むと戻れない（MCP のログインと同じ）。Access のポリシーは、`/callback` を Bypass にするか、`/callback` を含まないパスに限る。
  - `/dashboard` と `/dashboard/api/*` は、Access を前に置いてもよい（設計からの推論で、実環境では未確認）（ブラウザで開くので Access のログインが挟まる）。ただし二重のログインになり、`dashboard_url` を開いたときの戻りも長くなる。実際の防御線は gateway の GitHub ログインと、リポジトリごとの閲覧の認可（閲覧者の GitHub トークンで見えるリポジトリだけ）で、Access は追加の層。`/dashboard/api/*` を Access で保護するなら、同じ Access のセッションがブラウザから `fetch` に付く構成（同一ホスト）にする。
  - `/mcp`・`/authorize`・`/oauth/*`・`/.well-known/*` は、ダッシュボードとは別の経路で、今までの扱い（8）のまま。
  - Portal に入れるのは MCP の URL だけでよい。（実環境では未確認）ダッシュボードを Portal の外に出す必要はない（Portal は MCP のゲートウェイで、ブラウザの SPA は経由しない）。
- **Cloudflare の API トークンの権限**: 下の「Cloudflare の概要」。**AI Gateway Read** と **Account Analytics Read**（どちらも読み取り）。既存の環境は `terraform apply` が要る。`plan` でトークンが置き換え（`must be replaced`）になる場合だけ、`mise run deploy:secrets -- --rotate cloudflare-token` で値を入れ直す。`WORKER_NAMES`（Workers の集計の対象。`rovo.config.json` の `workerNames`）は `deploy:config` が入れる（5 の表）。
- **書体の同梱**: 書体（IBM Plex Sans JP と JetBrains Mono）は npm の `@fontsource` から `dist` に同梱し、同一オリジンから配信する（外部の CDN は使わない。ブラウザから外部への要求は 0 件）。ライセンスは SIL Open Font License 1.1 で、全文は `/dashboard/assets/licenses/` に同梱する。woff2 だけ、キリル・ギリシャ・ベトナム語は同梱しない。再配布する下流も、この `licenses/` を消さないこと。
- **読み取り専用と安全**: 状態を変える API は無い（ログアウトの `POST` を除く）。表示する出力の末尾は、agent と gateway で秘密をマスクしてから出す。マスクの限界は `SECURITY.md`。

### Cloudflare の概要（`GET /dashboard/api/cloudflare`。M9）

ダッシュボードは、コンテナの稼働・Workers のリクエスト数・AI Gateway のリクエスト数と費用・Workers AI の neurons・クレジット残高を、gateway が **固定のクエリ**で読んで出す（`apps/gateway/src/dashboard/cloudflare.ts`。クライアントは `range=1h|24h|7d|month` しか選べない（既定は `month` = UTC の月初から今まで。予算の月と同じ））。読むのは GraphQL Analytics API（`containersMetricsAdaptiveGroups`・`workersInvocationsAdaptive`・`aiGatewayRequestsAdaptiveGroups`・`aiInferenceAdaptiveGroups`）と AI Gateway のクレジット残高（`GET /accounts/{account_id}/ai-gateway/billing/credit-balance`）。AI Gateway のログの prompt / body は読まない。結果は gateway のメモリに 45 秒（取得に失敗した項目があるときは 5 秒）共有キャッシュされる。

- **トークンの権限が増えた**: secret の `CLOUDFLARE_API_TOKEN`（Terraform の `cloudflare_api_token.ai_gateway_read`）は、**AI Gateway Read** に加えて **Account Analytics Read**（Account / Account Analytics / Read）を持つ。どちらも読み取りだけ。名前（`...-gateway-ai-gateway-read`）とリソースのアドレスは変えていない（変えるとトークンが再作成されて値が変わるため）。権限グループが名前で見つからないときは `plan` が止まり、`account_analytics_read_permission_group_id` で ID を指定できる。
- **既存の環境の更新手順**: (1) 取り込みのあと `terraform -chdir=infra apply`（`infra/` のトークンの権限が in-place で増える。**`plan` に `must be replaced` が出たときだけ**トークンの値が変わるので、`mise run deploy:secrets -- --rotate cloudflare-token` で入れ直す。in-place の更新なら値は同じで、secret の入れ直しは要らない）、(2) `mise run deploy:config`（`WORKER_NAMES` が gateway の vars に入る）、(3) `mise run deploy:gateway`。`terraform apply` までの間は、権限の無い項目が「取得できない」（`forbidden`）と表示されるだけで、画面と他の機能は動く。
- **新しい secret は無い**。account id・gateway id・Worker 名は既存の vars（`CLOUDFLARE_ACCOUNT_ID`・`AI_GATEWAY_ID`）と `WORKER_NAMES` から取る。account id を含む URL は応答に載せない。
- **集計の範囲**: コンテナはアカウント全体（GraphQL のコンテナの項目はアプリケーション ID で絞るが、名前では絞れない）。AI Gateway は `AI_GATEWAY_ID`（Claude 用の Gateway）だけ。クレジット残高の単位は API のドキュメントに無く、USD として表示する。
