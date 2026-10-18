# Phase 6 実装計画: Security / Recovery / 観測性の仕上げ

設計書 `design.md` の Phase 6（12章）、9章、11章、15.7 を具体化したもの（下書き、2026-10-19、advisor レビュー反映済み）。

## Phase 6 の項目と、これまでの到達点

| design の項目 | 状態 | 備考 |
|---|---|---|
| ネットワーク制限 | **済**（Phase 2・3） | `enableInternet:false` + 傍受による許可リスト、receive-pack の判定 |
| Execution Lease | **概ね済**（下記） | DO の一意性、起動世代、tombstone、停止の意図で同等の性質を満たす。失効事象の監査は今回 |
| Git チェックポイント | **済**（Phase 3） | commit のたびに push し、作り直しは push 済みのチェックポイントから始める |
| R2 スナップショット | **今回** | 終端のタスクのイベントログと結果を R2 に**コピー**する（正は TaskDO のまま）。コンテナのスナップショットは見送る（下記） |
| Sandbox の再生成 | **済**（Phase 2・3・5） | 止まった起動は破棄してやり直す |
| 自動復旧 | **済**（Phase 2〜4） | 配送の意図を alarm で再送し、Pi の heartbeat が続きから再開する |
| 予算の制御 | **済**（Phase 2） | 呼び出し前のハードキャップと、月額の精算 |
| 監査ログ | **今回** | 11.2 のセキュリティイベントを、構造化した監査ログとして出す。欠落してはならないものは events にも積む |
| 観測性（11.1） | **今回** | タスクごとの要約レコードと、Sandbox の実行時間・起動世代 |

## Execution Lease（5.3）の扱い

設計書の Execution Lease は、次のように実装済みの仕組みで同等の性質を満たしている。新しいリースの仕組みは作らない。

| 5.3 の要件 | 実装 |
|---|---|
| 二重実行の防止 | タスクごとに TaskDO / AgentDO / SandboxDO が1つだけあり、DO の一意性で直列化される |
| 期限切れの実行主体が操作できない | SandboxDO の起動世代（`assertBootCurrent`）、AgentDO の tombstone と停止の意図、終端の後は何もしないガード |
| Fencing Token | 起動世代と operationId（`run:<taskId>`、`answer:<qid>`、`steer:<id>:<n>`）、Installation Token の expiresAt の単調増加 |
| 更新と再取得の区別 | 配送の意図（start / cancel / answer / steer / credential）と、その配送状態 |
| Expiration | SandboxDO の `deadlineAt` と AgentDO の期限。延長は単調増加だけを受け付ける（`extendDeadline`） |
| Allowed Operations / Resource Limits | 外向き通信の許可リスト、push 先 ref を `props` の taskId だけから作ること、呼び出し前の予算のハードキャップ |
| 復旧（9.3 の `RECOVERING`） | AgentDO のフェーズに `RECOVERING` は無く、agent は入らない。コンテナの作り直しと起動のやり直しは SandboxDO の中で完結する。**復旧の回数は、SandboxDO のカウンタ（観測性を参照）からしか取れない**。TaskDO の状態遷移からは取れない |

- design.md の 5.3 と 15.7 に、この対応表を追記する。
- 11.2 の「実行リースの失効・再取得」は、上の実装に対応する次の事象を監査する（イベント名は下の一覧）。
  - 古い起動世代の boot が破棄された（`boot_superseded`）
  - tombstone の後に届いた start が cancelled になった（`start_cancelled_by_tombstone`）
  - 同じタスクの start が衝突して拒否された（`start_conflict`）
  - AgentDO が cancel（停止の意図）を受理した（`agent_cancelled`）

## R2 への保存

### 位置づけ

- **R2 は「終端後の正」ではなく、コピー**。正は TaskDO のままで、`task_wait` / `task_result` は TaskDO（と AgentDO）から返す。
- TaskDO 側の `events` / `questions` / `git_token` の削除は **Phase 7 に送る**。R2 を正にするか（TaskDO から消してよいか）は、そのときに R2 の耐久性・読み出し経路とあわせて決める。Phase 6 では何も消さない。
- 保存は、タスクの結果にも予算の精算にも影響させない。アーカイブは `finishTask`（予算の返却）と独立している（下記）。

### バインディングとバケット

- バインディング名は `LOGS`、**gateway だけ**に持たせる。agent と web には持たせない。
- バケットは非公開にする（r2.dev の公開 URL もカスタムドメインも付けない）。
- gateway の MCP から、アーカイブの一覧・読み出しの API は作らない。読むのは運用者が、Cloudflare のダッシュボード・wrangler・S3 互換 API で行う。
- `apps/gateway/wrangler.jsonc` には、ローカル用の `r2_buckets`（例: `{"binding": "LOGS", "bucket_name": "rovo-logs"}`）だけを足す。本番のバケット名は下流（rovo-mcp）の設定で上書きする（design 16: 本番用の値を持たない）。
  - ローカルの `wrangler dev` / miniflare はこのバインディングで R2 を実体なしに動かせる。E2E の通しはこれを使う。

### 保存の条件と手順

- 保存するのは、**`finalize_done = 1` かつ `finished = 1`** になった後。
  - `finished = 1`: 費用が精算済みで、summary の値が確定している。
  - `finalize_done = 1`: PR 本文の更新とトークンの失効が済んでいる。終端の後も `finalizeGithub` が warning を積む（`pr_update_failed`、`token_revoke_failed`）ので、これより前に書くと、events.jsonl と result.json の `warnings` が欠ける。
  - GitHub と紐付かないタスク（`github_link` が無い）は、`finalize_done` を満たしているものとして扱う（`needsAlarm` の既存の判定と同じ）。
- 順序は **events.jsonl → result.json → summary.json**。summary.json を最後に書き、「summary.json がある = 3つが揃っている」とする。
- 保存は冪等にする（固定のキーへの上書き）。キーの `<yyyy>/<mm>` は**タスクの作成時刻（UTC）**から作り、再試行で別のキーにならないようにする。
- `LOGS` バインディングが無いとき、**fail-open**: アーカイブをスキップする。タスクの結果には影響させず、監査イベント `archive_skipped` だけを出す。スキップしたら `archive_done = 1` にして、alarm が空回りしないようにする。

### アーカイブの状態と再試行

- TaskDO に `archive_done` と `archive_attempts`（と次の試行時刻）を持たせる。置き場所（`agent_link` への列追加か、専用の singleton テーブルか）は M4 で既存の `addColumnIfMissing` の流儀に合わせて決める。
- `needsAlarm()` に「`archive_done = 0` の間は true」を足す。これを足さないと、終端後に alarm が止まり、再試行されない。
- 再試行は、GitHub の finalize と同じバックオフ（5s, 10s, 20s, 40s, 60s の上限）で行う。
- 上限は `ARCHIVE_MAX_ATTEMPTS = 6`（`FINALIZE_MAX_ATTEMPTS` と同じ）。超えたら、監査イベント `archive_failed` を出して打ち切り、`archive_done = 1` にする。
  - `archive_failed` は、アーカイブの後（events の確定後）に起きるので、events には入れられない。**監査ログ側にだけ**出す。
  - R2 がコピーである以上、長い障害でアーカイブを失うことは許容する。Phase 7 で R2 を正にするなら、打ち切りの方針は見直す。
- アーカイブの成功も `archive_completed` として監査ログに出す（キーの接頭辞とサイズ。本文は出さない）。

### 保存する内容と、保存しないもの

- `tasks/<yyyy>/<mm>/<task_id>/events.jsonl`: 公開イベント（TaskDO の `events`）の全件。1行1イベント。終端の後に積まれた warning と、監査の二重化イベント（下記）を含む。
- `tasks/<yyyy>/<mm>/<task_id>/result.json`: `task_result` と同じもの（patch・検証出力・warnings を含む）。
- `tasks/<yyyy>/<mm>/<task_id>/summary.json`: 11.1 の要約レコード（観測性の節）。**title は入れない**。
- **保存しないもの**
  - タスクの入力（`instructions` / `acceptance_criteria` / `constraints`）。利用者の自由記述で、秘密を含みうる。title も同じ理由で入れない。
  - 親の answer と steer の本文。公開イベントには ID（`question_id`、`steer_id`）だけが入っているので、events.jsonl にも本文は入らない。TaskDO の `questions` / `steers` テーブルは保存の対象外。
  - Installation Token（`git_token`）と、その暗号文。
  - ただし result.json には、`verification.commands`（子に渡した検証コマンド）が入る。コマンドの引数に秘密を入れない運用を README に書く。

### 取り扱い: R2 の中身は非信頼データ

- **events.jsonl は未加工**で保存する。アーカイブの時にマーカーで wrap しない。
  - 本文（patch、検証の出力、warnings、質問文、ツールの summary）は、子がリポジトリの内容（非信頼）から作ったものを含む。**読む側が、非信頼データとして扱う**。
  - この旨を README と、利用者向けの規約（docs/deploy.md の運用の節）に書く。
- 秘密のマスクは、子の側（`apps/agent/src/redact.ts`）で出る前にかけているものを引き続き使う。regex のマスクは **best effort** で、取りこぼしうる。
  - **アーカイブの境界で、新たに生のデータを足さない**（TaskDO が既に持っている公開イベントと結果だけを書く）。
  - 取りこぼしへの備えが、バケットの非公開、バインディングを gateway だけに持たせること、MCP から読み出さないこと、ライフサイクルである。
- 受入試験で、アーカイブの中をトークン形式（`ghs_` など）で grep する（acceptance.md 15）。

### キー設計とライフサイクル

- キーは `tasks/<yyyy>/<mm>/<task_id>/` を維持する。ユーザー単位の削除のための `userId` の接頭辞は、今は要らない（ユーザー単位の削除の要件が出た時に、summary.json の userId から対象を引ける。キーの変更が必要になったら、そのとき移行を考える）。
- R2 のライフサイクルの設定（例: 90日で削除）は、下流の Terraform で行う。docs/deploy.md に推奨値を書く（docs/deploy.md は Phase 7 の公開準備で作る）。

### コンテナのスナップショットは見送る

- コンテナのスナップショット（beta）は見送る。
  - 理由1: 復旧は push 済みのチェックポイントで成立している。
  - 理由2: beta への依存を増やさない。
  - 必要になったら、作り直しを速くするための最適化として再検討する。

## 監査ログ（11.2）

### 出力と保証の水準

- 監査イベントは、1行の構造化 JSON で `console.log` に出す。`{"audit": true, "event": "...", "ts": ..., ...}`。
- **Workers Logs の `console.log` だけでは、best-effort**。head sampling と短い保持期間のために、行が欠落しうる。これは監査として十分ではない。
- 監査として成立する条件（下流の設定。rovo は環境固有の値を持たないので、推奨値ではなく**条件**として書く）:
  - Workers Logs の head sampling が 100%（`observability.logs.head_sampling_rate = 1` 相当）。
  - Logpush で、保持期間を自分で決められる宛先に流す。
  - この条件が満たされていない環境では、監査ログは調査の補助でしかない。docs/deploy.md に、この条件と、満たしているかの確かめ方を書く。
- 保存先と保持期間は下流が決める。

### 欠落してはならない事象は events にも積む（二重化）

- トークンの発行・失効、特権操作、cancel、配送の打ち切りは、**TaskDO の `events` にも固定コードで積む**。
  - events は R2 の events.jsonl に残るので、ログ基盤の取りこぼしがあっても、タスクごとの監査の記録が残る。
  - 既存のイベントで足りるものは流用する（cancel は `cancelled`、期限・予算・回答待ちの上限は `status_changed` の reason、失効の失敗は `warning`: `token_revoke_failed`）。足りないものは、`type: "audit"`、payload は固定コードだけ（`{code, ...}`）のイベントを新設する。
  - agent 側の事象（特権操作など）は、AgentDO のイベントとして出し、gateway の `agent-events.ts` が `audit` として写す。
  - これらのイベントは `task_wait` で親にも見える。固定コードと ID だけなので、親に見えてよい。
- 二重化しないもの（監査ログだけ）: タスクに紐付かないもの（認証の失敗）、頻度が高く攻撃者が起こせるもの（外向き通信の違反、Web の block）、アーカイブの後に起きるもの（`archive_*`）、agent 内部の防御（起動世代、tombstone、start の衝突）。
  - agent 内部の防御は、ログが欠けても防御そのものは働くので、監査ログだけにする。

### 監査イベントの一覧

| event | 出す場所 | reason（固定コード）の例 | events にも積む |
|---|---|---|---|
| `auth_failed` | gateway | OAuth の state / code の不正、トークンの検証の失敗 | しない（タスクが無い） |
| `authz_denied` | gateway | team 不所属、owner でない、push 権限が無い、App が Installation に入っていない | しない |
| `credential_issued` / `credential_revoked` | gateway（TaskDO） | `kind`: start / refresh / final（トークンそのものは出さない） | する（`audit`） |
| `credential_revoke_given_up` | gateway（TaskDO） | 失効を `REVOKE_MAX_ATTEMPTS` で諦めた | する（既存の `warning`: `token_revoke_failed`） |
| `sandbox_privileged_op` | agent（SandboxDO） | `op`: terminate / destroy / set_deadline / extend_deadline | する（`audit`） |
| `outbound_denied` | agent（OutboundGateway） | 既存の違反コード（`host_not_allowed` など）、宛先の分類 | しない |
| `web_blocked` | web | verdict が block / unknown、`robots` / `redirect_policy` / `bot_challenge` による blocked | しない |
| `task_cancelled` | gateway | cancel の主体（parent / system） | する（既存の `cancelled`） |
| `agent_cancelled` | agent（AgentDO） | cancel（停止の意図）を受理した | する（`audit`） |
| `task_ended_by_limit` | gateway / agent | `budget_exceeded` / `deadline` / `input_timeout` | する（既存の `status_changed` の reason） |
| `delivery_given_up` | gateway（TaskDO） | 配送（start / cancel / answer / steer / credential）の打ち切り | する（`audit`） |
| `boot_superseded` | agent（SandboxDO） | 古い起動世代の boot の破棄 | しない |
| `start_cancelled_by_tombstone` | agent（AgentDO） | tombstone の後に届いた start を cancelled にした | しない |
| `start_conflict` | agent（AgentDO） | 同じタスクの start が衝突して拒否された | しない |
| `task_summary` | gateway（TaskDO） | 要約の生成（`finished` と `finalize_done` の後。数値と固定コードだけ） | しない |
| `archive_skipped` / `archive_failed` / `archive_completed` | gateway（TaskDO） | `LOGS` が無い / 再試行の上限 / 成功 | しない（アーカイブの後） |

### フィールドと allowlist

- 共通のフィールドは `event`、`ts`、`userId`、`taskId`、`caller`、`reason`（固定のコード）、`requestId`、`host`。
  - `caller` は `parent`（MCP 経由）/ `child`（agent 経由）/ `system`（alarm・内部）。
  - `requestId` は**任意**。DO の alarm の中では取れない。HTTP リクエストの中や、web の AI Gateway の request id のように、取れる場面だけ出す。
  - `host` は**常に出してよい**（web は既に全ての fetch で host を出している）。ただし URL のパス・クエリ・userinfo は出さない。host のラベルにデータを載せて外へ出す手口（DNS 経由の持ち出し）があるので、`audit()` が host の長さを制限し、トークン形式をマスクして通す。agent の違反ログは、今の宛先の分類（`dest`）を保ち、host を足すかは `audit()` への移行時に決めてよい（足すなら host だけ）。
  - 本文、URL のパスやクエリ、トークン、リポジトリの中身、タスクの入力は出さない。
- 出力を1か所の関数（`audit(event, fields)`）にまとめ、許可したフィールドだけを通す（allowlist）。未知のフィールドは黙って落とす。
- web は既に `web_research` というログ（`console.log(JSON.stringify(...))`）を持つ。これは観測用で、`audit` の対象のもの（block / unknown / blocked）だけを `audit()` 経由でも出す。

### audit() の置き場所は未決

- **M2（agent に着手する前）に決める。**
- 選択肢:
  1. `packages/audit` を新設する（pnpm のワークスペースは今 `apps/*` だけなので、`pnpm-workspace.yaml` の変更と、3つの Worker からの依存の追加が要る）。
  2. gateway / agent / web の3つに複製する。複製なら、**allowlist のテストを各 app に置く**（複製の間でフィールドの許可がずれても、各 app のテストが落ちるようにする）。
- M1（gateway）は、まず gateway 内に置いて始めてよい。決めた結果によって、移す。

### agent の違反ログの JSON 化

- agent の違反ログは今、整形した文字列（`outbound denied: code=... task=... dest=...`、`outbound-gateway.ts` の `formatViolationLog`）で、`console.warn` に出ている。これを `audit()` の JSON に変える。
- 実作業で、`formatViolationLog` の Unit テスト（`outbound-gateway.test.ts`）と、違反ログを見ているアサーション（E2E を含む）が変わる。**テストを弱めない**: 「コード・task・分類だけを含み、path や query を含まない」を、JSON のフィールドの検証に置き換える。

### E2E で監査イベントを検証する方法

- stdout の走査はしない。
- 既存の `testDeliveryStates` と `/__test/` ルート（`ENVIRONMENT=test` のときだけ有効）と同じ形で、**audit のシンクを読み出せる口**を作る。
  - `audit()` は、通常は `console.log` に出す。`ENVIRONMENT=test` のときだけ、発行元（DO またはWorker）にも記録を残し、`/__test/audit` が読み出す。
  - 本番（`ENVIRONMENT=production`）では記録も口も無効であることを、Unit で確かめる。
  - 発行元が DO のものは、DO の test 用メソッドで読む。DO の外（認証の失敗など）のものの記録先は M1 で決める（既存の E2E のスクリプトのように KV に TTL つきで置く案がある）。
  - web は、`ServiceDeps.log` の差し込み口を既に持つ。

## 観測性（11.1）

- タスクの要約レコード（`summary.json`。数値と固定コードの項目だけを、監査ログの `task_summary` 行にも出す。R2 が無い構成でも要約がログに残る）に、次のものを入れる。
  - Task ID、User ID、repository、PR URL、状態遷移（時刻つき）、実行時間
  - Claude の使用量と推定費用
  - Sandbox の実行時間と、起動世代の回数
  - Web の回数（search / fetch / browse）、安全性の判定の件数（verdict ごと）。**子が使った分だけ**。親が MCP から使う分は UserDO の日次のカウンタで、タスクに紐付かない
  - 質問の回数、復旧の回数（コンテナの作り直し、起動のやり直し）
  - 検証の結果、エラーの内容（固定のコード）
  - **title は入れない**
- Sandbox の実行時間と起動世代
  - SandboxDO が、コンテナの起動から停止までの時間を累計して永続化する（`runtimeMs`）。実行中の分は、起動時刻から現在までを足して返す。DO が退避して停止を観測できなかった場合に備え、keepalive の alarm のたびに最後に観測した時刻を更新し、閉じるときはそこまでを加算する。
  - **`restarts` / `bootRetries` は、今の agent には無い**。`sandbox-do.ts` の `this.gen`（起動世代）はメモリ上の値で、DO が退避されると 0 に戻るので、そのままでは使えない。`ensureRunning` が世代を進める箇所で、**永続化したカウンタ**を増やす。
    - `restarts`: コンテナの作り直し（2回目以降の起動）の回数。
    - `bootRetries`: 起動の確認点で失敗した・破棄された（superseded）やり直しの回数。
    - 定義は M2 の Unit で固定する。
  - AgentDO は、この値を usage イベントに載せる（`sandbox: {runtimeMs, restarts, bootRetries}`）。gateway の `agent-events.ts` が、公開用の形に写す（M3）。
  - 復旧の回数は、**このカウンタからしか取れない**（`RECOVERING` に agent は入らない。Execution Lease の節）。
- 費用は、Claude（AI Gateway）、Sandbox（実行時間）、Web（回数）を分けて記録する（11.3）。
  - Claude は AI Gateway の usage に基づく値。**Sandbox と Web の金額は、単価をかけた推定値**で、要約に `sandbox_usd_estimate` / `web_usd_estimate` のように推定であることが分かる名前で入れる。
  - 単価は、gateway の `vars` に**既定値**を置き、下流が上書きできる形にする（design 16: 環境固有の値を持たない。単価は料金改定で変わる）。例: `SANDBOX_USD_PER_HOUR`、`WEB_USD_PER_1K_SEARCH`。既定値は実装時に公式の料金表から取り、料金表の日付をコメントに残す。
  - Sandbox と Web の推定費用は、タスクの予算（$10）には含めない。

## マイルストーン

phase5.md の M の分け方に合わせる。各 M は、先に失敗するテストを書いてから実装する。

| M | 範囲 | 内容 | 最初の Red になるテスト |
|---|---|---|---|
| M1 | gateway | `audit()`、allowlist、test 用のシンク。認証失敗・認可拒否・cancel・トークンの発行/失効・配送の打ち切りのイベント（二重化を含む） | Unit: `audit()` が、禁止したフィールド（トークン、URL のパス、本文）と未知のフィールドを出力しない |
| M2 | agent | SandboxDO の実行時間と起動世代のカウンタの永続化、usage イベントの `sandbox: {...}`。違反ログの JSON 化、特権操作、リース相当の失効イベント | Unit: SandboxDO の起動→停止で `runtimeMs` が累計され、DO を作り直しても値が残る。**着手前に audit() の置き場所を決める** |
| M3 | gateway | `agent-events.ts` で sandbox の usage を写す。summary レコードの生成 | Unit: usage イベントの `sandbox` が公開用の payload に写る（欠けた値は 0）。summary に title が入らない |
| M4 | gateway | R2 アーカイブ（`needsAlarm` の拡張を含む） | Unit（fake の R2）: `finished && finalize_done` の前には書かず、成立後に1回呼んでも2回呼んでも同じ結果（冪等）。続けて、再試行と打ち切り。最後に wrangler のローカル R2 で通し |
| M5 | web + ドキュメント | web の監査（block / unknown / robots / redirect）。design 15.7、推奨値の下書きをこの文書の該当の節に置く（docs/deploy.md 自体は Phase 7 で作る）、README、acceptance 14 以降 | Unit: web の block / unknown / robots / redirect_policy が `audit()` の許可したフィールドだけで出る |

## テスト

- Unit
  - `audit()` の allowlist（禁止したフィールドが出ないこと）と、各イベントの発火。production で test 用のシンクが無効なこと。
  - R2 への保存（fake の R2）の冪等性・再試行・打ち切り（`archive_failed`）、`LOGS` が無いときの fail-open（`archive_skipped`、タスクの結果が変わらない）。保存の条件（`finalize_done` の前には書かない）。トークンが含まれないこと。title・タスクの入力・answer / steer の本文が含まれないこと。
  - `needsAlarm` が、アーカイブが済むまで true で、済んだら false になること。
  - 要約レコードの各フィールド（推定費用が推定として入ること、単価の上書き）。
  - Sandbox の実行時間の累計、起動世代のカウンタ（DO の退避をまたいでも残る）。
  - agent の違反ログが JSON で、許可したフィールドだけを持つこと。
  - web の audit が、host を出しつつ、パス・クエリ・userinfo を出さないこと。
- E2E（通し）
  - 完了したタスクの events.jsonl / result.json / summary.json が、wrangler dev のローカル R2（`LOGS`）に保存されること。summary.json が最後に書かれること。
  - キャンセルと予算超過で、`/__test/audit` から監査イベントが読めること。トークンの発行・失効が events にも積まれていること。
  - `LOGS` を外した構成でも、タスクが完了し、`archive_skipped` が出ること。

## 未決事項

- `audit()` の置き場所（`packages/audit` の新設か、3 Worker への複製か）。M2 に着手する前に決める。
- DO の外で発行する監査イベント（認証の失敗など）の、E2E 用の記録先（M1 で決める）。
- アーカイブの状態の置き場所（`agent_link` の列か、専用のテーブルか）。M4 で決める。
- Sandbox と Web の単価の既定値（実装時に公式の料金表から取る）。
- R2 を正にするかと、TaskDO の `events` / `questions` / `git_token` の削除（Phase 7）。

## 前提・注意

- R2 のバケットとライフサイクル、Logpush、Workers Logs の sampling の設定は、下流（rovo-mcp と cloudflare-infra）の Terraform で行う。このリポジトリには、バインディング名と、設定の条件・推奨値だけを書く。
- 推奨値と運用（ライフサイクル、Logpush の条件、R2 の中身が非信頼であること）は docs/deploy.md に書く。docs/deploy.md は Phase 7 の公開準備で作る（design 16）。それまでは、この文書と README に書く。

## Phase 6 でやらないこと

- コンテナのスナップショット（beta）
- 監査ログの検索 UI
- R2 からの一覧・読み出しの API（MCP を含む）
- TaskDO のデータの削除（Phase 7）

## advisor レビュー（2026-10-19）を受けた変更

下書きに対する独立レビューの指摘を、次のように決めて本文に反映した。

### R2 の位置づけと保存の条件

- R2 は「終端後の正」ではなくコピーとした。TaskDO の `events` / `questions` / `git_token` の削除は Phase 7 に送る（R2 への保存）。
- 保存の条件を `finalize_done = 1 && finished = 1` にした。終端の後も `finalizeGithub` が warning を積むため、`finished` だけでは欠ける。
- アーカイブの状態（`archive_done` / `archive_attempts`）を `needsAlarm` に足し、`ARCHIVE_MAX_ATTEMPTS = 6` を置いた。超えたら `archive_failed` を監査ログに出して打ち切る。アーカイブは `finishTask` と独立。
- `LOGS` が無いときは fail-open（スキップして `archive_skipped` だけ出す）。
- 書く順序を events → result → summary にし、summary を完了の印にした。キーの月は作成時刻から作る。

### 監査ログの保証の水準

- Workers Logs の `console.log` は best-effort（head sampling と短い保持で欠落しうる）と明記した。
- 「sampling 100% + Logpush」は推奨値ではなく、監査として成立する**条件**として書いた。rovo は環境固有の値を持たない。
- 欠落してはならない事象（トークンの発行・失効、特権操作、cancel、配送の打ち切り）は、TaskDO の events にも固定コードで積み、R2 の events.jsonl に残す二重化にした。`archive_failed` は events に入らないので、監査ログ側にだけ出す。

### R2 の中身の取り扱い

- 「本文は非信頼データのマーカーごと保存する」をやめた。events.jsonl は**未加工**で、読む側が非信頼として扱う。マーカーで wrap しない。README と規約に書く。
- regex のマスクは best effort。アーカイブの境界で、新たに生のデータを足さない。
- バケットは非公開、バインディングは gateway だけ、MCP からの一覧・読み出しの API は作らない。
- summary.json に title を入れない。保存しないもの（タスクの入力、answer / steer の本文）を明記した。

### 監査イベントの追加と、フィールドの統一

- リース相当の失効事象（`boot_superseded`、`start_cancelled_by_tombstone`、`start_conflict`、`agent_cancelled`）を一覧に足した。
- host の記述を、web の実装（全ての fetch で host を出す）と矛盾しないよう統一した。host は常に可。パス・クエリ・userinfo は出さない。`requestId` は DO の alarm の中で取れないので任意。
- `audit()` の置き場所は未決とし、M2 の前に決めることにした（`packages/audit` の新設か、3 Worker への複製。複製なら allowlist のテストを各 app に置く）。
- agent の違反ログの JSON 化で、Unit と E2E のアサーションが変わる点を明記した。

### 観測性

- `restarts` / `bootRetries` は agent に今は無く、`this.gen`（メモリ上の値）から**永続化したカウンタ**として作ることにした。
- `RECOVERING` に agent は入らないので、復旧の回数は SandboxDO のカウンタからしか取れない。5.3 の対応表に書いた。
- Sandbox と Web の単価は gateway の `vars` に既定値を置き、下流が上書きできる形にした（design 16）。金額は「推定」と明記した。
- 親の Web 利用はタスクに紐付かないので、要約の Web の件数は子の分だけとした。

### テスト

- E2E で監査イベントを検証する方法を、stdout の走査から、`testDeliveryStates` / `/__test/` ルートと同じ形の test 用のシンクに変えた。
- ローカルの R2 は、wrangler dev の `r2_buckets`（gateway/wrangler.jsonc にローカル用を足す。本番名は下流）にした。

### 構成とドキュメント

- キー設計 `tasks/<yyyy>/<mm>/<task_id>/` は維持した。ユーザー単位の削除のための `userId` の接頭辞は、今は不要。
- マイルストーンを M1〜M5 に分け、各 M の最初の Red を決めた。
- acceptance.md に Phase 6 の受入（14 以降）を追加した。design.md に 15.7 を追加し、5.3 にも対応表を追記した。
- README 参照だった推奨値の置き場所を、docs/deploy.md に統一した（design 16 が要求する。Phase 7 の公開準備で作る）。
