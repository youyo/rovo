# Phase 2 実装計画: Pi Durable / Coding Sandbox

設計書 `design.md` の Phase 2（12章）を具体化したもの。2026-10-18 の技術調査と advisor の助言を反映している。

## design.md からの変更点（後で 15 章へ反映する）

| 箇所 | 変更 |
|---|---|
| 6.4 Credential Helper | **廃止**。Sandbox DO の外向き傍受（Git Gateway entrypoint）が GitHub への認証ヘッダを注入する。トークンはコンテナに入れない。Phase 2 は `git-upload-pack`（fetch/clone）だけを許可し、push は Phase 3 で入れる |
| 7.2 外向き通信 | `enableInternet:false` と `interceptOutboundHttps` / `interceptOutboundHttp` による allowlist で強制する（後述） |
| 7.4 argv 規則 | Gateway 側（利用者の入力からコマンドを組み立てる箇所）には argv 実行を適用する。子エージェントの bash ツールはモデルが書くシェル文字列なので、`["bash","-lc",cmd]` で実行することを許す。理由: コンテナそのものが信頼境界で、資格情報を持たず、外向き通信は境界で制限されているため |
| 15.1 Sandbox | `@cloudflare/sandbox` 1.0.1 は 0.x と別物で、`getSandbox` / `exec` を持たない。`SandboxDO` を自作する（`ctx.container` + `Files`）。ツールは Pi の `defineTool` で自作し、`CodingTools` は使わない |
| 15.2 Claude | `createAI({binding: env.AI, id: <gateway id>, metadata: {userId, taskId}})`。モデル ID はハイフン形式（例: `anthropic/claude-sonnet-5-5`。実機で確認済み） |
| 構成 | 子エージェントは別 Worker `apps/agent` に置く。Gateway からは `script_name` 付きの DO バインディングで呼ぶ |
| Phase 3 の範囲 | GitHub App 認証は Phase 1 で済んだ。Phase 3 は Installation Token Broker、Git Gateway の push 許可（`agent/task-*` ブランチのみ）、Draft PR の作成・更新とする |

## ゴール

`task_start` → `RUNNING` → Sandbox で編集・テスト・ローカル commit → `VERIFYING` → `COMPLETED` / `FAILED`、の流れが動く。

- push と Draft PR は作らない（Phase 3）。
- 親への質問（`INPUT_REQUIRED`）は作らない（Phase 4）。

## 構成

```
apps/gateway (既存 Worker)
  TaskDO ──RPC(script_name binding)──▶ apps/agent: AgentDO (1 task = 1 instance)
                                           │  PiHarness (Pi Durable) + 自作ツール
                                           │  createAI → env.AI → AI Gateway (BYOK) → Anthropic
                                           ▼ RPC
                                        SandboxDO (1 task = 1 instance)
                                           │ ctx.container (enableInternet:false)
                                           │ interceptOutbound* → OutboundGateway (WorkerEntrypoint)
                                           ▼
                                        Container: node / git / ripgrep, /workspace
```

- RPC は「Gateway → Agent → Sandbox」の一方向だけにする。逆向きのバインディングは作らない（循環を避ける）。
- 名前（DO の ID）は、認証済みの task_id から導く。利用者の入力から直接作らない。
- `apps/agent` は新しい Worker なので、Sandbox の公式例にある `exports` 形式の設定を最初から使える。Gateway の `migrations` 形式との共存問題を踏まない。

### パッケージ

- `agents@0.28.1`（PiHarness を同梱）
- `@earendil-works/pi-durable@1.3.0`、`@earendil-works/pi-ai@1.3.0`（beta なので完全に固定する）
- `@cloudflare/sandbox@1.0.1` と、Docker イメージ `cloudflare/sandbox:1.0.1`（タグをそろえる）
- Pi への依存は `apps/agent/src/pi/` のアダプタ層に閉じ込める（15.1）。

## AgentDO（子エージェント）

- `Lifecycle.install(this).use(piHarness)`。復旧は PiHarness の heartbeat（30秒）と checkpoint に任せる。
- モデル
  - 既定は `anthropic/claude-sonnet-5-5`。env で変更できる。
  - `createAI` の `metadata` に userId と taskId を入れ、AI Gateway のログで突き合わせられるようにする。
- 起動
  - Gateway から `start(taskSpec)` を呼ぶ。`operationId` は taskId から導いて、Gateway が再試行しても二重に submit しないようにする。
  - taskSpec には、repository / base_sha / instructions / acceptance_criteria / constraints / 予算 / userId を入れる。
- システムプロンプト（sections）
  - 受け入れ条件、制約、作業手順（調査 → 実装 → テスト → commit → 完了報告）
  - 外部コンテンツを信用しないこと、push や PR はしないこと
- イベント
  - Pi の `events()` を購読し、要約したイベント（状態変化、ツール呼び出しの要約、エラー、完了報告）を AgentDO 自身の SQLite に seq 付きで永続化する。
  - Gateway の TaskDO は `getEvents(afterSeq)` で引き、自分の seq に写して `task_wait` に流す。Phase 1 の `task_wait` の約束は変えない。
- 状態の報告
  - AgentDO は `phase`（`running` / `verifying` / `completed` / `failed` / `budget_exceeded` / `cancelled`）を持ち、`getEvents` の応答に含める。
  - Gateway の TaskDO は、それを状態遷移表に従って反映する。
- 予算
  - Pi に予算の機能はない。ターン後と `beforeTool` フックで `pi().usage()` を読み、モデル別の単価で費用を計算する。$10/Task を超えたら `abort` して `budget_exceeded` にする。
  - 費用は Gateway の UserDO の月額上限（phase1.md で「Phase 2 で入れる」としたもの）にも計上する。UserDO の月額上限を超えていたら `task_start` を拒否する。
- キャンセル
  - Gateway の `task_cancel` が AgentDO の `cancel()` を呼ぶ。AgentDO は `abort` し、SandboxDO の実行中プロセスを止める。
  - Gateway 側は、TaskDO を `CANCELLED` に確定させてから AgentDO を呼ぶ（Phase 1 の順序を守る）。
- 完了判定
  - モデルが `report_completion({summary, tests})` ツールを呼んだら `verifying` にする。
  - AgentDO は、受け入れ条件に書かれたテストコマンドを Sandbox で再実行して確かめる（モデルの自己申告だけで完了にしない）。
  - 合格なら `completed`、不合格なら差し戻して修正させる（自動修正は最大3回、7.3）。3回目も不合格なら `failed`。

## ツール（`defineTool` で自作）

| ツール | replay | 内容 |
|---|---|---|
| `read_file` | safe | `/workspace` 配下のファイルを読む。サイズ上限と行範囲あり |
| `list_files` | safe | ディレクトリ一覧（深さと件数に上限） |
| `search` | safe | ripgrep（argv 実行） |
| `write_file` | safe | 全文の書き込み（同じ内容なら冪等） |
| `edit_file` | unsafe | 一意な文字列の置換。厳密には冪等でないので、既定の unsafe のままにする |
| `bash` | unsafe | `["bash","-lc",cmd]`。タイムアウト（既定10分、上限30分）、出力上限（末尾 64KiB）、資格情報らしき文字列のマスク |
| `git_commit` | unsafe | `git add -A && git commit`（argv）。作者は bot 名 |
| `report_completion` | unsafe | 完了の申告 |

- パスはすべて `/workspace` 配下に正規化し、外に出るもの（`..` やシンボリックリンク経由）は拒否する。
- ツールの結果に含まれる外部由来の文字列は、信用しないデータとして扱う（プロンプトの section で明示）。

## SandboxDO

- `ctx.container.start({enableInternet: false})`。インスタンスタイプは `standard-1`。
- `ensureRunning()`
  - すべての操作の前に必ず通す。
  - コンテナが止まっていたら起動し、`/workspace` が空なら `git clone` → `git checkout <base_sha>` → 作業ブランチ `agent/task-<id>` を作る。
  - Phase 2 では、Sandbox が止まった後の復旧は「clone し直す」までにする。未 commit の変更は失われる。モデルにはツールのエラーとして伝え、やり直させる。snapshot による高速化は Phase 6。
- `exec(argv, {cwd, timeoutMs, maxOutputBytes})`
  - タイムアウトは `AbortController` で自前で実装する（`AbortSignal.timeout` は使えない）。
  - 出力は stream で読み、上限で切る（`output()` は全出力をメモリに載せるので使わない）。
  - 終了済みプロセスへの kill は例外になるので、それを握りつぶさずに扱う。
- 生存期間
  - `setInactivityTimeout` は2時間。処理中は1分ごとの alarm で DO を active に保つ。
  - 設計 7.3 の最大実行時間（2時間）を超えたら、AgentDO に通知して `failed` にする。
- 外向き通信（7.2 の強制）
  - `interceptOutboundHttps("*", OutboundGateway)` と `interceptOutboundHttp("*", OutboundGateway)` ですべてを受け、エントリポイント内でホストごとに判定する。
  - 許可するもの
    - `github.com`: `git-upload-pack`（GET `info/refs?service=git-upload-pack`、POST `git-upload-pack`）だけ。対象は taskSpec のリポジトリに限る。認証ヘッダは Worker 側で注入する。
      - Phase 2 の注入トークンは仮置き。公開リポジトリなら認証なしで通し、非公開リポジトリは Phase 3 の Token Broker で対応する。
    - `registry.npmjs.org`、`pypi.org`、`files.pythonhosted.org`: GET と HEAD だけ。
  - それ以外はすべて 403 を返し、ポリシー違反としてイベントに記録する。
  - コンテナ内では、Cloudflare のエフェメラル CA を `NODE_EXTRA_CA_CERTS` / `GIT_SSL_CAINFO` / `REQUESTS_CA_BUNDLE` に設定する。
- 既知の制限
  - postinstall で外部からバイナリを取る依存（playwright など）は失敗する。
  - 許可したホスト経由の情報流出は、原理的には防ぎきれない（7.2）。Phase 2 は GET 系だけに絞る。

## Gateway 側の変更

- `task_start`
  - 予約と TaskDO の作成の後、AgentDO の `start` を呼ぶ。
  - 成功したら `RUNNING` に遷移する。`start` の失敗は `CREATING` のまま残し、再試行（同じ idempotency_key）で再び `start` を呼べるようにする。
- TaskDO
  - AgentDO のイベントを取り込む仕組みを持つ。`task_wait` の中で取り込んでから返すことと、alarm（10秒ごと、実行中だけ）で取り込むことの両方を行う。
  - AgentDO の `phase` を状態遷移表に従って反映する。
- `task_cancel` は AgentDO の `cancel()` も呼ぶ（失敗しても TaskDO は `CANCELLED` のまま。AgentDO の照合で後から止まる）。
- UserDO: 月額の費用上限（初期値は env で設定。既定 $100）。

## テスト

- Unit（`apps/agent`）
  - SandboxDO は `SandboxPort` インターフェースの向こう側に置き、Unit では fake にする。コンテナ依存のコードが vitest で動くかは M1 で確かめる。
  - Pi のモデルは、台本付きの fake provider に差し替える（本物の Claude をテストで呼ばない）。差し替えられるかは M1 で確かめる。
  - ツールのパス正規化、出力上限、マスク、タイムアウト、予算超過時の abort、完了判定の再検証、自動修正の回数上限。
  - OutboundGateway の許可・拒否の判定（純粋関数として切り出す）。
- E2E
  - `wrangler dev`（Gateway と Agent の2つの設定）と Docker で、実際のコンテナを起動する。
  - fake のモデルの台本で「ファイルを編集してテストを通し、commit して完了を申告する」流れを通す。
  - 対象リポジトリは、テスト用に用意した純 JS の小さなもの（ローカルの偽 git サーバーか、偽 GitHub に git の smart HTTP を足したもの）。
  - 外向き通信: 許可されたホストに届くこと、許可されないホストや内部 IP に届かないこと。
  - Gateway の MCP 経由で、`task_start` → `task_wait` で `RUNNING` → `COMPLETED` のイベントが流れること。
- 手動の受入試験（acceptance.md に追加）
  - AI Gateway の作成、Authenticated Gateway、BYOK の登録。
  - 本物の Claude で小さな実装タスクが完了すること。
  - AI Gateway のログに userId と taskId のメタデータが付くこと。

## M1 スパイク（この順で確かめる）

1. SandboxDO + `wrangler dev` + Docker で、allowlist が効くこと、許可されないホストや内部 IP が落ちること、`git clone` と `npm install` が通ること。
   - 落ちた場合は design.md 7.2 の「セキュリティ要件達成済みとみなさない」に当たるので、構成を見直す。
2. `@cloudflare/vitest-plugin` でコンテナ依存のコードが動くか。動かなければ、Unit は fake、E2E は wrangler dev + Docker だけ、とテストの方針を確定する。
3. pi-ai の `createModels()` に台本付きの fake provider を差し込めるか。
4. 複数設定の `wrangler dev` で、Gateway → Agent のスクリプトをまたぐ DO RPC がローカルで通るか。
   - known issue に「片方だけ起動していると本番の DO に書き込む」とあるので注意する。
   - 通らなければ、WorkerEntrypoint の service binding に切り替える。

## 前提・注意

- Docker が開発と CI の前提になる（`apps/agent` の E2E とデプロイ）。
- Containers は Workers Paid プランが必要。
- Pi と `durable_object` スケジューリングポリシー、Container snapshot は beta。

## Phase 2 でやらないこと

- push と Draft PR（Phase 3）
- 親への質問と追加指示（Phase 4）
- Web 調査（Phase 5）
- snapshot による高速な復旧、R2（Phase 6）
- 実環境へのデプロイ（ユーザーの指示があるまで行わない）
