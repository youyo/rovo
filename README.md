# rovo

Claude Code / Cowork から Remote MCP 経由でコーディングタスクを委譲するための Task Gateway（Cloudflare Workers）。
設計は [docs/specs/design.md](docs/specs/design.md)、Phase 1 の実装計画は [docs/specs/phase1.md](docs/specs/phase1.md)、手動の受入試験は [docs/specs/acceptance.md](docs/specs/acceptance.md)。

## 現状（Phase 2: Gateway と子エージェントの統合）

GitHub App のユーザー認可でログインし、`/mcp` から次の 5 つのツールを使える。

| ツール | 内容 |
|---|---|
| `task_start` | タスクを作り、子エージェント（`apps/agent` の AgentDO）を起動する。`{task_id, status, draft_pr_url, note}`。`verification_commands`（任意）を渡すと、完了の申告後に Sandbox で実行される |
| `task_status` | 状態を返す |
| `task_wait` | 新しいイベントを最大 `timeout_seconds`（既定 30・上限 60）待つ（long polling）。待機中に子エージェントのイベントを取り込む |
| `task_result` | 終端になったタスクの成果（要約・検証結果・patch・費用）を返す。終端でなければ `not_ready` |
| `task_cancel` | キャンセルする（終端状態でも冪等）。子エージェントの停止を確認するまで Gateway が再送する |

**制約（ツールの応答にも明記している）**

- push と Draft PR は作られない（`draft_pr_url` は常に `null`）。成果は patch として `task_result` で返る。
- `idempotency_key` を省略すると、再試行の重複排除は保証されない。
- 利用者ごとの同時実行は 1 件まで。前のタスクの停止を確認できるまで、次のタスクは始められない。
- 1 タスクにつき $10 を月額の枠（env `MONTHLY_BUDGET_USD`、既定 100）から予約する。足りなければ `budget_exceeded`。

## 構成

- `apps/gateway`: Cloudflare Worker。Hono でルーティングし、`@cloudflare/workers-oauth-provider` で全体を包む。
  - `/mcp`（要 OAuth）: `agents/mcp/server` の `createMcpHandler` + `@modelcontextprotocol/server`。リクエストごとに McpServer を作り、ユーザー情報は共有しない
  - `/authorize`（同意画面）→ GitHub App のユーザー認可 → `/callback`: defaultHandler。state（1 回限り・10 分）と、開始したブラウザへの Cookie 紐付けは OAuthProvider の `beginUpstream` / `finishUpstream` を使う
  - `UserDO`（ユーザーごと）: GitHub 資格（AES-GCM で暗号化）、team 所属のキャッシュ（TTL 5 分）、同時実行の予約、月額予算（タスクごとの予約・usage の冪等な精算・終了時の返却）。GitHub のトークンは DO の外へ返さない
  - `TaskDO`（タスクごと）: 状態とイベント。AgentDO への start / cancel の配送、イベントの取り込み、usage の精算を alarm で収束させる
- `apps/agent`（Phase 2 の土台。M1 スパイク段階）: 子エージェントの別 Worker。`SandboxDO`（`ctx.container` を `enableInternet:false` で起動し、外向き通信を `OutboundGateway` に傍受させる）、`OutboundGateway`（許可判定は `src/outbound-policy.ts` の純粋関数）、`AgentDO`（`PiHarness` と台本付き fake モデルでの最小実装）。Gateway からは `script_name` 付きの DO バインディング `AGENT_DO` で呼ぶ

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
| `mise run test:unit` | gateway と agent の Unit。vitest + `@cloudflare/vitest-plugin`（workerd 上で実行）。個別は `test:unit:gateway` / `test:unit:agent`。agent の Unit ではコンテナが使えないので、`SandboxPort` を fake にする |
| `mise run test:fake-github` | 偽 GitHub サーバーと GitHub クライアントの結合テスト（Node） |
| `mise run test:e2e` | `test:e2e:gateway` + `test:e2e:docker` |
| `mise run test:e2e:gateway` | `wrangler dev` で実 Worker と偽 GitHub を起動し、MCP SDK の Client から DCR → `/authorize` → 偽 GitHub → `/callback` → token(PKCE) → 4 つのツールまで通す |
| `mise run test:e2e:docker` | **Docker 必須**。`wrangler dev` で実コンテナを起動し、ローカルの偽サーバー（偽 GitHub の git smart HTTP と偽 npm レジストリ）を許可先にして、外向き通信の許可・拒否（非許可ホスト、push、内部 IP、非 80/443 ポート、IPv6、CONNECT、WebSocket、リダイレクト、ヘッダ除去、再起動後の傍受）と `npm install` / `git clone`、Gateway → Agent の DO RPC（`-c gateway -c agent` の同時起動）を検証する |
| `mise run test:e2e:net` | **Docker 必須・実ネットワーク**。上の E2E の実ネットワーク版（実 registry.npmjs.org、`octocat/Hello-World` の匿名 clone）。CI で不安定になりうるため `test` には含めない。認証付きアクセスや push はしない |
| `mise run lint` / `mise run fmt` | Biome の lint / 整形、`tsc` の型検査 |
| `mise run typegen` | `wrangler.jsonc` を変えたら実行して両アプリの `worker-configuration.d.ts` を更新する |
| `mise run dev:all` | gateway と agent を同時にローカル起動する（Docker 必須）。`AGENT_DO` は `script_name` 付きなので、片方だけ起動すると本番の DO を参照してしまう（wrangler の known issue）。必ず両方を同時に起動する。`wrangler login` やデプロイは不要 |
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
