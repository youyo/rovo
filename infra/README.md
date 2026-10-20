# infra: rovo の Cloudflare リソース（Terraform）

rovo を自分のアカウントにデプロイするときに必要な Cloudflare のリソースを作る。誰が clone しても、変数を渡せば使える。全体の手順は [docs/deploy.md](../docs/deploy.md) の 4（手順の順番）。

## 作るもの

| リソース | 用途 | 対応する設定 |
|---|---|---|
| R2 バケット `<name_prefix>-archive` と、日数で削除するライフサイクル | タスクのアーカイブ（deploy.md の 9） | gateway の `r2_buckets`（`LOGS`） |
| R2 バケット `<name_prefix>-audit` と、日数で削除するライフサイクル | 監査ログの Logpush の宛先（deploy.md の 10） | wrangler 設定には書かない |
| KV namespace `<name_prefix>-oauth` | gateway の OAuth の状態 | gateway の `kv_namespaces`（`OAUTH_KV`） |
| AI Gateway `<name_prefix>-gateway` | agent と web の Claude / Web Search 呼び出し（deploy.md の 7） | agent と web の `AI_GATEWAY_ID` |
| API トークン（Logpush 用） | 権限は「Workers R2 Storage Bucket Item Write」だけ。対象は監査用バケットだけ | Logpush の宛先の資格情報 |
| Logpush ジョブ | データセット `workers_trace_events` を監査用バケットへ送る。**filter で `ScriptName` を rovo の 3 つの Worker だけに絞る** | 各 Worker に `"logpush": true` |

作らないもの: MCP Server Portal と Access の登録（別のインフラの管理側）、Anthropic の API キー（AI Gateway の画面で BYOK として登録する。Terraform に入れない）、Worker 本体（`mise run deploy:*`）、Worker の secret（`mise run deploy:secrets`）。

## 使い方

1. 認証は env の `CLOUDFLARE_API_TOKEN` から読む（provider の設定は `provider "cloudflare" {}` だけ）。このトークンには、R2・Workers KV・AI Gateway の編集、Logs の編集（Logpush）、API トークンの編集（Logpush 用トークンを作るため）の権限が要る。
2. `terraform.tfvars.example` をコピーして、`account_id` などを書く。
3. **state の置き場所（backend）を決める。** この `infra/` には `backend` ブロックが無い。`infra/backend.tf` を足して決める（例: S3 互換の R2、Terraform Cloud）。決めないと state はローカルの `terraform.tfstate` に置かれる。
4. `terraform init` → `terraform plan` → `terraform apply`（`infra/` で実行）。
5. `terraform output` の値を、下流の wrangler 設定（`deploy.example/` の雛形）に書き写す。

| output | 書き写す先 |
|---|---|
| `kv_namespace_id` | gateway の `kv_namespaces[].id` |
| `archive_bucket_name` | gateway の `r2_buckets[].bucket_name` |
| `ai_gateway_id` | agent と web の `vars.AI_GATEWAY_ID` |
| `audit_bucket_name` | wrangler 設定には書かない（Logpush の宛先。確認用） |

6. AI Gateway の画面で、Anthropic の API キーを BYOK として登録する。

## state は非公開の場所に置く

**Logpush の宛先（`destination_conf`）には、R2 の S3 互換の鍵が含まれる。** access-key-id は Logpush 用トークンの id、secret-access-key はそのトークンの値の SHA-256。トークンの値（`cloudflare_api_token.logpush.value`）とあわせて、**state に平文で残る**。state は非公開の場所に置き、リポジトリにコミットしない。upstream の `.gitignore` は `infra/.terraform/` と `infra/*.tfstate*` を除外している。

## 下流のファイルの置き方

下流（private リポジトリ）は、rovo を upstream として merge し、`infra/` の中に**新しいファイルを足す**だけで使う。upstream のファイルは書き換えない。

- `infra/backend.tf`（state の置き場所）と tfvars（`infra/terraform.tfvars` など）は、upstream の `.gitignore` では除外していない。下流で通常どおり `git add` してコミットできる（`git add -f` は要らない）。tfvars に秘密は無い（account id は秘密ではないが、公開しないほうがよいので、rovo の公開リポジトリには絶対にコミットしない。誤ってコミットすると `mise run scan:secrets` が検出する）。
- `.terraform.lock.hcl` は upstream がコミットしている（provider を `5.27.0` に固定し、4 つのプラットフォームのハッシュを入れてある）。provider の版を上げるときは、`terraform init -upgrade` と `terraform providers lock -platform=darwin_arm64 -platform=darwin_amd64 -platform=linux_amd64 -platform=linux_arm64` を実行して更新する。

## 既定の設定と理由

- **R2 のライフサイクル**: アーカイブ 90 日、監査 365 日で削除（変数 `archive_retention_days` / `audit_retention_days`。1 以上の整数）。対象はバケット全体（prefix なし）。Cloudflare の API は秒で受けるので、日数 × 86400 を渡している。
- **AI Gateway**: 認証あり（BYOK の前提。agent と web は `AI` バインディングと `AI_GATEWAY_ID` だけで呼び、バインディングからの呼び出しは認証済みとして扱われるので、gateway token は要らない）、Require provider credentials（`byok_only`。BYOK のキーが無いときに Unified Billing〔Cloudflare のクレジット〕へ流さず、400 で止める）、ログ収集あり（`ai_gateway_collect_logs`。誰がいくら使ったかの集計に使う）、キャッシュなし（TTL 0。モデルの応答を使い回さない）、レート制限なし（0 = 無効）。費用の上限は Gateway 側ではなく、gateway の `MONTHLY_BUDGET_USD` / `TASK_BUDGET_USD` が担う。費用の上限を Gateway 側にも持ちたい場合は、AI Gateway の画面で spend limits を足す。
- **Logpush のフィールド**: `Event`, `EventTimestampMs`, `Exceptions`, `Logs`, `Outcome`, `ScriptName`（監査行は `Logs` に入る。API がアルファベット順に並べ替えるので、その順で書く）。時刻は RFC 3339。宛先のパスは `workers_trace_events/{DATE}/`。
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

`infra/tests/rovo.tftest.hcl` が、Logpush の filter に 3 つの `ScriptName` が入ること、宛先が監査用バケットであること、ライフサイクルの日数が変数どおりであること、バケットが 2 つで別名であること、トークンの対象が監査用バケットだけであること、不正な変数（日数 0 など）が validation で拒否されることを確かめる。

- `destination_conf` は Logpush 用トークンの id と値に依存し、plan の段階では決まらない。そのテストだけ `mock_provider` に対する `apply` で確かめる（実アカウントには触れない）。
- provider の mock は「オブジェクトのリストの属性」に値を入れられず（Terraform 1.15.8 で確認）、権限グループの検索（`data.cloudflare_api_token_permission_groups_list`）を差し替えられない。そのため、テストでは変数 `r2_item_write_permission_group_id` に ID を渡して検索を省く。**名前による検索そのものは plan のテストで確かめていない。**

## 実アカウントで確かめたこと（2026-10-20 の初回 apply）

- 権限グループ「Workers R2 Storage Bucket Item Write」は名前で見つかった（`r2_item_write_permission_group_id` の指定は要らなかった）。
- R2 を宛先にした Logpush のジョブは、ownership challenge なしで作れた。Logpush 用トークンの権限（監査用バケットへの書き込みだけ）と filter も受け付けられた。
- **初回の apply で、Logpush のジョブの作成が `error validating destination: ... status=401 Unauthorized` で失敗することがある。** Logpush 用トークンを作った直後で、まだ使えない状態のため。もう一度 `terraform plan` → `apply` すると通る（作り直しは要らない）。
- **wrangler は、バインディングに指定した R2 バケットが無いと、デプロイのときに自動で作る。** Terraform より先に `deploy:*` を実行していると、apply がバケットの作成で `409 ... already exists, and you own it` になる。空のバケットなら `terraform import cloudflare_r2_bucket.archive '<ACCOUNT_ID>/<接頭辞>-archive/default'`（監査用は `.audit` と `-audit`）で取り込む。
- Logpush の `field_names` は、API がアルファベット順に並べ替えて返す。順序を変えると、plan のたびに差分が出る（`infra/tests` の `logpush_field_names_are_sorted` が確かめる）。

## 確かめていないこと

- Logpush の ScriptName の値が、Worker の名前（wrangler 設定の `name`）と一致することは、実際のログで確かめる（deploy.md の 10 と acceptance.md の 16 節）。
