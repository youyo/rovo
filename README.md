# rovo

Claude Code / Cowork から Remote MCP 経由でコーディングタスクを委譲するための Task Gateway（Cloudflare Workers）。
設計は [docs/specs/design.md](docs/specs/design.md)、Phase 1 の実装計画は [docs/specs/phase1.md](docs/specs/phase1.md)、手動の受入試験は [docs/specs/acceptance.md](docs/specs/acceptance.md)。

## 現状（Phase 1）

GitHub App のユーザー認可でログインし、`/mcp` から次の 4 つのツールを使える。

| ツール | 内容 |
|---|---|
| `task_start` | タスクを作る。`{task_id, status, draft_pr_url, note}` |
| `task_status` | 状態を返す |
| `task_wait` | 新しいイベントを最大 `timeout_seconds`（既定 30・上限 60）待つ（long polling） |
| `task_cancel` | キャンセルする（終端状態でも冪等） |

**Phase 1 の制約（ツールの応答にも明記している）**

- 子エージェントが未実装のため、`task_start` で作ったタスクは **`CREATING` のまま進まない**。
- Draft PR は作られない（`draft_pr_url` は常に `null`）。
- `idempotency_key` を省略すると、再試行の重複排除は保証されない。
- 利用者ごとの同時実行は 1 件まで。

## 構成

- `apps/gateway`: Cloudflare Worker。Hono でルーティングし、`@cloudflare/workers-oauth-provider` で全体を包む。
  - `/mcp`（要 OAuth）: `agents/mcp/server` の `createMcpHandler` + `@modelcontextprotocol/server`。リクエストごとに McpServer を作り、ユーザー情報は共有しない
  - `/authorize` → GitHub App のユーザー認可 → `/callback`: defaultHandler。state（1 回限り・10 分）と、開始したブラウザへの Cookie 紐付けは OAuthProvider の `beginUpstream` / `finishUpstream` を使う
  - `UserDO`（ユーザーごと）: GitHub 資格（AES-GCM で暗号化）、team 所属のキャッシュ（TTL 5 分）、同時実行の予約。GitHub のトークンは DO の外へ返さない
  - `TaskDO`（タスクごと）: 状態とイベント

## 開発手順

ランタイム（node / pnpm）は [mise](https://mise.jdx.dev/) で固定している。コマンドはすべて `mise run` 経由で実行する。

```sh
mise install          # node / pnpm を入れる
mise run install      # 依存パッケージ（pnpm install --frozen-lockfile）
mise run test         # Unit + 偽 GitHub + E2E
mise run lint         # Biome + 型検査
```

| タスク | 内容 |
|---|---|
| `mise run test:unit` | vitest + `@cloudflare/vitest-plugin`（workerd 上で実行） |
| `mise run test:fake-github` | 偽 GitHub サーバーと GitHub クライアントの結合テスト（Node） |
| `mise run test:e2e` | `wrangler dev` で実 Worker と偽 GitHub を起動し、MCP SDK の Client から DCR → `/authorize` → 偽 GitHub → `/callback` → token(PKCE) → 4 つのツールまで通す |
| `mise run lint` / `mise run fmt` | Biome の lint / 整形、`tsc` の型検査 |
| `mise run typegen` | `wrangler.jsonc` を変えたら実行して `worker-configuration.d.ts` を更新する |
| `mise run build` | Worker のバンドル確認（`--dry-run`。デプロイはしない） |
| `mise run dev` | ローカル起動（`http://localhost:8787`）。`apps/gateway/.dev.vars` を読む |

E2E が失敗したときは `E2E_DEBUG=1 mise run test:e2e` で `wrangler dev` の出力も表示される。E2E は GitHub に接続しない（偽 GitHub を使う）。

## 設定

### 変数（`wrangler.jsonc` の `vars`、またはローカルは `.dev.vars`）

| 変数 | 内容 |
|---|---|
| `ENVIRONMENT` | `production`（既定）。`test` のときだけ `GITHUB_OAUTH_BASE` / `GITHUB_API_BASE` の上書きを許す。**本番で `test` にしないこと**（本番で上書きを指定すると起動時に拒否される） |
| `PUBLIC_BASE_URL` | 公開 URL。OAuth の issuer と `/mcp` の resource、GitHub のコールバック URL（`<PUBLIC_BASE_URL>/callback`）になる。本番は `https`、ローカルのみ loopback の `http` が許される |
| `GITHUB_APP_CLIENT_ID` | GitHub App の Client ID（秘密ではない） |
| `ALLOWED_ORG` / `ALLOWED_TEAM` | ログインと全ツール呼び出しを許す org と team の slug。子 team のメンバーも許可される。空だとログインできない（fail closed） |

### Secret（`wrangler secret put <NAME>`、ローカルは `.dev.vars`）

| Secret | 内容 |
|---|---|
| `GITHUB_APP_CLIENT_SECRET` | GitHub App の Client secret |
| `TOKEN_ENC_KEY` | GitHub のトークンを UserDO に暗号化して保存する鍵。base64 の 32 バイト（`openssl rand -base64 32`）。変えると保存済みの資格は復号できなくなり、全員が再ログインになる |

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
`not_found` / `conflict` / `expired` / `concurrency_limit` / `invalid_cursor` / `forbidden` / `reauth_required` / `upstream_unavailable` / `invalid_input` / `internal`。
`reauth_required` は GitHub 資格を回復できないとき（MCP のトークンが有効でも）で、再ログインが必要。`internal` は想定外の失敗で、詳細は応答に含めない。
