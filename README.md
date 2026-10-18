# rovo

Claude Code / Cowork から Remote MCP 経由でコーディングタスクを委譲するための Task Gateway（Cloudflare Workers）。
設計は [docs/specs/design.md](docs/specs/design.md)、Phase 1 の実装計画は [docs/specs/phase1.md](docs/specs/phase1.md)。

現状は Phase 1 のマイルストーン M1（開発基盤と MCP 疎通のスパイク）まで。`/mcp` にはダミーツール `ping` だけがある。

## 構成

- `apps/gateway`: Cloudflare Worker。Hono でルーティングし、`@cloudflare/workers-oauth-provider` で全体を包む。
  - `/mcp`（要 OAuth）: `agents/mcp/server` の `createMcpHandler` + `@modelcontextprotocol/server`
  - `/authorize` ほか: defaultHandler（M1 では `ENVIRONMENT=test` のときだけ使える E2E 用スタブ。本番は 501）

## 開発手順

ランタイム（node / pnpm）は [mise](https://mise.jdx.dev/) で固定している。コマンドはすべて `mise run` 経由で実行する。

```sh
mise install          # node / pnpm を入れる
mise run install      # 依存パッケージ（pnpm install --frozen-lockfile）
mise run test         # Unit + E2E
mise run lint         # Biome + 型検査
```

| タスク | 内容 |
|---|---|
| `mise run test:unit` | vitest + `@cloudflare/vitest-plugin`（workerd 上で実行） |
| `mise run test:e2e` | `wrangler dev` で実 Worker を起動し、MCP SDK の Client（Streamable HTTP）から DCR → authorize → token(PKCE) → `ping` まで通す |
| `mise run lint` / `mise run fmt` | Biome の lint / 整形、`tsc` の型検査 |
| `mise run typegen` | `wrangler.jsonc` を変えたら実行して `worker-configuration.d.ts` を更新する |
| `mise run build` | Worker のバンドル確認（`--dry-run`。デプロイはしない） |
| `mise run dev` | `ENVIRONMENT=test` でローカル起動（`http://localhost:8787`） |

E2E が失敗したときは `E2E_DEBUG=1 mise run test:e2e` で `wrangler dev` の出力も表示される。

## 設定

| 変数 | 内容 |
|---|---|
| `ENVIRONMENT` | `production`（既定）。`test` のときだけ E2E 用スタブの `/authorize` が有効になる。**本番で `test` にしないこと** |
| `PUBLIC_BASE_URL` | 公開 URL。OAuth の issuer と `/mcp` の resource になる。本番は `https`、ローカルのみ loopback の `http` が許される |
