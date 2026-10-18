# Phase 6 実装計画: Security / Recovery / 観測性の仕上げ

設計書 `design.md` の Phase 6（12章）、9章、11章を具体化したもの（下書き、2026-10-19）。

## Phase 6 の項目と、これまでの到達点

| design の項目 | 状態 | 備考 |
|---|---|---|
| ネットワーク制限 | **済**（Phase 2・3） | `enableInternet:false` + 傍受による許可リスト、receive-pack の判定 |
| Execution Lease | **概ね済**（下記） | DO の一意性、起動世代、tombstone、停止の意図で同等の性質を満たす |
| Git チェックポイント | **済**（Phase 3） | commit のたびに push し、作り直しは push 済みのチェックポイントから始める |
| R2 スナップショット | **今回** | 終端のタスクのイベントログと結果を R2 に保存する。コンテナのスナップショットは見送る（下記） |
| Sandbox の再生成 | **済**（Phase 2・3・5） | 止まった起動は破棄してやり直す |
| 自動復旧 | **済**（Phase 2〜4） | 配送の意図を alarm で再送し、Pi の heartbeat が続きから再開する |
| 予算の制御 | **済**（Phase 2） | 呼び出し前のハードキャップと、月額の精算 |
| 監査ログ | **今回** | 11.2 のセキュリティイベントを、構造化した監査ログとして出す |
| 観測性（11.1） | **今回** | タスクごとの要約レコードと、Sandbox の実行時間 |

## Execution Lease（5.3）の扱い

設計書の Execution Lease は、次のように実装済みの仕組みで同等の性質を満たしている。新しいリースの仕組みは作らない。

| 5.3 の要件 | 実装 |
|---|---|
| 二重実行の防止 | タスクごとに TaskDO / AgentDO / SandboxDO が1つだけあり、DO の一意性で直列化される |
| 期限切れの実行主体が操作できない | SandboxDO の起動世代（`assertBootCurrent`）、AgentDO の tombstone と停止の意図、終端の後は何もしないガード |
| Fencing Token | 起動世代と operationId（`run:<taskId>`、`answer:<qid>`、`steer:<id>:<n>`）、Installation Token の expiresAt の単調増加 |
| 更新と再取得の区別 | 配送の意図（start / cancel / answer / steer / credential）と、その配送状態 |

- design.md 5.3 に、この対応表を追記する。

## R2 への保存

- バケット: `rovo-logs`。バインディング名は `LOGS`、gateway に持たせる。
  - 実際のバケット名と保持期間は、下流（rovo-mcp）の設定で決める。
- 保存するのは、終端を確定して停止を確かめた後の TaskDO の次のもの。
  - `tasks/<yyyy>/<mm>/<task_id>/events.jsonl`: 公開イベントの全件。本文は非信頼データのマーカーごと保存する。トークンは含めない。
  - `tasks/<yyyy>/<mm>/<task_id>/result.json`: task_result と同じもの（patch を含む）。
  - `tasks/<yyyy>/<mm>/<task_id>/summary.json`: 11.1 の要約レコード（下記）。
- 保存は冪等にし、alarm で再試行する。失敗が続いたら、警告を出して打ち切る（タスクの結果には影響させない）。
- R2 のライフサイクルの設定（例: 90日で削除）は、下流の Terraform で行う。README に推奨値を書く。
- コンテナのスナップショット（beta）は見送る。
  - 理由1: 復旧は push 済みのチェックポイントで成立している。
  - 理由2: beta への依存を増やさない。
  - 必要になったら、作り直しを速くするための最適化として再検討する。

## 監査ログ（11.2）

- 監査イベントは、1行の構造化 JSON で `console.log` に出す。Workers Logs / Logpush で収集し、保存先と保持期間は下流が決める。
  - 例: `{"audit": true, "event": "...", "ts": ..., "userId": ..., "taskId": ..., ...}`
- 対象のイベント
  - 認証の失敗（OAuth、トークンの検証）、認可の拒否（team、owner、push 権限、Installation）
  - GitHub Installation Token の発行・失効（トークンそのものは出さない）
  - Sandbox への特権操作（terminate、destroy、setDeadline、extendDeadline）
  - 外向き通信のポリシー違反（既存の違反ログを監査イベントに格上げする）
  - Web の verdict が block / unknown のもの、robots / redirect_policy による blocked
  - タスクのキャンセル、予算の超過、期限の超過、回答待ちの上限
  - 配送の打ち切り（トークンの失効の失敗など）
- 共通のフィールドは `event`、`ts`、`userId`、`taskId`、`caller`、`reason`（固定のコード）、`requestId`。
  - 本文、URL のパスやクエリ、トークン、リポジトリの中身は出さない。ホスト名は、ポリシー違反の宛先の分類として必要な場合だけ出す。
- 出力を1か所の関数（`audit(event, fields)`）にまとめ、許可したフィールドだけを通す（allowlist）。

## 観測性（11.1）

- タスクの要約レコード（`summary.json` と監査ログ）に、次のものを入れる。
  - Task ID、User ID、repository、PR URL、状態遷移（時刻つき）、実行時間
  - Claude の使用量と推定費用
  - Sandbox の実行時間
  - Web の回数（search / fetch / browse）、安全性の判定の件数（verdict ごと）
  - 質問の回数、復旧の回数（コンテナの作り直し、起動のやり直し）
  - 検証の結果、エラーの内容（固定のコード）
- Sandbox の実行時間
  - SandboxDO が、コンテナの起動から停止までの時間を累計して永続化する。
  - 作り直しと起動のやり直しの回数も数える。
  - AgentDO は、この値を usage イベントに載せる（`sandbox: {runtimeMs, restarts, bootRetries}`）。
- 費用は、Claude（AI Gateway）、Sandbox（実行時間）、Web（回数）を分けて記録する（11.3）。Sandbox と Web の金額は、単価をかけた推定値として要約に入れる。

## テスト

- Unit
  - audit() の allowlist（禁止したフィールドが出ないこと）と、各イベントの発火。
  - R2 への保存（fake の R2）の冪等性・再試行・打ち切り。トークンが含まれないこと。
  - 要約レコードの各フィールド。
  - Sandbox の実行時間の累計と、作り直しの回数。
- E2E（通し）
  - 完了したタスクの events.jsonl / result.json / summary.json が、R2（ローカルの miniflare の R2）に保存されること。
  - キャンセルや予算超過で、監査イベントが出ること。

## 前提・注意

- R2 のバケットとライフサイクル、Logpush の設定は、下流（rovo-mcp と cloudflare-infra）の Terraform で行う。このリポジトリには、バインディング名と推奨値だけを書く。

## Phase 6 でやらないこと

- コンテナのスナップショット（beta）
- 監査ログの検索 UI
