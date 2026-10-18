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
- GitHub Draft PR はタスク開始時に作成する。
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
| `task_answer` | 子の質問への回答 |
| `task_steer` | 追加指示 |
| `task_cancel` | キャンセル |
| `task_result` | 最終結果取得 |

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

PRは子エージェントによってマージしない。

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
| 同時実行タスク | 1 |
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

実装完了後はDraft PRと検証結果を親に返し、最終的なレビュー・マージ判断は親エージェントとユーザーが行う。

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

### 15.4 予算

- タスク単位の上限（初期値 $10 / Task）に加え、ユーザー単位の月額上限を設ける。
- 同時に実行できるタスクは、ユーザーごとに1つまでとする。

### 15.5 Web 取得結果の安全性評価

- 評価器は Workers AI の Clef-flash（`@cf/cloudflare/clef-flash`）から始める。Clef は Jev と API 互換である。
- 評価器はインターフェースで抽象化し、Clef（`@cf/cloudflare/clef`）や Jev 本体へ差し替えられるようにする。
- Clef / Jev はプロンプトインジェクションの専用検出器ではない。8.5 の各リスク分類は `questions` として自前で定義する。
- 取得した本文は `state`（データ）にだけ入れ、評価の指示は `questions` 側に分離する。
- 判定は誘導され得るため、Policy Engine では決定論的チェックと組み合わせる。
