# ダッシュボードの工場ビュー

一覧の上部にある「今日のタイムライン」の帯を、**Rovo の工場**の帯に置き換える。いまどのタスクがどの工程にいるか、チーム全体がどれぐらい動いているかを一目で分かるようにする。

- 見本（2026-10-30 に利用者が承認）: https://claude.ai/artifact/BDuFaXfurFQ5aXLJJaRKTb の `Factory2.dc.html`（案 A v5）。見た目と動きは見本を正にする。ただし作り方（インラインの style 文字列）は移さない（CSP の `style-src 'self'`、色は `:root` のトークンだけ）。
- 関連: [dashboard.md](dashboard.md)（一覧・帯・状態の印）、[worker-review.md](worker-review.md)（worker_review の段）。

## 表現

- 断面図の 2 階建ての工場。1 階 = 準備・コーディング・検証・レビュー・Ready、2 階 = 返事待ち・調査室・管制室。右端に貨物エレベーター、外に GitHub 出荷口（今日マージしたもの）。
- **1 タスク = 1 体の Rovo**（タスクごとに Sandbox ワーカーがいる実態に合わせる）。人の色は Rovo の**アンテナの電球**と足元の明かりで出し、目はブランドの青緑のまま。色だけに頼らないよう、頭文字のバッジを添える。
- 工程ごとの動作: コーディング = 打鍵、準備 = 箱を運ぶ、調査・レビュー = 虫めがね、検証 = ボタンを押す、返事待ち = 「?」の札、Ready = 箱に座って待つ。
- 部屋の定員を超えたら、定員 − 1 体を出し、残りは「+n」のタイルにまとめる。タイルには残りの人ごとの色の割合の帯を付ける（件数だけで描ける）。
- 管制室: フロアマップ（部屋ごとの人数）、Sandbox の枠（`running_slots / concurrency_limit`）、今月の予算のメーター、確認待ち・返事待ちの件数。
- 工程が変わった Rovo は、前の部屋から次の部屋へ手前の通路を歩いて移動する。階をまたぐときはエレベーターを使う（横に歩く → かご → 横に歩く）。移動中もその Rovo は行き先の部屋の 1 体として数える（人数と見た目が食い違わない）。
- 背景の部品（天井クレーン、配管の流れ、換気扇、ローラーなど）は小さく遅く控えめに動かす。`prefers-reduced-motion` ではすべて止める。
- ダークモード（`prefers-color-scheme: dark`）は**夜の工場**（夜空、窓とランプの明かり、アンテナの光が映える配色）。色は `:root` のトークンで切り替える。

## 出し分け

- **今日 = 工場の帯、過去の日 = 今のタイムラインの帯**（タイムラインの実装は残す）。
- マイタスク（`scope=me`）でも工場を出す。API が自分のタスクしか返さないので、工場にいるのは自分の Rovo だけ。チーム（`scope=all`）は全員。
- 見えないタスク（`HiddenTasksDto`）は工場に入れず、件数だけを出す。DOM（`data-task` など）にも出さない。
- 帯の高さは上限 300px 前後で、幅に合わせて縮小する（拡大はしない）。帯の端のボタンで**たためる**。たたむと「部屋ごとの人数」の 1 行になり、その状態はブラウザに覚えておく（`prefs.ts`）。
- 狭い幅（720px 以下）では断面図を出さず、たたんだときと同じ「部屋ごとの人の色の点と人数」の簡略版にする。
- Rovo を押すと、そのタスクを選ぶ（レール・タイムラインの棒と同じ `href` と `pushState` の流儀）。

## 人の色

- 6 色のトークン `--person-0`〜`--person-5`（ライト・ダークとも）。
- 割り当てはログイン名から決め、ポーリングをまたいで変わらないようにする（その回に見えた順で決めない）。7 人目以降は同じ 6 色を使い回し、頭文字のバッジで区別する。

## stage（契約）

`VisibleTaskDto` に任意の項目 `stage` を足す。古い索引の行（revision 0 のまま再送されないもの）や古い gateway の応答では省かれるので、ダッシュボードは `stage` が無いときに status と PR から部屋を決める。

| stage | 意味 | 決め方 |
|---|---|---|
| `prep` | 準備 | CREATING。または RUNNING / RECOVERING で、まだワーカーのツールの実行が無い |
| `code` | コーディング | RUNNING / RECOVERING で、最後のツールが編集・コマンド・commit 系（`edit_file` `write_file` `bash` `git_commit` など。調査系以外） |
| `research` | 調査 | RUNNING / RECOVERING で、最後のツールが `web_search` `web_fetch` `web_browse` |
| `verify` | 検証 | VERIFYING（worker_review の再検証 rechecking を含む） |
| `review` | レビュー | worker_review のレビューの段（commands / reviewing）。kind = review のタスクの実行中もここ |
| `wait` | 返事待ち | INPUT_REQUIRED |
| `ready` | 確認待ち | COMPLETED で、PR がマージも閉じもされていない |
| `merged` | 出荷済み | PR がマージ済み（`pr.merged` または `pr.state = merged`） |
| `done` | 工場の外 | FAILED / CANCELLED / BUDGET_EXCEEDED、PR が閉じられた、PR の無い COMPLETED |

- worker_review の修正（fixing）は `code` に、再検証（rechecking）は `verify` に畳む。
- **信号の優先順位**（1 つのタスクに複数の信号が同時に立つとき）: status が終端（COMPLETED / FAILED / CANCELLED / BUDGET_EXCEEDED）なら PR の状態で `ready` / `merged` / `done` を決める。終端でなければ、INPUT_REQUIRED（`wait`）> VERIFYING（`verify`）> worker_review の段（commands / reviewing → `review`、fixing → `code`、rechecking → `verify`）> 最後のツールの種類（`research` / `code`）> ツールの実行が無い（`prep`）。
- PR の状態が取れない（`pr.state = "unknown"`）COMPLETED は `ready` に倒す（確認待ちとして見せる方が安全側）。`pr = null` の COMPLETED は `done`。
- **kind = review のタスク（レビューの依頼）は工場に出さない**（部屋にも人数にも入れない。チームボードで「レビューを数に混ぜない」と決めたのに合わせる）。索引でも kind = review の行には作業の段を書かない。
- 索引（DirectoryDO）が持つのは、ワーカーの作業の段（`prep` / `code` / `research` / `verify` / `review`）だけにする。列名は既存の `review_stage` と紛れないよう **`work_stage`**。`wait` / `ready` / `merged` / `done` は、gateway が応答を組み立てるとき（`snapshotToVisibleTask`）に status と PR の状態から決める（PR の状態は閲覧時に取るため、索引には置けない）。
- 索引の revision は、**導出した作業の段が前回と変わったときだけ**上げる（`tool_start` ごとには上げない）。TaskDO の行に前回の段を持ち、イベントの取り込み（`applyPage`）で比べる。
- デプロイ: 契約（workspace のパッケージ）・DirectoryDO・TaskDO・ダッシュボードはどれも同じ gateway の Worker に入るので、別々のデプロイの順序は無い。守るのは「stage を出す gateway の変更（PR1）を、それを使うダッシュボードの変更（PR2）より先にデプロイする」ことだけ。ロールアウト中の短い窓に備えて、`TaskIndexSnapshotSchema` の `work_stage` は optional にし、項目の有る snapshot も無い snapshot も `upsertTask` が受ける。

## 部屋への対応（ダッシュボード）

| 部屋 | stage | 階 |
|---|---|---|
| 準備 | `prep` | 1 階 |
| コーディング | `code` | 1 階 |
| 検証 | `verify` | 1 階 |
| レビュー | `review` | 1 階 |
| Ready | `ready` | 1 階 |
| 返事待ち | `wait` | 2 階 |
| 調査室 | `research` | 2 階 |
| 出荷口 | `merged`（今日の分） | 外 |
| （出さない） | `done` | — |

`stage` が無いとき: CREATING → 準備、RUNNING / RECOVERING → コーディング、VERIFYING → 検証、INPUT_REQUIRED → 返事待ち、COMPLETED は PR の状態で Ready / 出荷口 / 出さない、それ以外は出さない。kind = review のタスクは、`stage` の有無によらず出さない。
