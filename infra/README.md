# infra: rovo の Cloudflare リソース（Terraform）

rovo を自分のアカウントにデプロイするときに必要な Cloudflare のリソースを作る。誰が clone しても、変数を渡せば使える。全体の手順は [docs/deploy.md](../docs/deploy.md) の 4。**通常は `mise run setup` が `terraform init` / `apply` を行う**（変数は `rovo.config.json` から渡すので、tfvars は要らない）。このファイルは Terraform を単独で使うとき、と中身の説明。

## 作るもの

| リソース | 用途 | 対応する設定 |
|---|---|---|
| R2 バケット `<name_prefix>-archive` と、日数で削除するライフサイクル | タスクのアーカイブ（deploy.md の 9） | gateway の `r2_buckets`（`LOGS`） |
| R2 バケット `<name_prefix>-audit` と、日数で削除するライフサイクル | 監査ログの Logpush の宛先（deploy.md の 10） | wrangler 設定には書かない |
| KV namespace `<name_prefix>-oauth` | gateway の OAuth の状態 | gateway の `kv_namespaces`（`OAUTH_KV`） |
| AI Gateway `<name_prefix>-gateway` | agent の Claude 呼び出し（deploy.md の 7）。byok_only | agent と gateway の `AI_GATEWAY_ID` |
| AI Gateway `<name_prefix>-web-gateway` | web の Web Search / Clef 呼び出し。byok_only なし（Web Search API をクレジットで払うため） | web の `AI_GATEWAY_ID` |
| API トークン（Logpush 用） | 権限は「Workers R2 Storage Bucket Item Write」だけ。対象は監査用バケットだけ | Logpush の宛先の資格情報 |
| API トークン（gateway の読み取り用） | 権限は「AI Gateway Read」だけ。対象はこのアカウントだけ（`com.cloudflare.api.account.<account_id>`）。名前は `<name_prefix>-gateway-ai-gateway-read` | gateway の secret `CLOUDFLARE_API_TOKEN`（sensitive の output `gateway_cloudflare_api_token`。`mise run deploy:secrets` が流し込む） |
| Logpush ジョブ | データセット `workers_trace_events` を監査用バケットへ送る。**filter で `ScriptName` を rovo の 3 つの Worker だけに絞る** | 各 Worker に `"logpush": true` |

作らないもの: MCP Server Portal と Access の登録（別のインフラの管理側）、Anthropic の API キー（AI Gateway の画面で BYOK として登録する。Terraform に入れない）、Worker 本体（`mise run deploy:*`）、Worker の secret（`mise run deploy:secrets`）。

## 使い方

1. 認証は env の `CLOUDFLARE_API_TOKEN` から読む（provider の設定は `provider "cloudflare" {}` だけ）。このトークンには、R2・Workers KV・AI Gateway の編集、Logs の編集（Logpush）、API トークンの編集（Logpush 用と gateway の読み取り用のトークンを作るため）の権限が要る。**人が作る Cloudflare のトークンはこれだけ**（デプロイは `wrangler login`）。
2. `terraform.tfvars.example` をコピーして、`account_id` などを書く。
3. **state の置き場所（backend）を決める。** この `infra/` には `backend` ブロックが無い。`infra/backend.tf` を足して決める（例: S3 互換の R2、Terraform Cloud）。決めないと state はローカルの `terraform.tfstate` に置かれる。R2 の例と制約は下の「remote backend（S3 互換の R2）の例と制約」。
4. `terraform init` → `terraform plan` → `terraform apply`（`infra/` で実行）。
5. `terraform output` の非秘密の値は、`mise run deploy:config` が読んで下流の wrangler 設定を生成する（手で書き写さない。docs/deploy.md の 4）。

| output | 使われ方 |
|---|---|
| `kv_namespace_id` | gateway の `kv_namespaces[].id`（`deploy:config` が書く） |
| `archive_bucket_name` | gateway の `r2_buckets[].bucket_name`（同上） |
| `ai_gateway_id` | agent・gateway の `vars.AI_GATEWAY_ID`（同上） |
| `ai_web_gateway_id` | web の `vars.AI_GATEWAY_ID`（同上） |
| `audit_bucket_name` | wrangler 設定には書かない（Logpush の宛先。確認用） |
| `gateway_cloudflare_api_token`（**sensitive**） | gateway の secret `CLOUDFLARE_API_TOKEN`。`deploy:secrets` だけが `terraform output -raw` で読む。`deploy:config` は読まない（`terraform output -json` は sensitive の値も出すので使わない） |

6. AI Gateway の画面で、Anthropic の API キーを BYOK として登録する。

## remote backend（S3 互換の R2）の例と制約

CI から使うなら state は remote に置く。R2 に置く `infra/backend.tf` の例（バケットは Terraform とは別に、先に作っておく。値はすべてプレースホルダ）。

```hcl
terraform {
  backend "s3" {
    bucket = "<YOUR_STATE_BUCKET>"
    key    = "rovo/terraform.tfstate"
    region = "auto"

    endpoints = {
      s3 = "https://<YOUR_ACCOUNT_ID>.r2.cloudflarestorage.com"
    }

    # R2 は AWS ではないので、AWS 向けの確認と path style 以外の指定を止める
    use_path_style              = true
    skip_credentials_validation = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
    skip_metadata_api_check     = true
    skip_s3_checksum            = true
  }
}
```

この例は Terraform の S3 backend の設定項目（Terraform 1.9 以上。`infra/versions.tf` の `required_version`）に沿って書いたもので、この repository では実際の R2 に対して流していない（**未検証**。下流で通った設定と食い違ったら、下流の設定を正とする）。

- **backend の設定は `backend.tf` にインラインで書く。** `mise run setup`（`scripts/setup.sh`）は `terraform init -input=false` を、`deploy:config`（`scripts/deploy-config.mjs`）と `deploy:secrets`（`scripts/deploy.sh`）は `terraform output -raw ...` を実行するが、どれも `-backend-config` を渡さない。bucket や endpoint を別ファイルに分けて `-backend-config` で渡す書き方は、これらのタスクでは使えない。
- **`setup` だけが `terraform init` を行う。** `deploy:config` と `deploy:secrets` は init を行わないので、`setup` を流していない環境（CI など）では、先に `terraform -chdir=infra init -input=false` を実行しておく。

### state を読むタスクと必要な env

remote backend では、Terraform 以外のタスクも state を読むので、R2 のアクセスキーが要る。**env の `AWS_ACCESS_KEY_ID` と `AWS_SECRET_ACCESS_KEY` に、R2 の S3 互換のキー（state のバケットに読み書きできるもの）を入れる。**

| タスク | state を読むか | 内容 |
|---|---|---|
| `setup` | 読む・書く | `terraform init` / `apply` |
| `deploy:config` | 読む | `terraform output -raw` で非秘密の 4 つを読む。`--no-terraform` と `--check`（`deploy:config:check`）は Terraform を呼ばないので不要 |
| `deploy:secrets` | 条件つきで読む | gateway の secret `CLOUDFLARE_API_TOKEN` を**入れるとき**だけ `terraform output -raw gateway_cloudflare_api_token` を読む。すでに入っていれば読まない（`--rotate cloudflare-token` / `--rotate all` は入れ直すので読む）。`--skip-github-app` でも読む |
| `deploy:web` / `deploy:agent` / `deploy:gateway` / `deploy:all` | 読まない | wrangler だけ |
| `byok` / `github-app` | 読まない | `deploy/infra.json`（保存済みの出力）を使う |

CI では、デプロイのジョブにも state 用の secret を渡すことになる（[docs/deploy-ci.md](../docs/deploy-ci.md)）。

## state は非公開の場所に置く

**gateway の読み取り用トークンの値（`cloudflare_api_token.ai_gateway_read.value`）も、state に平文で残る**（Logpush 用トークンと同じ扱い）。**Logpush の宛先（`destination_conf`）には、R2 の S3 互換の鍵が含まれる。** access-key-id は Logpush 用トークンの id、secret-access-key はそのトークンの値の SHA-256。トークンの値（`cloudflare_api_token.logpush.value`）とあわせて、**state に平文で残る**。state は非公開の場所に置き、リポジトリにコミットしない。upstream の `.gitignore` は `infra/.terraform/` と `infra/*.tfstate*` を除外している。

## 下流のファイルの置き方

下流（private リポジトリ）は、rovo を upstream として merge し、`infra/` の中に**新しいファイルを足す**だけで使う。upstream のファイルは書き換えない。

- `infra/backend.tf`（state の置き場所）と tfvars（`infra/terraform.tfvars` など）は、upstream の `.gitignore` では除外していない。下流で通常どおり `git add` してコミットできる（`git add -f` は要らない）。tfvars に秘密は無い（account id は秘密ではないが、公開しないほうがよいので、rovo の公開リポジトリには絶対にコミットしない。誤ってコミットすると `mise run scan:secrets` が検出する）。
- `.terraform.lock.hcl` は upstream がコミットしている（provider を `5.27.0` に固定し、4 つのプラットフォームのハッシュを入れてある）。provider の版を上げるときは、`terraform init -upgrade` と `terraform providers lock -platform=darwin_arm64 -platform=darwin_amd64 -platform=linux_amd64 -platform=linux_arm64` を実行して更新する。

## 既定の設定と理由

- **R2 のライフサイクル**: アーカイブ 90 日、監査 365 日で削除（変数 `archive_retention_days` / `audit_retention_days`。1 以上の整数）。対象はバケット全体（prefix なし）。Cloudflare の API は秒で受けるので、日数 × 86400 を渡している。
- **AI Gateway**: 認証あり（BYOK の前提。agent と web は `AI` バインディングと `AI_GATEWAY_ID` だけで呼び、バインディングからの呼び出しは認証済みとして扱われるので、gateway token は要らない）、Require provider credentials（`byok_only`。BYOK のキーが無いときに Unified Billing〔Cloudflare のクレジット〕へ流さず、400 で止める）、ログ収集あり（`ai_gateway_collect_logs`。誰がいくら使ったかの集計に使う）、ログ分類なし（`ai_gateway_log_classification`。有効にすると User Insights のタスクとモデルの分析が出るが、Cloudflare が保存されたプロンプトと応答〔対象リポジトリのコードを含む〕を分類する。ログ収集が前提。Beta。User Insights は追加費用なしとされているが、ログ分類個別の料金は明記されていない）、キャッシュなし（TTL 0。モデルの応答を使い回さない）、レート制限なし（0 = 無効）。**web 専用の Gateway（`<name_prefix>-web-gateway`）を分ける理由**: Web Search API は、Gateway に provider のキーが無いとクレジットで払う。byok_only の Gateway では `web_search_byok_not_configured`（400）で断られ、`web_search` が必ず失敗する。そのため web 専用の Gateway だけ byok_only を付けない（ほかの設定は同じ。Claude 用の Gateway は byok_only のまま）。既存のデプロイは `terraform apply` で Gateway が増える（既存の Gateway は変わらない）。そのあと `mise run deploy:config` と web のデプロイで web の `AI_GATEWAY_ID` を切り替える。費用の上限は Gateway 側ではなく、gateway の `MONTHLY_BUDGET_USD` / `TASK_BUDGET_USD` が担う。費用の上限を Gateway 側にも持ちたい場合は、AI Gateway の画面で spend limits を足す。
- **Logpush のフィールド**: `Event`, `EventTimestampMs`, `Exceptions`, `Logs`, `Outcome`, `ScriptName`（監査行は `Logs` に入る。API がアルファベット順に並べ替えるので、その順で書く）。時刻は RFC 3339。宛先のパスは `workers_trace_events/{DATE}/`。
- **gateway の読み取り用トークン**: 権限は「AI Gateway Read」と「Account Analytics Read」（どちらも scope は `com.cloudflare.api.account`。読み取りだけ）。名前は `...-ai-gateway-read` のままだが、後者はダッシュボードの Cloudflare の概要（GraphQL Analytics API。M9）用に足した（名前を変えると再作成されて値が変わるので変えない）。権限グループは名前の完全一致で検索し、見つからなければ resource の precondition で plan が止まる。名前が変わったときは `ai_gateway_read_permission_group_id` / `account_analytics_read_permission_group_id` で ID を指定する。既存の環境は `terraform apply` で権限が in-place で増える（`plan` が `must be replaced` と出たときだけ、値が変わるので `--rotate cloudflare-token`）。resources はアカウント単位 `com.cloudflare.api.account.<account_id>` = `*`（実アカウントの権限グループの scope に合わせた形）。TTL は付けない（期限切れで BYOK の判定が黙って止まるのを避ける。ローテーションは `terraform apply -replace=cloudflare_api_token.ai_gateway_read` のあと `mise run deploy:secrets -- --rotate cloudflare-token`）。
- **Worker の名前**: `worker_names`（既定 `rovo-gateway` / `rovo-agent` / `rovo-web`）。各 wrangler 設定の `name` と一致させる。名前を変えたときは、この変数も変える（合わないと、そのログは送られない）。

## Cloudflare のドキュメントで確かめたこと

- R2 を宛先にした Logpush の `destination_conf` の形: `r2://<BUCKET_PATH>/{DATE}?account-id=<ACCOUNT_ID>&access-key-id=<R2_ACCESS_KEY_ID>&secret-access-key=<R2_SECRET_ACCESS_KEY>`。<https://developers.cloudflare.com/logs/logpush/logpush-job/enable-destinations/r2/>、<https://developers.cloudflare.com/workers/observability/logs/logpush/>（`workers_trace_events` の例）
- access-key-id は API トークンの `id`、secret-access-key はトークンの値（`value`）の SHA-256: <https://developers.cloudflare.com/r2/api/tokens/>（「Get S3 API credentials from an API token」）。Terraform の例（`sha256(cloudflare_api_token.….value)`）は <https://developers.cloudflare.com/logs/reference/change-notices/2023-02-01-security-fields-updates/>
- バケットを絞るトークンのリソース名: `com.cloudflare.edge.r2.bucket.<ACCOUNT_ID>_<JURISDICTION>_<BUCKET_NAME>`（jurisdiction を指定しないバケットは `default`）。権限グループ名は「Workers R2 Storage Bucket Item Write」（<https://developers.cloudflare.com/r2/api/tokens/>）
- filter の形: `{"where":{"key":"ScriptName","operator":"in","value":[...]}}`。`in` は文字列にも使える（<https://developers.cloudflare.com/logs/logpush/logpush-job/filters/>）
- **ownership challenge**: R2 のジョブ作成の例（API と Terraform）には `ownership_challenge` が無い。そのため `ownership_challenge` は設定していない。一般の API の説明（<https://developers.cloudflare.com/logs/logpush/logpush-job/api-configuration/>）には「ジョブを作る前に宛先の所有を証明する」とあるが、R2 のページはチャレンジを要求していない。実アカウントでの apply は行っていない（下の「確かめていないこと」）。
- AI Gateway の既定値とレート制限: <https://developers.cloudflare.com/ai-gateway/configuration/manage-gateway/>、<https://developers.cloudflare.com/ai-gateway/features/rate-limiting/>

## テスト

```sh
mise run test:infra    # terraform init -backend=false → terraform test（mock_provider。資格情報は要らない）
mise run infra:validate
mise run lint          # terraform fmt -check を含む
```

`infra/tests/rovo.tftest.hcl` が、gateway 用トークンの権限が AI Gateway Read と Account Analytics Read の 2 つ（読み取りだけ）でアカウント単位であること、権限グループが名前で見つからないとき plan が止まること、output が値と一致すること、Logpush の filter に 3 つの `ScriptName` が入ること、宛先が監査用バケットであること、ライフサイクルの日数が変数どおりであること、バケットが 2 つで別名であること、トークンの対象が監査用バケットだけであること、不正な変数（日数 0 など）が validation で拒否されることを確かめる。

- `destination_conf` は Logpush 用トークンの id と値に依存し、plan の段階では決まらない。そのテストだけ `mock_provider` に対する `apply` で確かめる（実アカウントには触れない）。
- provider の mock は「オブジェクトのリストの属性」に値を入れられず（Terraform 1.15.8 で確認）、権限グループの検索（`data.cloudflare_api_token_permission_groups_list`）を差し替えられない。そのため、テストでは変数 `r2_item_write_permission_group_id`・`ai_gateway_read_permission_group_id`・`account_analytics_read_permission_group_id` に ID を渡して検索を省く（検索結果が空のときに plan が止まることは、ID を null にして mock の空の結果に任せて確かめる）。**名前による検索で正しい ID が選ばれることは plan のテストで確かめていない。** 「Account Analytics Read」という名前は Cloudflare のドキュメントによる（実アカウントでの検索は未確認）。

## 実アカウントで確かめたこと（2026-10-20 の初回 apply）

- 権限グループ「Workers R2 Storage Bucket Item Write」は名前で見つかった（`r2_item_write_permission_group_id` の指定は要らなかった）。
- R2 を宛先にした Logpush のジョブは、ownership challenge なしで作れた。Logpush 用トークンの権限（監査用バケットへの書き込みだけ）と filter も受け付けられた。
- **初回の apply で、Logpush のジョブの作成が `error validating destination: ... status=401 Unauthorized` で失敗することがある。** Logpush 用トークンを作った直後で、まだ使えない状態のため。もう一度 `terraform plan` → `apply` すると通る（作り直しは要らない）。
- **wrangler は、バインディングに指定した R2 バケットが無いと、デプロイのときに自動で作る。** Terraform より先に `deploy:*` を実行していると、apply がバケットの作成で `409 ... already exists, and you own it` になる。空のバケットなら `terraform import cloudflare_r2_bucket.archive '<ACCOUNT_ID>/<接頭辞>-archive/default'`（監査用は `.audit` と `-audit`）で取り込む。
- Logpush の `field_names` は、API がアルファベット順に並べ替えて返す。順序を変えると、plan のたびに差分が出る（`infra/tests` の `logpush_field_names_are_sorted` が確かめる）。

## 確かめていないこと

- Logpush の ScriptName の値が、Worker の名前（wrangler 設定の `name`）と一致することは、実際のログで確かめる（deploy.md の 10 と acceptance.md の 16 節）。
- gateway 用トークン（`cloudflare_api_token.ai_gateway_read`）を実アカウントで `apply` したこと。権限グループ「AI Gateway Read」が名前で見つかることは確かめてあるが（scope は `com.cloudflare.api.account`）、Terraform 用トークンがこの権限を持つトークンを作れるか（トークンの作成には、付与する権限を自分も持っている必要があるかもしれない）は未確認。**【実機で確認して追記】**
