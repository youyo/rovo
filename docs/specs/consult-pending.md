# 仕様: consult の pending と consult_result

長く考えるモデルの `consult` が、クライアントの MCP ツール呼び出しの打ち切りに当たらないようにする仕様。

用語: Sandbox で動くエージェントを「ワーカー」、MCP を呼ぶ側（AI か人）を「クライアント」と呼ぶ。

## 背景と決定済みの前提

- Claude Code は HTTP の MCP サーバーへのツール呼び出しを 1 回 60 秒で打ち切る（`MCP_TOOL_TIMEOUT`。https://code.claude.com/docs/en/env-vars ）。今の `consult` は最大 120 秒待つ（`apps/gateway/src/consult.ts` の `CONSULT_TIMEOUT_MS`）ので、思考の長いモデル（`openai/gpt-6-astra`）では、答えが出る前にクライアントが切れて「The operation timed out.」になる。
- クライアントの設定で延ばす案は採らない（OSS の利用者全員に設定を求めることになる）。サーバーの待ち時間を 50 秒に縮めて長いモデルを切り捨てる案も採らない。
- 採る案: `consult` は今までどおり 1 回の呼び出しで答えを待つが、待つのは最大 50 秒（`task_wait` の `MAX_WAIT_SECONDS` と同じ。`apps/gateway/src/tasks/validation.ts`）。間に合えば今と同じ形で返す。間に合わなければ `pending` を返し、モデルの呼び出しは裏で続ける。答えは新しいツール `consult_result`（long polling、最大 50 秒）で受け取る。

## 今の流れ（変える前）

1. `consult.ts` が入力を検証し、`resolveModel` でモデルを決める。
2. `UserDO.reserveConsult(consultId, model, owner)` が月の枠から `CONSULT_BUDGET_USD` を `task_budget` に予約し、`consult_log`（索引用。本文は持たない）に行を作る。
3. **gateway のリクエストの中で** `AgentDO.consult`（インスタンス `consult-<ULID>`。AI バインディングと thinking の補正を持つ。終わると `storage.deleteAll()`）を `Promise.race` で最大 120 秒待つ。
4. 同じリクエストの中で `UserDO.settleConsult` が実費（失敗で実費不明なら予約額）で精算し、`consult_finished` を監査に出して、結果を返す。
5. クライアントが先に切れると 4 の精算が走らない。取り残しは `closeStaleConsults`（ULID の時刻から `CONSULT_STALE_AFTER_MS` = 5 分）が、次の予約か `budget_status` のときに予約額で閉じる。

問題の根は、**精算がクライアントのリクエストの寿命に載っている**こと。待ち時間を縮めるだけでは直らず、モデル呼び出しの完了と精算をリクエストの外に出す必要がある。

## 変えるところ

- 新規: `UserDO` に consult の状態（開始・待つ・答えの保持・精算）を持たせる。裏のモデル呼び出しと精算は UserDO の中で完結させる。
- 変更: `consult.ts` は「予約 → UserDO に開始を頼む → 最大 50 秒待つ → 答えか pending を返す」だけになる。精算・監査（`consult_finished`）は UserDO 側の完了処理に移る。
- 新規: MCP ツール `consult_result`（`mcp/server.ts`、`mcp/annotations.ts` に追加。読み取り専用・冪等）。
- 変更: `closeStaleConsults` の期限（下の「予約・精算・期限切れ」）、`budget_status` の応答（`pending_consults` を足す）。
- 変えない: `AgentDO`、`AgentRpc` / `ConsultRequest` / `ConsultResult`（agent の契約）、AI Gateway の metadata、`consult_log` と Directory への索引（本文を含めない）、`consult` の入力。agent を変えないので、gateway と agent のデプロイ順は問わない。

## consult の応答

入力は変えない。応答は次の 2 通り。

1. 50 秒以内に終わったとき: **今と同じ** `{text, model, usage{input, output, cache_read, cache_write}, cost_usd}`（フィールドを足さない。後方互換）。失敗も今と同じエラー（`upstream_unavailable`・`model_rejected`・`invalid_input` など）。このとき答えの本文は UserDO に残さない（返した時点で消す）。
2. 間に合わなかったとき: `{consult_id, status: "pending", retry_after_seconds?}`。エラーではなく、通常の結果。
   - `consult_id` は予約と同じ `consult-<ULID>`。
   - `retry_after_seconds` は通常付けない（`consult_result` 自体が long polling なので、すぐ呼べばよい）。待機の枠が埋まっていて待てなかったときだけ `WAIT_RETRY_AFTER_SECONDS`（5）を付ける。

成功の形には `status` が無く、`pending` のときだけ `status` を持つ。

## consult_result

入力 `{consult_id, timeout_seconds?}`。`timeout_seconds` は `task_wait` と同じ規則（既定 30、上限 50 にクランプ、整数 0 以上）。答えが出るか待ち時間が尽きるまで待つ。

| 状態 | 応答 |
|---|---|
| pending（まだ裏で続いている） | `{consult_id, status: "pending", retry_after_seconds?}` |
| done | `{consult_id, status: "done", text, model, usage{...}, cost_usd}`（成功の形に `consult_id` と `status` を足したもの） |
| failed | `{consult_id, status: "failed", error: {code, message, retry_after_seconds?}, cost_usd}`。`error` は上の 1 の失敗と同じコード・文言・`retry_after_seconds` の規則。呼び出し自体は成功なので通常の結果で返す |
| not_found | エラー `not_found`。ID の形式が不正、存在しない、**他人の consult_id**、保持期間を過ぎた、のどれも同じ文言（存在を漏らさない） |

- 所有者の判定: UserDO はユーザーごとなので、他人の ID は自分の UserDO に行が無く、自然に `not_found` になる。`consult_answer` の `owner_id` との照合も二重に行う。
- done / failed は保持期間内なら何度でも同じ答えを返す（冪等。取得の応答が失われても取り直せる）。
- 待っている最中にクライアントが切れても、裏の処理にも答えにも影響しない。
- 同時に待てる数は `task_wait` と同じ考え方で上限を持つ（`MAX_CONCURRENT_WAITERS`）。超えたら pending と `retry_after_seconds` を返す。

## 裏の処理をどこで持つか

| 案 | 内容 | 評価 |
|---|---|---|
| A. gateway の `waitUntil` | リクエストの後に続ける | `waitUntil` は応答・切断の後に約 30 秒しか生きない。長いモデルに足りない。不採用 |
| B. AgentDO が答えを持つ | AgentDO が裏で続け、答えを自分に保存する | モデルの呼び出しは AgentDO にあるが、**精算ができない**。agent は別の Worker で `USER_DO` のバインディングを持たず、足すと agent から gateway への依存と権限が増える（デプロイ手順を増やさない方針に反する）。精算を「答えを取りに来たとき」にすると、取りに来ない consult が予約のまま残る。不採用 |
| C. 専用の ConsultDO | consult 用の DO クラスを新設 | クラス・マイグレーション・バインディングが増える（D10 で退けた理由と同じ）。UserDO が予約・精算・索引を既に持つので二重になる。不採用 |
| **D. UserDO が持つ（採用）** | UserDO が AgentDO.consult の RPC を裏で待ち、答えと精算を自分の中で完結させる | 予約・精算・`consult_log`・alarm が既にあり、**答えの保存と精算を同じ同期区間（`transactionSync`）で行える**ので、「答えは出たが精算されない」「精算されたが答えが無い」が起きない。バインディングもクラスも足さない（gateway の `AGENT_DO` を UserDO も使う）。リクエストの切断に左右されない |

D の要点:

- UserDO のメソッド `startConsult(request)` は、`consult_answer`（下）に pending の行を作り、`AgentDO.consult` の RPC の完了を待つ非同期処理を始めて**すぐ返る**。処理は完了時に（成功・失敗・例外・時間切れのいずれでも）答えの保存・精算（`settleConsult` と同じ規則）・`consult_log` の確定を同じ同期区間で行い、待っている呼び出し（`waitConsult`）を起こす。
- 保存するのは UserDO のテーブル `consult_answer`: `consult_id`（主キー）・`owner_id`・`status`（pending / done / failed）・`result_json`・`started_at`・`finished_at`・`expires_at`。`consult_log`（索引の outbox で Directory へ配送される）には本文を入れない。
- 裏の呼び出しの上限は `CONSULT_BACKGROUND_TIMEOUT_MS`（既定 5 分）。超えたら今と同じく実費不明として予約額で精算し、failed（`upstream_unavailable`）にする。
- 待つ処理（`waitConsult(consultId, timeoutMs)`）はメモリ上の waiter で起こす。UserDO が作り直されて waiter が消えても、行（SQLite）が正なので、呼び直せば最新の状態を返す。
- DO は未完了の RPC を待つ間は生きているが、デプロイやエラーで作り直されると裏の処理は失われる。その救済は alarm と期限（次節）で行う。
- 限界: 1 ユーザーの consult が 1 つの UserDO に集まるが、待つだけで CPU は使わないので許容する。AgentDO は consult ごとに別インスタンスのまま。

### 答えの保持期間と、取りに来なかった答え

- 保持は**完了から 1 時間**（`CONSULT_ANSWER_TTL_MS`）。過ぎた行は UserDO の alarm（既存の consult 索引の alarm に相乗り）と読み取り時に削除し、以後は `not_found`。
- 取りに来なかった答えに特別なことはしない（費用は完了時に精算済みなので、予算には影響しない）。期限で本文ごと捨てる。通知や再送はしない。
- 答えの本文はここ（UserDO）にしか残さない。AgentDO は従来どおり完了時に `deleteAll()`。ログ・監査・Directory には本文を出さない。
- 1 行は 2MB 未満（`max_output_tokens` の上限で収まる）。超えるなら切り詰めず failed にする（実際には起きない想定。Unit で固定）。

## 予約・精算・期限切れ・budget_status

- 予約は今と同じ（`consult` の入口で `reserveConsult`、`CONSULT_BUDGET_USD`）。`consult_id` も同じ。
- 精算は**裏の処理の完了時に UserDO が 1 回だけ**行う（`settleConsult` の冪等性を使う）。gateway のリクエストは精算をしない。`consult_started` はリクエスト側、`consult_finished` は完了処理が出す（同じ `userId`・`consult_id`・`model`・`cost_usd`）。
- pending の間は、予約が開いたまま（`budget_status` の `reserved_usd` に数える）。
- 期限: 今の 5 分（`CONSULT_STALE_AFTER_MS`）は「リクエストが切れて精算が消えた」ための値で、裏の呼び出しの上限 5 分と食い違い、**pending 中に閉じてしまう**。そこで次のとおり変える。
  - `CONSULT_STALE_AFTER_MS` を `CONSULT_BACKGROUND_TIMEOUT_MS` + 余裕（既定 10 分）にする。
  - 精算は UserDO の中で完結するので、通常は期限に当たらない。期限は「UserDO の作り直しなどで裏の処理が失われた」ときの最後の網。
  - 期限で閉じるときは、予約額で閉じて（`settled_estimated`。今と同じ）、`consult_answer` も failed（`upstream_unavailable`）にする。pending のまま残さない。閉じた後に遅れて届いた完了は、`settleConsult` が `applied: false` で無視し、答えも捨てる。
  - 期限の判定は今と同じく予約・`budget_status`・`consult_result` のときと、alarm（pending の行があれば期限に alarm を置く）で行う。
- `budget_status`: `reserved_usd` に pending の予約が入る（変更なし）。追加で `pending_consults`（開いている consult の件数）を返す。`estimated_usd` は、期限で閉じた分を今までどおり数える。応答の他のフィールドは変えない。
- 同時に pending にできる consult の数は上限を持つ（推奨 4。超えたら `concurrency_limit`）。月の枠で既に抑えられるが、暴走時の UserDO の負荷を抑える。

### 道具つきの consult（#135）

`tools` を指定した consult は、UserDO が裏でモデルとの往復（道具の実行を含む）を回す（`docs/specs/design.md` の D10「道具（tools）」）。pending と `consult_result` の仕組みはそのまま使う。

- 予約額は `CONSULT_TOOLS_BUDGET_USD`（既定 1）。予約の行（`task_budget`）の `consult_tools = 1` で、道具つきと分かる。
- 裏の上限は 10 分（`CONSULT_TOOLS_BACKGROUND_TIMEOUT_MS`。1 歩は 120 秒まで）、期限切れは 15 分（`CONSULT_TOOLS_STALE_AFTER_MS`）。道具なしは今までどおり 5 分と 10 分。
- 上限を過ぎたら、以後の歩・道具を呼ばずに予約額で精算する（`estimated`）。
- 古い agent と新しい gateway が混ざったときは、道具の呼び出しが返らないので道具が使われないだけで、安全側に倒れる（仕様として許容する。デプロイの順序は web → agent → gateway）。
- 答え（done）には `tools_used` / `tools_closed` が付くことがあり、道具を使った text は非信頼データとして囲む（下の「非信頼データの扱い」）。

## 費用の確定（AI Gateway のログ）

タスクと同じく、精算した consult の費用を、終了後に AI Gateway の Logs API で確定し直す。agent の見積もりや予約額（実費不明のとき）を、実際の cost に置き換える。

- 予定: 精算された consult（実費が分かった場合も、予約額・見積もりで精算した場合も、期限で閉じた場合も）について、UserDO が `consult_reconcile`（`consult_id`・`base`・`attempt`・`done`）に 1 行持つ。精算と同じ同期区間で作る。設定（`CLOUDFLARE_API_TOKEN`・`CLOUDFLARE_ACCOUNT_ID`・`AI_GATEWAY_ID`）が揃っていない環境では作らない。
- 時刻: 精算から 2 分・10 分・1 時間・6 時間（タスクと同じ `RECONCILE_DELAYS_MS`）。alarm は既存のものに相乗りし、次の予定の時刻を `nextConsultDeadline` に含める（索引の配送・期限・答えの保持の用事と、いちばん早い時刻に揃える）。1 回の alarm で試すのは 5 件まで。
- 照合: `fetchConsultGatewayCost`。`metadata.value` が consultId のログを引き、metadata の `consultId` が一致し `caller` が `"consult"` のものの cost を合計する。期待する呼び出し回数は 1（`AgentDO.consult` は AI Gateway を 1 回だけ呼ぶ）。道具つき（#135）は往復の歩の数で、精算のときに `consult_reconcile.model_calls` に残す。件数が足りない・成功したログに cost が無い・API のエラー・例外は「まだ」。
- 道具つきの web の費用は AI Gateway のログに載らないので、精算のときに `consult_reconcile.web_micro` に残し、確定額に足す（上書きで消さない）。期限切れ・裏の上限で閉じた道具つきの consult は、歩の数も web の費用も分からないので予定を作らない（予約額のまま）。
- 確定: `task_budget` の `settled_micro` を上書きし、`cost_source = 'gateway'`・`settled_estimated = 0` にする（閉じていて `estimate` のものだけ、1 回だけ）。`consult_log` にも写して dirty にし（`revision` を進める）、次の配送で索引（Directory）に届く。
- 打ち切り: 「まだ」と例外は回数を進め、4 回目でも確定できなければ見積もりのまま終える。設定が外れた（`unconfigured`）ときは何もせず終える。無制限には再試行しない。
- 月の枠: 確定額は閉じた行の `settled_micro` として月の集計に入る。`consult_answer` に保存した `cost_usd`（failed の答え）は精算時の額のまま。

## 非信頼データの扱い

答えはモデルの出力で、今の `consult` と同じ扱い: 非信頼データの囲みはしない。ただし道具（`tools`）を 1 回でも呼んだ consult の答えは、第三者が書いた Web の内容を読んだモデルの出力なので、`<<<UNTRUSTED_CONSULT_ANSWER: ...>>>` と `<<<END_UNTRUSTED_CONSULT_ANSWER>>>` で囲む（done も同じ）。`consult` と `consult_result` の説明と instructions に「答えは助言で、事実確認は自分で行う」を残す。`consult_result` の done も同じ。失敗の `message` はワーカーの自由文を含めず、固定の文言にする（今と同じ）。`consult_id` は ULID の形式を検証してから使う（`isConsultId`）。

## ツールの説明・instructions・クライアントへの影響

- `consult` の説明: 待つのは最大 50 秒。`status: "pending"` が返ったら `consult_id` で `consult_result` を呼ぶ。`consult_result` は最大 50 秒待つので、`pending` が返る間は呼び直す。会話を止めたくなければ、`task_wait` と同じくサブエージェント（バックグラウンド）に待たせる。
- 「ワーカー側の待ち時間の上限は 120 秒」「約 5 分後に予約額で閉じる」の記述を、新しい値（裏の上限 5 分、期限 10 分、答えの保持 1 時間）に直す。
- `consult_result` の説明: `pending` / `done` / `failed` / `not_found` の意味、保持は 1 時間、`failed` の `error` の読み方。
- mod（plugins/rovo）: `/rovo:consult` の手順（SKILL.md）に「pending が返ったら consult_result で受け取る。待つ間は会話を止めない」を足し、`plugin.json` の version を上げる。mod のコマンドの matcher は名前の一覧なので、`consult_result` が必要なら足す。
- Cowork など他のクライアント: 打ち切りが長いクライアントは、今までどおり 1 回で答えを受け取る。`pending` を知らない古いクライアントは、これまで「timed out」になっていた場面で `pending` を受け取る。説明を読めるモデルなら `consult_result` で続けられる。設定の追加は不要。
- `docs/specs/design.md` の D10（`consult`）の記述（120 秒、30 分/5 分の期限、精算の場所）を、この仕様に合わせて直す。

## テストの方針

TDD（Red → Green）で、Unit と E2E の両方。

**Unit**
- `consult.ts`（deps 差し替え）: 50 秒以内に終わる → 今と同じ形（`status` が無い）で、本文が UserDO に残らない。50 秒を超える → `pending`（`consult_id` が予約と一致）。待ち時間は注入できるようにして、実時間を待たない。失敗（`model_rejected` など）は従来のエラー。
- `UserDO`: `startConsult` が即返る。裏の完了で答えの保存と精算が同じ同期区間で起きる（片方だけが残らない）。クライアントの切断を模しても精算される。完了前の `waitConsult` が起きる／タイムアウトで pending。done / failed の冪等な再取得。保持期間（1 時間）後の `not_found`。他人の `consult_id` は `not_found`。裏の上限での予約額精算（`estimated`）。期限（10 分）が pending を早く閉じない／失われた pending を閉じて failed にする。遅れて届いた完了を無視する。同時 pending の上限。`budget_status` の `pending_consults`。
- `consult_result` の入力検証（形式不正、`timeout_seconds` のクランプ）。
- 既存の `consult` のテストは、成功・失敗の形が変わらないことの回帰として残す（弱めない）。

**E2E**（gateway の既存の E2E 構成。agent は台本 `withTestScripts` で差し替える）
- 台本が速い: `consult` が 1 回で答える。
- 台本が 50 秒を超えて遅い: `consult` → `pending` → `consult_result` で done。`budget_status` で、pending 中は `reserved_usd` と `pending_consults` が増え、done の後に `spent_usd` に実費が入る。
- クライアントが `consult` の途中で切れても、精算される（`consult_result` で done が取れる）。
- 台本が失敗: `consult_result` が failed。台本が上限を超えて返らない: 予約額で精算された failed。
- 別ユーザーの `consult_id` で `consult_result` → `not_found`。
- 時間を使うテストは時計を差し替えて短くする。実デプロイや実プロバイダーは使わない。

## 決めていないこと

- `consult` の取り消し（`consult_cancel`）。pending を止めたい要望が出たら足す。今回は作らない。
- 同時 pending の上限の値（推奨 4）と、`CONSULT_BACKGROUND_TIMEOUT_MS`（推奨 5 分）の既定。思考の長いモデルの実際の所要時間を見て決める。
- `retry_after_seconds` を pending に常に付けるか（今は通常付けない）。
- 完了をクライアントへ push する仕組み（MCP の progress 通知など）。クライアントごとの対応差が大きいので、今回は long polling だけにする。
