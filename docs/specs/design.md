# Cloudflare Coding Subagent 詳細設計書

## 1. 概要

### 1.1 目的

ローカルの Claude Code または Claude Cowork を親エージェント（司令塔）とし、Cloudflare 上の Pi Durable を子エージェントとして利用する。

親エージェントはユーザーとの対話、要件定義、実装計画、タスク委譲、レビューを担当する。

子エージェントは委譲された実装タスクを自律的に遂行し、GitHub Draft PR を作成・更新する。

子エージェントの実行環境には Cloudflare Sandbox を利用する。

Web 検索・Web ページ取得は Coding Sandbox から分離した専用環境で実行し、取得結果を Jev で安全性評価する。

### 1.2 基本方針

- 親エージェントは Claude Code / Claude Cowork。
- 子エージェントは Pi Durable + Anthropic Claude API。
- 子エージェントは原則1タスクにつき1つ。
- 独立した Factory Controller や別の司令塔は作らない。
- 親子間通信は Remote MCP を使用する。
- Claude Code と Cowork に同一の MCP インターフェースを提供する。
- 子エージェントは非同期で実行する。
- 親は子の実行中もユーザーとの会話や調査を継続できる構成を目指す。
- 子は必要な場合のみ親へ質問する。
- GitHub Draft PR はタスク開始時に作成する。完了しても Draft のまま返す。呼び出し元の AI がレビューし、問題が無ければ Ready にする。人のレビューが要るかは組織のポリシー次第で、`merge_policy`（`task_start` の入力）で選ぶ。要らない（`agent_merge`）なら、呼び出し元の AI がマージまでできる（15.8 の D9）。
- 障害発生時は可能な範囲で途中状態から自動復旧する。
- 親のセッションが終了してもクラウド側の処理は継続する。
- Web 調査は独立した Web Research Service に集約する。
- Coding Sandbox の外向き通信は用途別に制限する。
- GitHub 認証には GitHub App を使用する。
- ローカル端末の GitHub 認証情報を子エージェントに渡さない。

### 1.3 非目標

- 複数子エージェントの並列オーケストレーション
- 独立したソフトウェアファクトリーの構築
- 子エージェントによる自動マージ
- 親エージェントを介さない高レベルの仕様変更
- 子エージェントによる無制限の外部ネットワークアクセス
- Web 検索結果を信頼済み命令として扱うこと
- ローカルの未コミット変更を自動的にクラウドへ同期すること

---

## 2. システム構成

```
┌───────────────────────────────────────────┐
│ Local                                     │
│                                           │
│  Claude Code          Claude Cowork       │
│       │                    │              │
│       └─────────┬──────────┘              │
│                 │                         │
│           Remote MCP                      │
└─────────────────┼─────────────────────────┘
                  │
                  │ OAuth
                  ▼
┌───────────────────────────────────────────┐
│ Cloudflare                                │
│                                           │
│  ┌─────────────────────────────────────┐  │
│  │ Coding Task Gateway                 │  │
│  │ - Authentication / Authorization    │  │
│  │ - MCP Tools                         │  │
│  │ - Task API                          │  │
│  └──────────────────┬──────────────────┘  │
│                     │                     │
│                     ▼                     │
│  ┌─────────────────────────────────────┐  │
│  │ Durable Objects                     │  │
│  │ - Task State                        │  │
│  │ - Event Log                         │  │
│  │ - Questions / Answers               │  │
│  │ - Execution Lease                   │  │
│  │ - Recovery Metadata                 │  │
│  └──────────────────┬──────────────────┘  │
│                     │                     │
│                     ▼                     │
│  ┌─────────────────────────────────────┐  │
│  │ Pi Durable                          │  │
│  │ - Anthropic Claude API              │  │
│  │ - Coding Agent                      │  │
│  │ - Planning / Implementation         │  │
│  │ - Testing / Verification            │  │
│  └──────────────────┬──────────────────┘  │
│                     │                     │
│                     ▼                     │
│  ┌─────────────────────────────────────┐  │
│  │ Coding Sandbox                      │  │
│  │ - Git Workspace                     │  │
│  │ - Source Editing                    │  │
│  │ - Build / Test                      │  │
│  │ - Restricted Network                │  │
│  └─────────────────────────────────────┘  │
│                                           │
│  ┌─────────────────────────────────────┐  │
│  │ GitHub Token Broker                 │  │
│  │ - GitHub App                        │  │
│  │ - Installation Token                │  │
│  │ - Credential Helper Integration     │  │
│  └─────────────────────────────────────┘  │
│                                           │
│  ┌─────────────────────────────────────┐  │
│  │ Web Research Service                │  │
│  │ - Search Gateway                    │  │
│  │ - Isolated Web Sandbox              │  │
│  │ - Content Normalizer                │  │
│  │ - Jev Safety Evaluator              │  │
│  │ - Policy Engine                     │  │
│  └─────────────────────────────────────┘  │
│                                           │
│  R2: Snapshots / Logs                     │
└───────────────────────────────────────────┘
                  │
                  ▼
               GitHub
                  │
                  ▼
               Draft PR
```

### 2.1 コンポーネント

| コンポーネント | 役割 |
|---|---|
| Claude Code / Cowork | 親エージェント |
| Remote MCP | 共通の操作インターフェース |
| Coding Task Gateway | 認証、認可、タスク操作 |
| Durable Objects | タスク状態とイベント管理 |
| Pi Durable | 子エージェントの実行・継続 |
| Anthropic Claude API | 子エージェントの推論 |
| Coding Sandbox | コード編集、ビルド、テスト |
| GitHub Token Broker | GitHub App認証と短命トークン発行 |
| Web Research Service | 隔離されたWeb調査 |
| Jev Safety Evaluator | Web取得結果のリスク評価 |
| R2 | ログ、スナップショット |
| GitHub | ソースコード、作業ブランチ、Draft PR |

---

## 3. 親子エージェントの責務

### 3.1 親エージェント

親エージェントが担当する。

- ユーザーとの対話
- 要件の整理
- タスクの定義
- 受け入れ条件の定義
- 実装タスクの委譲
- 子エージェントからの質問への回答
- 追加指示
- 実装結果のレビュー
- PRの承認・マージ判断

親エージェントはクラウド側の内部実装を直接制御せず、Remote MCP 経由でタスクを操作する。

### 3.2 子エージェント

子エージェントが担当する。

- リポジトリの調査
- 実装計画の具体化
- ソースコードの変更
- テストの作成・実行
- ビルドと静的解析
- 必要に応じたWeb調査
- 作業ブランチへのコミット
- Draft PRの更新
- 実装結果の報告

子は、指定された受け入れ条件を満たすための局所的な判断を自律的に行える。

次の場合は親に質問する。

- 仕様が矛盾している
- 受け入れ条件が不明確
- 要求範囲を超える設計変更が必要
- 破壊的な変更が必要
- セキュリティ上の重大な判断が必要
- 予算や権限の制限により処理を継続できない

些細な実装判断では原則として質問しない。

---

## 4. Remote MCP

### 4.1 共通インターフェース

Claude Code と Cowork に同じ Remote MCP Server を提供する。

認証には Cloudflare Access / OAuth を使用する構成を基本とする。

### 4.2 MCP Tools

| Tool | 機能 |
|---|---|
| `task_start` | タスク開始 |
| `task_wait` | イベント待機 |
| `task_status` | 状態取得 |
| `task_console` | 画面（Claude Code の mod）に進み具合を出すための読み取り専用ツール。状態・段階・いまの手順・コンソールの出力を返す。ダッシュボードの設計 D19 |
| `task_answer` | 子の質問への回答 |
| `task_steer` | 追加指示 |
| `task_cancel` | キャンセル |
| `task_result` | 最終結果取得（`next_steps` で次の一手を案内する） |
| `task_pr_ready` | Draft PR を Ready for review にする（D9） |
| `task_pr_merge` | PR をマージする。`merge_policy` が `agent_merge` のとき（D9） |
| `models_list` | 使えるモデルと単価（USD / 100 万トークン）の一覧（D10） |
| `budget_status` | 自分の月の予算の状況（D10） |
| `consult` | セカンドオピニオン。1 回で完結するモデル呼び出し。コードは書かせない（D10） |

### 4.3 task_start

入力例：

```json
{
  "repository": "owner/repository",
  "base_ref": "main",
  "base_sha": "0123456789abcdef",
  "title": "Implement authentication",
  "instructions": "Implement OAuth authentication.",
  "acceptance_criteria": [
    "Authentication tests pass",
    "Existing APIs remain compatible"
  ],
  "constraints": [
    "Do not modify production credentials",
    "Do not merge the PR"
  ]
}
```

応答例：

```json
{
  "task_id": "task_123",
  "status": "CREATING",
  "draft_pr_url": null
}
```

`task_start` はタスクを非同期に受け付ける。

GitHubの初期化が完了すると、Draft PR URLを後続イベントまたは `task_status` で返す。

### 4.4 task_wait

入力例：

```json
{
  "task_id": "task_123",
  "cursor": "event_42",
  "timeout_seconds": 30
}
```

応答例：

```json
{
  "task_id": "task_123",
  "status": "INPUT_REQUIRED",
  "cursor": "event_43",
  "events": [
    {
      "id": "event_43",
      "type": "question",
      "question_id": "question_7",
      "message": "Which authentication provider should be used?"
    }
  ]
}
```

`task_wait` は一定時間で応答する bounded long polling とする。

MCP接続自体を無期限に保持しない。

親はバックグラウンドで待機し、イベント発生時に処理を再開する。

Claude Code と Cowork におけるバックグラウンドMCP呼び出しの挙動は結合テストで確認する。

### 4.5 task_answer

```json
{
  "task_id": "task_123",
  "question_id": "question_7",
  "answer": "Use the existing OIDC provider."
}
```

回答は質問ID単位で冪等に処理する。

同一質問への重複回答で処理を二重再開しない。

### 4.6 task_steer

実行中のタスクに追加指示を渡す。

例：

- 特定ファイルを変更対象から除外する
- テストケースを追加する
- 実装方針を修正する

追加指示はイベントとして永続化し、子エージェントの安全な処理境界で適用する。

### 4.7 task_cancel

キャンセル要求後は新しい外部操作を開始しない。

実行中プロセスを停止し、可能な範囲でログとGit状態を保存する。

Draft PRは自動削除しない。

---

## 5. タスク状態管理

### 5.1 状態

| 状態 | 意味 |
|---|---|
| `CREATING` | タスク・Git環境初期化 |
| `RUNNING` | 実装中 |
| `INPUT_REQUIRED` | 親の回答待ち |
| `VERIFYING` | ビルド・テスト・検証 |
| `RECOVERING` | 障害復旧中 |
| `COMPLETED` | 正常終了 |
| `FAILED` | 復旧不能な失敗 |
| `BUDGET_EXCEEDED` | 予算上限到達 |
| `CANCELLED` | キャンセル |

### 5.2 状態管理

Durable Objectsで以下を保持する。

- Task ID
- User ID
- Repository ID
- Installation ID
- Base Commit SHA
- Working Branch
- Draft PR Number / URL
- Current State
- Execution Lease
- Event Cursor
- Questions / Answers
- Cost Usage
- Recovery Checkpoint
- Created / Updated Timestamps

状態変更は原則として単一タスクのDurable Object内で直列化する。

### 5.3 実行リース

タスク実行には単発のExecution Leaseを使用する。

リースには以下を含める。

- Task ID
- Execution ID
- Expiration
- Allowed Operations
- Resource Limits
- Fencing Token

期限切れの実行主体が再び操作できないようにする。

リース更新と再取得を区別し、二重実行を防ぐ。

新しいリースの仕組みは作らず、実装済みの仕組みで次のように満たす（15.7）。

| 5.3 の要件 | 実装 |
|---|---|
| 二重実行の防止 | タスクごとに TaskDO / AgentDO / SandboxDO が1つだけあり、DO の一意性で直列化される |
| 期限切れの実行主体が操作できない | SandboxDO の起動世代（`assertBootCurrent`）、AgentDO の tombstone と停止の意図、終端の後は何もしないガード |
| Fencing Token | 起動世代と operationId（`run:<taskId>`、`answer:<qid>`、`steer:<id>:<n>`）、Installation Token の expiresAt の単調増加 |
| 更新と再取得の区別 | 配送の意図（start / cancel / answer / steer / credential）と、その配送状態 |
| Expiration | SandboxDO の `deadlineAt` と AgentDO の期限。延長は単調増加だけを受け付ける |
| Allowed Operations / Resource Limits | 外向き通信の許可リスト、push 先 ref を `props` の taskId だけから作ること、呼び出し前の予算のハードキャップ |
| 復旧（9.3 の `RECOVERING`） | AgentDO のフェーズに `RECOVERING` は無く、agent は入らない。作り直しと起動のやり直しは SandboxDO の中で完結する。復旧の回数は SandboxDO のカウンタからしか取れない |

---

## 6. GitHub連携

### 6.1 認証方式

GitHub Appを使用する。

ローカルClaude Code / CoworkのGitHub認証情報はクラウドに渡さない。

GitHub Appの秘密鍵はCloudflare Worker Secretsに保持する。

### 6.2 GitHub App権限

| Permission | Level |
|---|---|
| Metadata | Read |
| Contents | Read & Write |
| Pull requests | Read & Write |

GitHub Appは必要なリポジトリにのみインストールする。

タスク作成時には、MCP利用者が対象リポジトリへのタスク実行権限を持つことを別途検証する。

GitHub Appのインストール権限だけで、MCP利用者の操作を許可しない。

### 6.3 Token Broker

GitHub AppのInstallation Access TokenをWorker側で発行する。

- トークン有効期限は最大1時間
- 対象リポジトリを限定
- 必要な権限のみ指定
- タスク単位で発行
- 有効期限切れ時は再取得
- トークンをログに記録しない

### 6.4 Coding Sandboxへの認証情報の渡し方

初期実装ではCredential Helper方式を採用する。

```
Coding Sandbox
      |
      | git clone / git push
      v
Git Credential Helper
      |
      | Task-scoped authenticated request
      v
GitHub Token Broker
      |
      | GitHub App JWT
      v
GitHub API
      |
      v
Installation Access Token
```

Credential Helperは、Git操作時にToken Brokerから必要な認証情報を取得する。

トークンをGit URLへ埋め込まない。

```bash
# 禁止
git clone https://TOKEN@github.com/owner/repository.git
```

また、以下を禁止する。

- トークンのファイル永続化
- Git remote URLへのトークン埋め込み
- 標準出力・ログへのトークン出力
- Git credential storeによる平文保存
- 不必要な環境変数へのトークン設定

Credential Helperが返すトークンはSandbox内のGitプロセスから取得可能であり、完全な秘匿は保証されない。

そのため、短命・最小権限・実行環境の隔離を併用する。

将来的には認証付きGit操作をWorker側へ移すGit Broker方式も検討する。

### 6.5 Draft PRの作成

Draft PRはタスク開始時に作成する。

処理順序：

1. Repositoryへのアクセス権を検証
2. Base SHAを確定
3. 作業ブランチを作成
4. 初期コミットを作成
5. Draft PRを作成
6. Coding Sandboxを起動
7. Pi Durableが実装開始

GitHubのPR作成にはベースブランチとの差分が必要なため、初期コミットには空コミット等を利用する。

PRタイトルにはタスク名を使用する。

PR本文には以下を含める。

- Task ID
- 実装目的
- 受け入れ条件
- 実行状態
- テスト結果
- 未解決事項

PRは子エージェントによってマージしない。マージできるのは親（呼び出し元の AI）だけで、`merge_policy` が `agent_merge` のタスクに限る（D9）。

### 6.6 作業ブランチ

例：

```
agent/task-123
```

作業ブランチはタスクIDと紐付ける。

同一タスクの再試行で新しいPRを重複作成しない。

---

## 7. Coding Sandbox

### 7.1 実行単位

原則として1タスクにつき1つのCoding Sandboxを利用する。

Sandboxは次の処理を担当する。

- Git Clone
- Git Checkout
- ファイル編集
- コマンド実行
- Build
- Test
- Lint
- ローカルGit Commit
- Git Push

### 7.2 外向き通信ポリシー

用途別に通信を制限する。

| 用途 | 方針 |
|---|---|
| Web検索 | Web Research Service経由 |
| Webページ取得 | Web Research Service経由 |
| GitHub | 必要なGit/API通信のみ許可 |
| npm Registry | 許可 |
| PyPI | 許可 |
| その他の承認済みRegistry | 必要に応じて許可 |
| Anthropic API | Pi Durable側からのみ |
| 任意の外部URL | 原則拒否 |
| 内部IPアドレス | 拒否 |
| メタデータエンドポイント | 拒否 |

許可対象はドメイン名だけでなく、可能な範囲でプロトコル、HTTPメソッド、認証、通信量も制御する。

許可済みのGitHubやパッケージレジストリを経由した情報流出も脅威として扱う。

通信制限はプロンプトではなく、実際のネットワーク境界で強制する。

Cloudflare Sandboxで実現できる制御範囲は実機検証する。

必要な通信制限を強制できない場合、その構成をセキュリティ要件達成済みとはみなさない。

### 7.3 実行制限

初期設定案：

| 項目 | 初期値 |
|---|---|
| 同時実行タスク | 設定値（`MAX_CONCURRENT_TASKS`。OSS の既定は 2。`budget_status` の `concurrency_limit`） |
| 最大実行時間 | 2時間 |
| 最大Claude API費用 | $10 / Task |
| 自動修正試行 | 3回 |
| 質問待ち | 24時間 |

設定値は実測に基づいて調整可能とする。

### 7.4 コマンド実行

Sandbox操作には以下を適用する。

- 引数配列によるコマンド実行
- Shell文字列連結の回避
- 作業ディレクトリの固定
- パストラバーサル防止
- コマンドタイムアウト
- プロセス終了処理
- 出力サイズ制限
- 認証情報のマスキング

---

## 8. Web Research Service

### 8.1 目的

Web検索と外部コンテンツ取得をCoding Sandboxから分離する。

Claude Code、Claude Cowork、Pi Durableが共通のWeb Research Serviceを利用する。

### 8.2 提供ツール

- `web_search`
- `web_fetch`
- `web_browse`

親エージェントにはRemote MCPとして公開する。

子エージェントには内部APIまたは同等のツールインターフェースとして公開する。

### 8.3 処理フロー

```
Agent
  |
  v
Web Research Gateway
  |
  v
Search Broker / Fetch Proxy
  |
  v
Isolated Web Sandbox
  |
  v
Content Extraction
  |
  v
Content Normalizer
  |
  v
Jev Safety Evaluator
  |
  v
Policy Engine
  |
  v
Content + Source + Safety Result
```

### 8.4 Web Sandboxの制約

Web Sandboxには以下を適用する。

- Coding Sandboxと分離
- Coding Sandboxのファイルシステムへアクセス不可
- GitHubトークンを保持しない
- Anthropic APIキーを保持しない
- 社内認証情報を保持しない
- 内部ネットワークへの接続禁止
- SSRF対策
- リダイレクト先の再検証
- URLとスキームの検証
- レスポンスサイズ制限
- タイムアウト
- アクセスログ
- 実行終了後のクリーンアップ

### 8.5 Jevによる安全性評価

Webから取得した本文をJevで評価する。

評価対象：

- Prompt Injection
- Instruction Override
- Role Spoofing
- Tool Execution誘導
- Credential Exfiltration誘導
- 不審な外部送信指示

上記は評価したいリスク分類であり、Jevの実際の対応能力・モデル出力形式は実装時に検証する。

### 8.6 Safety Verdict

| Verdict | 処理 |
|---|---|
| `allow` | 本文を返す |
| `caution` | 警告付きで本文を返す |
| `block` | 本文を返さない |
| `unknown` | 本文を返さない |

Jevの実行に失敗した場合は `unknown` とする。

Jevの判定結果だけを安全性の保証として扱わない。

外部コンテンツは常に非信頼データとして処理する。

### 8.7 レスポンス形式

```json
{
  "source": {
    "url": "https://example.com/docs",
    "retrieved_at": "2026-10-18T03:00:00Z"
  },
  "content": "Retrieved page content...",
  "safety": {
    "evaluator": "jev",
    "model_version": "configured-model-version",
    "verdict": "caution",
    "categories": [
      "instruction_override"
    ],
    "reason": "Potential instructions directed at an AI agent.",
    "evaluated": true
  }
}
```

Jev固有のスコアが取得できる場合は、モデルのスコアとPolicy Engineの判定を区別して保持する。

Jevへ渡す情報は取得コンテンツと評価に必要な最小限のメタデータに限定する。

親エージェントの会話履歴、認証情報、内部シークレットは渡さない。

---

## 9. 障害復旧

### 9.1 基本方針

タスクの実行状態はSandboxの寿命から独立させる。

Sandboxが停止しても、タスク自体は直ちに失われない。

### 9.2 永続化

| 保存先 | 保存内容 |
|---|---|
| Durable Objects | 状態、イベント、質問、回答、リース |
| GitHub | コード変更、作業ブランチ、チェックポイント |
| R2 | ログ、復旧メタデータ、必要なスナップショット |

### 9.3 復旧処理

1. 実行主体の異常を検出
2. Execution Leaseを失効
3. タスクを`RECOVERING`へ変更
4. 最終チェックポイントを取得
5. 新しいSandboxを作成
6. Git作業ブランチをCheckout
7. 永続化されたエージェント状態を復元
8. Git状態と実行状態の整合性を検証
9. `RUNNING`または`VERIFYING`へ復帰

完全なプロセス状態の復元は保証しない。

必要に応じて子エージェントが作業状態を再確認してから再開する。

### 9.4 冪等性

以下の操作は冪等に扱う。

- Task作成
- Branch作成
- Draft PR作成
- 質問への回答
- タスク状態変更
- 完了通知
- リース再取得

同一タスクの復旧によってPRが重複作成されないようにする。

### 9.5 親セッション終了

親のセッションが終了しても、子は実行を継続する。

親が再接続した場合は `task_status` と `task_wait` により状態を取得する。

質問待ちの場合は `INPUT_REQUIRED` を維持する。

質問待ちが設定時間を超えた場合は、ポリシーに従って停止する。

---

## 10. 認証・認可

### 10.1 MCP認証

Cloudflare Access / OAuthを利用する。

タスク作成時には以下を検証する。

- ユーザーID
- 対象リポジトリ
- リポジトリへの操作権限
- GitHub AppのInstallation
- 許可された操作
- タスク実行予算

### 10.2 タスク操作権限

`task_status`、`task_answer`、`task_steer`、`task_cancel` では、Task IDを知っているだけで操作できないようにする。

すべての操作でタスク所有者または許可済み主体の認可を検証する。

### 10.3 Secrets

| Secret | 保存場所 |
|---|---|
| Anthropic API Key | AI Gateway（システムで1つ、15章参照） |
| GitHub App Private Key | Cloudflare Worker Secrets |
| OAuth Client Secret | Cloudflare Worker Secrets |
| GitHub Installation Token | Token Brokerで短期管理 |

長期シークレットをCoding SandboxまたはWeb Sandboxに配置しない。

---

## 11. ログ・観測性・コスト

### 11.1 記録項目

タスク単位で以下を記録する。

- Task ID
- User ID
- Repository
- PR URL
- 状態遷移
- 実行時間
- Claude APIトークン使用量
- Claude API推定費用
- Sandbox実行時間
- Web検索回数
- Jev判定結果
- 質問回数
- 復旧回数
- テスト結果
- エラー内容

### 11.2 セキュリティログ

以下は監査対象とする。

- 認証失敗
- 認可拒否
- GitHub Token発行
- Sandboxへの特権操作
- 通信ポリシー違反
- Jevによるblock判定
- タスクキャンセル
- 実行リースの失効・再取得

認証情報や取得したシークレットをログへ記録しない。

### 11.3 コスト制御

タスク単位の費用上限を設定する。

費用上限到達時は新しいモデル呼び出しを停止する。

Sandbox費用、API費用、Web調査費用を可能な範囲で区別する。

---

## 12. 実装フェーズ

### Phase 1: Task Gateway / Remote MCP

- Cloudflare Workers
- OAuth認証
- Durable Objects
- `task_start`
- `task_status`
- `task_wait`
- `task_cancel`

完了条件：

Claude CodeとCoworkの両方からタスクの作成と状態確認ができる。

### Phase 2: Pi Durable / Coding Sandbox

- Pi Durable統合
- Claude API統合
- Sandbox作成
- Git Clone
- コード編集
- Build / Test
- Git Commit

完了条件：

子エージェントが単独の実装タスクを実行できる。

### Phase 3: GitHub App

- GitHub App認証
- Installation Token発行
- Credential Helper
- 作業ブランチ
- Draft PR作成
- Push
- PR更新

完了条件：

タスク開始時にDraft PRが作成され、実装結果が反映される。

### Phase 4: 親子間対話

- `INPUT_REQUIRED`
- `task_answer`
- `task_steer`
- イベントカーソル
- 親側バックグラウンド待機

完了条件：

子が必要な場合に質問し、親の回答後に再開できる。

### Phase 5: Web Research Service

- Search Gateway
- Web Sandbox
- Fetch Proxy
- SSRF対策
- Content Normalizer
- Jev Safety Evaluator
- Policy Engine
- MCP / Internal API

完了条件：

親と子が共通のWeb検索サービスを利用でき、取得結果に安全性評価が付与される。

### Phase 6: Security / Recovery

- ネットワーク制限
- Execution Lease
- Gitチェックポイント
- R2スナップショット
- Sandbox再生成
- 自動復旧
- 予算制御
- 監査ログ

完了条件：

障害から復旧でき、外向き通信の制限が実際に強制される。

### Phase 7: End-to-End Test

以下を確認する。

1. Claude Codeから実装を委譲
2. Draft PRが作成される
3. Pi Durableが実装開始
4. 親が別の会話・調査を継続
5. 子が必要な場合だけ質問
6. 親が回答
7. 子が実装再開
8. Web検索は隔離環境で実行
9. Jev判定がレスポンスに含まれる
10. GitHubへ変更をPush
11. テスト結果をPRへ反映
12. 親がPRをレビュー
13. 親セッションを終了しても子が継続
14. 再接続後に状態・結果を取得
15. Sandbox障害から自動復旧

---

## 13. 未検証事項

以下は採用方針ではあるが、実装可能性や具体的な挙動を確認する必要がある。

| 項目 | 検証内容 |
|---|---|
| Claude Code | MCPバックグラウンド待機とイベント受信 |
| Claude Cowork | Codeと同等のMCP操作体験 |
| Pi Durable | 状態永続化と復旧粒度 |
| Cloudflare Sandbox | 外向き通信制限の強制力 |
| Git Credential Helper | Sandbox環境での安全なトークン受け渡し |
| GitHub App | Installation権限と利用者権限の整合 |
| Jev | 対応リスク分類、推論方式、出力形式、精度 |
| Web Sandbox | SSRF防止、リダイレクト制御、通信隔離 |
| R2 | スナップショット復元と整合性 |
| Cost Control | Claude API費用の正確な計測と停止 |

これらは初期の技術検証で優先的に確認する。

結果の記録先は `docs/specs/acceptance.md` の各 Phase の結果表。各項目と受入の節の対応は、同文書の「design 13 の未検証事項と、受入の節の対応」に置く（15.8）。

---

## 14. 最終的な完成条件

Claude CodeまたはClaude Coworkから実装タスクを委譲すると、Cloudflare上に子エージェントが起動し、GitHub Draft PRが作成される。

子エージェントはCoding Sandboxで実装・テストを実施する。

親エージェントは子の実行中もユーザーとの会話や調査を継続できる。

子エージェントは重要な判断が必要な場合のみ親に質問し、回答を受けて再開する。

Web調査は独立したWeb Research Serviceで実行し、Jevによる安全性評価を結果に含める。

Coding Sandboxの外向き通信は、GitHubやパッケージレジストリなど必要な用途に限定する。

GitHub認証にはGitHub Appを使用し、ローカルのGitHub認証情報をクラウドへ渡さない。

親セッションが終了しても子は継続し、再接続後にタスクの状態と結果を取得できる。

Sandbox障害が発生した場合は、保存されたチェックポイントから可能な範囲で自動復旧する。

実装完了後はDraft PRと検証結果を親に返す。親エージェントが差分をレビューし、問題が無ければ `task_pr_ready` で Ready にする。そのあとは `merge_policy`（`task_start` の入力。既定 `human_review`）による: `human_review` は人のレビューを待ち（マージは人が行う）、`agent_merge` は親エージェントが `task_pr_merge` でマージまでできる。組織としての強制は GitHub のブランチ保護に任せる（D9）。

---

## 15. 決定事項（2026-10-18）

実装着手前の確認で決定した事項。本文と食い違う場合はこの章を優先する。

### 15.1 子エージェント（Pi Durable）

- Earendil 製の Pi Durable（`@earendil-works/pi-durable`、`@earendil-works/pi-ai`）を、Cloudflare Agents SDK の `PiHarness` 経由で Durable Object 上に載せる。
  - 参考: https://developers.cloudflare.com/agents/harnesses/pi/ 、https://earendil.com/posts/pi-durable/
- 両者とも beta で API が変わり得るため、Pi への依存は子エージェントのアダプタ層に閉じ込める。
- Pi のイベントストリームにはカーソルがない。そのため `task_wait` が使うイベントログとカーソルは、Gateway 側のタスク DO が自前で連番を振って保持する。
- Pi の復旧は best effort で、ツール実行中にクラッシュした場合は副作用の成否が分からない。
  - Draft PR 作成や `git push` など外部副作用を持つツールは `replay: "safe"` にしない。
  - それらのツールは、実行前に GitHub 上の状態（既存 PR、ブランチの HEAD）を照合して冪等にする（9.4）。
- Pi にはツール承認ステップがない。危険操作の制限はネットワーク境界とツール実装側で強制する。
- Cloudflare Sandbox との公式連携は確認できていない。Pi Durable の実行環境抽象（`env`）に Sandbox を接続する部分は自作する。

### 15.2 Claude API の経路

- Claude は AI Gateway 経由で呼び出す（Pi AI の Cloudflare プロバイダ）。
- Anthropic API キーは組織で1つとし、AI Gateway に保管する。Worker・Sandbox にはキーを置かない。
- 誰がいくら使ったかは、Gateway へのリクエストにユーザー ID・タスク ID を付与し、タスク DO と Gateway ログで集計する。

### 15.3 MCP の認証・認可（組織利用前提）

- 1段目: Cloudflare MCP Server Portal を Access で保護し、組織のポリシーで利用者を絞る。Claude Code / Cowork から Portal への接続は確認済み。
- 2段目: MCP サーバー（Worker）自体は `workers-oauth-provider` で OAuth サーバーとなり、上流の認証に GitHub OAuth を使う。
  - Portal 側では「Require user auth」を有効にし、ユーザーごとに認証させる。
- MCP サーバー側でも利用者を制限する。指定した GitHub org の指定 team のメンバーだけを許可する。
  - Portal の Access ポリシーは直接の URL で迂回できるため、MCP 側の制限を実際の防御線とみなす。
- タスク作成時には、上記に加えて対象リポジトリへの push 権限をタスクごとに検証する（10.1）。
- GitHub のログインには、OAuth App ではなく GitHub App のユーザー認可（user-to-server トークン）を使う。これで次の3つを確かめる。
  - push 権限
  - 対象リポジトリに App がインストールされていること（`/user/installations/{id}/repositories`）
  - team への所属
- 詳細は `phase1.md` に記す。

### 15.4 予算

- タスク単位の上限（初期値 $10 / Task）に加え、ユーザー単位の月額上限を設ける。
- 同時に実行できるタスクの数には、ユーザーごとの上限を設ける（`MAX_CONCURRENT_TASKS`、`rovo.config.json` の `concurrency.maxTasks`。OSS の既定は 2）。UserDO の `reservation_slot` にタスクごとに 1 行の枠を持ち、件数が上限に達していれば `concurrency_limit` で断る。旧スキーマの `reservation`（1 行だけ）は、UserDO の起動時に `reservation_slot` へ移して消す（実行中の予約を失わない）。照合による回収（一度も作られなかった予約だけ）と `finishTask` による解放は、タスクごとに行う。予算（`task_budget`）の予約は別の仕組みで、両方を満たすときだけ始められる。
- **子のモデル呼び出し前の判定**（`AgentDO.preModelCall`）: 入力は、直前の呼び出しでプロバイダーが返した実測（input + cacheRead + cacheWrite）に、前回以降に context へ足された分をバイト数（トークン数の上限）で足す。実測が無い初回は context 全体のバイト数。単価は入力・出力とも最大値のまま（少なく数えない）。出力は即 block せず、残額に収まる `maxTokens`（`maxOutputTokensWithin`）まで絞って呼ぶ。収まる出力が 1,024 トークンを割るときだけ `budget_exceeded` で止める。
- **予算超過で止まったときの結果**: 作業ブランチへ push 済みの SHA（チェックポイントの push を含む）を `pushedSha` に、patch・diffstat を（Sandbox を破棄する前に取れれば）結果に残す。summary が空なら停止理由と最後に push した commit を固定文で入れる。PR の `head_sha` は記録するが、検証した commit が無いので `head_matches_verified` は false。cancel・期限・回答待ちの期限は Sandbox を直ちに破棄するので、patch は残さない（`pushedSha` と summary は同じ）。

### 15.5 Web 取得結果の安全性評価

- 評価器は Workers AI の Clef-flash（`@cf/cloudflare/clef-flash`）から始める。Clef は Jev と API 互換である。
- 評価器はインターフェースで抽象化し、Clef（`@cf/cloudflare/clef`）や Jev 本体へ差し替えられるようにする。
- Clef / Jev はプロンプトインジェクションの専用検出器ではない。8.5 の各リスク分類は `questions` として自前で定義する。
- 取得した本文は `state`（データ）にだけ入れ、評価の指示は `questions` 側に分離する。
- 判定は誘導され得るため、Policy Engine では決定論的チェックと組み合わせる。

---

## 16. 公開とデプロイの運用モデル（2026-10-18 決定）

- このリポジトリ（`rovo`）は、最終的にパブリックにする。汎用のコードとドキュメントだけを置く。
- デプロイは、下流の private リポジトリから行う。
  - 下流の private リポジトリは upstream にこのリポジトリを登録し、更新を取り込む。
  - 環境固有の値は下流側に置く。対象は、Cloudflare の account id、KV / AI Gateway の id、許可する org / team、公開 URL、secret の投入手順など。
- MCP Server Portal / Access への登録は、IaC のリポジトリ（Terraform）で行う。

### このリポジトリが守ること

- 環境固有の値、秘密情報、個人情報をコミットしない。必要な値は env・secret・下流の設定ファイルで差し込む。
- `wrangler.jsonc` はローカル開発とテスト用の設定とし、本番用の値（KV の id など）を持たない。
- 下流が upstream の変更をコンフリクトなく取り込めるようにする。下流は「新しいファイルを足すだけ」でデプロイできる構成にする（例: 下流の本番用 wrangler 設定を `-c` で指定してデプロイする mise タスク。ただし、そのタスクを upstream には置かない（15.8））。下流に upstream のファイルを書き換えさせない。
- 公開の前に、LICENSE、公開向けの README、下流でのデプロイ手順（`docs/deploy.md`）を用意する。

### 15.6 Web 検索（2026-10-18 決定）

- 検索には Cloudflare Web Search API（beta、2026-10-02 公開）を使う。Workers AI バインディングの `env.AI.websearch()` で呼ぶ。
  - AI Gateway を経由し、AI Gateway のクレジット（Unified Billing）で課金される。検索プロバイダの API キーを持たなくてよい（BYOK も任意）。
  - 既存の `ai` バインディングを使うので、npm の依存は増えない。Pi 用のアダプタ（`agents/websearch/pi` の `webSearchTool`）は、既に依存している `agents` に含まれる。
  - 必要な workerd は 1.20260924.1 以降（rovo は 1.20261012.1 で満たす）。
- プロバイダの既定は Linkup（当初は Ceramic.ai だった。2026-10-22 の本番での比較で変えた）。
  - Zero Data Retention に対応している。
  - $5.00 / 1,000 リクエスト。
  - 結果の説明文は最大 8,000 文字。
  - 比較（29 語 × 3 プロバイダ）: Linkup は 29/29 成功・日本語だけの検索語 6/6・関連 1.41。Ceramic は日本語だけの検索語のほとんどと「the」「a」で HTTP 502（成功率 76%、日本語だけは 1/6、関連 0.17）。Exa は質が最良（関連 1.97）だが ZDR がなく（Cloudflare の providers の表）$7.00 / 1,000 リクエスト。
  - Ceramic と Exa にも、パラメータを変えるだけで切り替えられる。Tavily は Web Search API のプロバイダでなく、規約で検索語の学習利用と取り消せないライセンスがあるので使わない。
- 結果（タイトル・URL・説明文）は外部コンテンツなので、信用しないデータとして扱う。説明文は 8.5 の安全性評価（Clef-flash）にかける。
- ローカル開発で呼ぶと、実際のアカウントに課金される。そのため、Unit / E2E では `websearch()` を fake に差し替える。
- ページ本文の取得（web_fetch）は別に扱い、Phase 5 で決める（Browser Run / Kitesurf が候補）。

### 15.7 Phase 6: Security / Recovery / 観測性（2026-10-19 決定）

詳細は `phase6.md`。

- **Execution Lease（5.3）** は新しい仕組みを作らず、実装済みの仕組みで満たす。

| 5.3 の要件 | 実装 |
|---|---|
| 二重実行の防止 | タスクごとに TaskDO / AgentDO / SandboxDO が1つだけあり、DO の一意性で直列化される |
| 期限切れの実行主体が操作できない | SandboxDO の起動世代（`assertBootCurrent`）、AgentDO の tombstone と停止の意図、終端の後は何もしないガード |
| Fencing Token | 起動世代と operationId（`run:<taskId>`、`answer:<qid>`、`steer:<id>:<n>`）、Installation Token の expiresAt の単調増加 |
| 更新と再取得の区別 | 配送の意図（start / cancel / answer / steer / credential）と、その配送状態 |
| Expiration | SandboxDO の `deadlineAt` と AgentDO の期限。延長は単調増加だけを受け付ける |
| Allowed Operations / Resource Limits | 外向き通信の許可リスト、push 先 ref を `props` の taskId だけから作ること、呼び出し前の予算のハードキャップ |
| 復旧（9.3 の `RECOVERING`） | AgentDO のフェーズに `RECOVERING` は無く、agent は入らない。作り直しと起動のやり直しは SandboxDO の中で完結する。復旧の回数は SandboxDO のカウンタからしか取れない |

- **R2（9.2、Phase 6）** は「終端後の正」ではなくコピーとする。正は TaskDO のまま。
  - TaskDO の `events` / `questions` / `git_token` の削除は Phase 7 で決める。
  - 書き込みは、費用の精算（`finished`）と GitHub の終端処理（`finalize_done`）が済んだ後に、冪等に行う。失敗が続けば `archive_failed` を監査ログに出して打ち切る。タスクの結果と予算の精算には影響させない。
  - バインディング（`LOGS`）が無いときは、アーカイブをスキップする（fail-open。`archive_skipped`）。
  - `apps/gateway/wrangler.jsonc` には `r2_buckets` を置かない（バケット名は環境固有で、下流が `LOGS` として束ねる。16）。ローカルの E2E は、E2E が生成する一時の wrangler 設定にだけ `LOGS` を足す。
  - キーは `tasks/<yyyy>/<mm>/<task_id>/{events.jsonl,result.json,summary.json}`（`<yyyy>/<mm>` はタスク作成時刻の UTC）。`summary.json` を最後に書き、これが完了の印。ライフサイクルの設定（例: 90 日）は下流で行う。
  - コンテナのスナップショット（beta）は、復旧のためには使わない。復旧は push 済みのチェックポイントで成立している。起動を速くするための依存関係のキャッシュには D14 で使う（15.8）。
  - 保存するのは公開イベントの全件・結果・要約。タスクの入力（instructions / acceptance_criteria / constraints）、title、親の answer / steer の本文、トークンは保存しない。
  - events.jsonl は未加工で、読む側が非信頼データとして扱う。バケットは非公開、バインディングは gateway だけ、MCP からの一覧・読み出しは作らない。
- **監査ログ（11.2）** は、1行の構造化 JSON で出す。
  - Workers Logs の `console.log` だけでは best-effort（head sampling と短い保持で欠落しうる）。監査として成立する条件は、sampling 100% と Logpush で保持を自分で決められる宛先に流すこと。これは下流の設定で、rovo は環境固有の値を持たない。
  - 欠落してはならない事象（トークンの発行・失効、特権操作、cancel、配送の打ち切り）は TaskDO の events にも固定コードで積み、R2 の events.jsonl にも残す。
  - 11.2 の「実行リースの失効・再取得」は、起動世代の破棄、tombstone 後の start、start の衝突、agent の cancel の受理を監査する。
  - 出力は `packages/audit`（`@rovo/audit`）の `audit()` に一本化する。gateway・agent・web が workspace 依存で使い、閉じたイベント名の一覧と許可したフィールドだけを通す（呼び出し側は allowlist を渡せない）。web の block / unknown は `web_blocked` として出す。
- **観測性（11.1）** の Sandbox 実行時間と復旧回数は、SandboxDO が永続化するカウンタから取る。Sandbox と Web の金額は単価をかけた**推定値**で、単価（`SANDBOX_USD_PER_HOUR`、`WEB_USD_PER_1K_SEARCH` / `FETCH` / `BROWSE`）は gateway の `vars` の既定値を下流が上書きできる（16）。要約（`summary.json` と監査ログの `task_summary`）の金額は `sandbox_usd_estimate` / `web_usd_estimate` で、タスクの予算には含めない。

### 15.8 Phase 7: End-to-End Test と公開の準備（2026-10-19 決定）

詳細は `phase7.md`。

- **読み替え**: 8・12・13・14 章の Jev は Clef に読み替える（実装は 15.5 の Clef-flash）。本文は直さない。
- **TaskDO のデータ（D1）**: R2 は引き続きコピーで、正は TaskDO のまま。`git_token` の暗号文（`enc` 列）だけを、`finalize_done = 1`（トークンの失効の後）に空にする。行と id は残す（`cred_delivered_id` の参照と、`credential_*` の件数の突き合わせを保つため）。`events` / `questions` / `steers` は消さない。本文の保持期限が要件になった時に、別の Phase で決める。
- **個人での利用の認可（D8、2026-10-20 決定。phase7.md の D7 は Jev の読み替え）**: GitHub の個人アカウントには team が無いので、数値の user ID の許可リスト `ALLOWED_USER_IDS` でも認可できるようにする。login は改名でき、空いた名前を他人が取れるので使わない。org/team のルールと ID のルールは OR（どちらかを満たせば許可）。少なくとも 1 つが完全に設定されている必要がある。`ALLOWED_ORG` と `ALLOWED_TEAM` は対で、片方だけの設定は不正（ID のルールに切り替えない。fail closed）。`ALLOWED_USER_IDS` は 1 つでも不正な要素（数字以外・0・重複・空要素）があれば全体が不正で、読み飛ばさない。ID の判定は `GET /user` で取得した `id` で行い、トークンの持ち主の確認（不一致は拒否）は省略しない。ID で通らず、org/team の対が設定されているときだけ team を確認する。拒否の応答と監査（`authz_denied` / `not_team_member`）は team に無い場合と同じ。キャッシュ（TTL 5 分）の振る舞いは変えない。解析と判定は `apps/gateway/src/auth/allowlist.ts` に置く。
- **呼び出し元の AI による PR の Ready 化とマージ（D9、2026-10-20 決定）**: 従来は「rovo は PR を Draft のまま返し、レビューとマージは親とユーザーが行う」だった。これを「呼び出し元の AI（親）が差分をレビューし、問題が無ければ Ready にする。人のレビューが要るかは組織のポリシー次第なので、要らなければマージまでできる」に変える。
  - **ポリシーは `task_start` の入力 `merge_policy`（`"human_review"` | `"agent_merge"`、既定 `human_review`）で、TaskDO に保存する**（`task_status`・`task_result` にも返す）。デプロイ全体の env（`PR_MERGE_POLICY` など）にはしない: 組織で使うときは各個人が選べるようにする。fingerprint は既定なら従来の値のまま（保存済みの冪等キーを壊さない）、`agent_merge` のときだけ別のタスクになる。
  - **MCP ツールは 2 つ。入力はどちらも `task_id` が中心で、リポジトリ・PR 番号・sha は呼び出し元から受け取らない**（任意の PR を操作する道具にしない。対象は TaskDO の記録: `github_link` の `pr_number` とブランチから取る）。`task_pr_ready {task_id}`: Draft PR を Ready for review にする。条件は、タスクの所有者であること・status が COMPLETED であること。冪等（すでに Ready なら成功）。`merge_policy` が `human_review` でも使える。`task_pr_merge {task_id, merge_method?: squash|merge|rebase（既定 squash）, delete_branch?: boolean（既定 false）}`: 上の条件に加えて、`merge_policy` が `agent_merge`（`human_review` は `forbidden`）、`task_result` の `head_matches_verified` が true、PR が Ready（Draft のままなら `conflict` で `task_pr_ready` を先に呼ぶよう返す）。GitHub のマージ API に、検証済みの head の sha（`github_link.head_sha`）を `sha` として渡し、検証後にブランチが動いていればマージしない（`head_moved`）。冪等（マージ済みなら成功）。`delete_branch` の削除に失敗してもマージは成功として返し、`warnings` に残す。
  - **操作は利用者の GitHub のユーザートークンで行う**（UserDO の `github_credential`、`CredentialManager.withToken`。401 なら 1 回 refresh する既存の流儀）。Installation Token は使わない。理由: Installation Token は D1 で終端の処理の後に消える。App の権限で操作すると、利用者のブランチ保護の扱い（バイパスの許可など）と監査の主体が利用者本人とずれる。トークンは UserDO の中だけで使い、RPC の戻り値には出さない。**組織としての強制は GitHub に任せる**: ブランチ保護（必須レビュー・必須チェック・ruleset）に拒否されたら、GitHub のメッセージを付けて `merge_blocked` で返す。回避しようとしない。
  - **GitHub の API**: Draft → Ready は REST に無く、GraphQL の `markPullRequestReadyForReview(input:{pullRequestId})`。node_id は保存せず、その場で `GET /repos/{o}/{r}/pulls/{n}` から読む（このとき PR が TaskDO の記録のブランチ・リポジトリと一致することも確かめる）。マージは `PUT /repos/{o}/{r}/pulls/{n}/merge`（`sha`、`merge_method`）。ブランチの削除は `DELETE /repos/{o}/{r}/git/refs/heads/{branch}`（記録の作業ブランチだけ）。
  - **エラーコードの追加**: `merge_blocked`（GitHub が 405 / 422 でマージを拒否: ブランチ保護など）、`head_moved`（409、または検証済みの sha と PR の head が違う）、`github_rejected`（その他の GitHub の拒否）。権限の不足は `forbidden`、トークンの失効は `reauth_required`、一時的な障害は `upstream_unavailable`。
  - **監査**: `pr_ready` / `pr_merged` / `pr_denied`（`taskId`・`userId`・`merge_policy`、`pr_denied` は `kind`（ready | merge）と固定の `reason`）。冪等な再実行（すでに Ready・マージ済み）では出さない。
  - **AI への伝え方**: MCP の initialize の応答の `instructions` に、使い方の全体の流れ（task_start → task_wait / task_status → task_result → 差分のレビュー → task_pr_ready → `agent_merge` なら task_pr_merge、`human_review` なら人のレビューを待つ）を書く。`task_result` の応答に `next_steps`（status・`merge_policy`・PR の draft 状態・`head_matches_verified` から決まる案内文）と `merge_policy`、`pr.draft`・`pr.merged` を足す。レビューで問題が見つかったときは、`task_steer`（実行中専用）ではなく新しいタスクで頼む: `base_ref` に PR のブランチ `agent/task-<id>`、`base_sha` に `pr.head_sha` を指定すると、その PR に積む形で続けられる。ポリシーを説明文だけに頼らない: 条件の検査は TaskDO と GitHub がサーバー側で行う。子エージェントの system prompt の `<no_push>` 節には「Draft PR は gateway が作る（子は作らない）」と書き、子の summary が「PR を作っていない」と誤解させないようにする。
  - **退けた案**: rovo が完了時に自動で Ready にする（親のレビューを挟むため）。呼び出し元の `gh` を使わせる（`gh` の無い環境で使えず、ポリシーを強制できないため）。デプロイ全体の `PR_MERGE_POLICY`（組織の中でも個人が選べるようにしたいため）。
  - GitHub App の権限は変えない（Pull requests: Read and write、Contents: Read and write のまま足りる。`docs/deploy.md`）。受入は `acceptance.md` の 21 節。
- **モデルの選択・予算の確認・consult（D10、2026-10-20 決定）**: 呼び出し元の AI が、タスクの難しさに合わせて子のモデルを選び、残りの予算を確かめ、設計の相談やレビューのセカンドオピニオンを 1 回で得られるようにする。
  - **単価はカタログから取る**。手書きの単価表（`apps/agent/src/agent/pricing.ts` の `MODEL_PRICES`）をやめ、pi-ai の Cloudflare AI Gateway カタログ（`providers/data/cloudflare-ai-gateway.json`。api 名の下にモデルがあり、各モデルに `cost{input,output,cacheRead,cacheWrite,tiers[]}`・`contextWindow` がある）から、明示の許可リストの id だけを取り出す。許可リストと「rovo の id → カタログの id」の対応は 1 か所（`packages/models` の `MODEL_CATALOG_IDS`。gateway と agent が共有する workspace package）。初期値は `anthropic/claude-haiku-5-5`・`sonnet-5-5`・`opus-5-5`・`fable-5-1`、`openai/gpt-6-luna`・`gpt-6-sol`・`gpt-6-astra`。rovo の id は `<プロバイダー>/<カタログの id>`（AI Gateway の specifier と同じ形）。カタログに無い・cost が無い・読めない tier があるモデルは「単価が分からない」ので使えない（fail closed）。
  - **JSON は直接 import できない**（pi-ai の `exports` は `./providers/*` → `dist/providers/*.js` だけで、`.json` は解決しない）。同じ内容を平坦化した `@earendil-works/pi-ai/providers/cloudflare-ai-gateway.models`（`agents/models/pi-ai` が使うのと同じ経路。バンドル・型検査が通る）の `CLOUDFLARE_AI_GATEWAY_MODELS` を読み、`packages/models` が実行時に形を検証して許可リストの id だけを取り出す。平坦化は id をキーにするので、api をまたいで同じ id があれば後勝ちになる。unit テストで api が期待どおり（claude は `anthropic-messages`、gpt-6 は `openai-responses`）であることも固定する。
  - **tier はキャッシュの単価まで持つ**（`inputTokensAbove` を超える呼び出しの `input`・`output`・`cacheRead`・`cacheWrite`）。以前の手書きの haiku は tier の `cacheRead` / `cacheWrite` が抜けていて、入力の見積り（`estimateCallCostUsd`: input と cacheWrite の高い方の最大値）が 100k 超で $0.5/M と過少だった（正しくは cacheWrite の $0.625/M）。これを直した。費用の計算 `computeCostUsd` は pi-ai の `calculateCost` と同じ規則（入力側の合計 = input + cacheRead + cacheWrite が `inputTokensAbove` を超えたら、いちばん高いしきい値の tier を全体に使う）。`ENVIRONMENT=test` の scripted モデルの単価 `TEST_MODEL_PRICES` は残す（cacheRead $0.1・cacheWrite $1.25 を足した。台本の usage にキャッシュが無ければ費用に影響しない）。
  - **使えるモデルの範囲は env `AGENT_MODELS`**（gateway と agent の vars。カンマ区切り）。未設定・空なら `AGENT_MODEL`（既定 `anthropic/claude-sonnet-5-5`）だけ（fail closed）。**許可リストに無い id は、起動時のエラーにせず無視する**（ログに `agent_models_ignored` を件数だけ出す。unit テストで固定）。`AGENT_MODEL` は許可リストにあれば常に含める（既定のモデルが選べないと `model` 省略のタスクが始められないため）。gateway が `task_start` / `consult` の入力を拒否し（`invalid_input`、`models_list` を案内）、agent も `start` / `consult` で `AGENT_MODELS` を独立に見る（`unknown_model`）。2 つの値が食い違えば、gateway が通したモデルを agent が拒否する（デプロイ時に揃える）。
  - **`task_start` の `model`（任意）**: `AGENT_MODELS` の中だけ。既定は `AGENT_MODEL`。TaskDO の `task.model` に保存し（D10 より前の行は NULL = 既定）、`TaskSpec.model` として AgentDO に渡し、`task_status`・`task_result` に返す。fingerprint は未指定なら従来の値（v1 / v2 / v3）のまま、指定があれば `["v4", ...fields, commands, merge_policy, model]`（保存済みの冪等キーを壊さない）。AgentDO は Pi の `defaults.model` がハーネスを開いた時点（`start` の spec を保存する前でありうる）で決まるので、最初の run を投入する直前に `session().setModel` で明示する（既定と違うときだけ）。費用の見積り（`preModelCall`）は `spec.model` の単価で行う。
  - **OpenAI のモデルの経路（着手前に確認した）**: AgentDO の Pi の経路は `createAI({binding: env.AI, id: AI_GATEWAY_ID}).provider` → `guardProvider`。`agents/models/pi-ai`（`apps/agent/node_modules/agents/dist/models/pi-ai/index.js`）の `dispatchOne`（`api` で分岐。1623-1630）が `openai-responses` を `streamResponses`（`index.js:1407`。`max_output_tokens` は 1431、`reasoning` の組み立ては 1435-1443）へ、`anthropic-messages` を `streamAnthropic`（`index.js:1307`）へ流す。どちらも `sendUniversal`（`index.js:495`）→ `transport.universal`（`env.AI.gateway(id).run`）で同じ AI バインディングの経路に出る。`buildGatewayModel`（`index.js:172`。レジストリは `buildGatewayRegistry` の 134）はレジストリのキー `<baseUrl 末尾のスラッグ>/<id>` で引き、gpt-6-* の baseUrl は `.../openai` で終わるので `openai/gpt-6-sol` が解決する。したがって OpenAI のモデルも AI バインディング経由で AI Gateway に送れる（別経路は作らない）。`guard-provider.ts` の thinking の補正（`fixAnthropicThinking`）は `isAnthropicModel`（api が `anthropic-messages` か id に `claude`）だけに効き、OpenAI の payload には触らない。OpenAI 向けに必要な補正は、コードを読む限り見当たらない（`streamResponses` は `thinkingLevelMap.off` を見て `reasoning` を組む: luna / sol は `off: "none"` で `reasoning.effort: "none"`、astra は `off: null` で `reasoning` を送らない。`max_output_tokens` は `Math.max(maxTokens, 16)`）。実キーでの呼び出しは未検証（受入 22 節）。
  - **`budget_status`**（入力なし）: UserDO から `{monthly_budget_usd, spent_usd, reserved_usd, remaining_usd, task_budget_usd, consult_budget_usd, max_concurrent_tasks, concurrency_limit, period}`。`spent` は `task_budget.settled_micro` の合計（精算済みの実費）、`reserved` は閉じていない行の `max(reserved − settled, 0)` の合計、`remaining = max(0, 月の上限 − spent − reserved)`（`committedMicro` と同じ数え方）。`max_concurrent_tasks = floor(remaining / task_budget)`（予算から見た件数）。`concurrency_limit` は同時実行の上限の設定値（`MAX_CONCURRENT_TASKS`）で、実際に同時に実行できる数は `concurrency_limit` と `max_concurrent_tasks` の小さいほう。`period` は今月（UTC）の開始と、翌月の頭（含まない）。Cloudflare の API トークンは使わない。**AI Gateway のクレジット残高と、Anthropic / OpenAI の残高は取得できない**（説明に明記し、各プロバイダの画面で上限を管理する）。
  - **`consult`**: 入力 `{model?, system?, messages: [{role: "user"|"assistant", content}], max_output_tokens?}`（messages は 1〜100 件、最初と最後が user、入力全体 256KB まで）。1 回で完結し、rovo は会話を保存しない（呼び出し元が毎回 messages を渡す）。コードは書かせず、Sandbox もタスクも使わない。応答 `{text, model, usage{input, output, cache_read, cache_write}, cost_usd}`。応答のテキストはモデルの出力なので、web のような非信頼データの囲みはしない。ただし `instructions` と説明に「答えは助言で、事実確認は自分で行う」と書く。
    - **DO の切り方**: consult ごとに別の AgentDO インスタンス `consult-<ULID>`（gateway が `consultId` として発行し、`env.AGENT_DO.getByName`）。AI バインディングと thinking の補正が AgentDO にあるので、gateway には AI バインディングを足さない。専用の DO クラスは作らない（クラス・マイグレーション・バインディングが増えるため）。AgentDO は名前が `consult-<ULID>` で `consultId` と一致し、タスクとして使われていない（`fingerprint` が無い）ときだけ動き、**終わったら `storage.deleteAll()` で保存データを消す**（使い捨て）。同じ名前のインスタンスをタスクとして使うことも、タスクの DO を consult に使うこともできない。
    - **予約と精算**: `UserDO.reserveConsult(consultId)` が、同時実行の枠（`reservation_slot`）を使わずに、月の枠から `CONSULT_BUDGET_USD`（既定 0.5。0 以下・不正は 0.5）を `task_budget` に行として予約する（タスクと同じ仕組み。足りなければ `budget_exceeded`。同じ `consultId` の再送は冪等）。AgentDO には UserDO が返した予約額を `budgetUsd` として渡す。終わったら `settleConsult(consultId, costUsd)` が実費で閉じる（予約の余りは月の枠に戻る。1 回だけ）。AgentDO が失敗を返したときはかかった費用で、**例外・タイムアウト（120 秒）・壊れた応答で実費が分からないときは予約額で**閉じる（予約より少なく数えない）。精算されないまま 30 分たった consult の予約は、次の予約のときに予約額で閉じる（`closeStaleConsults`。ULID の時刻で判定）。
    - **出力の上限**: 入力の見積り（UTF-8 のバイト数 + 枠の余裕 1024）を最悪の単価（価格帯・cacheWrite を含む最大値）で引いた残りを、出力の最悪の単価で割る（`maxOutputTokensWithin`）。`max_output_tokens`（既定 8192）がそれより大きければ絞る。入力だけで予約額を使い切る（残りが 64 トークン未満）なら、モデルを呼ばずに `invalid_input`（`input_too_large`）。費用の計算は、カタログの単価から計算した値とプロバイダー側の報告の大きい方（少なく数えない）。
    - **prompt caching**: Anthropic のモデルでは `onPayload` で、system の末尾のブロックと、最後の user メッセージの直前のメッセージの末尾のブロックに `cache_control: {type: "ephemeral"}` を付け、messages の他の `cache_control` を外す（pi-ai は既定で最後のメッセージに付けるが、最後の user は毎回変わるので効かない）。呼び出し元が同じ前置きを送れば 2 回目以降は `usage.cache_read` に出る。キャッシュには最小トークン数があり（モデルにより 1024〜4096 程度）、短い前置きはキャッシュされない。OpenAI は自動キャッシュ（payload は触らない）。
    - **観測**: AI Gateway の metadata に `userId`・`consultId`・`caller: "consult"`。監査に `consult_started` / `consult_finished`（`userId`・`consult_id`・`model`、finished は `cost_usd`。会話の内容は出さない）。
  - **思考レベル（effort。モデルごとに固定、2026-10-20 決定）**: それまで AgentDO は Pi（`@earendil-works/pi-ai` 1.3.0）に `reasoning` を渡しておらず、Pi の既定で `thinking: {type:"disabled"}` が送られていた（意図した設計ではない）。タスクごとではなく**モデルごと**に思考レベルを固定する。初期値は `packages/models` の `EFFORTS`: haiku-5-5 = low、sonnet-5-5（既定）= high、opus-5-5 = medium、fable-5-1 = low、gpt-6-luna = low、gpt-6-sol = medium、gpt-6-astra = low。デプロイごとに env `MODEL_EFFORTS`（`<モデルの id>=<レベル>` のカンマ区切り。例 `anthropic/claude-sonnet-5-5=medium,anthropic/claude-haiku-5-5=off`。レベルは off / minimal / low / medium / high / xhigh / max。gateway と agent の vars に同じ値）で上書きできる（`resolveEfforts` / `effortFor`）。
    - **不正な値は起動時のエラーにせず、無視して初期値にする**（`AGENT_MODELS` と同じ流儀。Worker に「起動時」は無く、エラーにすると全リクエストが失敗する）。無視するのは、書式の誤り（`=` が 1 つでない・空）、許可リストに無いモデル、知らないレベル（大文字小文字も区別する）、そのモデルが受け付けないレベル。受け付けるかは pi-ai の `getSupportedThinkingLevels` と同じ規則でカタログの `thinkingLevelMap` から決める（`null` のレベルは不可: fable・astra の off、luna / sol の minimal。xhigh / max は map に載っているものだけ）。無視した件数はログに `model_efforts_ignored` で出す。同じモデルを複数回書いたら後が勝つ。unit テスト（`packages/models`、gateway の `task-model`、agent の `agent-do` / `agent-do-consult`）で固定した。
    - **Pi への渡し方**: agents 0.28.1 の `PiSession` が公開するのは `setModel` だけで（`dist/harness/pi/index.js:625`）、セッションの thinking level を変える口は無い（`defaults.thinkingLevel` はハーネスを開いた時点で決まり、`spec.model` を知る前。`conversation().configure()` は `@internal`）。そこで、タスクのセッション（pi-durable の `generation.js:126` の `reasoning` 展開）と consult が通る `guardProvider` で、`streamSimple` の `options.reasoning` に**モデルごとの値を毎回セットする**（呼び出し側の値より優先。off ならセットしない）。`preModelCall` と consult の guard が verdict の `reasoning` に返す。`options.reasoning` は agents の pi-ai 経路が Anthropic（`thinkingOptions`: `compat.forceAdaptiveThinking` のモデルは adaptive thinking と `effort`。pi-ai `anthropic-messages.js:728-770` の `mapThinkingLevelToEffort`、`978-1000`）にも OpenAI（`streamResponses` `index.js:1435-1443` の `reasoning.effort`。`thinkingLevelMap` を通す）にも効く。off のときは今までどおり `reasoning` なしで、Anthropic の `thinking` は `THINKING_OFF` の表で補正する。
    - **`THINKING_OFF` の opus-5-5 を `disabled` に直した**（本番の AI Gateway のログで確認 2026-10-20: haiku-5-5 と opus-5-5 は `between_tools` を 400 で拒否する）。sonnet-5-5 だけ `between_tools`、fable-5-1 は `thinkingLevelMap.off` が null で Pi が `disabled` を送らないので対象外。
    - **予算への影響（変えていない）**: 思考のトークンは出力として課金されるが、許可リストの Anthropic は全て `forceAdaptiveThinking: true` で、Pi は `max_tokens` を呼び出し側の値のまま送り、思考はその中に収まる（usage の `output` に思考の分が含まれる。`anthropic-messages.js:676-679`）。OpenAI の `max_output_tokens` も reasoning を含む。したがって `estimateCallCostUsd`（タスク: `maxTokens` 16000 まで）と `maxOutputTokensWithin`（consult の `max_output_tokens`）の上限は、思考を含めても予約額を超えない。unit で固定した: agent の `pricing`（全モデル × 全レベルで、出力を上限まで使い切った実費が予約額以下）、`packages/models`（全 Anthropic が `forceAdaptiveThinking`。外れると Pi が `maxTokens` に思考の budget を足す〔`adjustMaxTokensForThinking`〕ので落ちる）。二重の防御として、`guardProvider` は送る直前の payload の `max_tokens` / `max_output_tokens` を guard の上限以下に抑える（`capOutputTokens`）。注意: 思考で `max_tokens` を使い切ると答えが切れる（consult の既定 8192 に対して high の思考が大きいと起こりうる）ので、`max_output_tokens` を余裕を持って渡す。
    - **見えるところ**: `models_list` の各モデルに `effort`（最終の値）、`task_status`・`task_result` に `effort`（model と並べて。TaskDO の `task.effort` にタスクの開始時の値を保存し、D10 より前の行は現在の設定から求める）。`instructions` と `models_list` の説明に「思考レベルはモデルごとに決まっている（effort）。考える量が多いほど出力トークン＝費用が増える」と書く。agent は自分の env の `MODEL_EFFORTS` で実際の値を決めるので、gateway と同じ値にする（食い違うと表示と実際がずれる）。
    - **モデルの 4xx と 5xx の区別**: `consult` でモデルがリクエストの中身を拒否した（4xx。例 400 `invalid_request_error`）とき、以前は gateway が `upstream_unavailable` と `retry_after_seconds: 30` を返していた（待っても直らないのに再試行を促す）。agents の pi-ai 経路は非 2xx を `CloudflareAIError` にして、メッセージの `diagnostics`（`type: "cloudflare-error"`）の `details.status` に載せるので、エラー文は解釈せずそのステータスで分ける（`upstreamStatus`）。4xx（408・425・429 を除く）は agent が `model_rejected` を返し、gateway が新しいエラーコード `model_rejected`（`retry_after_seconds` なし。入力か model を変える）にする。HTTP の 4xx は生成の前に拒否された応答なので課金されず、usage が無くても費用は 0 で精算する。5xx・429（レート制限）・408・ステータスなし（ストリームの途中の失敗・タイムアウト）は従来どおり `model_error` → `upstream_unavailable`（usage が無ければ予約額で精算）。タスク側にも同じ区別を付けた: 最後のモデル呼び出しが 4xx なら終端の `reason` が `model_rejected: ...`（それ以外は `model_error: ...`）。
  - **AI への伝え方（instructions と説明）**: `models_list` でモデルと単価を見てタスクの難しさで `model` を選ぶこと、`budget_status` で残りを確かめること、`consult` の使い方（設計の相談・レビューのセカンドオピニオン。前置きを毎回同じにするとキャッシュが効く）を足した。D9 の受入で見つかった 2 点も直した: `task_start` の説明に、`verification_commands` でシェルの機能（パイプなど）を使うなら `["sh", "-c", "..."]` で包むこと、`task_result` の説明と instructions に、終端の直後はエージェントの停止の確認まで数秒 `not_ready` が返るので `task_wait` か少し待って呼び直すこと。
  - **退けた案**: 手書きの単価表のまま（カタログとずれて過少見積もりになった）。gateway に AI バインディングを足して consult を直接呼ぶ（thinking の補正と guard を二重に持つ）。専用の `ConsultDO` クラス。`reserve()` の再利用（同時実行の枠を埋めるので、タスクの実行中に consult できなくなる）。Cloudflare の API トークンで AI Gateway のクレジット残高を取る（トークンの管理が増える。今回は入れない）。OpenAI のモデル用に別の呼び出し経路を作る（AI バインディング経由で足りる）。
  - 受入は `acceptance.md` の 22 節。
- **プロバイダーキーの有無で使えるモデルを決める・Workers AI のモデル（D10b、2026-10-20 決定）**: AI Gateway は byok_only（Require provider credentials）が有効で、Anthropic / OpenAI のキーが BYOK 登録されていないとそのプロバイダーのモデルは 400 で失敗する。そこで、キーが無いプロバイダーのモデルは選べないようにし、どちらのキーも無ければ Workers AI のモデルだけが使えるようにする。
  - **キーの読み方**: gateway が Cloudflare API の List provider keys（`GET /accounts/{account_id}/ai-gateway/gateways/{gateway_id}/provider_configs`。権限は Account / AI Gateway / Read だけの読み取り専用トークン）で登録済みのキーを読む。応答は `{success, result: [{id, alias, default_config, gateway_id, modified_at, provider_slug, secret_id, secret_preview, ...}]}` で、`result_info` は無く `page` / `per_page`（最大 100）で読む（件数が `per_page` に達する間だけ次のページ。5 ページまで）。**使うのは `provider_slug` と `alias` だけ**で、`secret_preview` などは読まず、保持せず、ログにも出さない。**判定は `alias === "default"` のキーがある `anthropic` / `openai` だけ**（AI バインディング経路は default alias のキーしか参照しない。Cloudflare の Unified Billing の資格情報の優先順位の docs）。`default_config` は使わない。Workers AI はキー不要なので常に available。
  - **使う設定**: secret の `CLOUDFLARE_API_TOKEN`、vars の `CLOUDFLARE_ACCOUNT_ID`（公開の upstream には書かない。deploy.example はプレースホルダ）と `AI_GATEWAY_ID`（agent と同じ値。gateway の vars に足した）。どれかが空なら判定せず、従来どおり `AGENT_MODELS` だけで決める。接続先の上書き `CLOUDFLARE_API_BASE` は `ENVIRONMENT=test` のときだけ効く（E2E の偽サーバー用）。account id と gateway id は `^[A-Za-z0-9_-]{1,64}$` に合うときだけ URL に入れる。
  - **キャッシュ**: KV（`OAUTH_KV`。キー `provider-keys:<account>:<gateway>`）に `{checkedAt, providers}` だけを置く。5 分は fresh で API を呼ばない。5 分を過ぎたら取り直す。**API が失敗したら直前のキャッシュ（24 時間まで）を使い、無ければ「判定できない」として `AGENT_MODELS` だけで決める（従来どおり）**。失敗の直後 60 秒は取り直さない（API が落ちているときにリクエストごとに 3 秒待たない）。KV を選んだ理由: 新しい DO / KV を足すと 下流のインフラ側の変更と migration が要る。`caches.default` は colo 単位で、失敗時に古い値を使う作りにできない。OAUTH_KV は既に実行時の状態（テスト用の台本など）に使っていて、結果は全ユーザー共通で小さく、最終的に整合すれば足りる。**fail-open にしすぎない理由**: 判定できないときに通すのは「従来の動き」で、`AGENT_MODELS`（運用者の許可リスト）の外には広がらない。キーの無いモデルを通しても byok_only の 400 で課金なしに失敗するが、タスクの予約・Draft PR の作成まで進んでしまうので、キーの状態が分かっているときは先に拒否する。API の障害のたびに全部のモデルを止める（fail-closed）と、キーがあるのに使えなくなる。
  - **見えるところ**: `models_list` の各モデルに `available`（boolean）と、使えないときの `unavailable_reason`（`no_provider_key`）。`default: true` は model を省略したときのモデル。`task_start` と `consult` は available でないモデルを新しいエラーコード `model_unavailable`（メッセージに models_list とキー登録の案内。トークンは出さない）で、予約より前に拒否する。AGENT_MODELS の外は従来どおり `invalid_input`。
  - **既定のモデル（model 省略時）**: `AGENT_MODEL` が available ならそれ。そうでなければ、available なモデルから**固定の順序**（`packages/models` の `DEFAULT_MODEL_ORDER`。unit テストで固定）で最初のもの: Anthropic（sonnet → haiku → opus → fable）→ `gpt-oss-120b` → 残りの Workers AI（gpt-oss-20b、qwen3.8-27b、nemotron-3-120b-a12b、glm-4.7-flash、gemma-4-26b-a4b-it）→ OpenAI（sol → luna → astra）。したがって Anthropic のキーが無ければ OpenAI のキーがあっても `gpt-oss-120b`（OpenAI より先）。1 つも無ければ `model_unavailable`。service が実際に使うモデルを決めて TaskDO に渡す（`task_status` / `task_result` の `model` は実際に使ったもの）。判定できないときは従来どおり `AGENT_MODEL`。
  - **Workers AI のモデル（無料プランで使えるものだけ）**: `gpt-oss-120b`、`gpt-oss-20b`、`qwen3.8-27b`、`nemotron-3-120b-a12b`、`glm-4.7-flash`、`gemma-4-26b-a4b-it`。kimi-k2.7-code・glm-5.2 / 5.3 / 5.3-flash・deepseek-v4 は有料プラン専用なので入れない（無料プランの運用者が選んで失敗しないように）。Workers AI は顧客データを学習に使わない（Workers AI の docs の Data usage）。rovo の id は `workers-ai/@cf/<vendor>/<model>`（pi-ai の gateway カタログのキーと同じ。`MODEL_CATALOG_IDS` の値も同じ文字列）。**Pi（agents の `createAI`）に渡す id は `@cf/...`**: `createAI` は `workers-ai/` の specifier を TypeError で拒否し、`@cf/` の id を `api: "cloudflare-ai"` のモデルとして `env.AI.run(model, body, {gateway: {id}})` に流す（`packages/models` の `piModelId`、agent の `model-access.ts`）。tools（`tool_calls`）・`reasoning_effort`・`max_tokens`・usage（`stream_options.include_usage`）の経路は agents の pi-ai 経路が持っていて、fake の AI バインディングの unit テストで確かめた。思考レベルは Pi の `reasoning`（low / medium / high）から `reasoning_effort` になる。thinking の補正（`fixAnthropicThinking`）は `anthropic-messages` か id に `claude` を含むモデルだけなので Workers AI には掛からない。出力上限の二重化（`capOutputTokens`）は `max_completion_tokens` も下げるようにした（agents の quirk が書き換える先。6 モデルは `max_tokens` のまま）。
  - **思考レベル**: 6 つとも `low` から。gemma-4-26b-a4b-it だけは Workers AI のレジストリの `thinkingLevelMap` で `low` / `medium` が null（`off` と `high` だけ）なので、受け付ける思考レベルの最小の `high`（`off` も受け付ける。`MODEL_EFFORTS` で `off` にできる）。`thinkingLevelMap` は gateway カタログには無いので、Workers AI のモデルだけ `cloudflare-workers-ai.models` から読む（Pi が実際に使うレジストリ）。
  - **単価**: pi-ai のカタログの USD 単価（gpt-oss-120b は 入力 $0.35 / 出力 $0.75 per 1M tokens など）で予算を管理する。Workers AI の実際の課金は Neurons（無料枠は 1 日 1 万 Neuron）で、USD 単価との差は管理しない（Neurons の使用量は Cloudflare の画面で見る）。カタログの単価は有料プランの超過分の目安で、無料枠の間は実費が 0 でも、rovo の予算は単価で減る（予算の約束を緩めない側に倒した）。
  - **退けた案**: Workers AI のモデルを AGENT_MODELS なしで常に使えるようにする（運用者の許可リストを迂回する）。有料プラン専用のモデルを入れる（無料プランで失敗する）。キー判定を DO に持つ（infra の変更と migration が要る）。判定できないときに全モデルを止める（API の障害でキーがあっても使えなくなる）。
- **モデルの自動選択（task_start で model を省略したとき。2026-10-22）**: 省略したときは既定（sonnet）にせず、Workers AI の決定モデル Clef がタスクの内容から使うモデルを選ぶ。指定すればそのモデル。Sandbox の大きさの自動判断（上の昇格）と同じ流儀（flash に聞き、曖昧なときだけ clef で聞き直す。失敗は fail-soft）で、`apps/gateway/src/model-selection.ts`（純粋関数と、`AI.run` を引数で受け取る判定）に置く。
  - **置き場所**: gateway の `task_start`（`createTaskService().start`）の中、`resolveModel`（使えるモデルの検証。省略時の既定もここで決まる）の後、予約（UserDO.reserve）と TaskDO を作る前。**TaskDO に新しい RPC は足さない**（本番で DO の新しいメソッドがデプロイ直後に TypeError になった前例がある）。選んだモデルと記録は、既存の `ensureCreated` の入力（`model` と、足した `model_selection`）に載せる。gateway に `ai` バインディングを足した（新しい secret は無し。AI Gateway は既存の `AI_GATEWAY_ID`。**空なら Clef を呼ばず既定のモデル（`fallback_unconfigured`）**: agent の昇格の判断・web と同じ fail closed。metadata は `caller` と `userId` だけ）。
  - **候補**: env `AUTO_MODEL_CANDIDATES`（カンマ区切り。未設定は `haiku,sonnet,opus`。**fable は既定に入れない**。env で足せる。空文字は自動選択をしない）∩ 使えるモデル（`AGENT_MODELS` にあり、D10b のプロバイダーのキーが使えるもの）。等級（haiku < sonnet < opus < fable。費用の安い順）が分かる Anthropic のモデルだけで、同じ等級は env で先に書いたほう 1 つ。**openai/*・workers-ai/* は env に書いても候補にしない（弾く）**: 4 段の等級に他社のモデルを当てはめる根拠が無く、Workers AI のモデルは「キーが無いときの代わり」で役割が違う（自動で選ぶと、Anthropic のキーがあるのに弱いモデルで始まりうる）。候補が 1 つならそれ（`single_candidate`）、0 なら既定（`no_candidates`）で、Clef を呼ばない。
  - **質問**: 1 問の `score` で、段の数 = 候補の数（費用の安い順）。各段の criteria は仕事の性質で書き、**モデル名・「既定は sonnet」は書かない**（haiku: 機械的・小さな変更 / sonnet: 複数ファイルの普通の実装・テストを書く・バグ修正 / opus: 設計を伴う・広範囲のリファクタ・原因不明のデバッグ・並行性やセキュリティの難所 / fable: 極端に重い作業。最も安い段には「それより軽いものも含む」、最も重い段には「それより重いものも含む」を足す）。補助の `noul` 質問は足さなかった（score だけで見本 20 件中 18 件が期待どおりで、足す根拠がなかった）。入力は JSON の state に title・instructions・acceptance_criteria・verification_commands（argv を連結した 1 行）・repository（owner を除いた名前）。秘密らしい値は `maskSecrets` で伏せる。出力は無料なので、聞くのは 1 問。
  - **窓（clef-flash は 24,576 tokens、超えるとエラーで黙って切られない）**: instructions の上限は 100,000 文字（task_start の入力検証）で窓を超えうる。**clef に回さず、先頭 3,500 文字と末尾 1,500 文字を残して切る**（元の長さは `instructions_chars` に入れる）。理由: clef は遅く、同期の MCP 呼び出し（全体 3 秒）に収まらない。長い指示でも意図は先頭と末尾（目的と完了条件）にある。受け入れ条件は 15 件×250 文字、検証コマンドは 5 件×150 文字、title は 200 文字まで。全体は約 1 万文字以下で、実測は 26,000 文字のログを貼った指示でも 2,559 tokens。
  - **判断の流れ**: (1) flash に聞く。確率から「その段以上」の累積確率を作る。(2) **累積確率が 0.5 以上のうち、いちばん重い段を選ぶ**（どれも届かなければ最も安い段）。(3) 累積確率が **0.3 以上 0.7 未満**の段が 1 つでもあれば、clef で聞き直し、**段ごとに大きいほうの確率で決める**（軽く見積もって失敗する損のほうが、重く見積もって費用が増える損より大きい。sizing と同じ非対称）。clef が失敗したら flash の答え。(4) 失敗（例外・時間切れ・想定外の応答・段の数が合わない答え）は **1 回 1.5 秒・最大 2 回、全体 3 秒**。それでも駄目なら既定のモデルで、task_start は失敗させない。Clef が返すのは段の確率で、段 → 候補の対応はこちらが持つので、候補外のモデルは構造上選ばれない。閾値は env `AUTO_MODEL_CLEF_THRESHOLDS`（`up=0.5,band=0.3-0.7`。書いたキーだけ上書き。不正な値は丸ごと既定に戻して警告）で変えられる。
  - **実験の根拠（2026-10-22。見本 20 件は `apps/gateway/test/fixtures/model-selection-samples.json`、実 Clef の確率は `model-selection-clef.json`。測るスクリプトは `scripts/clef-model-experiment.mjs`）**: 同じ入力は同じ確率になった。20 件中 18 件が期待どおり（haiku 期待 5 件中 4、sonnet 期待 8 件中 7、opus 期待 7 件中 7）。食い違いは 2 件で、閾値を合わせて消していない: 「関数名の改名（7 か所）」を期待 haiku としたが flash も clef も sonnet 寄り（累積 0.65 / 0.75）、「原因不明のテスト落ちを直して」と一行だけの指示を期待 sonnet としたが、clef が opus 寄り（累積 0.56）で、flash（0.47）との大きいほうで opus になった（原因が分からない指示なので、強いモデルに倒れるのは許容した）。clef で聞き直すのは 5 件（25%）。往復は flash が約 200〜800 ms、clef が約 250〜850 ms（flash + clef でも 2 秒未満）。
  - **記録**: タスクの `model_selection: {mode: "auto" | "explicit", chosen, reason, scores?, latency_ms?}`。reason は固定のコード（`explicit` / `single_candidate` / `no_candidates` / `clef_flash` / `clef_cascade` / `fallback_unconfigured` / `fallback_timeout` / `fallback_error` / `fallback_invalid`）。scores は段ごとの「その段以上」の確率（最も安い段は常に 1 なので入れない。候補のモデル id がキー）。`task_start`（と `model`）・`task_status`・`task_result` の応答に出し、TaskDO の `task.model_selection` 列（JSON。無ければ NULL = 古いタスクで、キーを付けない）に保存する。ダッシュボードの `TaskDetailDto.settings.model_selection` は `{mode, reason}` だけ（確率・時間は出さない）で、詳細の「設定」に「モデルの選び方: 自動（Clef が内容から選んだ）」を 1 行出す。ログには指示文・例外の文面・トークンを出さない（固定のコードだけ）。
  - **冪等キー**: fingerprint は「model 省略」のまま。TaskDO の fingerprint は rovo が選んだモデル（`mode: "auto"`）を含めない（含めると、同じ idempotency_key の再試行で Clef の答えが変わったときに conflict になる）。この変更より前に model を省略して作られたタスク（fingerprint に既定のモデルが入っている）の再試行も同じタスクとして扱う。再試行でも Clef は呼ばれるが、最初の選択が残る。予約額は選んだモデルに関係なく `TASK_BUDGET_USD`、effort はモデルごとの固定値。
  - **退けた案**: TaskDO の中で選ぶ・新しい RPC を足す（前例の TypeError）。clef を常に使う（遅く、同期の呼び出しの 3 秒に収まらない）。指示が長いときに clef に回す（同上）。モデル名や「既定は sonnet」を質問の文に書く（Clef が名前の印象で答える）。openai/*・workers-ai/* を候補に入れる（等級を当てはめる根拠が無い）。閾値を見本の 2 件の食い違いに合わせて動かす（同じデータへの過学習）。
  - 受入は `acceptance.md` の 23 節。
- **デプロイを簡単にする（D12、2026-10-20 決定）**: 手順は 4 節（terraform apply → BYOK → GitHub App → deploy.example/ を deploy/ にコピーして `<...>` を埋める → deploy:secrets → deploy:all）で、人が作る Cloudflare のトークンが 2、人が入力する secret が 5、wrangler の設定に手で書く値が 9 か所（gateway 7 + agent 1 + web 1。`AI_GATEWAY_ID` ×3、`AGENT_MODEL(S)` / `MODEL_EFFORTS` / `WEB_BROWSE_ENABLED` の重複、account id、バケット名、Worker 名も重複していた）あった。目標は、トークン 2→1（Terraform 用だけ）、人が入力・用意する secret 5→2（GitHub App の Client secret と `.pem` のパス）、wrangler の設定に手で書く値 9→0（秘密でない値は下流の設定ファイル 1 つ）、手順は `mise run setup` 1 本 + 画面の作業（GitHub App の作成、BYOK の登録）。
  - **設定ファイル `rovo.config.json`**（下流が書く唯一の設定。秘密でない値だけ）: account id、`namePrefix`、`workerNames`、`publicBaseUrl`、GitHub App の ID と Client ID、認可（org / team / user ID）、予算、`AGENT_MODEL` / `AGENT_MODELS` / `MODEL_EFFORTS`、`WEB_BROWSE_ENABLED`、雛形の他の var の上書き。形式は JSON（node で読むだけで依存を増やさない）。重複していた値は 1 か所から全体に反映する。
  - **生成してコミットする**: `deploy:config`（`scripts/deploy-config.mjs`）が、`deploy.example/`（`<NAME>` のプレースホルダ入りの雛形）に `rovo.config.json` と Terraform の非秘密の出力 4 つ（`kv_namespace_id` / `archive_bucket_name` / `ai_gateway_id` / `ai_web_gateway_id`。後者は web 専用の byok_only なしの Gateway で、Web Search API をクレジットで払うために分けた）を埋め、`deploy/{gateway,agent,web}.wrangler.jsonc` と `deploy/infra.json`（Terraform の出力の保存）を作る。デプロイの時に Terraform を読まないので、普段のデプロイと CI に Terraform 用の強いトークンは要らない。`deploy:config:check`（`--check`）は、Terraform を読まず、保存済みの `infra.json` から作り直した結果と既存の生成物をバイト比較する（下流の CI 用。CI の変更は下流が行う）。Terraform の出力は `-json`（sensitive の値も平文で出る）を使わず、名前指定の `-raw` で 4 つだけ読む。生成物には `deploy.sh` の検査（`<...>` の残り・upstream の設定への symlink）がそのままかかる。
  - **gateway の読み取り用トークンを Terraform で作る**: `cloudflare_api_token.ai_gateway_read`（権限グループ「AI Gateway Read」だけ。resources は `com.cloudflare.api.account.<account_id>` = `*`）。権限グループは名前で検索し、`ai_gateway_read_permission_group_id` で上書きできる（mock のテストと、名前が変わったとき）。値は sensitive の output `gateway_cloudflare_api_token`。state に平文で残る（Logpush 用トークンと同じ扱い）。
  - **secret の入れ方**: 既定は「入っていないものだけ入れる」（`wrangler secret list` で確かめる。読めなければ止まる）。`TOKEN_ENC_KEY` を誤って変えると全員が再ログインになり、`setup` を冪等にもするため。入れ直しは `--rotate <名前>`。`TOKEN_ENC_KEY` は gateway と agent で別の値を `openssl rand -base64 32` で作る（結合が無く、分けたほうが漏えい時の影響が狭い）。`CLOUDFLARE_API_TOKEN` は `terraform output -raw` を、秘密鍵は `.pem` を PKCS#8 に変換して、標準入力で `wrangler secret put` に流す（引数・env・ログに載せない）。事前の確認に失敗したら、何も put しない。人が入力するのは `GITHUB_APP_CLIENT_SECRET`（wrangler の隠した入力）だけ。
  - **`mise run setup`**: 前提の確認（mise・Docker・`CLOUDFLARE_API_TOKEN`・`wrangler login`・設定ファイル。欠けていたら何も実行しない）→ `terraform init` / `apply`（確認は対話。変数は設定ファイルから `-var-file` で渡す。初回の Logpush の 401 は再実行で通る旨を案内）→ `deploy:config` → `deploy:all` → `deploy:secrets` → GitHub App の作成画面に入れる値（Callback URL = `PUBLIC_BASE_URL/callback`、権限の表）と BYOK の手順の表示。順序は実績のある deploy:all → secrets（secret が入るまで gateway は fail-closed）。GitHub App は `PUBLIC_BASE_URL` が決まってから作るので、初回は `githubApp` を空のまま進め（GitHub App の secret は飛ばす）、作ったら ID を設定に入れて `setup` を再実行する。env の `CLOUDFLARE_API_TOKEN`（Terraform 用）は wrangler を呼ぶ手順には渡さない（wrangler は env を `wrangler login` より優先し、Workers の権限が無いと失敗するため）。
  - **退けた案**: `deploy:config` が毎回 `terraform output -json` を読む（強いトークンが要る。sensitive の値が混ざる）。`TOKEN_ENC_KEY` を gateway と agent で共通にする（漏えい時の影響が広がる）。既定で secret を上書きする（再ログイン）。設定ファイルを toml にする（node に依存を足す）。
  - **食い違いの修正**: web の `browser` バインディングは upstream の `wrangler.jsonc` も `deploy.example/` も常に宣言している。コードが使うのは `WEB_BROWSE_ENABLED` が `"true"` のときだけ（`apps/web/src/service.ts` は有効の確認の後でしか `env.BROWSER` を触らない）。docs の「`web_browse` を使う場合だけ」は「宣言は常にある。使うのは有効なときだけ」に直した。Browser Run の無いアカウントで宣言だけでデプロイが通るかは未確認。`AGENT_MODELS` の例は `deploy.example/` の値（`gpt-oss-20b` を含む）に揃えた。
  - 未確認: 実アカウントでの `setup` の通し、Terraform 用トークンが「AI Gateway Read」のトークンを作れるか。
- **手で扱う secret を 0 にする（D12b、2026-10-20 決定）**: D12 の後に残った手作業は、GitHub App の作成（画面で設定を入れ、Client secret と `.pem` を控えて渡す）と BYOK のキー（ダッシュボードで登録）。目標は、デプロイする人が手で扱う secret を 0 にすること。
  - **GitHub App を manifest フロー（公式）で自動作成する**（`mise run github-app`、`setup` が `githubApp` の空のときに `deploy:all` の後で呼ぶ）。`127.0.0.1` のランダムなポートに一時の HTTP サーバー → ブラウザで手元のページ（manifest + state〔CSRF 用の乱数〕のフォーム）→ GitHub へ POST → 利用者が「Create GitHub App」を押す → `redirect_url`（`http://127.0.0.1:<port>/callback?code&state`）に戻る → state を照合 → `POST /app-manifests/{code}/conversions`（認証不要、201）。manifest は docs/deploy.md の 4 のとおり（権限は 6 と同じ。Webhook 無効）。作成先は `allowed.org` が既定で、`--org` / `--personal` で選ぶ。
  - **secret はディスクを通さない**: `client_secret` と `pem` は応答からメモリを経て `deploy.sh secrets --github-app-stdin`（標準入力の JSON）→ `openssl pkcs8`（標準入力）→ `wrangler secret put`（標準入力）。`webhook_secret` は使わないので捨てる。`id` と `client_id` だけ `rovo.config.json` に書く（既存の整形を保ち、書いた結果が githubApp 以外を変えないことを確かめてから置き換える）。secret の put → 設定の更新 → `deploy:config --no-terraform` → gateway の再デプロイ（`GITHUB_APP_ID` / `GITHUB_APP_CLIENT_ID` が vars なので）の順。
  - **失敗は何も書かずに止まる**: 時間切れ（既定 15 分）、state の不一致、`code` 無し、conversions の失敗・応答の欠け。secret の put に失敗したら設定を書かない（その App の client secret と pem は残っていないので、GitHub の画面で削除してやり直す）。一時サーバーは `Host` が `127.0.0.1:<port>` の GET だけを受ける。
  - **「ユーザーのトークンに期限を付ける」は manifest で指定できるか docs に書かれていない**ので、作成後に App の設定画面（Optional features）で確かめるよう案内する。Install はブラウザの作業として残る（`https://github.com/apps/<slug>/installations/new` を開く）。
  - **BYOK を CLI で登録する**（`mise run byok -- <anthropic|openai>`）: Cloudflare API の `POST /accounts/{accountId}/ai-gateway/gateways/{ai_gateway_id}/provider_configs`（body `{ provider_slug, alias: "default", default_config: true, secret }`）。`accountId` は `rovo.config.json`、ゲートウェイの id は `deploy/infra.json`、認証は env の `CLOUDFLARE_API_TOKEN`（Terraform 用）。キーは隠した入力（TTY の echo を切る）で受け取り、引数・env・ログ・ファイルに出さない。既に `default` があれば list で確かめて上書き（`PUT .../provider_configs/{id}`）するかを聞く。403 のときは必要な権限（AI Gateway Edit、Secrets Store の可能性）を案内して止まる。`setup` は案内だけで自動では実行しない（キーの入力が要る）。
  - **退けた案**: client secret / pem を一時ファイルに書いて既存の `--pem` に渡す（ディスクに残る）。secret を env で渡す（プロセスの環境に残る）。キーを引数で渡す（プロセス一覧に見える）。BYOK を `setup` の中で自動実行する（キーの入力が要る）。
  - **未確認（実機）**: GitHub が manifest を受理するか（`redirect_url` が loopback の http で通るか）、User-to-server token expiration の既定、BYOK の API が body の `secret` を直接受けるか（docs には Secrets Store に `{gateway_id}_{provider_slug}_{alias}` の名前で先に secret を作る手順もある）、Terraform 用トークンの権限で足りるか（Secrets Store）、上書きが `PUT .../provider_configs/{id}` でよいか。
- **Sandbox コンテナの大きさを指定できるようにする（D13、2026-10-20 決定）**: 本番の利用者から、子の Sandbox で `npm test` がローカルの約 80 倍遅く（2.2 秒 → 171 秒）、`npm ci` も 190 秒かかり、途中で「Network connection lost」でコンテナが再起動して（`sandbox_restarts: 1`）`node_modules` が消えた、と報告があった。原因は、`scheduling_policy: durable_object` のとき wrangler の `instance_type` が効かず、SandboxDO の `ctx.container.start()` が `instance` を指定していないため、既定の `lite`（1/16 vCPU、256 MiB、2 GB）で動いていたこと。再起動はメモリ不足の可能性が高い（推測。下の「再起動の理由」）。
  - **agent の var `SANDBOX_INSTANCE`** を `start()` の `instance` に渡す。受け付けるのは名前付きの 5 種類（`lite` / `standard-1` / `standard-2` / `standard-3` / `standard-4`）だけ。**既定は `standard-2`**（1 vCPU、6 GiB、12 GB。ユーザーの決定）。不正な値・空は `standard-2` に戻し、警告のログだけ出す（起動はエラーにしない。`MODEL_EFFORTS` と同じ流儀）。一方、デプロイ設定の生成器（`deploy:config`）は、`rovo.config.json` の `sandbox.instance` が 5 種類以外ならエラーにする（デプロイ前に気づけるため）。カスタムの `{vcpu, memoryMib, diskMb}` は扱わない。
  - **単価は大きさから決める**: 表（大きさごとの vCPU・メモリ・ディスクと、Containers の単価）は `packages/models/src/sandbox.ts` の 1 か所。`sandboxUsdPerHour(instance)` が CPU 100% 稼働の上限側で 1 時間あたりを計算し、小数 4 桁に**切り上げる**（少なく数えない）。`standard-2` は `1*3600*0.00002 + 6*3600*0.0000025 + 12*3600*0.00000007 = $0.129024` → `0.1291`。この単価を使うのは gateway（要約の `sandbox_usd_estimate`）だけで、agent は使わない。gateway の `SANDBOX_USD_PER_HOUR` の既定は `standard-2` の値で、明示の値があればそれを優先する（上書きできる）。`deploy:config` は `sandbox.instance` から agent の `SANDBOX_INSTANCE` と gateway の `SANDBOX_USD_PER_HOUR` の両方を決める（`vars.gateway.SANDBOX_USD_PER_HOUR` を書けばそれを優先）。gateway と agent は別 Worker で、gateway は agent の `SANDBOX_INSTANCE` を読めないので、デプロイ設定で揃える。
  - **再起動の理由（調査）**: Workers の `Container` API は終了コードも OOM かどうかも返さない（`monitor()` は `Promise<void>`、`inspect()` は labels と image だけ）。SandboxDO が分かるのは「動いているはずのコンテナが止まっていて、`start` し直した」ことだけ（`restarts` に数えている）。メモリ不足（exit 137）と他の停止（Network connection lost など）を区別して記録することはできないので、新しいイベントは足さない。大きさを上げて再発するかで切り分ける。
  - **退けた案**: wrangler の `instance_type`（`durable_object` では効かない）。大きさをタスクごとに選ばせる（この時点では退けた。次の「Sandbox の大きさの使い分け」で改めて入れた）。単価を agent も持つ（agent は使わない）。
- **Sandbox の大きさの使い分けと、必要になるまで起動しない（D13 の続き、2026-10-20 決定）**: 実測で、`standard-2`（1 vCPU）では gateway の unit が 4〜5 分かかる（18 コアの手元では 13 秒）。一方、編集だけ・web 検索だけのタスクに大きな Sandbox は要らない。動いているコンテナの大きさは変えられないので、大きさは起動のときに決める。第一段階として次を入れた（後段の「小さく起動し、重いコマンドの初回でスナップショットを取って大きい Sandbox で起動し直す（昇格）」は、まだ入れていない）。
  - **必要になるまで Sandbox を起動しない（lazy boot）**: 以前は `start` の直後（`AgentDO.doLaunch`）に `SandboxDO.ensureReady` を呼んでから子を走らせていた。今は `doLaunch` は子を走らせるだけで、**子が最初に Sandbox を使うツール（ファイルの読み書き・コマンドの実行・git など = `SandboxPort` の `exec` / `readFile` / `writeFile`）を呼んだとき**に `AgentDO.ensureSandboxReady` が `ensureReady` を呼ぶ（同時の呼び出しは 1 つを共有。起動済みの印は `sandbox_booted`）。依存キャッシュ（D14）の待ち・復元、ブランチの clone、傍受の登録は、従来どおり `ensureReady`（起動）の中でまとめて行う（順序は変えない）。起動の失敗は、**rovo の側で**最大 3 回まで再試行し（`setup_attempts` を永続化。間隔は 5 秒。呼んだツールはその間待つ）、3 回とも失敗したら、モデルを介さずに `sandbox_setup_failed` で終える（以前は tick job が再試行していた。モデルに失敗を見せて判断させない）。起動を試みて失敗したタスクは、下の「起動せずに完了」の近道の対象にしない。`sandbox_runtime_ms` は SandboxDO がコンテナを動かした時間を数えるので、起動しなければ 0。`web_search` / `web_fetch` だけで進むタスクは Sandbox を起動しない。
  - **起動していない間の扱い**: 質問（`ask_parent`）は、未 commit の確認と期限の延長・設定をしない（守るコンテナもトークンも無い。起動するときの期限は、そのときの `deadlineAt()` から作る）。完了の申告（`report_completion`）は、**検証コマンドが無く、Sandbox を一度も起動しておらず、起動に失敗した試みも無ければ**、確かめるものが無いので起動せずに完了とする（作業ブランチは出発点 `initialSha` のままで、リモートも同じ。push も同期もしない）。検証コマンドがあれば、検証のために起動する。終端の patch の取得も、起動していなければ空の patch として扱い、起動しない。cancel・期限・予算の終端は従来どおり `terminate` を呼ぶ（起動していない Sandbox も終端にして、あとから起動されないようにする）。lazy boot の前に始まったタスク（`lazy_boot` の印が無く、投入済み）は、起動済みとして扱う（デプロイをまたぐ実行中のタスクの patch を失わないため）。
  - **`task_start` の `sandbox_instance`（任意）**: `standard-1` / `standard-2` / `standard-3` / `standard-4` だけ（**`lite` は選べない**。メモリ不足で落ちた実績がある。選べる集合は `packages/models` の `SELECTABLE_SANDBOX_INSTANCES` が出どころで、gateway の入力の検証と `sandbox_instances_list` の `selectable` が同じ集合から導く）。lite・未知の値は `invalid_input`。省略時は従来どおり agent の env の `SANDBOX_INSTANCE`。指定したら、そのタスクの間はずっとその大きさ（TaskSpec に `sandboxInstance` がある = 利用者が明示した。後段の自動の昇格もしない）。fingerprint は指定したときだけ足す（`model` の v4 と同じ流儀。省略した入力の fingerprint は変わらない。指定があれば v5 として `model`（無ければ null）の後ろに足す）。経路は `TaskSpec.sandboxInstance` → `WorkspaceSpec.instance` → `SandboxDO.boot` の `start({instance})`（`spec.instance` が env の既定より優先）。AgentDO と SandboxDO も `standard-1〜4` 以外を拒否する（fail-closed）。**依存キャッシュを作るコンテナ（`deps-<key>`）の大きさは既定のまま**（キャッシュはタスクの大きさに依らず共有されるので、変えない）。
  - **実際の大きさと費用**: SandboxDO は `start()` に渡した大きさを `instance` に覚え、`SandboxMetrics.instance` → `usage.sandbox.instance` → 公開の usage イベントの `sandbox_instance`（packages/models の表にある名前だけ通す）として gateway へ届く。`task_result` の `usage.sandbox_instance` に、**実際にコンテナを起動した大きさ**を返す（Sandbox を起動しなかったタスクには付かない）。`task_status` の `sandbox_instance` は、`task_start` で明示した値（省略したタスクは `null` = 既定）。要約（`task_summary`）の `sandbox_usd_estimate` は、報告された大きさの単価（`sandboxUsdPerHour`）で計算する（`summary.sandbox.instance` と、使った単価 `unit_prices.sandbox_usd_per_hour` も残す）。大きさが報告されなかったタスク（起動しなかった・古い agent）は、従来どおり `SANDBOX_USD_PER_HOUR`（既定は `standard-2`）。gateway にも var `SANDBOX_INSTANCE`（agent と同じ値。`deploy:config` が `sandbox.instance` から両方に入れる）を足した。`sandbox_instances_list` の `default` を決めるためで、単価の計算には使わない。
  - **`sandbox_instances_list`（MCP ツール）**: 入力なし。`{instances: [{name, vcpu, memory_gib, disk_gb, usd_per_hour, default, selectable}]}`。値は `packages/models` の表と `sandboxUsdPerHour` から作り、数値を二重に持たない（`task_start` の説明に数値は書かず、このツールを案内する）。`default: true` は gateway の `SANDBOX_INSTANCE`（不正な値・未設定は `standard-2`）。`lite` は `selectable: false`。
  - **子のシステムプロンプト**: `dependencies` の節が `SECTION_KEYS`（`pi/extension.ts`）に無く、実際のプロンプトに出ていなかったので足した（Pi の section は生成のたびに再評価され、内容が変わると後ろに足される）。起動前（`deps_cache` が未確定）は「最初のコマンドの前に導入される（キャッシュが使えれば速い）」と書き、`hit` / `built` が分かったら従来の「導入済み」の文になる。`testing` の節も足した。TDD の途中は、変更したファイルに関係するテストだけを流し（例 `vitest run <file>`）、全体のテストは完了報告の前に 1 回だけ流す。ファイルの末尾の改行を保つ。
  - **後段の昇格に向けて**: 昇格は「明示されていないタスク（`TaskSpec.sandboxInstance` が無い）だけ」が対象になる前提。lazy boot で、最初の Sandbox 使用が起動の唯一の入口（`ensureSandboxReady`）になったので、昇格の判断（コマンドの前に Clef が判断する）もこの入口の近くに置ける。
  - **昇格（2026-10-21 に規則で入れ、2026-10-22 に Clef に一本化。小さく始めて、コマンドの前に Clef が「足りない」と判断したら大きい Sandbox へ）**: 動いているコンテナの大きさは変えられない。実験で、`standard-2` で作ったスナップショットを `standard-3` で `start({ containerSnapshot, instance })` で戻せることを確かめた（スナップショットはイメージの版に結び付き、大きさには結び付かない。`node_modules` のネイティブのバイナリも動いた）。起動の既定は `standard-2` のまま。**判断は Workers AI の決定モデル Clef（`@cf/cloudflare/clef-flash`。曖昧なときだけ `@cf/cloudflare/clef`）だけが行う（ユーザー承認）**。コマンドの種類を表で判定する規則（旧 `heavy-command.ts`）・子が呼ぶツール `sandbox_scale_up`・検証コマンドの `heavy: true` による強制昇格は削除した。昇格の手順（下の「手順」）は旧来のまま。
    - **なぜ Clef に一本化したか**: 規則（argv のパターン）は表に無い重い処理（`make ci`、独自スクリプト）を見逃し、軽い `npm test` を誤検知する。子に判断させる `sandbox_scale_up` は、判断が子の自己申告に依り、ツールが増え、規則との二重管理（保険の的中の数え方など）が複雑だった。コマンドと「並列の手がかり」を見て判断する決定モデルなら、`vitest` の `maxWorkers` や `make -j` の指定まで読んで、2 vCPU で足りるか 4 vCPU が効くかを選び分けられる。
    - **実験の根拠（2026-10-22。生データはリポジトリに入れない）**: 質問は英語で、`criteria.true` / `criteria.false` を必須にする。3 問（重さ: `score` 0〜3 の P(2)+P(3) / 大きさ: `choice` の `standard-2` / `3` / `4` / 4 vCPU で 2 vCPU より明らかに速いか: `noul`）を **1 リクエストにまとめる**（出力は無料なので、まとめても費用は増えない）。state は JSON（コマンド・argv・cwd・今の大きさ・各大きさの vCPU とメモリ・リポジトリの文脈・直近 3 件のコマンド・並列の手がかり）。直近 8 件の履歴は逆効果だったので 3 件。手がかりありの flash で、大きさの一致は 85〜92%、3 と 4 の選び分けは 52 件中 46〜49 件。手がかりなしでは 3 と 4 を選び分けられない。flash の往復は中央値 約 350 ms・p95 約 1 秒。実装した質問と state の形で実際の Clef-flash を 20 回ほど呼んで、応答の形（`answers.weight.probabilities` の `"0"`〜`"3"`、`answers.size.probabilities`、`answers.beyond2.noul`、`usage.input_tokens`。入力は 830〜900 tokens）と、軽いコマンド（`ls`・`git status`）の重い確率が 0.06〜0.20、`make -j4` が 0.54〜0.58、`cargo build --release` が 0.83 になることを確かめた。一方、`pnpm test`（`maxWorkers: 4`）は 0.29〜0.43 と曖昧な帯に入り、clef での聞き直しになる（閾値 0.5 では上げ損ねやすい傾向がある。下の「残る課題」の閾値の見直しを参照）。`weight`（score）の質問文には、実験の文（`How CPU-heavy is the shell command in the state when run on a single CPU core?`）に `Take its parallelism settings into account.` を足した（同じ 10 件で、重い確率が 0.1 ほど高く出たため）。本番の実測（大きさを固定したベンチマーク）: CPU だけの並列処理は `standard-3` で 2.0 倍、`standard-4` で 3.5〜3.9 倍。gateway の vitest（1 つの workerd を共有する）は `standard-3` で 1.42 倍、`standard-4` でも 1.48 倍で頭打ち。**以前の「4 vCPU にしても速くならない」は vitest 固有の結果で、一般には当てはまらない**（並列に動く処理は `standard-4` で速くなる）。そのため `standard-4` は「速くならない」ではなく「並列の手がかりがあるときに選ぶ」大きさとして扱う。
    - **誰のコマンドを判断するか（出自）**: `ExecOptions.origin`（`agent_command` = 子の `bash` ツール、`verification` = 検証コマンド）が付いた `exec` だけが対象。Sandbox 自身の内部の `exec`（AgentDO の git・ファイルの確認・依存キャッシュの作成など）は `origin` が無く、聞かない（毎回 0.4〜1 秒の往復と serial の占有を避ける）。**これは「誰が実行するコマンドか」の区別で、「何が重いか」の規則ではない**（重さの判断は一切しない）。聞かない場合: `task_start` で `sandbox_instance` を明示したタスク（`fixed_instance` を 1 回だけ残す）、`SANDBOX_MAX_INSTANCE` が空・`off`、今の大きさがすでに上限、`AI_GATEWAY_ID` が空または `ai` バインディングが無い（警告のログ。今の大きさのまま実行する）。
    - **判断の流れ**（`apps/agent/src/sandbox-scale-decision.ts`。純粋関数と、AI.run を引数で受け取る判定）: (1) flash に 3 問を聞く。(2) **重い確率（P(2)+P(3)）< 0.5 なら上げない**。重いなら、4 vCPU で速い確率（`noul`）>= 0.4 で `standard-4`、そうでなければ `standard-3`。いずれも上限の範囲で、今の大きさより大きいときだけ（上げるだけ。下げない）。(3) flash の確率が**曖昧な帯**（重い確率が 0.2〜0.7、または、重いと判断して `standard-4` に届きうるときの 4 vCPU の確率が 0.2〜0.5）のときだけ、clef で聞き直し、**flash と clef の重い確率の大きいほうが 0.5 以上なら上げる**（clef が失敗したら flash だけ。0.7 を超えれば flash だけで上げる。4 vCPU の確率は clef の答え）。clef が失敗したら flash の答えを使い、3 と 4 で迷うときは `standard-3` に倒す（4 に上げ損ねても損は小さい。CPU は使った分だけ課金）。上記の閾値は実験で調整した値で、同じデータで調整したので、env `SANDBOX_CLEF_THRESHOLDS`（`heavy=0.5,four=0.4,heavy_band=0.3-0.7,four_band=0.2-0.5` の形。書いたキーだけ上書き。不正な値は既定に戻して警告）で変えられるようにしてある。何回でも上げられる（2 → 3 → 4）。上限は env `SANDBOX_MAX_INSTANCE`（`rovo.config.json` の `sandbox.maxInstance`。既定 `standard-4`。空・`off` で Clef による昇格を無効）。旧 `SANDBOX_HEAVY_INSTANCE` と `SANDBOX_AGENT_MAX_INSTANCE`（`sandbox.heavyInstance` / `sandbox.agentMaxInstance`）はこの 1 つにまとめた。
    - **Clef の呼び出し**: agent の既存の `ai` バインディングと `AI_GATEWAY_ID` を使う（Workers AI は BYOK 専用の AI Gateway でも通る）。**新しいバインディングも secret も足さない**（デプロイを簡単に保つ）。AI Gateway の metadata は web の `safety/clef.ts` にならい `caller: "sandbox_scale"` と `taskId`（`SandboxDO` は `userId` を持たないので入れない。`WorkspaceSpec` を増やさない）。失敗（例外・時間切れ・想定外の応答）は 1 回 5 秒・最大 3 回・合計 20 秒まで再試行し、それでも駄目なら今の大きさのまま実行する（fail-soft）。数秒の遅延は許容する。`@cf/cloudflare/clef-flash` の窓（24,576 tokens）を超える state は AI.run が例外にするので、state は各部分を切り詰めて数千 tokens に収める。
    - **並列の手がかり（事実の収集。規則ではない）**: コマンドの cwd と、その上の git のルートから、決まったファイル（`package.json` の `packageManager` / `workspaces` / `scripts`、vitest / jest / playwright / mocha の設定、`pyproject.toml` / `pytest.ini` / `setup.cfg`、`Cargo.toml` / `.cargo/config.toml`、`Makefile`、`gradle.properties`、`.bazelrc`、`turbo.json`、`nx.json` など）と、ロックファイルなどの有無を、**コンテナ内の node のスクリプト（`SCALE_FACTS_SCRIPT`）が生のテキストのまま**読む（実験では、生のテキストが JSON に整形したものと同等以上だった）。1 ファイル 1,500 文字・全体 6,000 文字まで。通常のファイルだけ（シンボリックリンクは辿らない）。**ファイルの一覧は「何を読むか」で、「何が重いか」の規則ではない。どのファイルが大事か・並列がいくつかの判断は Clef に任せる**（ユーザーは静的な判断を消すことを求めた）。タスクの中で一度集めて SandboxDO の storage に覚える（cwd ごとに最大 3 つ、10 分。集められなければ空で、覚えずに次回また試す）。**リポジトリの中身は非信頼のデータ**で、質問の側には混ぜず state にだけ入れる。悪意のある設定が Clef の答えを歪めても、影響は**大きさの選択だけ**で、上限（既定 `standard-4`）が費用を抑える（コマンドの実行・秘密・権限には及ばない）ので許容する。秘密らしい値は、コマンド・リポジトリの事実・直近のコマンドのすべてから伏せる（`maskSecrets`）。**既知の形式（`ghp_` や `sk-` など）だけで、`NPM_TOKEN=xxx` のような汎用の値は伏せられず、同じアカウントの Workers AI（AI Gateway 経由）に渡る**（既知の限界）。
    - **手順**: (a) 作業ツリーの指紋（HEAD・追跡ファイルの差分・追跡されていないファイルのハッシュ。`PROMOTE_STATE_SCRIPT`）を取る → (b) `snapshotContainer({name: promote-<task>-<回数>})`（2 分で打ち切り。名前は回数ごとに別で、重複の扱いに頼らない）→ (c) コンテナを破棄 → (d) `start({containerSnapshot, instance: 昇格先})` → (e) 傍受の登録・exec の応答・CA 証明書・指紋の一致を確かめ、基準プロセスを記録し直す → 元のコマンド。コンテナの作り直し（`restarts`）には数えない。以降の作り直しは最終の大きさで起動する（`boot` の大きさの解決は spec.instance → 昇格先 → env の既定）。昇格の失敗時は、最初の大きさではなく**今の大きさ**で起動し直す。実行中のコマンドとは `exec` と同じ直列（`serial`）で競合しない。
    - **fail-soft と理由コード**（`packages/models` の `SANDBOX_PROMOTION_REASONS`）: スナップショットが使えない・失敗 → 破棄せず小さいまま（`snapshot_unsupported` / `snapshot_failed` / `state_unreadable`）。昇格先の起動・確認に失敗 → 同じスナップショットで元の大きさに起動し直す（`start_failed` / `cert_missing` / `workspace_mismatch`）。それも失敗 → image からの起動に乗せて「再起動した」例外（`fallback_failed`）。昇格の途中の terminate は、起動したコンテナを残さず terminated の結果を返す。Clef の失敗は上記のとおり今の大きさのまま実行し、`promotion_failures` には混ぜず別に数える（`sandbox_scale_clef_failures`）。`already_large` は、上限に達していれば Clef を呼ばなくなったので付かない（古いタスクの記録としてだけ残る）。
    - **結果と費用**: `SandboxMetrics` に `promotedTo` / `promotedAt` / `runtimeMsBeforePromotion` / `promotionReason` / `promotions` / `promotionFailures`（既存の意味は変えない）→ 公開の usage イベントと `task_result` の `usage.sandbox_promoted_to` / `sandbox_promoted_at` / `sandbox_runtime_ms_before_promotion` / `sandbox_promotion_reason` / `sandbox_promotions`（`trigger` は `clef`）/ `sandbox_promotion_failures`。`usage.sandbox_instance` は最初の大きさのまま。`task_summary` の `sandbox_usd_estimate` は、大きさごとの区間（`sandbox_segments`）の時間 × その大きさの単価の合計。`sandbox_instances_list` の `auto_scale_max` が上限（旧 `promotion_target` と `agent_max` は 1 つにまとめた）。Sandbox の費用を予算に含めない扱いは変えない。依存キャッシュを作るコンテナ（`deps-<key>`）は昇格しない。
    - **振り返りの記録（usage。ユーザーは Clef の精度を後で振り返りたい。規則との比較の代わりに、判断ごとに残す）**: SandboxDO が判断のたびに記録を足す（直近 50 件。古い方から捨てる。storage の kv `scale_log`）: 判断した時刻・その時の大きさ（`from`）・判断の結果の大きさ（`to`。変えなければ `null`）・確率（`heavy` / `fast4` / `choice`）・使ったモデル（`flash` / `clef`）・Clef の所要（`clef_ms`）・そのコマンドの実行時間（`cmd_ms`。昇格の時間は含まない）と終了コード（`exit_code`）・コマンドの先頭の語（`cmd`。`argv[0]` の basename を 24 文字まで。子の bash ツールと検証コマンドは `bash -c "<コマンド>"` / `sh -c`（`-lc` なども）の形で exec されて `argv[0]` が常に `bash` になるので、この形のときはコマンド文字列の先頭の語を使う。環境変数の代入（`FOO=1`）・`cd <dir> &&`・前置き（`env` / `timeout` / `time` / `nice` など）は単純な規則で読み飛ばし、読めなければ（引用符・`$(` が閉じない、代入だけで区切りの後ろ、前置きの引数が想定外、コマンド名らしくない・秘密らしい語など）迷わず `argv[0]`（`bash`）に戻す。**先頭の語だけで、argv の全体・コマンド文字列は残さない**）。Clef が失敗した判断は `failed: true` で、確率とモデルが無い。集計（`scaleStats`。捨てずに数え続ける）: 判断の回数・上げた回数・Clef の失敗回数・上げなかったのに 60 秒を超えたコマンドの数。**TaskDO の storage の大きさに配慮**し、記録の一覧は終端の確定のときだけ AgentDO の usage に載せ（`runtimeMs` と同じ扱い。途中で usage イベントを増やさない）、gateway は**公開の usage イベントには集計の数値だけ**（`sandbox_scale_decisions` / `sandbox_scale_raised` / `sandbox_scale_clef_failures` / `sandbox_scale_slow_not_raised`。`usage_public` に覚える数値）を載せ、一覧は `task_result` の `usage.sandbox_scale_log` にだけ出す（`getResult` の usage から。最大 50 件で約 7 KB）。`task_summary` の `sandbox.scale` も集計だけ。 **`task_wait` の usage イベントでも、`sandbox_promotions` / `sandbox_promotion_failures` は `task_result` の usage と同じく配列で返す**（TaskDO の保存形は payload がプリミティブだけなので JSON 文字列のままで、gateway の service 層が返すときに配列へ戻す）。`sandbox_segments` は `task_summary`（`summary.json`）だけの項目で、usage には出さない（区間は `sandbox_promotions` と `sandbox_runtime_ms` から導ける）。既存の `sandbox_promotions` の `trigger` に `clef` を足し、`sandbox_segments`・`sandbox_promotion_failures` は維持する。**古いタスクの記録（`trigger` の `agent` / `rule` / `verification`、`rule_match`、`sandbox_heavy_commands_*`）は、gateway の sanitize・`summary.ts` で読めるまま残す**（`rule_match` は表を削除したので、小文字で始まる短い名前だけを通す）。
    - **振り返りの読み方**（タスクの集合 = 振り返りたい期間の、Sandbox を使った `task_result`）:

      | 知りたいこと | 見る項目 | 読み方 |
      |---|---|---|
      | 上げた割合 | `sandbox_scale_raised` ÷ `sandbox_scale_decisions` | 低すぎれば Clef が控えめ、高すぎれば上げすぎ。タスクの種類（テストを回すか）とあわせて読む |
      | 見落とし（上げなかったのに遅い） | `sandbox_scale_slow_not_raised`、`sandbox_scale_log` の `to: null` かつ `cmd_ms` が大きい | 0 より大きければ、そのコマンド（`cmd`）と確率（`heavy` / `fast4`）を見て、閾値（`SANDBOX_CLEF_THRESHOLDS`）の見直しや state の手がかりの不足を疑う |
      | 上げすぎ | `to` が `standard-4` の判断の `cmd_ms` | 4 vCPU にしても `cmd_ms` が短くならない（共有ランタイムの vitest など）なら、`fast4` の閾値を上げる。`standard-3` との所要の差は同じコマンドの前後でしか比べられないので、タスクの傾向として見る |
      | Clef の失敗 | `sandbox_scale_clef_failures`、`sandbox_scale_log` の `failed: true` | 多ければ AI Gateway・Workers AI の障害か、state の大きさ・形の問題。失敗した判断は今の大きさのまま実行されている |
      | 聞き直しの割合 | `sandbox_scale_log` の `model: "clef"` | 高ければ flash が曖昧な判断が多い。往復の時間（`clef_ms`）と費用（Clef の費用は AI Gateway の usage）に響く |
      | Clef の遅延 | `sandbox_scale_log` の `clef_ms` | 通常は 1 秒前後。数秒を超えれば再試行が起きている |
      | 昇格の失敗の内訳 | `sandbox_promotion_failures` | `reason` ごとに数える。`fallback_failed` は、その直前の昇格先の失敗（`start_failed` など）と対で 2 件出る（1 回の試みで 2 件） |
    - **退けた案**: 規則（argv の表）と Clef の併用（二重管理になり、「静的な判断を消す」要望に反する）。判断を子に任せる `sandbox_scale_up`（子の自己申告に依り、ツールが増える）。全 `exec` を Clef に聞く案（内部の git などまで 0.4〜1 秒の往復が乗る）。負荷（CPU・OOM）を見て後追いで上げる案（今回はやらない）。下げる機能。Sandbox が未起動のときに、起動の大きさだけを変えて最初から大きく起動する最適化（lazy boot の入口が増える。子は読み取りの後に呼ぶのが普通なので、起動してから上げる）。コストの予測しやすさは重視しない（ユーザー）。
    - **閾値の決定（2026-10-22。Opus の判断）**: 本番のベンチマークで gateway の vitest（`maxWorkers=2`）は `standard-3` で 1.42 倍速くなったので、この種のコマンドは必ず上げる側に入る必要がある。損は非対称（上げすぎはメモリ代と数秒、上げ損ねは時間）なので、聞き直しの帯の下端を 0.3 から 0.2 に下げ（重い確率 0.2 以上 0.7 未満で clef に聞き直す。上端は排他）、帯の中は max(flash の重い確率, clef の重い確率) >= 0.5 で決める（clef が失敗したら flash だけ。0.7 以上は flash だけで上げる）ことにした。既定値は env `SANDBOX_CLEF_THRESHOLDS` で変えられる。実 Clef で測った 10 コマンドの確率（下の表。flash の重い確率 score / noul、clef の score）は Unit のフィクスチャ（`sandbox-scale-decision.test.ts`）に入れて、`ls` / `git status` / `cat package.json` は上げない、`pnpm test`（`maxWorkers` 4 / 2 / `singleWorker`）・`pytest -n auto`・`cargo build --release`・`make -j4`・`pnpm build` は上げる、を固定した。実測: `ls -la` 0.08 / 0.08 / 0.02、`git status` 0.07 / 0.08 / 0.03、`cat package.json` 0.20 / 0.57 / 0.02、`pnpm test`（4）0.42 / 0.61 / 0.76、同（2）0.28 / 0.50 / 0.64、同（singleWorker）0.34 / 0.53 / 0.53、`make -j4` 0.58 / 0.75 / 0.15、`pytest -n auto` 0.57 / 0.68 / 0.76、`pnpm build` 0.53 / 0.78 / 0.29、`cargo build --release` 0.82 / 0.93 / 0.85。質問の型（score か noul か）は変えていない。`cat package.json` は flash の noul で誤検知する（0.57）ので、score を使い続ける。実タスクの `sandbox_scale_log`（確率・`cmd_ms`・`slow_not_raised`）で、上げすぎ・上げ損ねを見て再調整する。
    - **`fixed_instance` の扱い**: `task_start` で大きさを明示したタスクは Clef を呼ばないが、`sandbox_promotion_reason` と `sandbox_promotion_failures` には `trigger: clef`・`reason: fixed_instance` が 1 件だけ入る（旧実装の rule / verification と同じ扱い。「Clef による昇格を見送った理由」の意味）。
    - **その他の残る課題**: 昇格のスナップショットの一覧・削除の API が無い。ローカルの `wrangler dev`（workerd + Docker）は `snapshotContainer` と `containerSnapshot` での起動に対応しているので、`test:e2e:docker` が実コンテナで昇格（作業ツリーの未 commit の変更・傍受の CA・作り直しが昇格先で起動すること・コンテナ内でのリポジトリの設定の収集）まで通しで確かめる。Clef は E2E では呼ばず、応答を仕込む（`ENVIRONMENT=test` の `setClefForTest`）。判断の確率 → 大きさは `sandbox-scale-decision.ts` の Unit、見送り・起動の失敗・元の大きさでの起動し直し・Clef の失敗などの fail-soft の経路は SandboxDO の Unit（container の API と AI.run を差し替える）で確かめ、実際の Clef での精度と本番での確認は acceptance.md。
- **依存関係のキャッシュ（Containers のスナップショット）（D14、2026-10-20 決定）**: Sandbox を `standard-2` にした本番の実測で、x-mcp のタスクが 74.6 秒（Sandbox の時間が 67 秒）になった。内訳の大半は `npm ci` と vitest の起動で、毎回同じ導入をしている。依存関係を使い回す。**これは Phase 6 の「コンテナのスナップショットは見送る」（phase6.md、上の「復旧は push 済みのチェックポイントで成立している」）を改める決定**。見送った理由は復旧のためのスナップショットが要らないことで、今回は復旧ではなく**起動を速くする**ために使う。beta への依存は増えるが、使えなくても今までどおり動く（下の fail-soft）ので許容する。
  - **仕組み**: Containers のスナップショット（public beta。`ctx.container.snapshotContainer({name})` が書き込み可能なルートファイルシステムを保存し `{id, size, name?}` を返す。`start({containerSnapshot: {id}, ...})` で復元する。`image` とは同時に渡せない）。メモリ・プロセス・マウントは含まれない。別の Durable Object から復元できる。作ったイメージの版に結び付く。保持は 30 日（復元で延長）。一覧・削除の API は無い（TTL に任せ、GC は作らない）。`scheduling_policy: durable_object`（agent は満たしている）が要る。
  - **キャッシュ専用のコンテナで作る（タスクのコンテナを保存しない）**: タスクのコンテナを保存すると、作業ツリー（他のタスクの内容）が混ざる。そこで、キャッシュの鍵ごとに `DepsCacheDO`（agent の Worker。名前 = 鍵）を置き、`ensure()` が作成を 1 回だけ行わせる。作るのは **SandboxDO の別インスタンス（名前 `deps-<鍵>`）の `buildDepsSnapshot()`**。image で起動 → 傍受を登録（タスクと同じ許可リスト。外向きは遮断）→ `git init` + `fetch --depth 1 origin <base_sha>` + checkout → 導入 → すべての `node_modules` を `/opt/deps-cache/nm/<相対パス>` へ `mv`（ルートと、ワークスペースの各パッケージの `node_modules`。相対パスの一覧を `manifest` に書く）→ `/workspace` を空にする → `snapshotContainer({name: "deps-<鍵の先頭16桁>"})` → 破棄。スナップショットには node_modules とパッケージマネージャのキャッシュ（`~/.npm` など）だけが入り、リポジトリの作業状態は入らない。10 分で時間切れ。
    - **DepsCacheDO にコンテナを持たせなかった理由（当初の案からの変更）**: コンテナはクラスごとの `containers` の項目で宣言し、イメージもクラスごとに別の参照（`rovo-agent-<クラス名>-workspace@sha256:...`）で登録される。スナップショットは作ったイメージの版に結び付き、「別のクラス・別のアプリケーションのイメージで復元できるか」はドキュメントに無い。DepsCacheDO にコンテナを持たせると、タスク側（SandboxDO）のイメージと別の参照になり、復元できる保証がない。そこで、コンテナはこれまでどおり SandboxDO だけが持ち、DepsCacheDO は状態の管理（`building` / `ready` / `failed`、同時の `ensure` を 1 回にまとめる、クールダウン）だけをする。`containers` の項目を増やさないので、デプロイで増えるイメージも無い。
    - **DepsCacheDO の状態**: `building`（作成中）→ 成功で `ready {snapshotId, size, createdAt}`、失敗・時間切れで `failed {failedAt, cooldownMs}`。`ready` ならすぐ返す。`building` の間の `ensure` は同じ作成を待つ（待っただけの呼び出しは `built: false`）。`failed` は 60 秒のクールダウンの後に作り直す。復元に失敗したスナップショット（期限切れ・イメージとの不整合）は SandboxDO が `invalidate()` で知らせ、10 分のクールダウンの後に作り直す（壊れ続けるときに毎回作り直さない）。`building` のまま DO が再起動したら、待ち手が消えているので作り直す。
  - **lockfile の検出**: ルート直下だけ（v1）。`pnpm-lock.yaml` → `pnpm install --frozen-lockfile`、`package-lock.json` → `npm ci`、`yarn.lock` → `yarn install --frozen-lockfile`（この優先順位）。どれも無ければキャッシュしない。pnpm / yarn は、Dockerfile で `corepack enable` した shim（`/usr/local/bin/pnpm` など。子も素の `pnpm` を呼べる）を、corepack 経由（`corepack pnpm ...`。Node 24 のイメージに入っている）で呼ぶ。本体は package.json の `packageManager` に従って corepack が初回に取る（取得先は `registry.npmjs.org` で、外向きの許可に既にある。`COREPACK_ENABLE_DOWNLOAD_PROMPT=0` で確認の入力待ちにならない）。同じ Dockerfile に python3（apt。pip は無し）も入れた（イメージは圧縮前で約 50 MB 増）。導入のコマンドは表の固定の argv で、gateway から来た文字列を実行しない（agent は表にある組だけを受け付け、それ以外は `invalid_deps`）。
  - **gateway が lockfile と package.json の blob SHA を読む**: `GET /git/commits/{base_sha}` → `GET /git/trees/{tree}?recursive=1` を Installation Token で呼び、ルート直下の lockfile・`package.json`・`pnpm-workspace.yaml` の blob SHA と、入れ子の `package.json`（workspace の各パッケージ。`node_modules` の中は除く）の「パスと blob SHA の一覧」の sha256 を、`TaskSpec.deps: {repositoryId, lockfilePath, blobSha, installCommand, packageJsonSha, workspaceSha, manifestsSha} | null` に載せる（`workspaceSha` / `manifestsSha` は無ければ null）。ルートの `package.json` が無い、または tree が切り詰められた（`truncated`。大きなリポジトリ）ときは `deps: null`（一部の `package.json` を読めていない鍵は作らない）。`packageManager` や `pnpm.patchedDependencies` などは package.json にあるので鍵に入っている。鍵から漏れるのは、`.npmrc`・`.yarnrc.yml`・`.pnpmfile.cjs`、install スクリプトが読むファイルの中身、patch ファイルそのものの中身（パスが同じで中身だけ変わる場合）。漏れたときの影響は、同じリポジトリの別ブランチに古い依存が混ざる正確性の問題までで、鍵に `repository_id` が入るのでリポジトリをまたぐことは無い。再帰 tree の取得は 10 秒で打ち切り、超えたら `deps: null`（キャッシュなし）で続ける。TaskDO の `runSetup` で取得して `github_link.deps` に保存し、`start` の再送でも同じ値を送る（agent は spec の同一性で冪等を判定する）。API の失敗は `deps: null`（キャッシュなし）で続け、タスクを失敗させない。通常のファイル（100644 / 100755）の blob だけを lockfile とみなす。
  - **キャッシュの鍵**: `sha256(["rovo-deps-cache-v2", repository_id, lockfile のパス, lockfile の blob SHA, 導入のコマンド, ルートの package.json の blob SHA, pnpm-workspace.yaml の blob SHA（無ければ null）, 入れ子の package.json の一覧の sha256（無ければ null）, イメージの参照])`（JSON の配列にして境界を曖昧にしない）。イメージの参照は SandboxDO が `container.images.workspace`（本番では digest 付き）から足す。イメージが変わると別の鍵になる。別のリポジトリとは共有しない（`repository_id` が鍵に入る）。  同じ lockfile でも `package.json` の scripts（`postinstall` など）が違えば別の鍵になる（v1 は lockfile だけで、scripts を差し替えたブランチの `node_modules` を同じリポジトリの後続のタスクが使えてしまった）。v1 のキャッシュは使われなくなる（スナップショットは 30 日で期限切れ）。
  - **タスクの起動**: SandboxDO の `boot()` は、`deps` があれば `DepsCacheDO(鍵).ensure()` を**同期で**呼ぶ（最初のタスクは作るのを待つ。今の `npm ci` と同じくらいの時間）。ready なら `start({containerSnapshot: {id}, ...})`（`image` は外す）→ 起動後に CA 証明書（`/etc/cloudflare/certs/cloudflare-containers-ca.crt`）が読めることを確かめる（無ければ破棄して image から起動し直す）→ `prepareWorkspace`（空の `/workspace` に clone。GitHub の資格は従来どおりコンテナに入らない）→ manifest どおりに `node_modules` を `/workspace` の同じ相対位置へ `mv`（作業ツリーに同名が既にあれば戻さない）。コンテナを作り直す（`restarts`）ときも同じ流れで戻る。
  - **fail-soft（キャッシュのせいでタスクを失敗させない）**: `ensure` の失敗・時間切れ、`snapshotContainer` の例外、復元の例外、復元したコンテナが ready にならない、証明書の欠落、`mv` の失敗は、すべて image からの普通の起動に戻して続ける。理由は固定コードで `deps_cache_miss: <reason>` とログに出す（`ensure_failed` / `ensure_timeout` / `build_failed` / `build_timeout` / `cooldown` / `snapshot_unsupported` / `snapshot_failed` / `restore_failed` / `cert_missing` / `move_failed` / `invalid_deps`。入力や例外の文面は出さない）。復元に失敗した試行は、通常の起動の試行の上限（3 回）を消費しないよう、上限を 1 回分増やして試す（止まった試行は、従来どおり `bootRetries` に数える）。
  - **pnpm / yarn の本体の用意とハッシュ固定**: 実行時に Node の fetch で大きな本体を取ると外向き通信の中継越しに undici が落ちるため（`assert(!this.paused)`）、イメージのビルド時に pnpm と yarn classic を焼き、違う版は `apps/agent/container/pm-prepare.mjs` が clone の後（と作成コンテナの導入の前）に npm の経路で用意する。`packageManager` の `+sha512.<hex>` は捨てず、完全な spec を `corepack install -g --cache-only` に渡して corepack に検証させる（不一致ならキャッシュに置かず失敗。fail-soft）。待ちはタスクの期限と 3 分の短い方で、残り 10 秒未満なら諦める。異常終了で残った古い一時ディレクトリは次の実行の開始時に掃除する。
  - **見える化と費用**: `task_result` の `usage` に `deps_cache`（`hit` / `miss` / `built` / `disabled`）を出し、キャッシュを作ったタスクには `cache_build_ms` を足す。`deps_cache` が `miss` のときは、使えなかった理由の固定コード（ログの `deps_cache_miss: <reason>` と同じ。`build_failed` / `cooldown` など）を `deps_cache_miss_reason` に出す（miss 以外には付けない）。同じ値が `usage` の公開イベントの `deps_cache` / `cache_build_ms` にも出る。作った時間は、そのタスクの Sandbox の実行時間（`sandbox_runtime_ms`）に**足す**（作ったコンテナは別のインスタンスだが、少なく数えない。`sandbox_usd_estimate` に反映される）。`built` のタスクは、コンテナの作り直しで `hit` になっても `built` のまま。`task_status` には出さない。
  - **子への指示**: `hit` / `built` のときだけ、システムプロンプトに「依存関係は導入済み（`npm ci` / `pnpm install` / `yarn install` は不要。lockfile や package.json の依存を変えたときだけ入れ直す。ビルドの成果物は入っていない）」と書く。
  - **セキュリティ**: GitHub のトークンはスナップショットにも作成用のコンテナにも入らない（外向きの転送時に OutboundGateway が、依頼したタスクの資格で付ける）。作成用のコンテナが実行するのは base_sha のコミット済みのコードだけで、タスクの変更は入らない。スナップショットは `repository_id` ごとに別で、他のリポジトリとは共有しない。作成用のコンテナの外向き通信はタスクと同じ許可リスト（github.com は対象リポジトリの git だけ、レジストリは GET だけ）。
  - **無効にする**: agent の var `DEPS_CACHE_ENABLED`（`false` / `0` / `off` で無効。既定は有効）。`rovo.config.json` の `depsCache.enabled` で設定する。public beta の機能なので、止められるようにしておく。無効のとき `deps_cache` は `disabled`。
  - **新しい DO クラス**: `DepsCacheDO`（SQLite、コンテナなし）を agent の `durable_objects` と `exports` に足す。`containers` の項目は増えない。
  - **npm のキャッシュ**: スナップショットには `~/.npm`（HOME は `/root`。作業ツリーの外）が残り、検証コマンドの `npm ci` は同じ HOME でそれを使う（npm の既定の cache の場所なので設定は不要。`npm ci --offline` が通ることを確認済み）。E2E（`sandbox-do.e2e.test.ts`）は、hit のタスクで `npm ci` を実行しても registry から tarball を取り直さないことを確かめる。ただし `npm ci` は `node_modules` を消して入れ直すので、キャッシュが hit でも検証で入れ直すと時間がかかる。`task_start` の `verification_commands` の説明で、依存は起動時に導入済みで入れ直しは不要と伝える。
  - **範囲外**: Python / PyPI、ルート以外の lockfile（モノレポの入れ子）、スナップショットの削除・GC、イメージ間の移行、pnpm store のキャッシュ（`node_modules` と `~/.npm` などがスナップショットに入るだけ）。
  - **退けた案**: タスクのコンテナを保存する（作業状態が混ざる）。DepsCacheDO に専用のコンテナを持たせる（上の理由）。起動のたびに `npm ci` する（今の動き）。
  - **ローカルでの確認と、実機で確かめること**: ローカルの `wrangler dev`（workerd 1.20261012.1 + Docker）は `snapshotContainer` と `start({containerSnapshot})` に対応していて、実コンテナの E2E（`test:e2e:docker` の `sandbox-do.e2e.test.ts`、`test:e2e:full` の a・b）が、作成（built）→ 復元（hit）→ 作り直し後の復元・別の鍵・導入の失敗（miss → cooldown）まで通しで確かめている（偽の npm・偽の git）。実機でしか確かめられないのは、Cloudflare 本番に固有の部分: digest 付きのイメージ参照で鍵が安定すること、アカウントでスナップショット（public beta）が使えること、`git fetch --depth 1 origin <sha>` を github.com が受け付けること（偽 git の http-backend は受け付けた。GitHub は到達可能なコミットを許す）、corepack の取得が本番の外向きの許可で通ること、TTL（30 日）の期限切れ、実際の時間の短縮（acceptance.md の 24）。
- **履歴の公開（D2）**: author / committer のメールは、そのまま公開する（書き換えない）。`Claude-Session` トレーラーは `git filter-repo` でメッセージ中の当該行だけを消す（`Co-Authored-By` は残す）。実行は公開の直前に、ユーザーと一緒に行う。書き換えの後、全履歴で `claude.ai/code/session_` が 0 件であることを確かめる。Phase 7 で今後作るコミットには `Claude-Session` 行を付けない。
- **デプロイ用のタスク（D3）**: 16 の例（upstream に置くデプロイの mise タスク）は採らない。upstream の `mise.toml` には `deploy:*` を置かない。下流が、新しいファイル（`mise-tasks/` のファイルタスク、または `MISE_ENV` で読まれる `mise.<env>.toml`）を足してタスクを持つ。手順は `docs/deploy.md`。デプロイの順序は web → agent → gateway。
  - **2026-10-20 に見直した（D3 の撤回）。理由は、誰でも clone して、自分の値を渡せばデプロイできるようにするため。** upstream が `deploy:web` / `deploy:agent` / `deploy:gateway` / `deploy:all` / `deploy:secrets`（`scripts/deploy.sh`）と、Cloudflare のリソースを作る Terraform（`infra/`）を持つ。下流は `ROVO_DEPLOY_DIR` の wrangler 設定（雛形は `deploy.example/`）、tfvars、backend を新しいファイルとして足すだけで、upstream のファイルは書き換えない。`ROVO_DEPLOY_DIR` が未設定、または設定ファイルが無いときは何もせずに失敗する（upstream の `apps/*/wrangler.jsonc` を誤ってデプロイしないため）。上の「採らない」「置かない」は、この見直しの前の決定。MCP Server Portal と Access の登録は引き続き範囲外。
- **付属ファイル（D4）**: `SECURITY.md` を置く。連絡先は GitHub の private vulnerability reporting で、公開の直後に有効にする。CONTRIBUTING と CI（GitHub Actions）は置かない。ライセンスは MIT（著作権者は youyo）。
- **web_browse（D5）**: 実機のゲートの結果によらず、コードは残して既定で無効のまま公開する。README に「実験的で、既定で無効」と明記する。外すかどうかは、ゲートの結果が深刻な場合に改めて決める。
  - 2026-10-20 の決定: 実機のゲートは行わず、運用者の本番では有効にする。upstream の既定は無効のまま。確かめていない点を残存リスクとして受け入れ、acceptance.md の 11 節に記録する。
- **実機での障害の起こし方（D6）**: コードに検証用の分岐を入れない。Cloudflare 側の操作でコンテナを止める方法を基本とし、具体的な手段は M7 で調べて手順に書く。手段が無ければ、実コンテナの E2E で確認済みとして記録し、実機で確かめられない限界を残す。
  - M7 で調べた結果（2026-10-19、ドキュメントによる）: rovo は `scheduling_policy: durable_object` なので、再デプロイでは Sandbox のインスタンスは止まらず、障害の再現に使えない。有力な手段は、`wrangler containers ssh` で入り、主プロセス（`tini -- sleep infinity`）を落とす方法。詳細は acceptance.md の 18 節。
  - 2026-10-20 の決定: この方法は試験の間だけでも本番のコンテナに ssh の口を開けるので採らず、復旧の試験は実機では行わない。実コンテナの E2E で確認済みとして記録し、本物の Containers での停止と作り直しを確かめていない限界を残す。

### 15.9 ダッシュボード（2026-10-21 決定。2026-10-22 に PR の状態を追記）

読み取り専用の運用画面（`/dashboard`）。選択肢・理由・却下した案は [dashboard.md](dashboard.md) の「決めること」（D1〜D18）と「気づいた矛盾・提案」にある。ここには決定の要点だけを写す。本文と食い違う場合はこの項を優先する。

- **置き場所と配信（D1・D11・D12）**: SPA は新設の `apps/dashboard`（Vite + React + TypeScript。ルーターと状態管理は自前の最小実装、チャートは SVG）。ビルドの成果物を gateway の `assets` として同梱し、`run_worker_first: true` で Worker が `/dashboard/*` だけを渡す（`/mcp`・OAuth の経路を飲み込ませない。未知の `/dashboard/api/*` は JSON 404）。ビルドはデプロイの経路に組み込み、新しい secret・手順は増やさない。書体は自前配信（OFL。woff2 だけ）。
- **ログイン（D2・D3・D4）**: `/callback` の URL は共有し、state の接頭辞（`rovo-dash.`）だけで振り分ける（既存の GitHub App の変更は要らない）。処理・KV・Cookie は MCP と分離し、身元確認（コード交換 → ユーザー取得 → 許可ルール → 資格の保存）は共通関数。セッションは UserDO の `dashboard_session` と `dashboard_epoch`（絶対 7 日 + 無操作 8 時間）。**複数の端末で同時に使える**（2026-10-23 に「1 人 1 セッション」から変更）: ログインのたびに新しい sid を発行して追加するだけで、他の端末は落とさない（ログイン前の sid は引き継がない）。1 人あたり最大 10 セッション（`SESSION_MAX_PER_USER`）で、INSERT のときに期限切れを掃除し、超えたら last_seen の古い順に消す。`dashboard_epoch` は全端末ログアウト用に残し、ログインでは進めない（照合は残すが、進める操作は現状まだ無い）。ログアウトは自分の sid だけを消す。Cookie は暗号化した `__Host-` で、GitHub のトークンは入れない。GitHub のユーザートークンは MCP と共用の資格に保存する（ダッシュボード側の失効で MCP も再ログインになるリスクを承知）。
- **認可（D5・D6・D7）**: 閲覧者のトークンで見えるリポジトリ id の集合を作り、一覧・詳細・events・result・件数のすべてに同じ判定をかける（詳細は TaskDO の現在の `repository_id` で再認可。曖昧なときは fail closed で、404 で存在を漏らさない）。キャッシュは 30 秒（詳細の最初の 1 回は取り直す）。見えないタスクは表・レーンから外し、「権限の無いタスク N 件」と全員分の合計だけを出す（差し引きで費用が推定できる点は承知）。
- **索引と費用（D8・D9・D10）**: シングルトンの `DirectoryDO` に、TaskDO の outbox（単調増加の revision。索引の障害でタスクを失敗させない）と、consult の索引（UserDO の `consult_log` と outbox）を入れる。「全員」の合計は全員分、「あと何件」は閲覧者本人の分だけ。月の区切りは UTC で、画面に明記する。
- **Cloudflare の概要（D13）**: 既存の Terraform 管理の読み取りトークンに Account Analytics Read を足す（名前は変えない）。サーバー側で固定した集計だけを返し、取れない項目は「取得できない」と出す。
- **進み具合（D14・D15）**: agent がマスク済みの構造化イベント（command・編集したパス・commit・Web の host）を送り、gateway が再マスクして型ごとの許可リストと上限で絞る。差分の本文は送らない。更新は 5 秒のポーリング（非表示のタブで停止・backoff）で、SSE は後回し。
- **`dashboard_url`（D16）**: `<PUBLIC_BASE_URL>/dashboard/tasks/<task_id>`。`task_start` / `task_status` / `task_result` に付く。ログインしていなければログイン後に同じ詳細に戻る（戻り先は固定の形だけ）。権限の無い人には 404。
- **E2E と時刻（D17・D18）**: ブラウザの E2E は Playwright（Chromium）で、偽の GitHub と偽の Cloudflare API に向ける。画像の差分テストは入れない。「今日」はブラウザのローカル日。
- **PR の状態（2026-10-22）**: 人が GitHub 上でマージしても rovo は知らないので、閲覧時に gateway が閲覧者本人のトークンで GraphQL から PR の状態（open / merged / closed / unknown）を取って表示する。権限の判定に通ったタスクの、完了済みで `pr_merged` が未記録の PR だけを聞く。失敗は `unknown` で、他の部分は壊さない。webhook は、手順と secret を増やすので採らない。
- **安全**: テキストのみの表示（HTML・Markdown を解釈しない）、CSP（インライン無し）、読み取り API は `GET` のみ（ログアウトの `POST` は同一オリジンだけ）。マスクの限界は [SECURITY.md](../../SECURITY.md)。
