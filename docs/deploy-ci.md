# GitHub Actions からデプロイする（下流向け）

下流（private リポジトリ）を、ローカルの `mise run setup` / `deploy:*` ではなく GitHub Actions からデプロイするときの手順。全体の手順は [deploy.md](deploy.md) の 4、Terraform は [infra/README.md](../infra/README.md)。環境固有の値はすべてプレースホルダ（`<YOUR_...>`）で書く。

**印について**: 下流で実際に動かして確かめた内容を元に書いたが、この repository では実際の Cloudflare・GitHub Actions に対して流していない。確かめていないことには「**【未検証】**」と印を付けた。印の箇所は事実として扱わず、自分の環境で確かめる。

## 1. 構成

雛形は [`deploy.example/deploy.workflow.yml`](../deploy.example/deploy.workflow.yml)。下流の `.github/workflows/deploy.yml` にコピーして使う。

| イベント | ジョブ | 内容 |
|---|---|---|
| Pull request | `plan` | `terraform plan`（適用しない）と `mise run deploy:config:check` |
| main への push | `apply` | `terraform apply` |
| 同上 | `deploy`（`apply` のあと） | `deploy:config:check` → web → agent → gateway の順にデプロイ → `mise run deploy:secrets -- --skip-github-app` |

- `deploy:*` は `deploy/` の生成物（コミット済み）を使い、Terraform を読まない（deploy.md の 4「生成物はコミットする」）。例外は `deploy:secrets` で、gateway の secret `CLOUDFLARE_API_TOKEN` をまだ入れていないときだけ state を読む（infra/README.md の「state を読むタスクと必要な env」）。
- GitHub App は CI では作らない。手元で `mise run github-app`（または `setup`）で作る。だから `deploy:secrets` は `--skip-github-app` を付ける。
- agent のイメージのビルドに Docker が要る。`ubuntu-latest` のランナーには入っている。
- 雛形の action は、upstream の `.github/workflows/ci.yml` と同じ commit SHA で固定している（タグではなく SHA。更新するときは ci.yml に合わせる）。checkout には `persist-credentials: false` を付け、`permissions` は `contents: read` だけにしている（ジョブごとにも明示）。

## 2. トークンは 3 種類に分ける

| 用途 | 使うジョブ | 渡し方 | 権限 |
|---|---|---|---|
| **Terraform 用** | `plan`・`apply` | env `CLOUDFLARE_API_TOKEN` | infra/README.md の「使い方」の 1（R2・Workers KV・AI Gateway の編集、Logs の編集、API トークンの編集） |
| **デプロイ用**（wrangler） | `deploy` | env `CLOUDFLARE_API_TOKEN` | 下の表 |
| **state 用**（R2） | 全ジョブ | env `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | state のバケットへの読み書き。R2 の API トークン（S3 互換のキー）で、state のバケットだけに絞る |

デプロイ用のトークンの権限。下流で実際に通ったのは、次のとおり。

- 「Edit Cloudflare Workers」テンプレート
- Containers（Edit）
- Cloudchamber（Edit）
- Zone DNS（Edit）

**【未検証】** このうち Cloudchamber と Zone DNS が本当に必要かは確かめていない。Containers は agent のコンテナのデプロイ、Zone DNS は独自ドメイン（`customDomain`）のときに wrangler が DNS レコードを作るために要ると考えられるが、権限を 1 つずつ外して確かめてはいない。最小にしたいときは、足した権限を 1 つずつ外してデプロイが通るか確かめる。

state 用のキーは、Terraform を使うジョブだけでなく、`deploy` ジョブにも渡す（`terraform init` と `deploy:secrets` が state を読むため）。`deploy:*`（`deploy:secrets` 以外）には要らない。

## 3. env の名前の衝突（`CLOUDFLARE_API_TOKEN`）

Terraform 用とデプロイ用のトークンは、どちらも env の `CLOUDFLARE_API_TOKEN` という同じ名前で渡す（Terraform の provider も wrangler もこの名前を読む）。取り違えると、権限が足りずに失敗する。

- **ジョブ全体の `env:` には置かない。** 使うステップの `env:` だけに渡す。
- Terraform 用は `plan` / `apply` のジョブ、デプロイ用は `deploy` のジョブに分ける（雛形のとおり）。`deploy` のジョブには Terraform 用のトークンを渡さない。
- 同じジョブで両方を使う必要が出たら、ステップごとに別の secret を `CLOUDFLARE_API_TOKEN` に割り当てる。

## 4. Actions secret の名前の例

| secret | 中身 |
|---|---|
| `CLOUDFLARE_API_TOKEN_TERRAFORM` | Terraform 用のトークン |
| `CLOUDFLARE_API_TOKEN_DEPLOY` | デプロイ用（wrangler）のトークン |
| `R2_STATE_ACCESS_KEY_ID` | state 用の R2 のアクセスキー ID |
| `R2_STATE_SECRET_ACCESS_KEY` | 同じく secret |

名前は例で、変えてよい（雛形の `secrets.<名前>` も合わせる）。値は、リポジトリの Settings の Secrets and variables → Actions に登録する。複数のアカウントに権限があるトークンを使うときは、env `CLOUDFLARE_ACCOUNT_ID` も要るかもしれない（**【未検証】**。雛形ではコメントアウトしてある）。

## 5. 初回の流れ（2 回に分けてコミットする）

`deploy/` は Terraform の出力（`kv_namespace_id` など）に依存するので、リソースを作ってから生成する。2 回に分ける。

1. **1 回目のコミット**: `infra/backend.tf`（infra/README.md の R2 の例）、`rovo.config.json`、ワークフロー。`deploy/` はまだ無い。PR で `plan` を確かめてから main に入れると（この PR の `plan` は `deploy/infra.json` が無いので `deploy:config:check` を飛ばす）、`apply` が通ってリソースができる。**この push の `deploy` ジョブは `deploy:config:check` で止まる**（`deploy/infra.json` が無いため。想定どおり）。
2. **`deploy/` を作る**: 手元で state の資格情報（`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`）と Terraform 用のトークンを env に入れ、`terraform -chdir=infra init -input=false` のあとに `mise run deploy:config` を実行する（infra/README.md の「state を読むタスクと必要な env」）。
3. **2 回目のコミット**: できた `deploy/` をコミットして main に入れる。`deploy` ジョブが web → agent → gateway → secret と流れる。
4. GitHub App は手元で作る（`mise run github-app`。deploy.md の 4）。BYOK は `mise run byok -- anthropic`（Cloudflare のトークンが要る手元の作業。同じ deploy.md の 4）。

その後は、`rovo.config.json` や `deploy.example/` が変わるたびに `mise run deploy:config -- --no-terraform` で作り直してコミットする（`deploy:config:check` が差分を検出する）。

## 6. 既知のつまずき

- **Logpush の 401**: 初回の `apply` で、Logpush のジョブの作成が `401 Unauthorized` で失敗することがある（Logpush 用のトークンを作った直後のため。deploy.md の 4）。ジョブを再実行すると通る。
- **wrangler のアセットのアップロード**: まれに一時的な `unknown error` で失敗することがある。再実行で通る（下流で観測した。原因は調べていない）。

## 7. BYOK をダッシュボードで登録するとき

AI Gateway の画面（ダッシュボード）から BYOK のキーを登録すると、`default_config` が `false` になる。rovo は alias が `default` のキーだけを見る（`default_config` は見ない）ので、問題なく動く。`false` になっていても、登録し直さなくてよい。`mise run byok` で登録したキーも alias は `default`（deploy.md の 4「BYOK を CLI で登録する」）。

## 8. MCP Portal に登録したあとの注意

Portal と Access の登録は rovo の範囲外（deploy.md の 1・8）。登録したあとに、次のことが起きうる。

- **Code mode がオンになり、全サーバーのツールが見えなくなる**ことがある。Portal の設定で Code mode を確かめる。
- **ツールの定義が変わったら、Portal で再同期が要る**。rovo の更新でツールの名前・引数が変わったとき、デプロイしただけでは Portal の一覧に反映されない。

どちらも下流で観測したことで、Portal 側の仕様は確かめていない（**【未検証】**）。

## 9. 設定の変更が反映されるまでの遅延

`MONTHLY_BUDGET_USD` などの設定値を変えて再デプロイしても、既存の UserDO（Durable Object）は古いバージョンのまま応答し続けることがある。下流で確かめたときは、新しい値に切り替わるまで約 10 分かかった（1 回の観測。一定とは限らない）。変えた直後の `budget_status` は古い値を返しうる。反映を確かめるときは、時間を置いてからもう一度読む。

## 10. 未検証のまとめ

- デプロイ用トークンの Cloudchamber と Zone DNS の権限が必要か（2）
- 複数アカウントのトークンで `CLOUDFLARE_ACCOUNT_ID` が要るか（4）
- 雛形のワークフロー全体は、この repository では実際の GitHub Actions で流していない。action の SHA と、`mise run` の各タスクの呼び方は、upstream の `ci.yml` と `scripts/` の実装に合わせた
- MCP Portal の挙動（8）
- R2 の `backend.tf` の例（infra/README.md）
