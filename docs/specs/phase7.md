# Phase 7 実装計画: End-to-End Test と公開の準備

設計書 `design.md` の Phase 7（12章）、13章、14章、16章を具体化したもの（**確定（ユーザー承認 2026-10-19）**。advisor レビュー反映済み）。

Phase 7 の中身は 2 つ。(A) 実環境での E2E・受入試験（acceptance.md）。(B) 公開の準備（LICENSE、docs/deploy.md、README、公開前の点検）。それに、Phase 6 から送られた残件（TaskDO のデータの扱い、細かい穴、不安定なテスト）を加える。

**この文書は確定した計画。設計の判断が要ったものは「決めること」に選択肢と推奨を並べ、各項目に「決定（2026-10-19）」の行を足した（却下した案は理由として残す）。** 決定は、design.md に 15.8 として書き写す（実装の最初の作業）。未決は「未決事項」の 2 件だけ。

**決定事項（共通）: Phase 7 で今後作るコミットには `Claude-Session` 行を付けない（ユーザーの指示）。** `Co-Authored-By` は付けてよい。

## Phase 7 の項目と、これまでの到達点

| 項目 | 状態 | 備考 |
|---|---|---|
| design 12 の Phase 7（15 項目の通し） | **一部だけ自動で済**（Phase 3〜6 の full E2E） | 偽の GitHub・偽のモデル（台本）・偽の Web での通し。実 Claude Code / Cowork、実 GitHub、実 Claude、実 Cloudflare の通しは未実施 |
| acceptance.md（1〜17 節） | **未実施** | 全項目が `[ ]`、各節の「結果」表も空。Phase 2 の節は無い（下の「acceptance.md の穴」） |
| web_browse の有効化前のゲート（11 節） | **実施しない**（2026-10-20 の D5 の更新） | web_browse は既定で無効。保証の範囲は「禁止先・判定不能の取得結果を返さない」まで（phase5.md 末尾の Kitesurf スパイクの節） |
| TaskDO の `events` / `questions` / `git_token` の削除 | **未決**（Phase 6 から送られた） | 「決めること」D1 |
| LICENSE・公開向け README・docs/deploy.md（design 16） | **未着手** | README と phase6.md は docs/deploy.md を「Phase 7 で作る」と参照している |
| 細かい残り（low）4 件 | **未着手** | M3 |
| full E2E `g` の不安定 | **未解決**（原因は未確定） | M1 |

## 範囲と、やらないこと

- 範囲: 上の表のとおり。コードの変更は、M1〜M3 のテスト・テスト基盤と、M2 の TaskDO の変更（テスト用の `/__test/` ルートと TaskDO のテスト用メソッドを含む）に限る。新しい機能は足さない。
- 進め方: M4〜M7 は M1 と触るファイルが重ならないので、M1 と並列に進めてよい（M4・M5 の間の README と deploy.md の依存だけは守る）。M2 と M3 の順序は固定しない（どちらが先でもよい。M3 は M1 の後が望ましい）。
- やらないこと
  - 新機能（design 12 の Phase 1〜6 の範囲外のもの）、コンテナのスナップショット（Phase 6 で見送り済み）、監査ログの検索 UI、R2 の一覧・読み出し API
  - rovo の `wrangler.jsonc` に本番の値を置くこと（`r2_buckets` を含む。design 16）
  - Portal / Access の登録（IaC のリポジトリの範囲。このリポジトリは必要な情報を docs/deploy.md に書くだけ）
  - 下流（デプロイ用の private リポジトリ、IaC のリポジトリ）のファイルの作成・変更

## 作業の区分（ユーザーの作業とエージェントだけでできる作業）

| 区分 | 内容 | マイルストーン |
|---|---|---|
| エージェントだけでできる | テスト・テスト基盤の修正、TaskDO の変更、LICENSE、README、docs/deploy.md、acceptance.md の整理、公開前の点検の実施（読み取りと報告） | M1〜M7 |
| ユーザーと一緒に行う | 本番（または検証用）環境へのデプロイ、GitHub App の作成、AI Gateway、Portal の登録、実クライアントでの受入、課金されるサービスの呼び出し、web_browse の有効化、**git の履歴の書き換え・push・リポジトリの公開** | M8〜M11 |

- エージェントは、ユーザーの了承なしに、デプロイ、外部サービスの操作（課金されるものを含む）、push、履歴の書き換えをしない。
- M8 以降は、ユーザーが操作し、エージェントは手順の提示・結果の記録・不具合の修正を受け持つ。実機の結果は acceptance.md の結果表に、実施者・日付・環境つきで書く。**秘密や個人の環境の値（account id、実 URL、org / team の名前、ログの本文）は書かない。**

## 決めること（決定済み。却下した案は理由として残す）

### D1. R2 を正にするか、TaskDO の `events` / `questions` / `git_token` を消すか

現状（Phase 6）: R2 は終端後の**コピー**。TaskDO のデータは何も消していない。R2 は `LOGS` が無ければスキップ（fail-open）、書き込みに 6 回失敗すると打ち切り（`archive_failed`）、MCP からの読み出し経路は無い。

| 案 | 内容 | 長所 | 短所 |
|---|---|---|---|
| A | 何も消さない。R2 はコピーのまま | 変更が無い。`task_wait` / `task_result` の読み出し経路が変わらない | `git_token`（暗号文）と、answer / steer の本文が、TaskDO に残り続ける |
| B | `git_token` だけ、`finalize_done = 1` の後（トークン失効の後）に消す。`events` / `questions` / `steers` は消さない | 秘密の最小化。R2 に依存しない。失効済みなので、消しても機能は失われない | 本文（answer / steer、質問文）は残る |
| C | B に加え、終端から N 日後に TaskDO の `events` / `questions` / `steers` を消す。ただし `archive_done` が「成功」（`archive_completed`）のときだけ | TaskDO の保存量が増え続けない。本文の保持期限が切れる | 消した後の `task_wait` / `task_result` の応答を決める必要がある（`expired` など）。R2 が読めない構成（`LOGS` 無し、`archive_failed`）のタスクは消せない。R2 の保持（ライフサイクル）と N の整合を取る必要がある |
| D | R2 を正にする（TaskDO から消し、読み出しは R2 経由） | 一元化 | `LOGS` が必須になり fail-open と矛盾する。MCP に R2 の読み出し経路が要る。打ち切りの方針の見直しが要る。Phase 6 で見送った API を作ることになる |

- **推奨: B**。理由: (1) `git_token` は秘密で、失効後は価値が無い。消すのは R2 と無関係に安全。(2) R2 は fail-open で、長い障害で失うことを許容している設計なので、「正」にするには条件が足りない（D は取らない）。(3) C は、消した後の応答の設計と保持期間の整合が要り、公開前に抱える複雑さに見合わない。本文の保持期限が要件として出た時（ユーザー単位の削除など）に、別の Phase で決める。
- 承認で変わること: A→M2 は不要。B→M2 は小さい（`git_token` の削除と、削除後も `needsAlarm` / 失効の再試行が壊れないこと）。C→M2 が大きくなり、仕様（削除後の応答）の追記が要る。

**決定（2026-10-19）: 案 B。** `git_token` の暗号文（`enc` 列）だけを、`finalize_done = 1` の後に空にする。行と id は残す。`events` / `questions` / `steers` は消さない。M2 はこの範囲で実装する。

### D2. 履歴の公開（メールと Claude-Session トレーラー）

確かめた事実（Opus が確認）:

- 全 56 コミットの author と committer のメールが、すべて `1003ni@gmail.com`。
- 56 コミット中 55 本のメッセージ末尾に `Co-Authored-By:` と `Claude-Session: https://claude.ai/code/session_...` のトレーラーがある（セッションの URL が履歴に残る）。
- worktree は main の 1 つだけ（他のブランチ・worktree に別の履歴は無い）。

**決定済み（ユーザーの回答）: author / committer のメール（`1003ni@gmail.com`）は、そのまま公開してよい。書き換えない。** したがって、リポジトリの `user.email` を noreply に切り替えること、GitHub の「Block command line pushes that expose my email」を有効にすることは、推奨に含めない。M6 の点検もメールを対象から外す。

**論点: `Claude-Session` トレーラー（55 本）を残すか。** `--mailmap` ではメッセージ内のトレーラーは直らない。

| 案 | 内容 | 注意 |
|---|---|---|
| a | そのまま残す | セッションの URL が公開される。URL から第三者がセッションを読めるかは不明（読めないと思われるが、確かめていない）。取り消せない |
| b | メッセージだけ書き換える（`git filter-repo` の `--message-callback` または `--replace-message` で `Claude-Session:` 行を削除する。`Co-Authored-By` は残す） | 破壊的（コミット ID が全部変わる）。他のクローンや下流の upstream 設定と整合を取る必要がある。書き換え後に全履歴で `claude.ai/code/session_` が 0 件であることを確かめる |
| c | 履歴を捨てて、現在の tree を 1 コミットで新規に公開する | トレーラーも過去の秘密の心配もまとめて消える。開発の履歴（設計の経緯）を失う |

- 推奨は置かなかった（ユーザーの判断事項）。参考: 履歴を残したいなら b、残す必要がなければ c が最も簡単。a は URL が公開される。
- いずれの書き換えも破壊的な操作で、**ユーザーが決めて、ユーザーと一緒に行う**（M11）。M6 は、書き換えが要るかの点検と、手順の用意までを行う（実行しない）。
- 判断材料（M6 の点検結果）: 履歴に過去に入って消えた秘密・個人の値があれば、b では足りず（filter-repo で該当を消す）c が現実的になる。

**決定（2026-10-19）:**
- メール（author / committer の `1003ni@gmail.com`）は、書き換えない。
- `Claude-Session` トレーラーは**案 b**。`git filter-repo` でメッセージ中の `Claude-Session:` 行だけを消し、`Co-Authored-By` は残す。
  - 実行するのは M11 の公開直前で、ユーザーと一緒に行う（M6 は手順書までで、実行しない）。
  - 2026-10-20 に履歴を書き換え済み。`Claude-Session` 入りのコミットは 0 本になったので、`scan:secrets` の上限を 55 から 0 にした（1 本でもあれば失敗）。
  - 書き換えた後、**全履歴（全ブランチ・全タグ）で `claude.ai/code/session_` が 0 件**になったことを確かめる（`git log --all --format=%B | grep -c 'claude.ai/code/session_'` と、gitleaks と同じ範囲の自前の正規表現）。
  - 書き換えるとコミット ID が全部変わる。文書の中で古いコミット ID を参照している箇所が無いか、書き換えの前に点検する（M6）。2026-10-19 時点で、リポジトリ内（`docs/`、README、ソース）に現行のコミット ID を参照する箇所は見つからなかった。見つかった場合は、ID を使わない書き方（件名・タグ・Phase 名）に直してから書き換える。書き換えの後にも、同じ点検を再実行する。
  - `.claude/handover/` など追跡されていない手元のファイルに古い ID が残っていても、公開には影響しない。ただし、書き換えの前にバックアップ（ミラークローン）を取る。
- Phase 7 で今後作るコミットには `Claude-Session` 行を付けない（冒頭の共通の決定）。
- 却下した案: a（そのまま残す。URL が公開される）、c（squash。履歴を失う）。

### D3. 公開リポジトリにデプロイ用の mise タスクを置くか

design 16 は「下流の本番用 wrangler 設定を `-c` で指定してデプロイする mise タスク」を例に挙げている。いま `mise.toml` に `deploy:*` は無く、`build:*`（`wrangler deploy --dry-run`）だけがある。

- 案 1: upstream に `deploy:<app>` タスクを置く（設定ファイルの場所は環境変数 `ROVO_WRANGLER_<APP>` で受ける）。下流は env を設定するだけ。誤って upstream の `wrangler.jsonc`（本番の値が無い）をデプロイする事故を、env 未設定でのエラーで防げる。
- 案 2: upstream には置かず、下流が**別のファイルを足す**だけでタスクを持てるようにする。docs/deploy.md に、その足し方の例を示す。「下流の `mise.toml` に書く」例は、下流に upstream の `mise.toml` を書き換えさせることになり、design.md 1070 行（下流は新しいファイルを足すだけでデプロイできる構成にする）と食い違うので採らない。
  - 候補 (i): `MISE_ENV` で読まれる `mise.<env>.toml`（下流が新規に足すファイル）。
  - 候補 (ii): `mise-tasks/` のファイルタスク（下流が新規に足す実行ファイル）。
  - どちらが upstream の `mise.toml` と衝突なく動くかは、実装時に mise のドキュメントで確かめる（確かめる前は断定しない）。
  - `mise.local.toml` は `.gitignore`（4 行目）に入っているので、下流で共有する手段としては使えない。
- **推奨: 案 2**。upstream にデプロイの手段を持たせると、下流の運用（承認、順序、変更の管理）に口を出すことになる。デプロイの順序（web → agent → gateway）と注意点を docs/deploy.md に書く。
- 承認されたら、design.md 15.8 に「design 16 の例（upstream に置くデプロイのタスク）は採らない」と書く（M7 の作業に入れる）。

**決定（2026-10-19）: 推奨どおり案 2**（upstream にデプロイ用タスクを置かない。下流が別ファイルで足す）。15.8 に「design 16 の例は採らない」と書く。

**決定の見直し（2026-10-20）: 案 1 に変更。** 理由は、誰でも clone して、自分の値を渡せばデプロイできるようにするため。upstream が `deploy:*` タスク（`scripts/deploy.sh`）と、Cloudflare のリソースを作る Terraform（`infra/`）を持つ。設定ファイルの場所は、案 1 の `ROVO_WRANGLER_<APP>` ではなく、env の `ROVO_DEPLOY_DIR`（中に `gateway.wrangler.jsonc` などを置く）で受ける。未設定・ファイルが無いときは何もせずに失敗する。下流は upstream のファイルを書き換えず、wrangler 設定・tfvars・backend を新しいファイルとして足す。Portal と Access の登録は範囲外のまま。反映先: design.md 15.8、docs/deploy.md の 1・4・9・10 節、README。

### D4. 公開時の付属ファイル（SECURITY.md、CONTRIBUTING、CI）

- SECURITY.md: 脆弱性の報告先。**推奨: 置く**（最小の内容）。連絡先は、GitHub の private vulnerability reporting（PVR）へ誘導する。**PVR は公開リポジトリで使える機能なので、順番は「公開 → 直後に PVR を有効化」**（M11。実施の前に GitHub Docs で条件を確かめる）。SECURITY.md の文面か手順に、この順番を書く（公開直後の短い間は PVR が使えないことを許容する）。
- CONTRIBUTING.md: **推奨: 置かない**（個人プロジェクトとして公開。Issue / PR の受け付け方針は README に 1〜2 行）。
- CI（GitHub Actions）: **推奨: 置かない**（M4 では）。理由: E2E は Docker と実コンテナを使い重く、実行時間が不安定（M1 の問題）。置くなら lint + `test:unit` + `build` だけ。ユーザーが望めば M4 に足す。design 16 は「CI も `mise run` 経由」を要求するだけで、CI の有無は決めていない。

**決定（2026-10-19）: 推奨どおり。** SECURITY.md は置く（公開 → 直後に PVR）、CONTRIBUTING は置かない、CI は置かない。

### D5. web_browse の扱い（ゲートの結果しだい）

- ゲートの実機確認（M9）の後に、ユーザーが残存リスクを受け入れるかを決める。受け入れなければ「有効にしない」。**有効にしない場合の扱い**に選択肢がある。
  - 案 1: コードは残し、既定で無効のまま公開する（現状）。README に「実験的・有効にするな」を明記する。
  - 案 2: web_browse を公開リポジトリから外す（コードを削除する）。
- **推奨: 案 1**。既定で無効、ゲートの記録を acceptance.md に残す。外すかは M9 の結果を見て決める（結果が深刻なら案 2）。

**決定（2026-10-19）: 推奨どおり案 1。** 有効にしない場合も、コードは残して既定で無効にし、README に明記する。

**決定の更新（2026-10-20）: 実機のゲートは行わず、運用者の本番では web_browse を有効にする（ユーザーの決定）。** upstream の既定は `"false"` のまま変えない（ほかの運用者には影響しない）。確かめていない点（`redirectChain` / `finalUrl` に現れない経路での fail-closed、DNS rebinding、UA と `rovo-web` の食い違い）を残存リスクとして受け入れ、acceptance.md の 11 節に記録する。ゲートの手順（付録 A）は任意の手順として残す。

### D6. 実機での障害の起こし方（design 12 Phase 7 の 15 項目目）

「Sandbox 障害から自動復旧」「起動のやり直しが実機で効くか」を実機で確かめる方法が要る。本番相当の環境では、`/__test/` のルートは無効（`ENVIRONMENT=production`）で、特権操作も外から呼べない。

- 案 1: Cloudflare 側の操作でコンテナを止める（ダッシュボードや API で Containers のインスタンスを停止する）。コードに手を入れない。
- 案 2: 検証用の環境（`ENVIRONMENT` を本番と同じにしたまま、Sandbox のイメージにだけ「起動時に一度だけ失敗する」ような仕掛けを足したもの）。コードに検証用の分岐が入る。
- **推奨: 案 1**。コードに検証用の分岐を入れない（本番の経路と同じ経路を確かめる）。コンテナを止める具体的な手段は M7 で調べて手順に書く。調べる項目は次の 3 つ。
  1. Cloudflare のダッシュボード・API でコンテナのインスタンスを停止する方法。
  2. Sandbox の中から通常のコマンドでコンテナのメインプロセスを落とす方法（コードの変更は要らないが、ワーカーが実行するコマンドとして行うため、外向き通信の制限や権限の範囲内でできるかを確かめる）。
  3. agent を再デプロイして、実行中のインスタンスを置き換える方法（デプロイ時のコンテナの入れ替わりで、実行中のタスクが復旧するかを見る）。
  - 調べても手段が無ければ、実機での確認は諦めて、実コンテナの E2E 〔`sandbox-do.e2e.test.ts`〕で確認済みとして記録し、その限界を残す）。

**決定（2026-10-19）: 推奨どおり案 1。** コードに検証用の分岐を入れない。手段は M7 で 3 項目を調べる。

**決定の更新（2026-10-20）: 復旧の試験は実機では行わない（ユーザーの決定）。** M7 の調べでは、有力な手段は `wrangler containers ssh` で主プロセスを落とす方法だけだった（再デプロイではインスタンスが止まらない）。この方法は、試験の間だけでも本番のコンテナに ssh の口を開ける必要がある。それは採らない。復旧は実コンテナの E2E（`apps/agent/test/e2e/sandbox-do.e2e.test.ts`）で確かめた範囲を根拠とし、実機で確かめていない限界を acceptance.md の 18 節と 15 項目の表に残す。

### D7. design 12 の「Jev」と実装の名前

design の 8 章・12 章・13 章・14 章（design.md 993 行）は評価器を「Jev」と呼ぶが、実装（15.5）は Clef-flash。**推奨**: 名前を実装に合わせて直す（M7 のドキュメント整合）。判断が要るのは、`design.md` の本文を書き換えてよいか（15 章の決定事項が本文に優先する、という既存のルールで足りるなら、15.8 に「8・12・13・14 章の Jev は Clef に読み替える」と 1 行書く）。**推奨: 1 行で足りる（本文は直さない）**。

**決定（2026-10-19）: 推奨どおり。** 15.8 に「8・12・13・14 章の Jev は Clef に読み替える」と 1 行書く。本文は直さない。

### D8. 個人での利用の認可（`ALLOWED_USER_IDS`）

GitHub の個人アカウントには team が無いので、org/team に加えて、数値の user ID の許可リスト `ALLOWED_USER_IDS` でも認可できるようにする。login は改名でき、空いた名前を他人が取れるので使わない。org/team のルールと ID のルールは OR。詳細は design.md 15.8（D8）。

**決定（2026-10-20）: 実装済み。** 解析と判定は `apps/gateway/src/auth/allowlist.ts`。docs/deploy.md の 5 に変数の説明がある。

## acceptance.md の穴（M7 で埋める）

調べた事実:

- Phase 2（ワーカーと Sandbox）の受入の節が無い。節の番号は 1〜4（Phase 1）、5〜7（Phase 3）、8〜10（Phase 4）、11〜13（Phase 5）、14〜17（Phase 6）。Phase 2 の実機の確認が欠けている。
- design 12 の Phase 7 の 15 項目と、acceptance の節の対応が書かれていない。
- 「起動のやり直しが実機で効くか」に当たる項目が無い。
- design 13 の未検証事項の表（Claude Code、Cowork、Pi Durable、Sandbox の外向き通信制限、Git Credential Helper、GitHub App、Jev、Web Sandbox）と、その表に載っていない R2 と Cost Control（design.md 976〜977 行付近の記述）を、受入の節に対応させる。表と、受入の節の対応が無い。

追加する節（案）:

- 18. Sandbox・復旧の実機（Phase 2）: 本物の Containers で SandboxDO が起動する。外向き通信が `enableInternet:false` と OutboundGateway で強制される（許可外の宛先に到達できない。IP 直指定、DNS 経由を含む）。コンテナを止めた後に、起動のやり直し・作り直しが働き、push 済みのチェックポイントから続きが進む（`restarts` / `bootRetries` が summary に出る）。Git credential helper が Sandbox の中でトークンを渡す（トークンが環境変数・ファイル・ログに残らない）。
- 19. design 12 の Phase 7 の 15 項目の通し: 項目ごとに、自動 E2E の対応するテストと、実機での確認の方法を表にする（下の表）。
- 20. 公開前の最終確認（M6・M11 の結果の記録）。

### design 12 の Phase 7（15 項目）の対応

| # | 項目 | 自動（偽の外部サービス）で済 | 実機で確かめる節 |
|---|---|---|---|
| 1 | Claude Code から実装を委譲 | 台本付き MCP クライアントで済（full E2E） | 2 |
| 2 | Draft PR の作成 | full E2E（偽 GitHub） | 5 |
| 3 | Pi Durable が実装を開始 | full E2E（実コンテナ、台本のモデル） | 19（実 Claude で） |
| 4 | クライアントが別の会話・調査を継続 | 自動では確かめられない（クライアントの挙動） | 3、8 |
| 5〜7 | 質問、回答、再開 | full E2E h など（台本） | 9（実モデルが質問する振る舞い） |
| 8 | Web 検索は隔離環境で実行 | web の E2E（偽） | 11（web_browse は既定で無効なので、web_search / web_fetch が対象） |
| 9 | 安全性判定（Jev→Clef）がレスポンスに含まれる | 同上 | 11、12、13 |
| 10 | GitHub へ Push | full E2E | 5 |
| 11 | テスト結果を PR へ反映 | full E2E | 5 |
| 12 | クライアントが PR をレビュー | 対象外（人間の作業） | 19（ユーザーが実際にレビューして記録） |
| 13 | クライアントのセッションを終了してもワーカーが継続 | cursor での再接続は自動で済 | 3（クライアントを閉じて開き直す） |
| 14 | 再接続後に状態・結果を取得 | 同上 | 3 |
| 15 | Sandbox 障害から自動復旧 | agent の実コンテナ E2E | 18（D6） |

## マイルストーン

phase6.md の M の分け方に合わせる。各 M は、先に失敗するテストを書いてから実装する（文書・実機の M は「Red」の代わりに「先に決めること」を置く）。順番は、エージェントだけでできるもの（M1〜M7）を先に、ユーザーの作業が要るもの（M8〜M11、★）を後にする。

| M | ユーザーの作業 | 範囲 | 一言 |
|---|---|---|---|
| M1 | なし | gateway のテスト基盤 | full E2E `g` の不安定の切り分けと対策 |
| M2 | なし | gateway（TaskDO） | `git_token` の削除（D1 の案しだいで範囲が変わる） |
| M3 | なし | gateway / agent / web | 細かい残り 4 件のテスト |
| M4 | なし | リポジトリ全体 | LICENSE、README、SECURITY.md、依存ライセンスの点検 |
| M5 | なし | docs | docs/deploy.md |
| M6 | なし（履歴の書き換えは M11） | リポジトリ全体 | 公開前の点検（秘密・個人の値・履歴） |
| M7 | なし | docs | acceptance.md の整理と、実機の手順の準備 |
| M7b | なし | agent | 公開前の `test:e2e:net` の実行と記録 |
| M8 ★ | あり | 実環境 | デプロイと Phase 1〜4 の受入 |
| M9 ★ | あり | 実環境 | Phase 5 の受入と web_browse の有効化 |
| M10 ★ | あり | 実環境 | Phase 6 の受入、Sandbox・復旧、15 項目の通し |
| M11 ★ | あり | リポジトリ | 公開（履歴の処理、push、リポジトリの公開） |

### M1. full E2E `g` の不安定の切り分けと対策

**目的**: `apps/gateway/test/full/full.e2e.test.ts` の「g. 完了の後に PR の head が動いたら head_moved_after_verification の警告が出る」が、`mise run test` の通し実行で `collect` の既定 240 秒（`timeoutMs = 240_000`）を超えて `timeout; status=RUNNING` で落ちる問題について、原因を確定し、再発しない形にする。単独の再実行は 26/26 で通っている。負荷による遅れとみているが、確定していない。

**対策の方針（守ること）**: 待ち時間を延ばさない。アサーションを弱めない。skip しない。

**仮説**（切り分けで 1 つずつ確かめる）

1. 通し実行では、直前の `test:e2e:docker` が残した状態（コンテナ、イメージのビルド、Docker Desktop の VM の資源）が、full E2E のコンテナの起動や実行を遅らせる。`test:e2e:full` は `wait_for` で `test:e2e:docker` の後に回してある（mise.toml 73・79 行）ので、通しでは docker の直後に動く。Docker 側の片付けは非同期。
2. スイート全体の途中で、コンテナの再利用や、イメージの初回ビルド、npm の取得（偽の上流）が遅れる。`g` は前のシナリオの後始末と重なる位置にある。
3. その他の「Sandbox / AgentDO 側で終端に至らなかった」系（起動のやり直し、`restarts` / `bootRetries` の発生、モデル台本の停止など）。

**除外した仮説（根拠つき）**

- 「`g` の `beforeHandle`（GitHub の応答への割り込み）が原因」は除外する。`GET /pulls` を呼ぶのは `getPull`（`apps/gateway/src/github/repo-api.ts` 230〜234 行）だけで、呼び出し元は `updatePullBody` → `finalizeGithub` しかない。`finalizeGithub` は、終端（isTerminal）かつ `cancel_state === "stopped"` の後でしか進まない（`task-do.ts` 1999 行）。一方、`collect` は終端まで待つので、割り込みが効くのはタスクが終端に達した**後**。「RUNNING のまま 240 秒」は、この仮説では説明できない。したがって、割り込み条件を直す対策は取らない。
- 「`collect` の待ちが `task_wait` の long polling に引きずられて、観測が遅れている」は除外する。long poll は 20 秒なので、観測の遅れは最大 20 秒。240 秒を超える説明にならない。

**作業の内容**

1. **再現**: 通し実行の負荷を再現する手段を作る。(a) `mise run test` を連続で数回走らせて、シナリオごとの所要時間を記録する（vitest の JSON レポーターの出力を、スクラッチのファイルに保存して比較する）。**主に比べるのは、「単独の `test:e2e:full`」と「通しの中の `test:e2e:full`」の差**（通しでは `test:e2e:docker` の直後に動く）。(b) 負荷をかけた状態（CPU を使い切るプロセスを論理コア数だけ起動する）での単独実行は、**優先度を下げる**（上の比較で差が出なかったときだけ行う）。
2. **計測の追加**（テスト基盤だけの変更。アサーションは変えない）: `collect` が失敗するとき、`status`、最後のイベントの seq・時刻・種別、`task_status` の内訳、wrangler dev の直近のログ、`docker ps` の状態に加えて、**AgentDO / SandboxDO の状態を必ず含める**（コンテナの起動から ready までの時刻、最後の agent イベント、`restarts`、`bootRetries`）。これらをエラーメッセージに含めて落とす。`timeout; status=RUNNING` だけでは原因が分からないため。
3. **切り分け**: 仮説ごとに、(1) コンテナの起動から ready までの時間、(2) 各シナリオでタスクが RUNNING に入ってから終端までの時間、(3) `restarts` / `bootRetries` の値、を比較する。
4. **対策の選定**（切り分けの結果で決める。次の案から、原因に合うものを選ぶ）
   - 原因が docker の残した状態の干渉（仮説 1）: `test:e2e:full` の前に「コンテナが残っていないこと」を確かめるガードを `mise.toml` のタスクに足す（待ち時間を延ばすのではなく、前提条件を確認して、残っていれば明示的に失敗または掃除する）。
   - 原因が遅さそのもの（仮説 2・3）: 待ち方を、絶対時間（240 秒の壁）から「進捗がないこと」（最後のイベントから一定時間、新しいイベントも状態の変化も無い）の検出に変える。**ただし、これは実際には `collect` の上限が 240 秒から最大 360 秒（`testTimeout`）に延びる変更で、言い換えても待ち時間の延長である。** 方針（待ち時間を延ばさない）に反するので、**延ばすかどうかは「承認が要る事項」として、ユーザー（Opus 経由）に諮る**。承認が無ければこの案は取らない。承認された場合も、全体の上限（`testTimeout`）は変えず、進捗なしの上限を決める。
   - テストの分割: `g` が検証したいのは TaskDO の終端の処理（head が動いたら警告）で、実コンテナは必須でない。Unit（TaskDO + fake の agent）で警告の判定を網羅し、full E2E の `g` は「実コンテナで完了させた後に head を動かす」最小の通しだけにする。**ただし、E2E を消して Unit に置き換えるのは、テストを弱めることになるので、承認を得る**（Opus に ESCALATE）。
5. 対策を入れた後、`mise run test` を連続 5 回通して、`g` が毎回 `collect` の既定の範囲内に収まることを確かめる。

**先に書くテスト（Red）**

- 計測: `collect` が失敗したときのメッセージに、最後のイベントの seq・時刻と状態が含まれることを確かめる Unit（`collect` を切り出して、時刻を差し替えられる形にする）。
- 停滞の検出（その案を取る場合）: 「進捗が止まったら、進捗なしの上限で落ちる」「進捗がある間は、全体の上限まで待つ」Unit。
- 再現できなければ、再現できなかった条件と実施した回数を記録する（原因が確定しないまま「直った」とは書かない）。

**完了条件（観測できる証拠）**

- 原因が確定している（再現できた条件と、計測の数値）。確定できなければ、確定できなかったことを明記し、計測の追加と進捗ベースの待ち、のように、原因が何であっても効く対策に限る。
- `mise run test` を連続 5 回実行して全て通り、`g` の所要時間が記録されている。所要時間の見積もり: 1 回の通しは約 13 分（795 秒）だったので、5 回で約 65 分。
- 待ち時間（`collect` の既定、`testTimeout`）は、承認なしには増えていない。アサーションは弱められていない。差分で確認できる。
- `mise run lint` が通る。

**依存関係**: なし。M2〜M3 の前に行うのが望ましい（通し実行が不安定だと、以降の完了の確認が信用できない）。M4〜M7 とは触るファイルが重ならないので並列に進めてよい。

### M2. TaskDO の `git_token` の暗号文の削除（D1: 案 B）

**目的**: D1（案 B）で決まった範囲、つまり `git_token` の暗号文だけを、`finalize_done = 1` の後に空にする。

**作業の内容**

- **方式: 行を DELETE せず、暗号文の列（`enc`）を空（または NULL）にする（推奨）。** `cred_delivered_id` が `git_token` の id を参照している（`task-do.ts` 283・1228 行）ので、行を消すと参照が壊れる。また、acceptance 16 節の件数の突き合わせ（`credential_issued` / `credential_revoked` の件数）を壊さずに済む。
- `finalize_done = 1`（トークンの失効が済んだ後）に、`git_token` の暗号文を空にする。`SetupFailure` の経路（`task-do.ts` 2016〜2027 行）も `finalize_done = 1` に至るので、「`finalize_done` の後に消す」の一本で扱える（経路ごとの特別扱いは要らない）。
- **セキュリティ面の確認**: `finalize_done` の後に `workingToken` を呼ぶ経路が無いこと（`task-do.ts` 1997・2002 行）を、読んで確かめ、Unit で固定する。暗号文を消した後にトークンを復号する経路があると、消した行を読んで失敗する／再発行してしまうため。
- 失効に失敗して打ち切った場合（`token_revoke_failed`）の扱いを決める。失効に失敗して打ち切った場合（`token_revoke_failed`）の扱いを決める。**失効できなかったトークンは、期限（最長 1 時間）が来るまで有効なので、暗号文は消してよい（再試行は打ち切り済み）が、再試行の途中では消さない。**
- 消した後でも、`needsAlarm()`、失効の再試行、終端の処理、アーカイブが壊れないこと。`result.json` / `events.jsonl` にトークンが無いことは Phase 6 で確認済みで、変えない。
- 既存の TaskDO の行（移行）: 次の起動で、終端済み（`finalize_done = 1`）で暗号文が残っているタスクの暗号文を空にする（`addColumnIfMissing` の流儀に合わせ、冪等に）。

**先に書くテスト（Red）**

- Unit: `finalize_done` の前（失効の再試行の途中）には `git_token` が残る。後には無い。2 回目の alarm でも結果が同じ（冪等）。
- Unit: 消した後、`task_status` / `task_result` / `task_wait` の応答が変わらない。アーカイブが成功する。
- Unit: 既存の終端済みの行（移行）で、起動後に `git_token` が消える。
- Unit: `finalize_done` の後に `workingToken` が呼ばれる経路が無い（呼ぶと失敗する）。`SetupFailure` で終わったタスクでも暗号文が空になる。`cred_delivered_id` の参照と、`credential_*` の件数が変わらない。
- E2E（full）: 完了したタスクの後、TaskDO のストレージに暗号文が残っていない。**TaskDO のストレージを E2E から読むために、新しい `/__test/` ルート（`apps/gateway/src/test-routes.ts`）と TaskDO のテスト用メソッドを足す**（ENVIRONMENT=test のときだけ有効で、production で無効なことを Unit で確かめる。既存の `/__test/audit` と同じ流儀）。

**完了条件**: 上のテストが緑。テスト用ルートとメソッドが production で無効。`mise run test` と `mise run lint` が通る。design.md 15.8 に決定を追記。案 C を取った場合は、削除後の応答の仕様と、その E2E を追加する。案 A の場合、この M は無し。

**依存関係**: D1。M1。

### M3. 細かい残り（low）4 件

**目的**: Phase 6 から残った穴を、テストで埋める。実装の変更は、テストが落ちた場合に限る。

1. **web_browse が無効のときの full E2E**: `WEB_BROWSE_ENABLED` を `"false"`（既定）で 3 つの Worker を起動した通しで、クライアントの `tools/list` に `web_browse` が出ず、ワーカーのツールにも出ず、呼んでも `disabled` で BROWSER を使わない。現在の full E2E は 3 つの Worker すべてで `true` にしてある（phase5.md）。既存の構成を保ったまま、無効の構成を追加する方法（wrangler dev を 2 つ起動するのは重いので、Worker の設定だけを切り替えた別の full 構成、または E2E の中で `vars` を切り替える方法）は、M3 の最初に決める。**決められないときは ESCALATE**。
2. **`LOGS` を外した構成の E2E**: 今は Unit（`task-archive.test.ts`）だけで確認している。E2E で、`LOGS` なしで起動した gateway が、タスクを普通に完了させ、`archive_skipped`（`reason: no_binding`）が `/__test/audit` に出ることを確かめる。構成の作り方は M3-1 と同じ問題（wrangler dev の起動数）。gateway の E2E（Docker 不要）は `r2_buckets` を生成した設定で起動しているので、そこに `LOGS` 無しの起動を足せるかを調べる。
3. **`result_unavailable` で打ち切る場合の Unit**: アーカイブが `result_unavailable`（結果を作れない）で再試行の上限に達し、`archive_failed`（`reason: result_unavailable`）を出して `archive_done = 1` にすることの Unit。タスクの結果と予算の精算は変わらない。
4. **outbound-handler の reason ごとのテストの網羅**: `outbound_denied` の `reason`（既存の違反コードの全部）ごとに、`dest` の分類と JSON の形が出ることを確かめる Unit。違反コードの一覧（`outbound-policy.ts`）から表を作り、一覧にあって、テストに無い reason が無いことを確かめるテスト（一覧を増やしたときにテストの追加を促す）にする。

**先に書くテスト（Red）**: 上の 1〜4 自体が Red になる（実装が既に満たしているなら、最初から緑になりうる。その場合は、テストが本当に失敗しうることを、実装を一時的に壊して確かめてから戻す）。

**完了条件**: 4 件のテストがあり、`mise run test` と `mise run lint` が通る。壊して確かめた結果を報告に書く。

**依存関係**: M1（full E2E の安定）。M3-1 と M3-2 は同じ構成の問題なので、同時に決める。

### M4. 公開の準備: LICENSE、README、付属ファイル

**目的**: 公開リポジトリとして最低限そろえる。

**作業の内容**

- `LICENSE`: MIT。`Copyright (c) 2026 youyo`。
- `package.json`（ルートと各 app / package）に `"license": "MIT"` を足す（`private: true` は維持する）。
- 依存のライセンスの点検: `pnpm licenses list`（mise タスク `licenses` として追加）で、配布や公開に影響するライセンス（GPL / AGPL など）が無いことを確かめる。Sandbox の Docker イメージ（`apps/agent/Dockerfile`）に入れるもの（Pi など）のライセンスも確認し、表にして `docs/deploy.md` か `NOTICE` に書く。問題があれば ESCALATE。
- README の見直し（公開向け）
  - 冒頭に、rovo が何か（3 行）、構成の図（gateway / agent / web / packages/audit）、状態（Phase 7 の実機の受入が済むまで「beta」か「実験的」と明記）、ライセンス。
  - 「現状（Phase 2）」の見出しを、現在の状態（Phase 6 まで実装済み）に直す。ツール一覧に Phase 4 のもの（`task_answer`、`task_steer`）と Phase 5 のもの（`web_search`、`web_fetch`、`web_browse`）を、表に揃える（現状は Phase 2 の 5 ツールの表と、Phase 5 の節が別れている）。
  - 内部用語・個人の環境の記述を点検する（下流の private リポジトリと IaC のリポジトリは、名前も中身も URL も書かない）。
  - 「docs/deploy.md（Phase 7 で作る予定）」を、実際の docs/deploy.md へのリンクに直す。phase6.md 内の同じ記述も、事実に合わせて直す。
  - 脆弱性の報告（SECURITY.md へのリンク）、Issue / PR の方針を 1〜2 行。
- `SECURITY.md`（D4 で置くと決定。公開 → 直後に PVR の順を書く）。
- phase1〜6 の文書の「下書き」「advisor レビュー反映済み」など、内部の作業の跡の記述は、残してよい（設計の経緯として価値がある）が、個人の環境の値が無いことを M6 で確かめる。

**先に書くテスト（Red）**: 文書なので、機械的に確かめられるものだけ、スクリプト（`mise run docs:check`）で確かめる。(1) README と docs 内の相対リンクが、存在するファイルを指す。(2) README が「Phase 7 で作る」と書いた箇所が無い。(3) 各 `package.json` の `license` が `MIT`。最初は (1)(2)(3) が失敗する状態から始める。

**完了条件**: LICENSE がある。`mise run docs:check` が通る。`mise run test`、`mise run lint` が通る。依存ライセンスの点検の結果を報告する。

**依存関係**: D4。M5 と並行できるが、README のリンク先が docs/deploy.md なので、M5 の見出し構成が先に必要。

### M5. docs/deploy.md

**目的**: 下流（デプロイ用の private リポジトリ）が、upstream の rovo を取り込み、デプロイするための手順を、公開できる形で書く。環境固有の値は、すべてプレースホルダ（`<YOUR_...>`）にする。

**目次案**

1. この文書の位置づけ（rovo は upstream、private の下流からデプロイ、Portal は IaC のリポジトリ。D3 の方針）
2. 前提（Cloudflare のプランと必要な機能: Workers、Durable Objects、Containers、R2、KV、AI Gateway、Browser Run〔web_browse を使う場合〕、Workers AI）と、課金されるもの
3. 構成とデプロイの順序（web → agent → gateway。service binding と `script_name` 付き DO の依存）
4. 下流のリポジトリの作り方（upstream の登録、更新の取り込み、`-c` で下流の wrangler 設定を指定する例〔D3〕。下流が upstream のファイルを書き換えなくてよい形）
5. 下流が用意する値の一覧（表: 変数・secret・バインディングごとに、どの Worker か、必須か、例、説明）。README の「設定」節と重複する部分は、deploy.md を正にして README から参照する
6. GitHub App の作成（権限、コールバック URL、Installation。README の節を移す）
7. AI Gateway の設定（Claude、Web Search API、Clef-flash の経路。metadata〔userId / taskId / caller〕）
8. Portal / Access への登録に必要な情報（MCP の URL、ユーザーごとの OAuth、DCR・認可・トークンの各 URL）。登録自体は IaC のリポジトリの範囲
9. R2 アーカイブの設定（`LOGS` を gateway にだけ束ねる、非公開、ライフサイクルの推奨値〔例: 90 日〕、キーの構造、取り扱いの規約〔未加工の非信頼データ〕）
10. 監査ログの設定（head sampling 100%、Logpush、確かめ方）
11. 単価（推定費用）の上書き
12. web_browse の有効化（既定は無効。有効化前のゲートへのリンク、順序）
13. 初回デプロイの確認（スモークテスト）と、acceptance.md へのリンク
14. 更新手順とロールバック（upstream の更新の取り込み、DO のマイグレーションの注意）
15. 運用の注意（予算の上限、秘密のローテーション〔`TOKEN_ENC_KEY` の扱い〕、障害時の見方）
16. トラブルシューティング（README の「エラー」節へのリンク）

**作業の内容**: 上の目次を書く。事実は README・phase6.md・各 `wrangler.jsonc` のコメント・`.dev.vars.example` から取り、コードと矛盾しないことを確かめる。コードを読んで確かめられないこと（Cloudflare 側の画面操作、料金）は、書かずに「M8 の実機で確認して追記」と印を付ける。

**先に書くテスト（Red）**: `mise run docs:check` に次を足す。(1) deploy.md の「env / secret の一覧」の表の変数名が、各 `wrangler.jsonc` の `vars` と `.dev.vars.example` の変数名と一致する（欠けも余りも失敗にする）。(2) 目次の見出しが、上の 16 項目にある。最初は deploy.md が無いので失敗する。

**完了条件**: docs/deploy.md がある。`mise run docs:check` が通る。M8 の実機で確認した結果で、「印」を付けた箇所が消えること（M8 の完了条件でも確認する）。

**依存関係**: M4（README のリンク）。M8 で実機の確認をして仕上げる。

### M6. 公開前の点検（秘密・個人の値・履歴）

**目的**: 公開してよい状態かを、機械的に確かめる。**点検と報告までを行い、履歴の書き換えと公開は M11（ユーザーと一緒）。**

**作業の内容**

1. 点検の道具をそろえる: `mise run scan:secrets`。gitleaks を `mise use gitleaks@<version>` で版を固定して使う。許可リストは `.gitleaks.toml` の allowlist に置き、**理由のコメントを付ける**。**gitleaks が見つけないもの**（32 桁 hex の account id、`*.workers.dev` の実在サブドメイン、org 名、`/Users/<name>/`、`claude.ai/code/session_`）は、**自前の正規表現で別に調べる**（同じタスクの中で実行する）。`release:check` には `pnpm audit` も足す。HEAD と、**git の全履歴**（全ブランチ・全タグ・削除された blob を含む）の両方を対象にする。
2. 検索する対象（正規表現を `scripts/` か mise タスクに置く）
   - 秘密: `ghs_` / `ghu_` / `gho_` / `ghp_` / `github_pat_` / `sk-` / `sk-ant-` / `xox?-` / `eyJ`（JWT）/ `-----BEGIN`（秘密鍵）/ `Authorization: Bearer` / 高エントロピーの文字列。
   - 個人・環境の値: account id（32 桁の 16 進数）、`*.workers.dev` の実在のサブドメイン、KV / R2 / AI Gateway の実 ID、org / team の実名、ローカルの絶対パス（`/Users/<name>/`）、`Claude-Session` トレーラー（D2）。**メールアドレスは決定済み（D2）なので対象から外す。**
   - 追跡されているファイル: `.dev.vars` が追跡されていないこと（`.dev.vars.example` だけ）、`.claude/`（`handover` を含む）が追跡されていないこと、`dist/`・`.wrangler/` が追跡されていないこと。
3. 既存の許容: テストの偽の値（`ghs_abcdefghijklmnop` のような明らかなダミー）は、許可リスト（理由つき）に登録する。許可リストは小さく保つ。
4. 履歴の点検: 過去に入って消えた秘密・個人の値が無いか。見つかったら、D2 の判断材料にする。author / committer のメール（`1003ni@gmail.com`）は公開してよいと決定済みなので対象外。`Claude-Session` トレーラーの件数（55 本）は D2 の判断材料として再確認する。
5. 公開してよい文書の点検: 文書内に、他のリポジトリや個人の環境の詳細（下流の private リポジトリと IaC のリポジトリの中身）を書いていないか。
6. 履歴の書き換えの手順書を用意する（D2 の b の場合の `git filter-repo --message-callback`（または `--replace-message`）の手順、検証コマンド、元に戻す方法〔書き換える前のバックアップ〕）。**実行はしない。**
7. **下流（private）側の確認項目**: 下流のリポジトリの履歴に rovo のコミットが入っていないか（たとえば、ローカルのパスから取り込んでいないか。upstream をリモートとして登録していれば履歴は共有されるので、書き換えると整合が崩れる）。確認はユーザーの作業（下流のリポジトリはこのリポジトリの範囲外）。
8. `.gitignore` は `.claude/handover` だけを無視している。`.claude/settings.json` などができると追跡されうるので、公開前に `.claude/` 配下に追跡対象が無いことを確かめる（必要なら `.gitignore` に足す）。

**先に書くテスト（Red）**: 道具の確認として、(a) 意図的にダミーの秘密を入れた一時的なディレクトリ（スクラッチ）で、`scan:secrets` が検出すること、(b) 許可リストのダミーが検出されないこと、を確かめる。(a) が失敗する（道具が動いていない）状態から始める。

**完了条件**: `mise run scan:secrets` が、HEAD と全履歴で 0 件（許可リストを除く）。点検の結果の表（検索した項目、件数、許可したもの、理由）を報告する。D2 の判断材料（履歴の秘密・個人の値、トレーラーの有無）を報告する。`mise run lint` が通る。

**依存関係**: D2、M4。M1 とは触るファイルが重ならないので並列に進めてよい。公開の直前に、M11 でもう一度実行する（M4〜M5 の変更が入るため）。

### M7. acceptance.md の整理と、実機の手順の準備

**目的**: M8〜M10 でユーザーと一緒に迷わず実施できるように、受入試験を整える。

**作業の内容**

- 上の「acceptance.md の穴」の節 18〜20 を追加する。design 12 の 15 項目の対応表を 19 に置く。design 13 の未検証事項の表に、受入の節への対応を足す。
- 全項目を一覧にして、実施のしかたを区分する。
  - **自動で済（偽の外部サービス）**で、実機でも再確認する項目か、実機だけで意味のある項目か。
  - **課金が発生する項目**（実 Claude、Web Search API、Clef-flash、R2、Sandbox）と、その見積もり。
  - **ユーザーの操作が要る項目**（Claude Code / Cowork の操作、GitHub 上の操作、Cloudflare の画面）。
  - **環境の準備が要る項目**: 例として、`127.0.0.1.nip.io` と `169.254.169.254.nip.io` を `web_fetch` に渡す（11 節）、team から外す（4 節）、ブランチ保護（6 節）、Free プランの private リポジトリ（7 節）、1 時間を超えるタスク（5 節）、24 時間（省略可）、Logpush の宛先（16 節）。
- 注入サンプルの用意（13 節）: 各 10 件以上、日本語と英語。攻撃文の例を含むサンプルは、`docs/` ではなく `apps/web/test/` の下に置く。**決定（2026-10-19）: 推奨どおり置く**（検出率を再現するため）。
- web_browse のゲートの手順書（M9 の準備。2026-10-20 の D5 の更新により、M9 では実施せず任意の手順として残す）: Kitesurf の実機確認に必要な、確認用のページ（iframe、popup、meta refresh、JS 遷移、service worker、`data:` / `blob:`、A→禁止B→A、短い TTL で内部 IP に切り替わる名前）を置く方法を決める。
  - 確認用のページは、**公開されて Kitesurf から到達できる**必要がある。ユーザーの Cloudflare アカウント上の一時的な Worker か、静的ページとして置く（コミットしない。確認が終わったら削除する）。ページの HTML は、スクラッチに作り、手順書にはその作り方だけを書く。
  - 禁止先の通信の発生を確かめるために、**ユーザーが管理する受け口**（ログを取れるサーバー）が要る。内部 IP への通信は、受け口に届かないことで間接的に確かめる。確認の方法の限界（内部 IP への通信は観測できないこと）を手順書に書く。
- 結果の記録の形式を揃える（各節の結果表に「実施者・日付・環境・結果・備考」。秘密・環境の値を書かない）。
- design.md の 15.8（Phase 7 の決定。D3 が承認されたら「design 16 の例〔upstream に置くデプロイのタスク〕は採らない」を含める）、13 章（未検証事項の結果の記録先）、「Jev」の読み替え（D7）を書く。

**先に書くテスト（Red）**: `mise run docs:check` に、(1) acceptance.md の節番号が連続していて、重複が無い、(2) 15 項目の対応表に 15 項目が全部ある、(3) 結果表がすべての Phase にある、を足す。最初は 18 以降が無いので失敗する。

**完了条件**: acceptance.md に 18〜20 がある。実機の項目の区分の表がある。`mise run docs:check`、`mise run lint` が通る。ユーザーに、M8〜M10 の実施の順序と所要時間・課金の見積もりを提示できる。

**依存関係**: M5（deploy.md の手順を参照する）。

### M7b. 公開前の `test:e2e:net` の実行（M8 の前）

`test:e2e:net`（mise.toml 85〜88 行。実 npm への GET、許可外ホストの拒否、github.com への認証なし clone が 401 で落ちること。`test` には含まれない）を、公開前に 1 回実行して、結果を acceptance.md の節 18 に記録する。Docker とネットワークが要る（実 npm を読むだけで、課金は無い）。落ちたら原因を調べ、再現するテストつきで直す。**エージェントだけでできる**（ユーザーのデプロイは要らない）。M1 の後に実行する（同時には走らせない。負荷の干渉を避ける）。

### M8 ★. デプロイと Phase 1〜4 の受入

**ユーザーの作業**: 検証用のリポジトリ、GitHub App の作成と Install、Cloudflare のリソース（KV、AI Gateway、R2）、下流（デプロイ用の private リポジトリ）の設定、デプロイ（web → agent → gateway）、secret の投入、Portal の登録（IaC のリポジトリ）、Claude Code / Cowork の操作。
**エージェントの作業**: deploy.md の手順に沿った確認の補助、不具合の切り分けと修正（TDD で、再現するテストを先に）、結果の記録、deploy.md の「印」の解消。

**範囲**: acceptance.md の「前提」、1〜4（ログイン、ツール、待機、GitHub 資格）、5〜7（Draft PR・push、ブランチ保護、Free プラン）、8〜10（バックグラウンド待機、質問と回答、steer）、18（Sandbox・復旧の一部: 起動と外向き通信の強制）。3 節の実測（30 / 45 / 60 秒の待機が Portal 経由で通るか）の結果で、`DEFAULT_WAIT_SECONDS` / `MAX_WAIT_SECONDS` を見直す。

**完了条件**: 上の節の項目に、結果（実施者・日付・環境・結果・備考）が記録されている。未達の項目は、原因と対応（修正、設計の見直し、許容と記録）が書かれている。不具合の修正は、再現するテストつきで `mise run test` が通る。deploy.md の「印」が消えている。

**依存関係**: M5、M7。D6 は 2026-10-20 の更新により、実機では使わない（M10 の 18 節は E2E を根拠にする）。

### M9 ★. Phase 5 の受入と web_browse の有効化

**ユーザーの作業**: AI Gateway の確認、課金される呼び出しの了承、`remote: true` の BROWSER の設定と web_browse の有効化。
**エージェントの作業**: 手順の提示、結果の記録、`web_fetch` の閾値の調整（結果しだい。TDD）。

**範囲**

- 11 節: 実 Web Search API と Clef-flash、非信頼データの囲み、ワーカーからの利用、robots / bot チャレンジ / private への redirect、**回数の上限**、**`127.0.0.1.nip.io` と `169.254.169.254.nip.io` を `web_fetch` に渡しても内部に到達しないこと**（到達できたら Phase 5 の完了としない。ESCALATE）。
- 12 節: Clef の応答の形、`usage.input_tokens`、sentinel の効き方、AI Gateway の metadata。
- 13 節: 注入サンプルでの検出率・誤検知率、閾値（`SAFETY_BLOCK_THRESHOLD` 0.8 / `SAFETY_CAUTION_THRESHOLD` 0.4）の調整。
- **web_browse**（11 節）: 有効化前のゲートは行わない（D5 の 2026-10-20 の更新）。web → agent → gateway の順に `WEB_BROWSE_ENABLED` を `"true"` にし、`tools/list` に現れることを確かめる。11 節の「そのほかの確認」（bot チャレンジ、注入サンプル、所要時間と上限、UA と `rovo-web` の食い違い、BROWSER の wrangler の版と compatibility_date）は、運用しながら確かめて記録する。

**完了条件**: 11〜13 節の項目に結果が記録されている。web_browse の残存リスクの受け入れが 11 節に記録され、有効化の確認の結果がある。閾値を調整したら、env と結果が記録されている。不具合の修正は、再現するテストつき。

**依存関係**: M8（デプロイ済み）、M7（手順書）。

### M10 ★. Phase 6 の受入、Sandbox・復旧、15 項目の通し

**ユーザーの作業**: R2 のバケットとライフサイクル、Logpush の宛先、head sampling、PR のレビュー（15 項目の 12）。
**エージェントの作業**: アーカイブの中身の検査（grep）、監査行の件数の突き合わせ、結果の記録、修正。

**範囲**

- 14〜17 節（アーカイブ、秘密の混入、監査ログ、ライフサイクル）。
- 18 節（Sandbox・復旧）: 実機ではコンテナを止めない（D6 の 2026-10-20 の更新）。復旧の項目は、実コンテナの E2E で確認済みとして記録し、実機で確かめていない限界を備考に残す。
- 19 節: design 12 の Phase 7 の 15 項目を、実 Claude Code / Cowork から通しで実施する。クライアントの別会話の継続、クライアントのセッションを終了してもワーカーが継続、再接続後の取得、PR をユーザーがレビューする、まで。
- 検証用に一時的に足した設定（短いライフサイクル、sampling を下げた構成）は、確かめた後に元に戻したことを記録する。

**完了条件**: 14〜19 節の項目に結果が記録されている。15 項目それぞれに、確かめた日付と結果がある。未達の項目は、原因と対応が書かれている。design 14 章の「最終的な完成条件」の各文について、満たしたことを示す節への参照を、15.8 に書く。

**依存関係**: M8、M9（web が使える状態で通しを行うため）。

### M11 ★. 公開

**ユーザーの作業**: D2 の決定（案 b）に沿った履歴の処理、push、リポジトリの公開（Visibility の変更）、その直後の private vulnerability reporting（PVR）の有効化、タグ、下流の upstream の設定の確認。**エージェントは、ユーザーの明示の指示があるまで、push も公開もしない。**

**作業の内容**

1. M6 の点検を、最新の HEAD と全履歴で再実行する（0 件）。
2. **公開直前に**、D2 の決定（案 b）に沿って履歴を処理する（M6 の手順書に沿う。ユーザーと一緒に行う）。(a) 処理の前に、バックアップ（ミラークローン）を取る。(b) 文書内の古いコミット ID の参照を点検する。(c) `git filter-repo` で `Claude-Session:` 行だけを消す（`Co-Authored-By` は残す）。(d) 全履歴で `claude.ai/code/session_` が 0 件であることと、`Co-Authored-By` が残っていることを確かめる。(e) 処理の後、M6 の点検と文書内のコミット ID の点検を再実行する。(f) 下流が upstream として履歴を共有していれば、書き換えの影響をユーザーが確認する。
3. README と docs/deploy.md の最終確認（リンク切れ、Phase の状態の記述）。
4. 順番: (1) リポジトリの設定（説明、トピック、Issue の設定）、(2) 公開、(3) **公開の直後に PVR を有効化**（PVR は公開リポジトリで使える機能。実施の前に GitHub Docs で条件を確かめる）。SECURITY.md の文面にもこの順番を反映する。
5. 公開後、下流（デプロイ用の private リポジトリ）が公開された upstream を取り込めることを確認する（ユーザーの作業）。
6. 任意: バージョンタグ（例: `v0.1.0`）。

**先に書くテスト（Red）**: 公開前の最終チェックリスト（`mise run release:check` として、点検の道具の自己テスト、`scan:secrets`、`pnpm audit` をまとめる。`docs:check` は `lint` の中で、`test`・`lint`・`build` は別に実行する。M6 で実装済み）を作る。最初は未実装で失敗する。

**完了条件**: `mise run release:check` が通る。点検の結果が 0 件。リポジトリが公開され、匿名でクローンでき、LICENSE が表示される。全履歴で `claude.ai/code/session_` が 0 件で、`Co-Authored-By` は残っている（D2。メールは公開してよいと決定済み）。下流の取り込みが確認されている。

**依存関係**: M1〜M10 のすべて、D2、D4。

## 全体のテスト方針

- 各 M で、先に失敗するテストを書く。Unit と E2E の両方（コードを変える M1〜M3）。文書の M は `docs:check` の機械的な確認と、結果の記録。
- 完了条件は `mise run test` と `mise run lint`。実機の M は、さらに acceptance.md の結果表の記録。
- 新しい mise タスク（M で追加する）: `docs:check`、`scan:secrets`、`licenses`、`release:check`。いずれも `mise.toml` の `[tasks]` に定義し、直接コマンドを叩かない。
- 実装した agent とは別の verifier が、各 M の最後に差分とテスト結果を確認する。

## 未決事項

- **M1 の待ち時間**: 原因を特定してから改めて決める。M1 はまず計測と原因の特定を行う。待ち時間を延ばす案（進捗ベースの待ち。`collect` の上限が最大 360 秒に延びる）は、原因が分かった時点でユーザーに承認を求める。承認が無ければ取らない。
- **テストの分割**（E2E を Unit に置き換える）: 未承認のまま残す。テストを弱めることになるので、必要になった時点でユーザーに承認を求める。

（D1〜D8、注入サンプルの置き場所、M3 の E2E 構成は決定済み。M3 の E2E 構成は M3 の最初に決める実装上の判断で、決められないときは ESCALATE。）

## 前提・注意

- 本番相当の環境へのデプロイ、GitHub App の作成、AI Gateway、Portal の登録、push は、ユーザーと一緒に行う（エージェントが単独で行わない）。
- 実機の受入は課金される（実 Claude、Sandbox、Web Search API、Clef-flash、R2、Browser Run）。M7 で見積もりを出してから始める。
- 公開リポジトリに秘密・個人の環境の値を入れない。受入の記録にも書かない。
- Portal / Access の登録は rovo の範囲外（IaC のリポジトリ）。

## 気づいた矛盾・不明点（計画の作成時）

- acceptance.md に Phase 2 の節が無い。「起動のやり直しが実機で効くか」に当たる項目も無い（M7 で追加）。
- design の本文は評価器を「Jev」と呼ぶが、実装は Clef-flash（D7）。
- design 12 の Phase 7 の項目 8「Web 検索は隔離環境で実行」は、web_browse が既定で無効であることと合わせて読む（web_search / web_fetch が対象）。
- phase6.md と README が、docs/deploy.md を「Phase 7 で作る」と書いている（M4・M5 で事実に合わせる）。
- git の履歴に `Claude-Session` のセッション URL が 55 本入っていた（D2。メールは公開してよいと決定済み）。2026-10-20 に履歴を書き換えて 0 本にし、`scan:secrets` の上限を 55 から 0 にした。
- `mise.toml` にデプロイ用のタスクが無い（design 16 の例との差。D3）。
