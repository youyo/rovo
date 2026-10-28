# Rovo の処理の流れの動画

ローカルの Claude が `task_start` で依頼してから、Sandbox のワーカーが実装・調査・検証・レビューを回し、GitHub の PR としてマージされるまでを 1 本で見せる動画。光の点が処理の順に一筆書きで進み、着いた場所で短い説明が出る。

すべて 1920×1080・30fps・H.264（MP4）。音声なし。

| 版 | 長さ | 中身 |
|---|---|---|
| `rovo-simple-*` | 約 53 秒 | Claude・rovo・Sandbox・PR の 4 つに絞った版 |
| `rovo-standard-*` | 約 78 秒 | gateway・Web Research（Clef の安全判定）・AI Gateway・Sandbox の段階まで出す版。README に載せている |
| `rovo-full-*` | 約 73 秒 | TaskDO / UserDO・mod pane・OutboundGateway まで出す版 |

ファイル名は `rovo-<版>-<dark|light>-<en|ja>.mp4`。`rovo-standard-<dark|light>-<en|ja>-poster.png` は README に置く静止画（最後の場面に再生ボタンを重ねたもの）。

動画に出す流れ（標準版）:

1. `task_start` で依頼 → 作業ブランチと Draft PR を作る
2. Sandbox を小さく起動して clone
3. AI Gateway 経由で LLM を呼んでコーディング
4. `web_search` で調べ、Clef が安全判定（allow / caution / block）
5. Clef がサイズを判断して Sandbox を自動でスケールアップ（standard-1 → standard-3）
6. テスト → 失敗したら直して再テスト → AI が差分をレビュー
7. push とレビューコメント → Ready for review
8. Claude が PR を受け取って全テスト → マージ
