# ダッシュボードの工場ビュー

一覧の上部にある「今日のタイムライン」の帯を、**Rovo の工場**の帯に置き換える。いまどのタスクがどの工程にいるか、チーム全体がどれぐらい動いているかを一目で分かるようにする。

- 見本（2026-10-30 に利用者が承認）: https://claude.ai/artifact/BDuFaXfurFQ5aXLJJaRKTb の `Factory2.dc.html`（案 A v5）。見た目と動きは見本を正にする。ただし作り方（インラインの style 文字列）は移さない（CSP の `style-src 'self'`、色は `:root` のトークンだけ）。
- 関連: [dashboard.md](dashboard.md)（一覧・帯・状態の印）、[worker-review.md](worker-review.md)（worker_review の段）。

## 表現

- 断面図の 2 階建ての工場を、帯に合わせて**横長**（1440 × 280 の座標系。縦横比 5:1 前後）に組み直したもの。各部屋の Rovo は 1 段（定員 = 横に並ぶ数）。1 階 = 準備・コーディング・検証・レビュー・Ready、2 階 = 返事待ち・調査室・管制室。右端に貨物エレベーター、外に GitHub 出荷口（今日マージしたもの）。
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
- 見えないタスク（`HiddenTasksDto`）は工場に入れず、件数だけを出す。DOM（`data-task` など）にも出さない。件数は一覧の応答にある今月の分（`month.hidden_tasks.count`。日ごとの件数は応答に無い）で、「見えない n 件」と出し、`title` で今月の分だと説明する。
- 断面図は帯の横幅いっぱいに描き、幅に合わせて縮小する（拡大はしない。1540px より広い画面では中央に置き、左右は空と地面が続く）。1440px の幅で高さ 280px。帯の端のボタンで**たためる**。たたむと「部屋ごとの人数」の 1 行になり、その状態はブラウザに覚えておく（`factory-prefs.ts`）。
- **背の低い画面では最初はたたむ**: 保存した好みが無いとき、広げてもコンソールのログの画面（`.screen`）に 700px が残る画面（`.main` に 1110px。ヘッダ 51 + 帯の見出し 35 + ステータスバー 42 + 1110 = 1238px を、画面の高さから断面図の高さを引いた残りが満たす）だけ最初から広げる（1440 × 1600 は広げる。1440 × 1200・1280 × 1400・1440 × 1000・1280 × 720 はたたむ）。帯の中身を読み込むまでの枠も、既定の状態と同じ高さを確保する（読み込みの前後で帯の下を動かさない）。ボタンで広げられ、保存した好み（たたむ / 広げる）があればそちらを優先する。
- 帯の中身（見出し・人数の 1 行・断面図）は遅延読み込みの別チャンク（`factory-panel`）。本体は帯の枠（`section`）だけを持つ。
- 狭い幅（720px 以下）では断面図を出さず、たたんだときと同じ「部屋ごとの人の色の点と人数」の簡略版にする。
- Rovo を押すと、そのタスクを選ぶ（レール・タイムラインの棒と同じ `href` と `pushState` の流儀）。

## 小窓（Document Picture-in-Picture）

別の作業をしながら画面の端で工場の様子を見られるよう、断面図を最前面の小窓に出せる。**Chrome / Edge だけ**（`documentPictureInPicture.requestWindow()`）。処理は工場のチャンク（`factory-pip.tsx`）に置き、本体の容量は増やさない（自動更新の条件を差し込む口だけが本体の `poller.ts` にある）。

- **ボタン**: `'documentPictureInPicture' in window` のときだけ、帯の見出しの行（たたむボタンの隣）に「小窓で表示」を出す。API の無いブラウザ（Safari・Firefox）と狭い幅（720px 以下）では出さない。たたんだ帯からも開ける。
- **中身**: 小窓には断面図（`FactoryScene`）だけを出し、窓の幅に合わせて縮める。描画は同じ React の木からの `createPortal`（同じデータ・同じ `onSelect`）。小窓へ付け替えると断面図は作り直され、FLIP の前回の場所は空から始まり（最初は歩かない）、実行中の歩き（`element.animate`）は外すときに止める。
- **元の帯**: 小窓に出している間は「小窓で表示中」と「戻す」の 1 行（たたんだ帯と同じ高さ。帯の下を動かさない）。小窓を閉じたら（小窓の window の `pagehide`）元の表示に戻る。「戻す」は小窓を閉じる。帯が消えたら（過去の日へ移る・scope を変えて読み込み直すなど）小窓も閉じる。
- **開くときの要求**: `requestWindow` を呼ぶ前に同期的に「要求中」を立て、要求中・開いている間は「小窓で表示」を押しても何もしない（`requestWindow` を 2 本走らせない。要求中はボタンも `disabled` にするが、ガードはこの「要求中」の印）。要求ごとに世代（番号）を持ち、最新の世代でない要求の解決は採用しない（返ってきた小窓はすぐ閉じ、表示も自動更新の条件も触らない）。要求中に帯が消えたら（過去の日へ移る・詳細だけの表示になる・scope の切り替えなど）世代を進めて要求を無効にする。断られた・例外になったら「要求中」を下ろし、帯はそのまま。小窓の初期化（link の写しなど）で例外が出たら、その小窓を閉じて自動更新の条件を外す（管理外の小窓・差し込んだままの条件を残さない）。
- **Rovo を押す**: クリックの処理の中で同期的に元の window の `focus()` を呼び（前に出せるかはブラウザ次第）、そのタスクを選ぶ（既存の `onSelect`）。focus の成否に選択は依存させない。小窓の中のイベントは portal の根で止め、React の木を伝って一覧側の親の `onClick` などに届かせない。
- **CSS と CSP**: CSP（`style-src 'self'`）は変えない。小窓の `document.head` には、元の文書の `<link rel="stylesheet">` を `href` を絶対 URL にして作り直して入れる（`<style>` 要素は作らない・`cssRules` の文字列は写さない）。ボタンは工場のチャンクの中にあるので、押した時点でチャンクの CSS（`factory-panel-*.css`）の link も元の head に入っている。`requestWindow` はクリックの中で最初に呼び（前に `await` を置かない）、小窓に入れた link の `load` を待ってから描く（読めなくても 3 秒で描く）。小窓用の見た目は `factory-scene.css`（`.fxpip*`）にあり、インラインの style・色の直書きは使わない。
- **配色と動き**: ダーク / ライトは小窓の文書で `prefers-color-scheme` が評価されるので、同じ CSS のまま切り替わる。`prefers-reduced-motion` は小窓でも全部止める（CSS は小窓の文書で評価され、`element.animate` の判定も描いている要素の `ownerDocument.defaultView` の `matchMedia` で行う）。
- **自動更新**: 小窓を開いている間は、元のタブが hidden でも一覧（`use-overview`）の自動更新を続ける。判定は「元の文書が visible、または開いている小窓の文書が visible」。`poller.ts` の `withKeepAlive` が `PollerDeps` の `isHidden` に `overviewKeepAlive`（小窓が差し込む条件）を重ねる。ポーラーは 1 本のまま（二重にしない）で、小窓を開いただけ・元が hidden になっただけでは取り直さない。止まっていたところから再開するときは即 1 回取り、遅れた分は追いかけない。元の文書と小窓の文書の `visibilitychange`、小窓の `pagehide` で判定し直す。閉じれば元の扱い（hidden の間は予約しない）に戻る。一覧以外（Cloudflare・待ち・コンソール）は今までどおり。
- **古さの表示**: 小窓の左上に、最後に更新に成功してから 30 秒以上経ったら「hh:mm から更新なし」、直近の更新に失敗したら「通信エラー（hh:mm 時点）」を小さく出す（止まった絵を新しいと誤解させない）。説明は `title`。新しいデータが届くと消える。「最後に更新に成功した時刻」は取得元の `use-overview` が持つ（`OverviewState` の ready の `okAt`。失敗して stale になっても前の成功の時刻のまま）もので、workspace → `OverviewView` → `FactoryBand` → `FactoryPanel` → 小窓へ渡す。小窓を開いた時刻からは作らない（すでに 30 秒以上更新できていない状態で開けば、すぐ「更新なし」。開き直しても時刻は戻らない）。古さの判定し直しは 5 秒ごと。
- **手元で確かめること**: OS の最前面表示、小窓の大きさの変更、スリープからの復帰、元のタブを裏にしたときのタイマーの間引き（ブラウザの throttling）での自動更新の続き方は、自動テストでは確かめられない。Chrome / Edge の実機で確かめる。Vite の開発サーバーは CSS を `<style>` で入れるため小窓に CSS が写らない（ビルドしたものでは link なので写る）。

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
| `review` | レビュー | worker_review のレビューの段（commands / reviewing） |
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
