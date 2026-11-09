# 仕様: 同じ PR への積み足し（continue_task_id）

`task_start` に `continue_task_id` を足し、**終わったタスクの PR ブランチ `agent/task-<元の id>` に新しいタスクのコミットを直接積む**。PR は増えず、1 本の PR のまま修正を重ねられる。この文書は設計だけを決める（**利用者の承認済み**。決めたことは「決めたこと（利用者の承認済み）」に書く）。実装は 4 つのタスク（A → B1 → B2 → B3）に分ける（「実装の分割」）。

用語: Sandbox で動くエージェントを「ワーカー」、タスクを頼む側（MCP のクライアント。AI か人）を「クライアント」と呼ぶ。「元のタスク」は積み足しの土台にするタスク、「積み足しタスク」は `continue_task_id` 付きで始めたタスク、1 本の PR に積まれたタスクの並びを「チェーン」と呼ぶ。チェーンの最初のタスク（ブランチを作ったタスク）を「根」と呼ぶ。

## 背景

利用者のフィードバック: 「課題 1 つに対して修正を重ねると PR が複数になり、過程が分かりづらい。1 PR を作り、修正が必要ならそのブランチに修正を重ねたい。PR ブランチに向けて別 PR を作ってマージする方式ではなく」。

今の rovo の修正の頼み方は「積み上げ PR」: `task_start` の `base_ref` に `agent/task-<元の id>`、`base_sha` に元の PR の head を渡すと、**別のブランチ・別の PR** ができる（`next-steps.ts` の `fixAdvice`、`mcp/server.ts` の説明）。修正のたびに PR が増え、クライアントは下の PR から順にマージしなければならない。

動機が違う 2 つの使い方を分ける。

- 同じ課題への修正（レビューの指摘への対応、テストの追加、やり直し）: **この仕様**。同じ PR に積む。
- 互いに依存する別々の作業（並列に分けたタスクの一方が他方の上に載る）: 今の積み上げ PR のまま。別の PR であることが目的なので変えない。

## 現状（2026-11-09 時点。コードで確かめた）

- 作業ブランチは `agent/task-<id>` で、`TaskDO` が `ensureCreated` で `github_link.branch` に入れる（`apps/gateway/src/tasks/task-do.ts` の `ensureCreated` 内の `INSERT INTO github_link`）。
- 準備（`runSetup`、`task-do.ts`）: ① `base_sha` の親に持つ決定的な空コミット（`rovo: start task <id>`）を作り `initial_sha` に保存 → ② `createBranch(branch, initial_sha)`。既にあれば `compare(initial, head)` が `identical` / `ahead` 以外のとき `SetupFailure("branch_conflict")` → ③ `ensurePull`（`findOpenPull(branch)` があれば `useExisting`、無ければ Draft PR を作る。base が `base_ref` と違えば `pr_base_mismatch`）→ PR 番号・URL を `github_link` と `task.draft_pr_url` に保存。
- push の門番は 3 層ある。いずれも `agent/task-<自分の taskId>` に固定されている。
  1. `AgentDO.validate`（`apps/agent/src/agent-do.ts`）: `spec.branch !== "agent/task-" + spec.taskId` なら `invalid_spec: branch`。
  2. `OutboundGateway`（`apps/agent/src/outbound-gateway.ts`）: `allowedRef(taskId)` が `refs/heads/agent/task-<props.taskId>` を返し、`decideOutbound`（`outbound-policy.ts`）の `WORK_BRANCH = /^agent\/task-[A-Za-z0-9_-]+$/` と、receive-pack の本文のコマンドの ref・newSha と、`SandboxDO` の許可証（ref と newSha）が一致したときだけ認証を付ける。
  3. トークンは `props.taskId` の SandboxDO から引く。ワーカーが bash から直接送る push は許可証が無いので拒否される。
- 完了時の push（`AgentDO.syncBranch`）は `readRemote()`（ls-remote）で今の先頭を読み、それを期待値にして `--force-with-lease=<ref>:<remote>` で push する。つまり**人や他が間に push していても、読んだ直後の値が期待値になり、上書きする**（今の 1 タスク 1 ブランチでは誰も触らない前提）。チェックポイントの push（`git_commit`・予算切れの WIP）は通常の push（force なし）。
- 空のまま終わったタスクの片付け（`closeEmptyPull`、`task-do.ts`）: PR の head とブランチの先頭が両方 `initial_sha` で、PR が Draft で open のとき、PR を閉じてコメントし、ブランチを `initial_sha` を条件に削除する。
- PR 本文（`apps/gateway/src/github/pr-body.ts`）: 目印 1 組 `<!-- rovo:begin -->` / `<!-- rovo:end -->`。`applyManagedBlock` はその範囲だけを書き換え、無ければ末尾に足す。
- マージの判定:
  - `head_matches` は **`TaskDO.updatePullBody`（終端の確定時）が書く 1 回きりのスナップショット**で、`github_link.head_sha`（GitHub から読んだ PR の head）と一緒に保存される（`task-do.ts` の `UPDATE github_link SET head_sha = ?, head_matches = ?`）。ほかに書く場所は無い（コードで確認。後から更新する照合の処理は無い）。
  - `prContext(op="merge")`（`task-do.ts`）は `head_matches === 1` と `head_sha !== null` を要求し、`head_sha` を `expectedSha` として UserDO に渡す。
  - `UserDO.pullProblem`（`user-do.ts`）は PR 番号・head のブランチ名・リポジトリだけを見る。**sha は見ない**。sha の照合は `UserDO.prMerge` が別に行う: `pull.headSha !== opts.expectedSha` なら `head_moved` で拒否し、一致したときだけ `mergePull(sha = expectedSha)` を GitHub に送る（GitHub 側も sha が違えば 409）。
- 現状の MCP の説明（`mcp/server.ts` の `SERVER_INSTRUCTIONS` 7・12、`START_DESCRIPTION`、`next-steps.ts` の `fixAdvice` と FAILED 時の案内）は「base_ref に `agent/task-<id>`、base_sha に `pr.head_sha` を指定すると、この PR に積む形で続けられる」と書く。実装は**別ブランチ・別 PR を作る**ので、読み手は「同じ PR に積まれる」と取れる。この仕様で直す。

### 未検証の積み足しコミットがマージされうるか（結論）

**古いタスク id で `task_pr_merge` しても、未検証の積み足しコミットはマージされない。** 根拠:

1. 元のタスクの `github_link.head_sha` は、元のタスクが終端になった時点の PR の head のまま固定される（上記。積み足しタスクが push しても元のタスクの行は更新されない）。
2. 積み足し後の PR の現在の head は元の `head_sha` と違う。`UserDO.prMerge` は `pull.headSha !== expectedSha` で `head_moved` を返し、マージ API を呼ばない（`user-do.ts` の `prMerge`、`headMoved`）。
3. すでにマージ済みの PR でも、`pull.headSha === expectedSha` のときだけ `already_merged` 扱いで、違えば `head_moved`。

つまり今のコードの sha の照合が、すでにこの穴を塞いでいる。残る問題は 3 つで、この仕様で扱う。

- **メッセージと案内が不親切**: 古い id で呼ぶと `head_moved`（「検証のあとにブランチが動いた」）が返るだけで、「より新しいタスクがある」と分からない。→「マージの判定」で、`next_steps` と `head_moved` のメッセージを直す。
- **`task_result` の `head_matches_verified` は古いタスクでは `true` のまま**: PR の今の head と比べていない（終端のスナップショット）。人が PR に直接 push した場合も同じ（今もそう）。→ マージ時の照合（`prMerge`）が最後の砦であることを仕様に明記し、`task_result` の `pr.head_sha` は「終端の時点」の値だと説明に書く。
- **先行タスクの warnings が最新のタスクに現れない**: `prContext(op="merge")` は自分の `composeResult().warnings` が 1 件でもあれば `warnings_present` で止める。積み足しタスクの warnings は積み足し分の差分（`base_sha..tip`）だけから作られるので、先行タスクで出た warning（テスト設定の変更など）が、きれいな積み足しタスクでマージを通す形で**洗われる**。→ 先行タスクの warnings を引き継ぐ（「マージの判定」）。

## 決めたこと（利用者の承認済み）

利用者が確定した判断（6 項目）:

1. `base_sha` は**必須**（省略による最新の head への追従は初版では採らない）。
2. 先行タスクの warnings は**引き継ぐ**（`inherited_warnings`）。確認済みの warning を打ち消す仕組みは作らない。引き継いだ warning があると、最新のタスクでも `task_pr_merge` は `warnings_present` で止まり、手動のマージになる。
3. 元にできるのは**終端全般**（`COMPLETED`・`FAILED`・`BUDGET_EXCEEDED`・`CANCELLED`）。ただし PR が無いもの、`closed_empty` のもの、`task_review` のタスクは元にできない。
4. 同時実行の鍵（`branch_lock`）は `finishTask` と**同じ経路**で解放する（終端の確定で鍵だけ先に返す案は採らない）。副作用は「範囲外・既知」。
5. 古いタスクの `pr_merged` は更新しない（後回し）。副作用は「範囲外・既知」。
6. 積み足しの**回数に上限は設けない**。副作用は「範囲外・既知」。

そのほか:

- push の門番を広げる。ただし範囲は「**同じ利用者が rovo で作った `agent/task-*` のブランチだけ**」。人が作ったブランチ・PR は対象外で、「rovo はクライアントのブランチに書き込まない」約束は保つ。
- push 先のブランチ名は gateway が `task_start` の時点で決めて `TaskDO` に記録し、props で agent に渡す。ワーカーの入力からは決めない。許す ref は必ず `^refs/heads/agent/task-[A-Za-z0-9_-]+$` に一致することを検査する。
- 入口は `task_start` の `continue_task_id`。受け付ける条件は「API」に書く。
- 同時実行: 1 つのチェーン（1 本の PR）に、非終端の積み足しタスクは同時に 1 つまで。`UserDO`（利用者ごとの単一スレッドの DO）の同期区間で判定し、別のロックの仕組みは作らない。
- 初期の空コミットと `createBranch` を飛ばす。`initial_sha = base_sha`。`github_link` に元の `pr_number` / `pr_url` / `branch` を写し、`continuation_of` を記録する。
- 完了時の push の lease は `readRemote()` ではなく、積み足しタスクでは `initial_sha`（以降はそのタスクが最後に push できた sha）に対して取る。人や他が間に push していたら上書きせず、明示的に失敗させる。`initial_sha` が新しい sha の祖先であることも確かめ、前のタスクのコミットの書き換えを拒否する。
- `closeEmptyPull` は積み足しタスクでは飛ばす（変更なしの積み足しで元の PR が閉じられ、ブランチが消えるのを防ぐ）。
- PR 本文はタスクごとの節にして過程を追えるようにする。既存の 1 組の目印の PR も壊さない。
- `task_pr_merge` は、マージ時に PR の現在の head と `gl.head_sha` を比べる（上の結論のとおり `prMerge` に既にある）。`next_steps` は積み足しのあと、最新のタスク id でマージするよう案内する。
- MCP の説明と `next_steps` を、この機能に合わせて直す。`worker-review.md` の「門番を広げない」の記述も、この設計に合わせて改める（同じ変更で書き換える）。
- 範囲外: Backlog 連携（保留中）、人が作った PR への積み足し、ダッシュボードの表示の手直し。

### 却下した案

- **今の積み上げ PR（`base_ref` に `agent/task-<元>` を渡して別 PR を立てる）で済ませる案**: 利用者が明示的に却下した。PR が増えて過程が追いにくくなることが、そもそもの不満。
- **任意のブランチ・人が作った PR のブランチへの push を許す案**: 安全上不可。門番を「rovo が作ったブランチ」より広げない。

## 設計上の決め方

| 項目 | 決め方 | 理由 |
|---|---|---|
| 入力の名前 | `continue_task_id` | 動詞で意図が分かる。`base_ref` に似た名前（`stack_on` など）だと今の積み上げ PR と混同する |
| `repository`・`base_ref` | 積み足しでは**省略可**。省略時は元のタスクから引き継ぐ。渡すなら元と同じでなければ `invalid_input` | 修正の頼みで毎回書かせない。PR の base は変えられない（変えると別の PR になる） |
| `base_sha` | **必須**。元のブランチの今の head と一致しなければ `branch_moved` | クライアントが見ている状態の確認になる。省略で最新に追従する案は、人が間に push した変更を黙って取り込むので採らない（利用者の承認済み。使い勝手の声があれば `base_sha: "head"` のような明示の値で足す） |
| 元にできるタスクの状態 | 終端（`COMPLETED`・`FAILED`・`BUDGET_EXCEEDED`・`CANCELLED`）で、エージェントの停止（`isStopped`）**と GitHub の終了処理の完了（`finalize_done = 1`。PR があれば `body_done = 1` も）を確認済み**。かつ**チェーンの最新のタスク** | `isStopped`（`cancel_state === "stopped"`）だけでは、`finalizeGithub`・`updatePullBody`・`closeEmptyPull`（`finalize_retry_at` による再試行あり）が後から走りうる。遅れた `closeEmptyPull` が PR を閉じてブランチを消す、遅れた `updatePullBody` が `head_sha` / `head_matches` を上書きする、を防ぐ。失敗したタスクの WIP の続きからやり直したい場面があるため `COMPLETED` に限らない。最新でないタスクからの積み足しは、チェーンの警告を洗うので断る（受け付ける条件 4・9） |
| ブランチの持ち主（根） | チェーンの根の id。`branch = agent/task-<根の id>`。積み足しタスク自身の id は branch に入れない | 1 本の PR の head は 1 つのブランチ。積み足しの積み足し（C1 → C2）でも、根を引き継ぐ |
| 同時実行の鍵 | ブランチ名（`agent/task-<根の id>`）。`UserDO` の `branch_lock (branch PRIMARY KEY, task_id)` | 利用者が同じなので UserDO に置ける。枠（`reservation_slot`）の予約と同じ同期区間で判定でき、解放も同じ経路（`finishTask`・回収）に乗る |
| 引き継ぐ先行タスクの warnings | 元のタスクの `composeResult().warnings`（と、その元から引き継いだ分）を `inherited_warnings` に保存し、`task_pr_merge` の判定に足す。`base_sha` が rovo の push と分かっている sha でないときは `base_not_from_rovo` を 1 件足す（受け付ける条件 8） | 上の「洗われる」問題を塞ぐ。`task_result` の `warnings` には `inherited from <id>: ` を前に付けて出す |
| チェーンの最新のタスク | `UserDO.branch_chain (branch PRIMARY KEY, latest_task_id, prev_task_id)`。積み足しの予約で `latest_task_id` を更新する。行が無ければ根が最新 | `TaskDO` の `superseded_by`（fail-soft）には頼らず、`UserDO` の同期区間で確実に判定する |
| PR のタイトル | 変えない | 積み足しのタイトルはタスクの title。PR の題名はクライアントのもの |
| 新しいエラーコード | `branch_moved`・`branch_busy`（`continue_superseded` などは `conflict` の接頭辞） | `head_moved` を足したときと同じ形で `ToolErrorCode` に足す。それ以外は既存のコード + 固定の接頭辞付きメッセージ（`fork_not_supported:` と同じ書き方） |

## API

### task_start の入力

追加する入力は 1 つ。

| 入力 | 型 | 既定 | 意味 |
|---|---|---|---|
| `continue_task_id` | string（ULID） | なし | このタスクの PR ブランチに、新しいタスクのコミットを積む |

`continue_task_id` を渡したとき、`repository`・`base_ref` は省略できる（`taskInputObject` の必須から外し、`continue_task_id` が無いときだけ従来どおり必須にする。`superRefine` で検査する）。それ以外の入力（`title`・`instructions`・`acceptance_criteria`・`verification_commands`・`model`・`effort`・`review_policy`・`review_*`・`budget_policy`・`sandbox_instance`）は今と同じで、**積み足しタスクごとに自由に選べる**（元のタスクの設定は引き継がない）。

- **冪等性の指紋**: `continue_task_id` があるときだけ、指紋に含める新しい版にする。無いときの指紋は変えない（`validation.ts` の `v4` / `v5` / `v6` の扱いに倣う）。

### 受け付ける条件

`task_start` の認可（`authorizeStart`）に加えて、新しい `UserDO.authorizeContinue` が次を順に確かめる。外部（GitHub / DO）を呼ぶ前の入力検査（形式）は `checkStartInput` が先に行う。

1. 元のタスクが**呼んだ人自身のもの**。他人のタスク・存在しない id は同じ `not_found`（存在を教えない）。
2. 元のタスクが `task_start` のタスク（`task_review` のタスクは元にできない: `invalid_input`・`continue_review_task`）。
3. 元のタスクが終端で、**停止（`isStopped`）と GitHub の終了処理の完了（`finalize_done = 1`。PR があれば `body_done = 1` も）を確認済み**。そうでなければ `conflict`・`continue_not_finished`（`task_wait` で終端を待ち、`task_result` が `not_ready` を返さなくなってから再試行するよう案内する）。`isStopped` だけでは、終了処理（`finalizeGithub`・`updatePullBody`・`closeEmptyPull`）が後から走りうる。
4. 元のタスクが**チェーンの最新のタスク**。`UserDO.branch_chain` の `latest_task_id` と一致しない（行が無ければ根の id と一致しない）ときは `conflict`・`continue_superseded`（メッセージに最新のタスク id を載せ、その id で続けるよう案内する）。古いタスクから積み足すと、間のタスクの警告が引き継がれずに洗われるため。
5. 元のタスクに PR がある（`github_link.pr_number` が非 null）。準備で失敗して PR が無いものは `conflict`・`continue_no_pr`。`closed_empty = 1`（rovo が空の PR を閉じた）は `conflict`・`continue_pr_closed`。
6. `repository` が渡されたら元と同じ、`base_ref` が渡されたら元の `base_ref` と同じ。違えば `invalid_input`・`continue_repository_mismatch` / `continue_base_ref_mismatch`。
7. 呼んだ人本人のトークンで PR が見え（`authorizeReview` と同じ。見えなければ `not_found`）、PR が open で未マージ。閉じていれば `conflict`・`continue_pr_closed`、マージ済みなら `conflict`・`continue_pr_merged`。PR の head のブランチが元のタスクの `github_link.branch` と一致し、head のリポジトリが base と同じ（fork でない）こと（base も元の `base_ref` と同じこと）。違えば `conflict`・`continue_pr_mismatch`。
8. **`base_sha` が PR の今の head と一致**。違えば `branch_moved`（メッセージに今の head の sha を載せ、`task_result` の `pr.head_sha` か `git ls-remote` で確かめ直すよう案内する）。一致したうえで、`base_sha` が**元のタスクの記録済みの head**（`github_link.head_sha`。rovo が push したと分かっている sha）と違うときは、`inherited_warnings` に警告 `base_not_from_rovo` を 1 件足す（人や他人の commit が、未レビューのまま `head_matches = true` で `task_pr_merge` を通るのを防ぐ。積み足し自体は止めない）。元のタスクの `head_sha` が null（`FAILED` などで終端の確定が push を読めなかった）ときは、記録済みの head を `github_link.initial_sha`（準備で確かめた、積み足し前の head。根なら空コミット）で代える。それとも違えば（チェックポイントの push が通っていた可能性があるが、rovo は確かめられない）、同じ警告を付ける。`FAILED` などの元のタスクでは `next_steps` が「`git ls-remote` で PR ブランチの先頭を確かめて `base_sha` に渡す」と案内する。
9. 同じチェーンに非終端の積み足しタスクが無い（無ければ `branch_busy`）。あわせて 4 を `reserve` の同期区間でもう一度確かめる（`continue_superseded`）。次節。

1〜8 は `reserve` の**前**に行う（予約を使わない）。9 は `reserve` の中で行う。

この確認は多重にかける（先行の確認はあくまで早めに断るため。正しさは後ろの層で保つ）。

| 層 | 確認 | 失敗したとき |
|---|---|---|
| `authorizeContinue`（上） | PR の今の head == `base_sha` | `task_start` が `branch_moved` |
| `UserDO.reserve`（同期区間） | チェーンの最新のタスク == 元のタスク、実行中の積み足しが無い | `continue_superseded` / `branch_busy` |
| `TaskDO.runSetup`（Installation Token） | ブランチの今の先頭 == `base_sha`、PR が open・未マージ・head のブランチと base が記録どおり | タスクが `FAILED`（`failure_phase: setup`、`reason: branch_moved` / `pr_not_open`） |
| `AgentDO.syncBranch`（lease） | リモートの先頭が lease の期待値のまま | `push_failed`（「失敗時の挙動」） |

### エラーコード

| コード | 意味 |
|---|---|
| `not_found` | 元のタスクが無い・他人のもの |
| `invalid_input` | 接頭辞で区別: `continue_review_task`・`continue_repository_mismatch`・`continue_base_ref_mismatch`（`base_sha` が無いのは形式の検査で既に `invalid_input`） |
| `conflict` | 接頭辞で区別: `continue_not_finished`・`continue_superseded`・`continue_no_pr`・`continue_pr_closed`・`continue_pr_merged`・`continue_pr_mismatch` |
| `branch_moved` | `base_sha` が PR ブランチの今の head と違う。人や別のタスクが push した、または古い sha を渡した |
| `branch_busy` | 同じ PR に積み足しタスクが実行中。終わるか `task_cancel` で止めてから、`branch_moved` が出なければ同じ入力で再試行する。`task_pr_merge` も、同じ PR に積み足しが実行中のあいだはこのコードで止まる（「マージの判定」） |

`branch_moved` と `branch_busy` は、`head_moved` を足したときと同じく `ToolErrorCode`（`mcp/server.ts`）と `ServiceErrorCode`（`tasks/service.ts`）に足す。

### 応答

`task_start` の応答は今と同じ形に、積み足しのときだけ次を足す。

- `continuation: { of: <元のタスク id>, pr_number, pr_url, branch }`
- `draft_pr_url` は、積み足しでは**既存の PR の URL**（準備の前から分かっているので null にならない）

`task_status`・`task_result` の `pr` は、元と同じ PR（`number`・`url`・`branch`）を返し、`continuation_of`（元のタスク id）を足す。`pr.head_sha` はそのタスクが終端になった時点の PR の head。

### next_steps

`next-steps.ts` を次のように直す。

- `fixAdvice`（COMPLETED のあとの修正の頼み方）: 「同じ PR に修正を重ねるなら、`task_start` に `continue_task_id: <このタスクの id>`、`base_sha: <pr.head_sha>` を渡す。`repository` と `base_ref` は省略できる。別の PR にしたい（互いに依存する別々の作業）ときだけ、`base_ref` に `agent/task-<id>` を渡して積み上げ PR にする」。
- `COMPLETED` 以外で PR があるとき: 同様に `continue_task_id` を先に案内する。`pr.head_sha` が null（`FAILED` などで push を読めなかった）ときは、`base_sha` に渡す値を「`git ls-remote <repo> refs/heads/agent/task-<根の id>` で PR ブランチの先頭を確かめた sha」と案内する（`pr.head_sha` が無いので。チェックポイントの WIP が push されていることがある）。確かめた先頭が rovo の記録と違えば `base_not_from_rovo` の警告が付くことも添える。
- **積み足しのあと、古いタスクの `next_steps`**: PR の今の head が違うことは `next_steps` の生成時点では分からない（スナップショット）ので、`task_result` を読んだ時点で分かる範囲に書く。積み足しタスクがあるタスクは `task_result` に `superseded_by`（このタスクの id を `continue_task_id` に持つ、最新の積み足しタスクの id。無ければ省略）を足し、`next_steps` が「このタスクのあとに積み足しがある。マージするなら最新のタスク `<id>` の結果を確認して、その id で `task_pr_merge` する」と案内する。`superseded_by` は `TaskDO` が積み足しの作成時に元のタスクの `TaskDO` へ書く（1 本の RPC）が、書けなくても積み足しの作成は止めない（**案内のためだけの fail-soft の値**。正しさには使わない。「最新のタスク」の判定は `UserDO.branch_chain` が持ち、マージの安全は `prMerge` の sha 照合と `branch_lock` の検査が守る）。
- 積み足しタスクの `COMPLETED`: 「PR は元のタスクと同じ。全体のテストとレビューは今の PR のブランチで行い、よければこのタスクの id で `task_pr_merge`」。
- `mcp/server.ts` の `SERVER_INSTRUCTIONS` 7・12 と `START_DESCRIPTION`・`task_pr_merge` の説明を直す（「MCP の説明」）。

## gateway 側の変更

対象: `apps/gateway/src/tasks/{validation,service,user-do,task-do,next-steps,state}.ts`、`apps/gateway/src/mcp/server.ts`、`apps/gateway/src/github/pr-body.ts`、`apps/gateway/src/agent/contract.ts`。

### 入力の検査（`validation.ts`・`service.ts`）

- `continue_task_id` を `taskInputObject` に足す（ULID の形だけ検査。`isTaskId`）。`repository`・`base_ref` は `continue_task_id` が無いときだけ必須（`superRefine`）。
- `service.start` は `continue_task_id` があるとき、`authorizeContinue` が返した**固定した事実**（元のタスクの repository・base_ref・根の id・ブランチ・PR 番号と URL・先行 warnings）を、`options.continuation` として受け取り、`ensureCreated` に渡す（`task_review` の `options.pull` と同じ形）。呼び出し側の入力から TaskDO に直接渡さない。
- `reserve(requestKey, fingerprint, lock?)`: `lock = { branch, continueOf }`（`continueOf` は元のタスクの id）を足す。

### 元のタスクを読む（`TaskDO` の新しい RPC）

`TaskDO.continuationSource(ownerId)`: 所有者の確認（`notOwner` なら `not_found`）、`isReview`、`isTerminal && isStopped`、`github_link`（`pr_number`・`pr_url`・`branch`・`closed_empty`・`pr_merged`）、`row.base_ref`、`row.repository`・`repository_id`・`installation_id`、`continuation_root`（積み足しタスクなら根の id。根ならそのタスクの id）、`github_link.head_sha`・`initial_sha`・`finalize_done`・`body_done`、`composeResult(row, status).warnings` と `inherited_warnings` を返す。`isTerminal && isStopped` に加えて `finalize_done = 1`（PR があれば `body_done = 1`）を満たさないものは、`continue_not_finished` を返せるよう、満たさない理由が分かる形で返す。読むだけで状態を変えない。

### 作成（`TaskDO.ensureCreated`）

積み足しのとき、`task` 行と `github_link` を次のように作る。

- `task.base_ref` = 元の `base_ref`、`task.base_sha` = 入力の `base_sha`。
- `github_link.branch` = `agent/task-<根の id>`（`TaskDO` が根の id から作る。呼び出し元の文字列は使わない。根の id は `^[A-Za-z0-9_-]+$` を検査）。
- `github_link.initial_sha` = `base_sha`（「準備」の空コミットを飛ばす）、`pr_number`・`pr_url`・`pr_draft` = 元の値、`task.draft_pr_url` = 元の PR の URL。
- 新しい列: `task.continuation_of`（元のタスク id）、`task.continuation_root`（根の id）、`github_link.inherited_warnings`（JSON、既定 `[]`）。`addColumnIfMissing` で足す（既存のタスクは null）。
- `spec`（`BaseSpec`）に `continuation: { of, root }` を載せる（agent に渡す。「agent 側の変更」）。`initialSha` は準備の後で `start` の直前に足す今の流れのまま（`startFields`）。

### 準備（`TaskDO.runSetup`）

積み足し（`continuation_of` が非 null）では次のようにする。

1. `deps` の検出（今の step 0）は同じ（`base_sha` 時点の lockfile）。
2. 初期コミット（step 1）と `createBranch` / `compare`（step 2）は**飛ばす**。`branch_ready = 1` にする。
3. 代わりに確認する（Installation Token）。**どれも「読めなかった」は失敗にせず再試行する（今の準備と同じ。5xx やネットワークは `onGithubError` の再試行）。確定した不一致だけを `SetupFailure` にする。**
   - `getBranchSha(branch) === base_sha`。違えば `SetupFailure("branch_moved")`。ブランチが無ければ `SetupFailure("pr_not_open")`（消された）。
   - `getPull(pr_number)` が open・未マージ・head のブランチが `branch`・base が `base_ref`。違えば `SetupFailure("pr_not_open")`。
4. `ensurePull`（step 3）は飛ばす。`draft_pr_created` の代わりに `continued` イベント（`{ of, number, url, branch, initial_sha }`）を 1 回だけ出す。
5. `existing_pr_not_draft` の警告は出さない（`ensurePull` を通らない）。PR が Draft のままのとき（元が失敗して Draft のまま）は、積み足しが `COMPLETED` で終わったとき `autoReady` が Ready にする（今の動き）。

`SetupFailure` の理由コードに `branch_moved`・`pr_not_open` を足し、`task_result` の `failure_phase: setup` の説明（`mcp/server.ts`）と `setupFailureAdvice`（`next-steps.ts`）に書く。**準備で失敗した積み足しタスクは、PR にもブランチにも何も書かない**（後述の本文の更新も飛ばす）。

### 終端の確定（`TaskDO.updatePullBody` ほか）

- `closeEmptyPull` を**積み足しでは呼ばない**（`row.continuation_of !== null` なら返す）。変更なしの積み足しは、PR の head が `initial_sha` のまま `COMPLETED` になる（`pushedSha = initial_sha`）。PR は元のまま残る。変更なしであることは `summary` と PR 本文の節に出る。
- `updatePullBody` の `matches`（`pull.headSha === pushed`）は、そのタスクの push の結果と比べるので、そのまま使える。積み足しの終端のスナップショットが新しい `head_sha` / `head_matches` になる。
- 準備で失敗した（`setup_done = 0`）積み足しは、本文の節を書かない（PR が別物になっている恐れがあるため）。
- `composeResult` は `inherited_warnings` を `inherited from <元の id>: <元の warning>` として `warnings` に足す。

### 同時実行とチェーンの最新（`UserDO`）

`reservation_slot` と同じ DO の同期区間で `branch_lock` と `branch_chain` を扱う。

- 新しいテーブル `branch_lock (branch TEXT PRIMARY KEY, task_id TEXT NOT NULL, continue_of TEXT NOT NULL, reserved_at INTEGER NOT NULL)`（実行中の積み足し）。
- 新しいテーブル `branch_chain (branch TEXT PRIMARY KEY, latest_task_id TEXT NOT NULL, prev_task_id TEXT NOT NULL)`（チェーンの最新のタスク。積み足しが 1 度も無い PR には行が無く、最新は根。根の id は `branch`（`agent/task-<根の id>`）から取れる）。
- `decide()` の順番: ①同じ `requestKey` の既存（冪等・conflict）→ ②**`lock` があり、`branch_lock` に行があれば `branch_busy`**（回収の対象かは呼び出し側が確かめる。下記）→ ③**`branch_chain` の最新（行が無ければ根）が `continueOf` と違えば `conflict`・`continue_superseded`** → ④枠が上限なら `occupied` → ⑤月額 → ⑥新規発行。⑥で `reservation_slot`・`branch_lock` の追加と `branch_chain` の更新（`latest_task_id` = 新しいタスク、`prev_task_id` = それまでの最新）を同じ `transactionSync` の中で行う。
- **回収の照合（`decide()` は同期なので await できない）**: `occupied` と同じ形にする。`decide()` は ② で `{ kind: "locked", row }` を返し、`reserve` の呼び出し側のループが transaction の外で `shouldRelease(row.task_id, row.reserved_at)` を await して照合する。回収できるもの（一度も作られなかった予約）なら、`task_id` を指定して解放（`clearSlot` と `branch_chain` の巻き戻し）してから `decide()` をやり直す。解放できなければ、行の顔ぶれが照合の前と同じなら `branch_busy`、入れ替わっていれば判定をやり直す（`MAX_RECONCILE_ATTEMPTS` の中で）。
- **`branch_chain` の巻き戻し**: 回収（一度も作られなかった予約の解放）では、`latest_task_id` がその `task_id` のときだけ `prev_task_id` に戻す。`finishTask` では戻さない（作られて終端になったタスクは、`FAILED` でもチェーンの最新のまま。次はそのタスクを元にする）。
- 解放は `clearSlot(taskId)` と同じ経路: `finishTask` と、回収（`releasable`）。**`clearSlot` は枠が無いと早期に `false` を返す（`user-do.ts` の `clearSlot`）が、`branch_lock` の `task_id` の行は、その早期 return の前に必ず消す**（枠の行が先に消えていても、鍵だけ残って `branch_busy` が続くのを防ぐ）。戻り値（枠を持っていたか）は今のまま。キャンセル・失敗・予約の回収のどれでも同じ経路で解放される。解放の経路を増やさない。
- 鍵はブランチ名なので、同じ PR の元の根・積み足しのどれから始めても同じ鍵に当たる。**根のタスクは鍵を取らない**（根が非終端のあいだは、そもそもそのタスクを元にできない: 受け付ける条件 3）。
- 解放が `finishTask`（最終精算）になるため、タスクが終端になってから鍵が開くまでに数秒かかることがある。そのあいだに積み足しを頼むと `branch_busy` になる。`task_result` が `not_ready` を返さなくなってからの再試行で通る（`task_result` の終端判定と同じ「停止を確認」の基準に揃うまで待つ）。
- `branch_busy` のメッセージに、実行中の積み足しタスクの id を載せる（所有者本人の情報）。

### 通信の許可の範囲（`SandboxDO` から props へ）

props の `OutboundGatewayProps` に `branchTaskId?: string`（積み足しのときだけ、根の id）を足す。`SandboxDO` が props を作る 2 か所（`sandbox-do.ts` の傍受の登録と `waitContainerReady`）で `spec.continuation?.root` を入れる。依存関係のキャッシュを作るコンテナ（`DepsCacheDO`）は push を持たないので変えない。

### PR 本文（`pr-body.ts`）

- 目印をタスク別にする: `<!-- rovo:begin task=<id> -->` … `<!-- rovo:end task=<id> -->`。`<id>` は `^[A-Za-z0-9_-]+$` だけ（TaskDO が作る ULID）。`neutralize` の正規表現（`<!--\s*rovo:`）は新しい目印にも効く。
- 見出しを `## rovo` から `## rovo — task <id>` にし、積み足しの節には `Continues task <元の id>` の 1 行を足す。
- 節の探し方（`applyManagedBlock(existing, block, taskId, { isRoot })`）:
  1. 自分の id の節があれば、その範囲だけを書き換える。
  2. 無く、**根のタスク**（`continuation_of` が null）なら、旧形式の 1 組の目印（`<!-- rovo:begin -->` / `<!-- rovo:end -->`）を探して書き換える（この機能より前に作られた PR、初期の本文）。それも無ければ末尾に足す。
  3. 無く、**積み足しのタスク**なら、本文のうち最後の rovo の目印（旧形式・新形式のどちらでも）の終わりのすぐ後ろに新しい節を足す。1 つも無ければ（利用者が消した）末尾に足す。**旧形式の 1 組には触らない**（それは根の節）。
- 新しい本文は、根のタスクも `renderInitialBlock` から新形式で作る。この機能より前の PR は旧形式のまま残り、根の節として扱う。
- **ロールバック時の既知の挙動**: gateway を旧版に戻したあと、旧版の `applyManagedBlock` は新形式の目印（`task=<id>` 付き）を見つけられず、旧形式の目印で探して無ければ本文の末尾に 2 つ目の節を足す。新形式の PR に節が重複するが、害は無い（利用者の編集は残る）。
- 長さの上限（`MAX_PR_BODY_CHARS = 65536`）: 節が増えると超えうる。**今のタスクの節を完全な形で書き、前の節を古い順に短い形（状態・検証の合否・PR の head・`summary` の先頭 1 行）に縮める**。それでも収まらなければ、前の節の本文を削り、目印と見出しだけにする。外側（利用者の編集）の予約 4000 字は今のまま。
- 本文の更新は、元のタスクの `TaskDO` ではなく、積み足しタスクの `TaskDO` が自分の節だけを書く。同時に 2 つの `TaskDO` が同じ PR の本文を更新することは、同時実行の制約（1 つまで）で起きない。人が間に本文を編集しても、節の範囲の外側は残る（今と同じ）。

### マージの判定（`prContext` / `UserDO.prMerge`）

- `prMerge` の sha 照合（`pull.headSha !== expectedSha` → `head_moved`）は**そのまま維持する**。積み足しのあと古いタスクの id でマージしようとしても止まる。
- **積み足しの実行中は、どの id でもマージさせない**（`branch_busy`）。積み足しタスクが未 push のあいだ、PR の head は元のタスクの `head_sha` のままなので、sha の照合だけでは元の id のマージが通り、`delete_branch` でブランチも消せてしまう。`prMerge`（`user-do.ts`）が、`pullProblem` の後・`getPull` の結果を使う前に、`target.branch`（PrTarget のブランチ名）の `branch_lock` の行が残っていれば `conflict`・`branch_busy` を返す。`branch_lock` は `UserDO` が持つので、同期的に読める。`prContext(op="merge")`（`task-do.ts`）でも、`UserDO` に鍵の有無を尋ねて早めに断る（正しさは `prMerge` が保つ）。`task_pr_ready` は PR の状態だけを見るので止めない。
- 鍵が開くのは `finishTask` のあと（数秒の遅れあり）。実行中の積み足しが終わった直後の `task_pr_merge` は `branch_busy` になりうる。`task_result` が `not_ready` を返さなくなってから再試行する。
- `head_moved` のメッセージを、原因が分かる文にする: 「PR の head が、このタスクが検証した commit と違う。同じ PR に積み足しタスクがあるなら、最新のタスクの結果を確認して、その id で `task_pr_merge` する」。コードは `head_moved` のまま。
- `prContext(op="merge")` は、自分の `head_matches === 1` と `warnings`（先行の引き継ぎを含む）を従来どおり見る。**最新のタスク**の `head_sha` が `expectedSha` になる。
- 古いタスクで `task_pr_ready` を呼んだ場合は、PR の状態（`draft`）だけを見るので、そのまま通る（冪等）。
- マージが成功したとき、`recordPrAction` が `pr_merged = 1` にするのは**呼ばれたタスクだけ**（利用者の承認済み。「範囲外・既知」）。チェーンの他のタスクは `pr_merged = 0` のまま（既知。`task_result` の `pr.merged` が false に見える。ダッシュボードと同じく後回しにする。古い id で呼ぶと、`already_merged` の判定の `pull.headSha === expectedSha` が false なので `head_moved` になる。この場合のメッセージには「PR はすでにマージ済み」を含める）。

### MCP の説明（`mcp/server.ts`・`next-steps.ts`）

- `SERVER_INSTRUCTIONS` の 7: 「マージせず、新しいタスクで修正を頼む」の後を、`continue_task_id`（同じ PR に積む）の説明に差し替える。別 PR の積み上げは「互いに依存する別々の作業」の場合の説明として 12 に残し、「同じ課題の修正は `continue_task_id`」を足す。
- `START_DESCRIPTION`: `continue_task_id` の入力・省略できる入力・受け付ける条件・`branch_moved` / `branch_busy` と応答の `continuation` を書く。「依存のある作業は…積む」の文に「同じ課題への修正は `continue_task_id`」を足す。
- `task_pr_merge` の説明: 「最新のタスクの id でマージする。積み足しのあとに古い id で呼ぶと `head_moved`」を足す。
- `task_result` の説明: `pr.continuation_of`・`superseded_by`、`failure_phase: setup` の理由に `branch_moved`・`pr_not_open` を足す。
- `SERVER_INSTRUCTIONS` 6 の「クライアントが PR のブランチに修正を積むと `head_matches_verified` が false になり」は、今の説明のまま正しい（人が直接 push する場合）。積み足しの場合は別の文で書く。

## agent 側の変更

対象: `apps/agent/src/{agent-do,outbound-gateway,sandbox-do}.ts`、`apps/agent/src/agent/types.ts`（`TaskSpec`）。`apps/gateway/src/agent/contract.ts` の `TaskSpec` と同じ形に揃える（契約テスト `apps/agent/test/contract/` が見る）。

### TaskSpec

`continuation?: { of: string; root: string }` を足す。省略は今の動き。

### 門番 1: `AgentDO.validate`

- `continuation` が無い: 今のまま（`spec.branch === agent/task-<taskId>`）。
- `continuation` がある:
  - `of`・`root` が `^[A-Za-z0-9_-]+$`、`root !== taskId`、`spec.branch === agent/task-<root>`（それ以外は `invalid_spec: branch`）。
  - `spec.initialSha === spec.baseSha`（積み足しは空コミットを持たない。違えば `invalid_spec: initialSha`）。
  - `spec.kind`（task_review）との併用は `invalid_spec: continuation`。
  - `continuation.of === taskId` は拒否する（自己参照を防ぐ）。
  - 作業ツリーの再作成に備え、最後の push の sha（`pushed_head`）を記録し、HEAD 検査（門番 3）の期待値にする。
  - ローカルに既存のブランチがあれば、`merge-base` で祖先を確認する。
- `agent/task-<root>` の `root` を、ワーカーが与えられる入力（`instructions` など）から決めることはできない。`spec` は gateway の `TaskDO` が作って RPC で渡す値で、AgentDO は自分の `spec` の保存と同じ経路でしか読まない。

### 門番 2: `OutboundGateway`

- `allowedRef(props)`: `id = props.branchTaskId ?? props.taskId`。`^[A-Za-z0-9_-]+$` に一致しなければ undefined（今と同じ fail-closed）。`refs/heads/agent/task-${id}` を返す。正規表現は 2 層で書き分ける: `allowedRef` が返す ref は `refs/heads/` を含む `^refs/heads/agent/task-[A-Za-z0-9_-]+$`、`decideOutbound` の `WORK_BRANCH`（`outbound-policy.ts`）は `refs/heads/` を含まない `^agent/task-[A-Za-z0-9_-]+$`。**`props.task`（spec.branch）は使わない**（依存関係のキャッシュ側で弱い正規表現の値が入るため。実際、そちらは `/^[A-Za-z0-9_][A-Za-z0-9_./-]{0,199}$/`）。
- `decideOutbound` の `WORK_BRANCH` の検査はそのまま。receive-pack の本文の ref・newSha と許可証（`permit.ref === workRef`）の一致も今のまま。これで許す push は「`agent/task-<根の id>` への、SandboxDO が秘密の検査を通した commit の push」だけで、`main` や他の `agent/task-*`、タグの作成・削除は今までどおり通らない。
- トークンと許可証の読み出しは `props.taskId` のまま（SandboxDO の名前 = 積み足しタスクの id）。

### 門番 3: 作業ツリー

`SandboxDO` の clone（`--branch spec.branch`）・switch のあとの `verifyBase`（`merge-base --is-ancestor baseSha HEAD`、`sandbox-do.ts`）は**祖先かどうかしか見ない**。積み足しでは、clone / switch した時点でブランチの先頭が人や他人の push で `baseSha` より進んでいても通ってしまう。そこで、積み足し（`spec.continuation` あり）では clone / switch の直後に **`git rev-parse HEAD` が `spec.initialSha`（= `baseSha`）と等しいこと**を fail-closed で確かめる。一致しなければ作業ツリーを使わず、準備の失敗として扱う（`branch_moved`。メッセージに実際の HEAD を載せる）。`rev-parse` が判定できないとき（終了コードが 0 でない）も失敗側。作業ツリーの再作成（`healthy` でないとき）の clone 後も、既存の作業ツリーの switch 後も、同じ確認を通す。`continuation` が無いタスクは今のまま（`verifyBase` だけ）。

### ワーカーへのプロンプト

`agent-do.ts` の system prompt（`promptSections` の `role`）は `branch agent/task-${spec.taskId}` と「an empty commit on top of base」と書いている。`spec.branch` を使い、積み足しのときは「The branch already has the commits of earlier tasks of the same pull request; the branch tip is the starting point. Do not rewrite or drop earlier commits (no rebase, reset, amend of existing commits)」を足す。同様に、レビューの入力の文（`agent-do.ts` の review の system、`work branch agent/task-${spec.taskId}`）も `spec.branch` にする。

### push と lease（`syncBranch`）

積み足しのときだけ、完了時の push を次のようにする（`spec.continuation` が無いタスクは今のまま）。

```
expected = this.lastPushedSha()            // 最後に push できた sha。無ければ spec.initialSha
1. initial_sha が sha の祖先であること: git merge-base --is-ancestor <initialSha> <sha>
   - 終了コード 1 → 履歴の書き換え。push しない。push_failed（固定コード history_rewritten）、再試行しない
   - 他の失敗（判定できない）→ 再試行の対象
2. remote = readRemote()
   - remote == sha            → すでに push 済み（前の試行が通っていた）。成功として扱う
   - remote == expected       → git push --force-with-lease=<ref>:<expected> <url> <sha>:<ref>
   - それ以外                 → 人や他が push した。push しない。push_failed（固定コード branch_moved_externally）、再試行しない
3. push のあと readRemote() == sha を確かめる（今と同じ）
```

- **lease の期待値は `readRemote()` ではなく `expected`**。今の実装は読んだ直後の値を期待値にするので、間に入った push を上書きする。積み足しでは、それを許さない。force が要るのは、ワーカーがモデルの操作で履歴をずらした（ただし祖先は保つ）ときや、ワーカーが `git commit --amend` で自分の分を直したときなど。`initial_sha` が祖先であれば、前のタスクのコミットは残る。
- チェックポイントの push（通常の push・force なし）は、リモートが進んでいれば non-fast-forward で拒否される。拒否は `push_failed` として今のとおり記録される。
- `lastPushedSha()` は、チェックポイントの push が通るたびに更新される（`onCheckpointPush`）。したがって途中で通常の push が通っていても、`expected` は最新の値になる。
- 秘密の検査（`scanUnpushedForSecrets`）の範囲の始まりは `lastPushedSha()`（無ければ `initial_sha`）のまま。前のタスクのコミットは再検査しない（そのタスクで検査済み）。
- 失敗は `finishSync({ error })` と `push_failed` イベント（`final: true`）で記録する。メッセージは固定のコードを先頭に付ける（`history_rewritten:` / `branch_moved_externally:`）。`TaskDO` は既存の `push_failed` の経路で `pushedSha` 無し → `head_matches = null` として扱う（「失敗時の挙動」）。

## 同時実行

- 制約: **1 つのチェーンに、非終端の積み足しタスクは同時に 1 つ**。`UserDO.branch_lock`（鍵 = ブランチ名）で守る（「gateway 側の変更」）。
- チェーンの異なる PR（別のブランチ）の積み足しは互いに独立で、通常の同時実行の枠（`concurrency_limit`）だけを消費する。
- 積み足しタスクは通常のタスクと同じに予算（`task_budget_usd`）と枠を 1 つずつ消費する。
- 根のタスクが終端のあいだに、別のクライアントのセッションが同じ根から 2 つ同時に積み足しを始めると、片方が `branch_busy` になる。もう片方が終わったあとは、`base_sha` が古くなって `branch_moved` になる（正しい動き）。
- `task_cancel` で止めたとき、`CANCELLED` の確定（`finishTask`）で鍵が開く。キャンセルまでに通った WIP の push は PR に残る（次の積み足しは、その head を `base_sha` にする）。

## 失敗時の挙動

| 状況 | 動き |
|---|---|
| 積み足しの準備でブランチの先頭が `base_sha` でない | `FAILED`（setup、`branch_moved`）。PR・ブランチ・本文に何も書かない。`next_steps` が「`pr.head_sha` を確かめ直して `task_start` し直す」 |
| 準備のあいだに PR が閉じられた・マージされた | `FAILED`（setup、`pr_not_open`）。同上 |
| ワーカーの作業中に人が PR ブランチへ push した | チェックポイントの push は non-fast-forward で拒否され `push_failed`。完了時は `branch_moved_externally` で、**人の push を上書きしない**。`pushedSha` 無し・`head_matches = null`・`warnings` に `push_failed`。タスクは `COMPLETED` でも `task_pr_merge` は `head_not_read` / `head_not_verified` で止まる（今の push 失敗と同じ）。ワーカーの変更は Sandbox の作業ツリーと `patch` に残り、クライアントが取り出して反映できる |
| ワーカーが履歴を書き換えた | `history_rewritten`。push しない。同上 |
| 変更なしで終わった | PR は閉じない・ブランチは消さない。`COMPLETED`、`summary` に変更なしと残る。本文の節にも出る |
| 予算切れ・キャンセル・期限 | 今と同じ（WIP は通常の push）。PR は Draft に戻さない |
| `ensureCreated` が失敗（予約は取ったが TaskDO が作られない） | 今の予約の回収（`abandonIfUncreated`）が、`reservation_slot` と同じ経路で `branch_lock` も解放し、`branch_chain` の最新を `prev_task_id` に巻き戻す |
| 元のタスクの終了処理が終わる前に積み足しを頼んだ | `conflict`・`continue_not_finished`。`task_result` が `not_ready` を返さなくなってから再試行する |
| 積み足しの実行中に `task_pr_merge`（どの id でも） | `conflict`・`branch_busy`。積み足しが終わるか `task_cancel` で止めてから再試行する |
| 積み足しの clone / switch の直後に HEAD が `base_sha` でない（作業ツリー） | 準備の失敗（`branch_moved`）。何も push しない |

## セキュリティ

- 門番の範囲は「同じ利用者が rovo で作った `agent/task-*` のブランチ」。ブランチ名は gateway が根の id から作って記録し、props で agent に渡す。ワーカー・MCP クライアントの入力に、ブランチ名を渡す口は無い（`continue_task_id` は id だけ。名前を作るのは `TaskDO`）。
- 元のタスクが**呼んだ人自身のもの**であることを `TaskDO.continuationSource` で確かめる（所有者の検査）。他人のタスクの id は `not_found`。他の利用者のブランチには書けない。
- 人が作ったブランチ・PR は対象外: `agent/task-*` の名前でも、rovo の `TaskDO` に記録のあるブランチ（`continue_task_id` で指したタスクの根のブランチ）にしか push できない。`allowedRef` は props の `branchTaskId`（TaskDO 由来）だけを見る。
- 許す push は `agent/task-<根の id>` への通常の push と、lease 付きの更新だけ。lease は `initial_sha` / `lastPushedSha`（記録済みの値）で取り、リモートが動いていれば失敗する。履歴の書き換え（`initial_sha` が祖先でない）は拒否する。
- 秘密の検査（`scanUnpushedForSecrets`）は積み足しでも push の前に走る。
- 人や他人の commit の上に積む場合は、`base_sha` が rovo の記録した head と違えば `base_not_from_rovo` の警告が付き、未レビューの commit が `head_matches = true` のまま `task_pr_merge` を通ることはない。
- 積み足しの実行中は `task_pr_merge` を `branch_busy` で止める（未 push の PR の head が、検証済みの古いタスクの `head_sha` と一致して通るのを防ぐ）。
- `main` など他のブランチ、タグ、ブランチの削除は、今までどおり通らない（`decideOutbound` と本文のコマンドの検査）。
- `branch_moved` の応答に載せる sha は、呼んだ人が読める PR の head（呼んだ人の権限で読んだ値）だけ。
- PR 本文のタスク別の節は、信用しないデータ（要約・出力）を今までどおりコードフェンスで囲み、長さを切る。`task=<id>` の `<id>` は TaskDO が作る ULID だけ（`^[A-Za-z0-9_-]+$` を検査してから埋める）。
- `docs/specs/worker-review.md` の「rovo はクライアントのブランチに書き込まない」は保たれる（この仕様の対象は rovo 自身が作ったブランチ）。

## 範囲外

- Backlog 連携（保留中）。
- **人が作った PR・ブランチへの積み足し**。`task_review` のクライアントの PR に対する修正も、`worker-review.md` の「将来の拡張」のとおり別 PR のまま。
- **ダッシュボードの表示の手直し**。積み足しのあと、元のタスクの段が「マージ待ち」のまま古くなる（`apps/dashboard/src/factory.ts` の `COMPLETED` の段の判定。PR の状態は `pr.merged` / `pr.state` で決まり、積み足しタスクは同じ PR を指す）。マージしたのは最新のタスクなので、古いタスクは `pr_merged = 0` のまま「マージ待ち」に見える。**既知・後回し**。
- 積み足しの自動化（例えば `worker_review` の修正の回を同じ PR に積む形にすること）。`review_fix_rounds` は今のまま、同じタスクの中で直す。
- `base_sha` の省略による最新の head への追従。
- 積み足しタスクによる PR のタイトル・説明の書き換え（本文の自分の節以外）。
- チェーンの先頭へのマージ後の削除などの整理（`delete_branch` はマージを呼んだタスクが指す根のブランチを消す。今のまま）。

### 既知（利用者の承認済み。後回し）

- **鍵の解放のタイミング**: `branch_lock` は `finishTask`（最終精算）で開く。終端から数秒は `branch_busy`（積み足し・`task_pr_merge` の両方）。`TaskDO` の終端の確定で鍵だけ先に返す案は、「予算と枠の返却は最終精算と同じトランザクションだけ」の原則を崩すので採らない。
- **チェーンの古いタスクの `pr_merged`**: 最新のタスクでマージしても、古いタスクは `pr_merged = 0` のまま。チェーン全体を `pr_merged = 1` にする案は、ダッシュボードの手直しと一緒に後で。
- **積み足しの回数の上限なし**: 1 つの PR に積めるタスクの数に上限は設けない。PR 本文の節は縮むので実害は小さい。必要なら `MAX_CHAIN_LENGTH` を足す。
- **引き継いだ warning はマージを止め続ける**: 先行の warning を人が確認済みでも、最新のタスクで `task_pr_merge` は `warnings_present` で止まり、手動のマージになる。

## テストの方針

TDD で、unit を先に Red にする。配置は既存の命名に合わせる。

### gateway の unit（`apps/gateway/test/unit/`）

| ケース | 足す先 |
|---|---|
| 入力: `continue_task_id` の形式、`repository`・`base_ref` の省略可、無い場合は必須のまま。指紋: 付くと新しい版、付かないと従来と同じ値 | `task-validation.test.ts`、`task-service.test.ts` |
| `authorizeContinue` の全分岐（他人のタスクは `not_found`、`task_review` 元は `continue_review_task`、非終端、PR 無し、`closed_empty`、`repository`/`base_ref` 不一致、PR が閉じている・マージ済み・fork、`base_sha` 不一致 → `branch_moved`、本人のトークンで PR が見えない） | 新規 `task-continue.test.ts` |
| **M1**: 停止済みでも `finalize_done = 0`（または PR があって `body_done = 0`）なら `continue_not_finished`。`closeEmptyPull` / `updatePullBody` の再試行待ち（`finalize_retry_at` が先）でも断る。`finalize_done = 1` で通る | 同上 |
| **M2（古い id）**: 根 R → C1（警告あり）の後、`continue_task_id = R` は `continue_superseded`（最新の id が載る）。C1 からは通り、C1 の警告が引き継がれる。`reserve` の同期区間でも、`authorizeContinue` の後に別の積み足しが入った場合に `continue_superseded` | 同上、`user-budget.test.ts` |
| **M2（人の commit）**: `base_sha` が PR の今の head と一致していても、元のタスクの記録済みの `head_sha` と違えば `inherited_warnings` に `base_not_from_rovo`、`task_pr_merge` は `warnings_present`。`head_sha` が null の元のタスクは、`initial_sha` と比べる（一致なら警告なし、違えば警告）| 同上、`task-pr.test.ts` |
| `UserDO`: `branch_lock` — 同じ鍵の 2 回目は `branch_busy`、別の鍵は通る、同じ `requestKey` の再試行は同じ `task_id`、`branch_busy` は枠を消費しない | `user-budget.test.ts` |
| `branch_lock` の解放: **キャンセル（`CANCELLED`）・失敗（`FAILED`）・完了・予約の回収（一度も作られなかった予約）のそれぞれ**で解放される。回収は呼び出し側のループで照合 → 解放 → 再判定（`decide()` は同期で await しない）の形になること。回収したとき `branch_chain` の最新が `prev_task_id` に戻る（`finishTask` では戻らない） | 同上 |
| **`clearSlot` の早期 return**: 枠（`reservation_slot`）の行が無くて `false` を返す場合でも、`task_id` の `branch_lock` の行が消える | 同上 |
| `ensureCreated`: `github_link` の値（`initial_sha = base_sha`、PR の写し、`branch = agent/task-<根>`）、C1 → C2 で根が引き継がれる、`continuation_of`・`continuation_root`、spec の `continuation` | `task-github.test.ts`（fake の GitHub クライアントを使う既存の枠） |
| `runSetup`: 空コミットと `createBranch` を呼ばない、ブランチの先頭が違えば `branch_moved`、PR が閉じていれば `pr_not_open`、読めない（5xx）は再試行、`continued` イベント、`draft_pr_created` を出さない | 同上 |
| `closeEmptyPull` が積み足しで呼ばれない（変更なし終端でも `closeEmptyPull` に入らず、PR・ブランチを閉じない・消さない） | `task-github.test.ts`（既存の `closed_empty` のテストの隣） |
| 終端の `head_sha` / `head_matches` が積み足しの結果で更新される。準備で失敗した積み足しは本文を書かない | `task-github.test.ts` |
| `prMerge`: **古いタスクの id でマージすると、積み足しのあとは `head_moved`（`mergePull` を呼ばない）**。最新のタスクの id では通る。先行の warnings が `warnings_present` で止める | `task-pr.test.ts`、`task-pr-service.test.ts` |
| **M3**: 積み足しの実行中（`branch_lock` あり）は、最新でない id でも最新の id でも `task_pr_merge` が `branch_busy` で止まり、`mergePull` を呼ばず、`delete_branch` も走らない。鍵が開いたあとは最新の id で通る。`task_pr_ready` は止まらない | 同上 |
| 同じ積み足しタスクの `runSetup` の再試行が冪等: `continued` イベントが 1 回だけ、`github_link` の写しが変わらない（途中で 5xx → 再試行しても重複しない） | `task-github.test.ts` |
| `next_steps`: 積み足しの案内（`continue_task_id`・`base_sha`）、`superseded_by` のある古いタスク、準備の失敗の理由（`branch_moved`・`pr_not_open`） | `next-steps.test.ts`、`next-steps-worker-review.test.ts` |
| PR 本文: 節の新形式、旧形式の 1 組の PR に積み足しの節が後ろに付く（旧形式は書き換わらない）、自分の節だけが更新される、利用者の編集が残る、長さの上限で前の節が縮む、目印の偽装（`neutralize`） | `github/pr-body.test.ts` |
| MCP の説明: `continue_task_id`・`branch_moved`・`branch_busy` が説明にあり、「この PR に積む形で続けられる」の旧い記述が無い。スキーマの公開（`publishedSchema`）に `continue_task_id` | `mcp.test.ts` |

### gateway の e2e（`apps/gateway/test/e2e/`、通しは `test/full/full.e2e.test.ts`）

- `pr.e2e.test.ts`: 通しのシナリオ — 根が `COMPLETED` → `continue_task_id` で積み足し（応答の `continuation`、PR の番号が同じ）→ `COMPLETED` → 古い id で `task_pr_merge` が `head_moved` → 最新の id で通る。積み足しの実行中にもう一度 `task_start` すると `branch_busy`、`base_sha` が古いと `branch_moved`。
- `tools.e2e.test.ts`: `tools/list` の `task_start` のスキーマに `continue_task_id`。
- `full.e2e.test.ts`（gateway と agent を通すもの）: 実際に push した commit が同じ PR の head になり、PR が 1 本のまま。

### agent の unit（`apps/agent/test/unit/`）

| ケース | 足す先 |
|---|---|
| `allowedRef`: `branchTaskId` があればそれ、無ければ `taskId`。`^[A-Za-z0-9_-]+$` 以外は undefined。`props.task` を見ない | `outbound-gateway.test.ts`、`outbound-handler.test.ts` |
| 他の `agent/task-*`、`main`、タグ、積み足しの根以外への push が `github_push_not_allowed` / `push_not_permitted` で拒否される（`branchTaskId` があっても、根以外の `agent/task-*` へは拒否）。正規表現の層: `allowedRef` は `refs/heads/` を含み、`WORK_BRANCH` は含まない | `outbound-policy.test.ts`、`outbound-gateway.test.ts` |
| `validate`: `continuation` の組合せ（`branch` と `root` の不一致、`root === taskId`、`initialSha !== baseSha`、`kind` との併用） | 新規 `agent-do-continue.test.ts` |
| `syncBranch`: lease の期待値が `initial_sha`（`readRemote()` ではない）、リモートが動いていれば push せず `branch_moved_externally`（再試行しない）、`initial_sha` が祖先でなければ `history_rewritten`、`remote == sha` なら成功扱い、チェックポイントの push のあとは `lastPushedSha()` が期待値、今のタスク（`continuation` 無し）の動きが変わらない | 同上 |
| system prompt に `spec.branch` と積み足しの注意が入る | `agent-do-continue.test.ts` |
| props: `SandboxDO` が `spec.continuation.root` を `branchTaskId` に入れる | `sandbox-do-push-permit.test.ts`、`sandbox-do-git.test.ts` |
| **S1**: clone / switch の後に `rev-parse HEAD == initialSha` を fail-closed で確かめる（先頭が進んでいれば `branch_moved`、`rev-parse` の失敗も失敗側、`continuation` が無いタスクは今のまま） | `sandbox-do-git.test.ts` |
| 契約: 2 つの `TaskSpec` の形が一致 | `apps/agent/test/contract/` |

### agent の e2e（`apps/agent/test/e2e/`）

- `git-push.e2e.test.ts`: 実際の git で、(1) 既存のブランチの先頭から積んだ commit の完了時の push が通り、(2) 間に別の commit が push されていたら lease で失敗して上書きされず、(3) 履歴を書き換えた commit は拒否され、(4) `main` への push は門番が拒否する、(5) **`branchTaskId` があっても、根以外の `agent/task-*` へは push できない**（門番が拒否する）。

### 実行

完了条件: `mise run test`（unit + e2e）と `mise run lint`。ワーカーに頼むときは `docs/specs/test-selection.md` の方針のとおり、関係する unit に絞る（全体は手元で流す）。

## 実装の分割

4 つのタスクに分ける。順番は **A → B1 → B2 → B3**。**agent を先、gateway を後**にする（agent が `continuation` を受け付ける前に gateway が送ると、古い agent は `invalid_spec: branch` で拒否する。fail-closed なので害は無いが、積み足しが全て失敗する）。各段を単独でデプロイ・テストできるようにし、**`continue_task_id` の入力スキーマの公開（`publishedSchema`・`tools/list`）は B3 の最後**にする（B1・B2 のあいだは、クライアントから見えない）。

### タスク A: agent 側（先）

- 範囲: 「agent 側の変更」の全部（`TaskSpec` の `continuation`、`validate`、`allowedRef` と props の `branchTaskId`、`syncBranch` の lease と祖先の検査、clone / switch 後の `rev-parse HEAD == initialSha` の確認、system prompt）と、`apps/gateway/src/agent/contract.ts` の `TaskSpec` の同じ形の追加（型だけ。gateway の振る舞いは変えない）。
- 完了条件: 上の agent の unit / e2e が通る。`continuation` を付けない spec の動きが変わらない（既存のテストが無修正で通る）。
- 先に出しても安全: gateway が送らないあいだは何も起きない。

### タスク B1: 予約と認可（A のあと）

- 範囲: `branch_lock`・`branch_chain`・`reserve`（`decide` の順番、回収の照合、`clearSlot` の解放）、`validation`（入力・指紋）、`TaskDO.continuationSource`、`UserDO.authorizeContinue`（受け付ける条件 1〜9）、新しいエラーコード。`service.start` は `continue_task_id` を受けても、まだ `ensureCreated` を呼ばず、内部の確認までに留める（公開しない）。
- 完了条件: 「gateway の unit」のうち該当する行（入力 / 指紋、`authorizeContinue`、M1・M2、`branch_lock` の解放、`clearSlot` の早期 return）が通る。`continue_task_id` を使わない `task_start` の動きが変わらない。
- 依存: A のデプロイ後（B1 自体は agent に依存しないが、順番を守る）。

### タスク B2: 作成・準備・終端の確定（B1 のあと）

- 範囲: `ensureCreated`、`runSetup`（`continued` イベントの冪等性）、`closeEmptyPull` の省略、終端の確定、PR 本文（`pr-body.ts`）、`composeResult` の `inherited_warnings`、`superseded_by`。
- 完了条件: 該当する gateway の unit が通る。

### タスク B3: マージ・案内・MCP・e2e（B2 のあと）

- 範囲: `prMerge`（`branch_busy`・`head_moved` のメッセージ）、`composeResult`、`next-steps`、MCP の説明、gateway の e2e、**最後に `continue_task_id` の入力スキーマを公開**。
- 完了条件: 残りの gateway の unit / e2e が通る。`mise run test` / `mise run lint` が手元で通る。
- 依存: A が先にデプロイされていること。A が入っていない環境では、`continue_task_id` を `invalid_input`（`continue_unsupported`）で断るスイッチは**持たない**（デプロイの順番で守る。設定を増やさない。`docs/deploy.md` の方針）。

### デプロイの順

agent → gateway（B1 → B2 → B3）。agent の変更は `continuation` が無ければ従来どおりなので、先にデプロイして問題ない。B1・B2 は入力スキーマを公開しないので、単独でデプロイしても利用者には見えない。B3 のデプロイ後、実機で 1 本通して確かめる（根 → 積み足し → 最新の id でマージ）。

