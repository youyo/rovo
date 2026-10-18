# Phase 4 実装計画: 親子間の対話（INPUT_REQUIRED / task_answer / task_steer）

設計書 `design.md` の 3.2・4.5・4.6・9.5 と Phase 4 を具体化したもの（下書き、2026-10-18）。

## ゴール

- 子エージェントは、必要なときだけ親に質問できる（3.2 の条件）。質問すると、タスクは `INPUT_REQUIRED` になる。
- 親は `task_wait` で質問を受け取り、`task_answer` で回答する。子は回答を受けて作業を再開する。
- 親は、実行中のタスクに `task_steer` で追加の指示を渡せる。子は安全な区切りでそれを取り込む。
- 回答と追加指示は、ID 単位で冪等に処理する（4.5）。

## 子エージェントの質問

- AgentDO 固有のツール `ask_parent({question, options?, context?})` を追加する（replay は unsafe）。
  - システムプロンプトに、質問してよい条件を書く（3.2）。対象は、仕様の矛盾、受け入れ条件が不明確、範囲を超える設計変更、破壊的な変更、セキュリティ上の重大な判断、予算や権限の制約。些細な実装判断では質問しない。
  - 質問は、未回答のものが同時に1つまで。未回答の質問があるのに呼ばれたら、エラーを返す。
  - 長さの上限: question は 4,000 文字、options は 10 個まで（各 500 文字）。
- 質問の流れ
  1. ask_parent が呼ばれたら、AgentDO は `question_id` を発行する。次の3つを同じトランザクションで記録する。
     - 質問
     - phase `input_required`
     - イベント `question {question_id, message, options}`
  2. 作業中の変更を失わないよう、未 commit の変更があれば、自動で WIP の commit を作って push する（best-effort）。
  3. ツールは「質問を送った。回答を待つ」を返し、現在の run を終える（Pi の run は回答まで再開しない）。
- 回答待ちの間の扱い
  - Sandbox は止めない。ただし inactivity timeout（2時間）で止まることはある。止まった場合は、再開のときに push 済みのチェックポイントから作り直す（Phase 3）。
  - 期限（2時間）は、回答待ちの間は止める。`deadlineAt` を、待った時間の分だけ後ろにずらす。
  - 回答待ちの上限は24時間（7.3）。超えたら `failed`（reason: `input_timeout`）にする（9.5）。
  - 予算はモデルを呼ばないので減らない。

## task_answer

- 入力: `{task_id, question_id, answer}`（answer は 1〜20,000 文字）。
- Gateway の TaskDO の処理
  - owner と team を確かめる（他のツールと同じ）。
  - 状態が `INPUT_REQUIRED` で、question_id が未回答の質問と一致することを確かめる。一致しなければ `not_found` または `conflict` を返す。
  - 回答を永続化する。冪等にし、同じ question_id で同じ回答なら成功、違う回答なら `conflict` を返す。
  - 回答を配送する意図を記録し、`AgentDO.answer(question_id, answer)` を、成功するまで alarm で再送する。
- AgentDO の処理
  - question_id が未回答の質問と一致すれば、回答を記録し、イベント `answered {question_id}` を出す。
  - 期限を延ばし、phase を `running` に戻す。
  - 回答を新しいユーザーメッセージとして Pi に submit する。operationId は `answer-<question_id>` にし、再送で二重に再開しないようにする。
  - 同じ question_id で2回目以降の配送が来ても、何もせず成功を返す。
- 回答そのものは、認証された親からの指示として扱う（非信頼データではない）。ただし長さは制限する。

## task_steer

- 入力: `{task_id, message, idempotency_key?}`（message は 1〜20,000 文字）。
- 受け付ける状態: `RUNNING` / `VERIFYING` / `INPUT_REQUIRED`。それ以外は `conflict` を返す。
- Gateway の TaskDO の処理
  - steer_id を発行する（idempotency_key があれば、そこから導く）。
  - イベント `steer_received {steer_id}` を永続化し、`AgentDO.steer(steer_id, message)` を成功するまで alarm で再送する。
- AgentDO の処理
  - steer_id で冪等にする。
  - 実行中なら、Pi の `steer()` で安全な区切り（次のモデル呼び出しの前）に取り込む。
  - 回答待ち（`input_required`）の間に届いた追加の指示は、質問への回答とはみなさない。次に再開するときのメッセージに添える。
  - 取り込んだらイベント `steer_applied {steer_id}` を出す。
- 追加の指示で、受け入れ条件や制約を書き換えることはしない（モデルへの追加情報として渡すだけ）。検証コマンドは変わらない。

## 状態遷移の追加

| from | to | きっかけ |
|---|---|---|
| RUNNING | INPUT_REQUIRED | 子の質問 |
| INPUT_REQUIRED | RUNNING | 回答の取り込み |
| INPUT_REQUIRED | FAILED | 回答待ちの上限（24時間） |
| INPUT_REQUIRED | CANCELLED | task_cancel |

- 表には Phase 1 のときから定義済み。今回は、公開 API から使えるようにする。

## 同時実行と予算

- 回答待ちの間も、同時実行の枠（ユーザーごとに1件）は占有したままにする。待っている間に別のタスクを始められないので、親には `task_wait` で質問に気づけるようにする。
- 予約した予算も、回答待ちの間は持ったままにする。

## MCP の変更

- 新しいツール: `task_answer`、`task_steer`。
- `task_wait` のイベントに、次のものを加える: `question`、`answered`、`steer_received`、`steer_applied`。
- `task_status` に、未回答の質問（`pending_question: {question_id, message, options} | null`）を加える。
- ツールの説明文に「質問が来たら `task_answer` で答える。答えるまでタスクは止まる」と書く。

## テスト

- Unit
  - ask_parent: 条件のプロンプト、長さの上限、未回答の質問がある場合の拒否。WIP の commit と push。
  - 回答待ちの間の期限の延長、24時間で `input_timeout`、回答待ちの間の cancel。
  - task_answer の冪等性（同じ回答・違う回答・違う question_id・回答待ちでない状態）と配送の再送。
  - AgentDO.answer の冪等性（二重の配送で二重に再開しない）。
  - task_steer の冪等性、受け付ける状態、実行中の取り込みと、回答待ちの間に届いた場合の扱い。
- E2E（通し）
  - 台本のモデルが ask_parent を呼ぶ → `task_wait` で question を受け取る → `task_answer` → 再開して完了。
  - 実行中に `task_steer` → 取り込まれて、モデルへのメッセージに含まれる。
  - 回答待ちの間に cancel する。
  - 回答待ちの間にコンテナが止まっても、回答の後に push 済みのチェックポイントから再開する。

## 未検証事項（13章）

- Claude Code / Cowork で、`task_wait` をバックグラウンドで待ちながら、ユーザーとの会話を続けられるか。受入試験で確かめる。

## Phase 4 でやらないこと

- 複数の未回答の質問
- 回答待ちの間に同時実行の枠を解放すること（必要になったら、別途設計する）
