# Phase 2 実装計画: Pi Durable / Coding Sandbox

設計書 `design.md` の Phase 2（12章）を具体化したもの。2026-10-18 の技術調査と advisor の助言を反映している。

## design.md からの変更点（後で 15 章へ反映する）

| 箇所 | 変更 |
|---|---|
| 6.4 Credential Helper | **廃止**。Sandbox DO の外向き傍受（Git Gateway entrypoint）が GitHub への認証ヘッダを注入する。トークンはコンテナに入れない。Phase 2 は `git-upload-pack`（fetch/clone）だけを許可し、push は Phase 3 で入れる |
| 7.2 外向き通信 | `enableInternet:false` と `interceptOutboundHttps` / `interceptOutboundHttp` による allowlist で強制する（後述） |
| 7.4 argv 規則 | Gateway 側（利用者の入力からコマンドを組み立てる箇所）には argv 実行を適用する。子エージェントの bash ツールはモデルが書くシェル文字列なので、`["bash","-lc",cmd]` で実行することを許す。理由: コンテナそのものが信頼境界で、資格情報を持たず、外向き通信は境界で制限されているため |
| 15.1 Sandbox | `@cloudflare/sandbox` 1.0.1 は 0.x と別物で、`getSandbox` / `exec` を持たない。`SandboxDO` を自作する（`ctx.container` + `Files`）。ツールは Pi の `defineTool` で自作し、`CodingTools` は使わない |
| 15.2 Claude | `createAI({binding: env.AI, id: <gateway id>, metadata: {userId, taskId}})`。モデル ID はハイフン形式（例: `anthropic/claude-sonnet-5-5`。実機で確認済み） |
| 構成 | 子エージェントは別 Worker `apps/agent` に置く。Gateway からは `script_name` 付きの DO バインディングで呼ぶ |
| Phase 3 の範囲 | GitHub App 認証は Phase 1 で済んだ。Phase 3 は Installation Token Broker、Git Gateway の push 許可（`agent/task-*` ブランチのみ）、Draft PR の作成・更新とする |

## ゴール

`task_start` → `RUNNING` → Sandbox で編集・テスト・ローカル commit → `VERIFYING` → `COMPLETED` / `FAILED`、の流れが動く。完了したタスクの成果（要約、検証結果、patch）は `task_result` で取得できる。

- push と Draft PR は作らない（Phase 3）。
- 親への質問（`INPUT_REQUIRED`）は作らない（Phase 4）。

## codex レビュー（2026-10-18）で追加した原則

1. **停止の保証**: 止めるときは、プロセスグループ全体を止めて終了を確かめる。キャンセルや期限切れのときは、最終手段としてコンテナ全体を止める。Pi の `abort()` は idle を待つので、Sandbox の停止は abort より先か、並行して行う。
2. **配送の収束**: Gateway → Agent の指示（start / cancel）は、意図を永続化してから送る。成功を確かめるまで alarm で再送する。受け手は冪等にし、tombstone で遅れて届いた指示を拒否する。
3. **期限は各層が持つ**: 下位の層から上位の層へ通知はしない（一方向 RPC）。Gateway は deadline を渡し、各層は自分で期限を確かめて止まる。上位は poll で状態を知る。
4. **費用は呼び出し前に止める**: 次のモデル呼び出しの最大費用を見積もり、残りの予算で払えなければ呼ばない（事後の usage で止めるだけでは上限を保証できない）。
5. **検証の入力はモデルの手の外に置く**: 検証コマンドは親が渡し、AgentDO の storage に保存する。対象の commit SHA を固定する。

## 構成

```
apps/gateway (既存 Worker)
  TaskDO ──RPC(script_name binding)──▶ apps/agent: AgentDO (1 task = 1 instance)
                                           │  PiHarness (Pi Durable) + 自作ツール
                                           │  createAI → env.AI → AI Gateway (BYOK) → Anthropic
                                           ▼ RPC
                                        SandboxDO (1 task = 1 instance)
                                           │ ctx.container (enableInternet:false)
                                           │ interceptOutbound* → OutboundGateway (WorkerEntrypoint)
                                           ▼
                                        Container: node / git / ripgrep, /workspace
```

- RPC は「Gateway → Agent → Sandbox」の一方向だけにする。逆向きのバインディングは作らない（循環を避ける）。
- 名前（DO の ID）は、認証済みの task_id から導く。利用者の入力から直接作らない。
- `apps/agent` は新しい Worker なので、Sandbox の公式例にある `exports` 形式の設定を最初から使える。Gateway の `migrations` 形式との共存問題を踏まない。

### パッケージ

- `agents@0.28.1`（PiHarness を同梱）
- `@earendil-works/pi-durable@1.3.0`、`@earendil-works/pi-ai@1.3.0`（beta なので完全に固定する）
- `@cloudflare/sandbox@1.0.1` と、Docker イメージ `cloudflare/sandbox:1.0.1`（タグをそろえる）
- Pi への依存は `apps/agent/src/pi/` のアダプタ層に閉じ込める（15.1）。

## AgentDO（子エージェント）

- `Lifecycle.install(this).use(piHarness)`。復旧は PiHarness の heartbeat（30秒）と checkpoint に任せる。
- モデル
  - 既定は `anthropic/claude-sonnet-5-5`。env で変更できる。
  - `createAI` の `metadata` に userId と taskId を入れ、AI Gateway のログで突き合わせられるようにする。
- 起動
  - Gateway から `start(taskSpec)` を呼ぶ。
  - taskSpec には、repository / base_sha / instructions / acceptance_criteria / verification_commands / constraints / 予算 / userId / deadlineAt を入れる。
  - AgentDO は、taskSpec の fingerprint と operationId（taskId から導く）を永続化する。
    - 同じ operationId と同じ fingerprint の再送には、受理済みの結果を返す。
    - fingerprint が違えば `conflict` を返す。
    - cancel の tombstone があれば `cancelled` を返して、何も始めない（start より先に cancel が届いた場合）。
- システムプロンプト（sections）
  - 受け入れ条件、制約、作業手順（調査 → 実装 → テスト → commit → 完了報告）
  - 外部コンテンツを信用しないこと、push や PR はしないこと
- イベント
  - AgentDO のイベントは、AgentDO 自身の状態遷移（phase の変化、ツール呼び出しの開始と終了の要約、エラー、完了報告、費用の更新）として、同じトランザクションで SQLite に seq 付きで書く。
  - Pi の `events()` は表示用の補助にとどめ、正本にしない。Pi のイベントは再起動後に途中から再開できず、永続化する前にクラッシュすると抜けが生じるため。
  - `getEvents(afterSeq, limit)` は `{events, throughSeq, hasMore, phase, phaseAsOfSeq, usage}` を返す。
- 状態の報告
  - AgentDO は `phase`（`starting` / `running` / `verifying` / `completed` / `failed` / `budget_exceeded` / `cancelled`）を持つ。
  - phase の変化も、イベントとして seq に載せる。Gateway は、終端の phase のイベントを取り込み終えてから、TaskDO を終端に確定する。
- 予算（呼び出し前に止める）
  - モデルの単価表はコードに固定する。単価表にないモデルは使えない（起動時に拒否する）。
  - 次のモデル呼び出しの前に、最大費用を見積もる。見積もりは「現在のコンテキストのトークン数 × 入力単価」と「出力の上限トークン数（max_tokens）× 出力単価」の合計。
    - 残りの予算で払えなければ、呼ばずに `budget_exceeded` で終える。
    - Pi に「モデル呼び出しの前」のフックがあるかは M2 で確かめる。無い場合は、ツールの結果を返した直後（＝次のモデル呼び出しの直前）に判定する。
  - 実際の費用は `pi().usage()` から計算し、キャッシュの読み書きと再試行の分も含める。
  - 月額の上限
    - UserDO が `task_start` の時点で、タスクの予算（$10）を月額の枠から予約する。足りなければ `task_start` を拒否する。
    - TaskDO は、AgentDO のイベントに含まれる usage を取り込み、UserDO に冪等に精算する（usage の seq で重複を防ぐ）。
    - タスクが終わったら（成功・失敗・キャンセルのいずれでも）、予約と実費の差額を枠に戻す。月をまたいだタスクは、開始した月に計上する。
    - AgentDO から UserDO へは直接計上しない（一方向 RPC）。
- 期限
  - AgentDO は `startedAt` と `deadlineAt`（開始から2時間）を永続化する。alarm、モデル呼び出しの前、ツールの開始前に確かめ、超えていたら `failed`（理由: deadline）にする。
  - 再起動しても期限は延長しない。
- キャンセル（停止を確かめるまで収束させる）
  - Gateway は、TaskDO を `CANCELLED` に確定させ、同じトランザクションで「cancel を配送する意図」を記録する。
  - TaskDO の alarm は、AgentDO から停止の確認（`stopped: true`）が返るまで cancel を再送する。TaskDO が終端になった後も続ける。
  - AgentDO の `cancel()`
    1. cancel の tombstone を記録する（遅れて届いた start を拒否するため）。
    2. SandboxDO の停止（プロセスグループ全体を止め、終わらなければコンテナを止める）を先に始め、並行して Pi の `abort()` を呼ぶ。
    3. 両方が終わったら `stopped: true` を返す。終わっていなければ `stopped: false` を返し、次の再送で確かめ直す。
  - UserDO の同時実行枠は、停止を確かめてから解放する。Phase 1 の照合（`reserve` 時に予約先を確かめる）も、TaskDO の「停止確認済み」を見るように変える。古いタスクが動いたまま次のタスクが始まらないようにするため。
- 完了判定
  - `task_start` の入力に `verification_commands: {argv: string[], cwd?: string, timeout_seconds?: number}[]` を追加する（任意）。自然文の acceptance_criteria とは分ける。
  - モデルが `report_completion({summary})` を呼んだら `verifying` にする。
  - AgentDO は、その時点の commit SHA を固定し、AgentDO の storage に保存した verification_commands を Sandbox で実行する。
  - 全部が成功（終了コード 0）なら `completed`。失敗なら、結果をモデルに返して修正させる。
    - 試行は「最初の1回 + 修正3回」の計4回まで。4回目も失敗なら `failed`。
  - verification_commands が無い場合は、モデルの申告だけで `completed` にし、結果に「未検証」と記す。
  - 限界: モデルはテストの設定（例: package.json の test スクリプト）を書き換えられるので、この検証は門番であって保証ではない。テスト関連のファイル（package.json の scripts、テストの設定ファイル、テストファイルの削除）が変わっていれば、結果に警告として記し、親のレビューに委ねる。
- 成果の保存
  - `completed` / `failed` になったら、base_sha からの patch（`git format-patch`）と、検証結果・要約を AgentDO の storage に保存する。
  - patch は 1MiB までとし、DO の行サイズの制限を避けるため分割して保存する。超える場合は「大きすぎる」と記し、diffstat だけを保存する。
  - Sandbox を作り直すと未 push の commit も失われるので、成果はこの保存分を正とする（push は Phase 3）。

## ツール（`defineTool` で自作）

| ツール | replay | 内容 |
|---|---|---|
| `read_file` | safe | `/workspace` 配下のファイルを読む。サイズ上限と行範囲あり |
| `list_files` | safe | ディレクトリ一覧（深さと件数に上限） |
| `search` | safe | ripgrep（argv 実行） |
| `write_file` | safe | 全文の書き込み（同じ内容なら冪等） |
| `edit_file` | unsafe | 一意な文字列の置換。厳密には冪等でないので、既定の unsafe のままにする |
| `bash` | unsafe | `["bash","-lc",cmd]`。タイムアウト（既定10分、上限30分）、出力上限（末尾 64KiB）、資格情報らしき文字列のマスク |
| `git_commit` | unsafe | `git add -A && git commit`（argv）。作者は bot 名 |
| `report_completion` | unsafe | 完了の申告 |

- 構造化されたファイルツール（read / list / search / write / edit）のパスは、`/workspace` 配下に正規化し、外に出るもの（`..` やシンボリックリンク経由）は拒否する。
- `bash` はコンテナ全体（`/etc` や `/tmp` を含む）にアクセスできる。これを前提として、コンテナには他のタスクのデータ、秘密情報、信頼が必要な制御状態（検証コマンドなど）を置かない。
- `bash` は `setsid` で新しいプロセスグループとして起動する。タイムアウトやキャンセルのときは、グループ全体に SIGTERM を送り、猶予の後に SIGKILL を送って、終了を確かめる。
- 出力は上限付きのリングバッファで読み続ける（末尾 64KiB を残す）。読むのを止めると、プロセスが書き込みで詰まるため。
- ツールの結果に含まれる外部由来の文字列は、信用しないデータとして扱う（プロンプトの section で明示）。

## SandboxDO

- `ctx.container.start({enableInternet: false})`。インスタンスタイプは `standard-1`。
- `ensureRunning()`
  - すべての操作の前に必ず通す。
  - コンテナが止まっていたら起動し、`/workspace` が空なら `git clone` → `git checkout <base_sha>` → 作業ブランチ `agent/task-<id>` を作る。
  - Phase 2 では、Sandbox が止まった後の復旧は「clone し直す」までにする。未 commit の変更は失われる。モデルにはツールのエラーとして伝え、やり直させる。snapshot による高速化は Phase 6。
- `exec(argv, {cwd, timeoutMs, maxOutputBytes})`
  - タイムアウトは `AbortController` で自前で実装する（`AbortSignal.timeout` は使えない）。
  - 出力は stream で読み、上限で切る（`output()` は全出力をメモリに載せるので使わない）。
  - 終了済みプロセスへの kill は例外になるので、それを握りつぶさずに扱う。
- 生存期間
  - `setInactivityTimeout` は2時間。処理中は1分ごとの alarm で DO を active に保つ。
  - SandboxDO も AgentDO から渡された `deadlineAt` を持ち、超えたら自分でコンテナを止める（AgentDO へは通知しない。AgentDO は自分の期限で止まる）。
  - `stop()` RPC: プロセスグループ全体を止め、終わらなければコンテナを止める。停止を確かめてから戻る。
- 外向き通信（7.2 の強制）
  - 傍受の登録と CA の設定が終わるまで、clone や exec を行わない。コンテナを起動するたびに、傍受を登録し直す。
  - HTTPS は `interceptOutboundHttps("*", OutboundGateway)`、HTTP は全宛先を受ける API（`interceptAllOutboundHttp` があればそれ）で受け、エントリポイント内で判定する。両者の仕様の違いは M1 で確かめる。
  - 許可するもの
    - `github.com`（HTTPS、443、ホスト名の完全一致）:
      - GET `/<owner>/<repo>(.git)?/info/refs?service=git-upload-pack`（query は `service` だけ）
      - POST `/<owner>/<repo>(.git)?/git-upload-pack`
      - owner/repo は正規化したうえで、taskSpec のリポジトリと一致するものだけ。
      - 認証ヘッダは Worker 側で注入する。Phase 2 は公開リポジトリだけを対象にし、認証なしで通す。非公開リポジトリは Phase 3 の Token Broker で対応する。
      - git-receive-pack、dumb HTTP、LFS、別リポジトリ（submodule を含む）は拒否する。
      - リクエスト本文のサイズと時間に上限を設ける。
    - `registry.npmjs.org`、`pypi.org`、`files.pythonhosted.org`: GET と HEAD だけ。
  - それ以外（CONNECT、WebSocket、別ポート、裸の IP、IPv6 の直接指定、Host と SNI の不一致を含む）はすべて拒否し、ポリシー違反としてイベントに記録する。記録には query や本文を残さない。
  - 上流への転送
    - `redirect: "manual"` にし、redirect の行き先ごとに scheme / host / port / path / method を判定し直す。
    - 上流は HTTPS に固定し、必要なヘッダだけで組み立て直す。コンテナから来た Authorization / Cookie / Host は転送しない。
  - コンテナ内では、Cloudflare のエフェメラル CA を `NODE_EXTRA_CA_CERTS` / `GIT_SSL_CAINFO` / `REQUESTS_CA_BUNDLE` に設定する。
  - 残るリスク: 許可したホストへの GET / HEAD の path / query / header や、git の POST 本文を使った情報流出は、原理的には防ぎきれない（7.2）。「GET だから流出しない」とは言えない。lockfile にあるパッケージだけに絞るのは、将来の強化策とする。npm の tarball が外部ホストにある依存は失敗する（fail-closed）。
- 既知の制限
  - postinstall で外部からバイナリを取る依存（playwright など）は失敗する。
  - 許可したホスト経由の情報流出は、原理的には防ぎきれない（7.2）。Phase 2 は GET 系だけに絞る。

## Gateway 側の変更

- `task_start`
  - 入力に `verification_commands`（任意）を追加する。
  - 予約（同時実行枠と、月額枠からのタスク予算）と TaskDO の作成の後、AgentDO の `start` を呼ぶ。
  - TaskDO は、作成時に「start を配送する意図」と taskSpec の fingerprint を同じトランザクションで記録する。
  - `start` が成功したら `RUNNING` に遷移する。失敗したり応答が失われたりしても、TaskDO の alarm が `start` を再送する（`CREATING` も alarm の対象にする）。利用者の再試行に頼らない。
- TaskDO
  - AgentDO のイベントを取り込む。`task_wait` の中で取り込んでから返すことと、alarm（10秒ごと、終端で停止が確認されるまで）で取り込むことの両方を行う。
  - 取り込みは冪等にする。`(operationId, agentSeq)` を一意にし、TaskDO の状態・自分の seq・イベント・取り込みカーソルを同じトランザクションで更新する。`task_wait` と alarm が同時に同じ範囲を取りに行っても重複しない。
  - `hasMore` が false になるまで取り込み、終端の phase のイベントを取り込んだときだけ終端に確定する。
  - alarm は at-least-once で発火するので、処理は冪等にし、次の alarm は明示的に設定し直す。
- `task_cancel` の流れは、上の「キャンセル（停止を確かめるまで収束させる）」のとおり。
- `task_result`（新設）
  - `{task_id}` を受け取り、`{status, summary, verification: {commands, results, verified}, warnings, patch | diffstat, usage}` を返す。
  - 終端でないタスクには `not_ready` を返す。
  - owner の確認は、ほかのツールと同じ。
- UserDO
  - 月額の費用上限を持つ（初期値は env で設定。既定 $100）。
  - タスク予算の予約、usage の冪等な精算、終了時の差額の返却を行う。
  - 予算と同時実行枠の返却は、最終精算と同じトランザクションの `finishTask` だけが行う。`reserve` 時の照合で回収できるのは、一度も作られなかった予約（abandoned）だけで、停止確認済みでも精算前のタスクは返さない。`finishTask` が届かないときは TaskDO の alarm が再送して収束する。
  - Phase 1 で作られた CREATING のタスク（`agent_link` が無いもの）は移行しない（本番データ無し）。照合では abandoned と同じ扱いで回収してよく、`task_status` などではそのまま表示する。
  - AgentDO の `cancel` が `{stopped:true, finalSeq}` を返したら、TaskDO は取り込みカーソルが `finalSeq` に達するまで取り込み、その後で `finishTask` する。`task_wait` の内部 RPC は入口で決めた期限（timeout 0 と終端は短い猶予のみ）を超えて待たず、保存済みのイベントで返す。

## テスト

- Unit（`apps/agent`）
  - SandboxDO は `SandboxPort` インターフェースの向こう側に置き、Unit では fake にする。コンテナ依存のコードが vitest で動くかは M1 で確かめる。
  - Pi のモデルは、台本付きの fake provider に差し替える（本物の Claude をテストで呼ばない）。差し替えられるかは M1 で確かめる。
  - ツールのパス正規化、出力上限、マスク、タイムアウト、予算超過時の abort、完了判定の再検証、自動修正の回数上限。
  - OutboundGateway の許可・拒否の判定（純粋関数として切り出す）。
- E2E
  - `wrangler dev`（Gateway と Agent の2つの設定）と Docker で、実際のコンテナを起動する。
  - fake のモデルの台本で「ファイルを編集してテストを通し、commit して完了を申告する」流れを通す。
  - 対象リポジトリは、テスト用に用意した純 JS の小さなもの（ローカルの偽 git サーバーか、偽 GitHub に git の smart HTTP を足したもの）。
  - 外向き通信: 許可されたホストに届くこと、許可されないホストや内部 IP に届かないこと。
  - Gateway の MCP 経由で、`task_start` → `task_wait` で `RUNNING` → `COMPLETED` のイベントが流れ、`task_result` で patch と検証結果が取れること。
  - 外向き通信の遮断: IPv4 / IPv6、private / link-local / メタデータのアドレス、別ポート、DNS、redirect、CONNECT、WebSocket、Host と TLS の不一致。コンテナを再起動した後も遮断されること。
  - 停止: bash の子孫プロセスが、タイムアウトとキャンセルで止まること。
  - 配送: start の応答が失われても alarm で収束すること。cancel が start より先に届いた場合。cancel の配送が失敗した後の再送。古いタスクが止まるまで次のタスクが始まらないこと。
  - 取り込み: 重複しないこと、ページの終端、終端イベントまで取り込んでから終端に確定すること。
  - 期限と usage が、再起動の後も引き継がれること。
  - 検証の失敗と、修正回数の上限。
  - 予算: 残りが次の呼び出しの見積もりより少なければ、呼ばずに `budget_exceeded` になること。
  - 許可したホストへの疎通（git / npm）が通るだけでは、セキュリティ要件を満たした証明にはならない。遮断の確認が M1 と E2E の必須項目である。
- 手動の受入試験（acceptance.md に追加）
  - AI Gateway の作成、Authenticated Gateway、BYOK の登録。
  - 本物の Claude で小さな実装タスクが完了すること。
  - AI Gateway のログに userId と taskId のメタデータが付くこと。

## M1 スパイク（この順で確かめる）

1. SandboxDO + `wrangler dev` + Docker で、allowlist が効くこと、許可されないホストや内部 IP が落ちること、`git clone` と `npm install` が通ること。
   - 落ちた場合は design.md 7.2 の「セキュリティ要件達成済みとみなさない」に当たるので、構成を見直す。
2. `@cloudflare/vitest-plugin` でコンテナ依存のコードが動くか。動かなければ、Unit は fake、E2E は wrangler dev + Docker だけ、とテストの方針を確定する。
3. pi-ai の `createModels()` に台本付きの fake provider を差し込めるか。
4. 複数設定の `wrangler dev` で、Gateway → Agent のスクリプトをまたぐ DO RPC がローカルで通るか。
   - known issue に「片方だけ起動していると本番の DO に書き込む」とあるので注意する。
   - 通らなければ、WorkerEntrypoint の service binding に切り替える。

## 前提・注意

- Docker が開発と CI の前提になる（`apps/agent` の E2E とデプロイ）。
- Containers は Workers Paid プランが必要。
- Pi と `durable_object` スケジューリングポリシー、Container snapshot は beta。

## Phase 2 でやらないこと

- push と Draft PR（Phase 3）
- 親への質問と追加指示（Phase 4）
- Web 調査（Phase 5）
- snapshot による高速な復旧、R2（Phase 6）
- 実環境へのデプロイ（ユーザーの指示があるまで行わない）

## M1 スパイクの結果（2026-10-18）

4項目のうち3つ（1・3・4）が成立した。2（vitest でコンテナを動かす）は成立しなかったため、テスト方針を確定した。

1. 外向き制御: 成立。
   - HTTP（80）は `interceptAllOutboundHttp`、HTTPS（443）は `interceptOutboundHttps("*")` で受ける。
   - 次のものは `enableInternet:false` で接続自体ができない: 他ポート、IPv6、HTTPS の裸 IP。
   - CONNECT は通らない（501）。
   - OutboundGateway が見るホストは Host ヘッダ由来で、判定と接続先に同じ値を使う。コンテナが選んだ宛先 IP は無視される。
   - 傍受はコンテナを起動するたびに登録し直す（`boot()`）。
   - DO だけが再起動してコンテナが生き残った場合に傍受が維持されるかは、未検証。
2. vitest-plugin 上では `ctx.container` が `undefined` になる。Unit は `SandboxPort` の fake、E2E は wrangler dev + Docker に確定。
3. 台本付きの fake provider（`src/pi/scripted-provider.ts`）で、PiHarness を DO 上で動かせる。台本は transcript 中の assistant メッセージ数で進めるので、DO が再起動しても続きから進む。
4. Gateway → Agent は、`script_name` 付きの DO バインディングで RPC できる（複数設定の `wrangler dev`）。Gateway の Unit では、vitest.config.ts で `AGENT_DO` を同じ Worker 内のクラスに差し替える。

実装上の注意:

- `proc.pid` はホスト側の pid なので、コンテナ内のプロセスグループには使えない。当初は `setsid` + pidfile + `kill -KILL -- -PGID` で止める案だったが、M2 レビューで破棄した（コンテナ内は root で動き、偽装できるため）。現在の方式は次のとおり。
  - 停止の保証は `container.destroy()` だけで行う（bash のタイムアウト、cancel / terminate、期限、予算、reaper の失敗）。
  - コンテナ内の reaper（`/proc` の走査。`/proc/<pid>/stat` は全体を読み、最後の `) ` より後ろを厳密に解析し、解析できないものは止める対象にする）は、正常に終わったコマンドの後の「ベストエフォートの片付け」として残す。
  - 詳細は末尾の「codex レビュー（M2、2026-10-18）を受けた決定」。
- イメージに procps が無い（`ps` / `pkill` が無い）。`npm install` には `--no-audit` を付ける（audit の POST が 403 になるため）。
- PiHarness の `EntryRecord` を RPC の戻り値に直接使うと TS2589 になる。DTO にする。
- Gateway の `/__spike/agent-ping` と AgentDO の `ping` は、M3 / M4 で削除済み。

## マイルストーン

- M2a（並行）: SandboxDO の本実装と、ツール群（`src/tools/`）。
  - SandboxDO: `ensureRunning`（clone / checkout / ブランチ作成）、`exec`（タイムアウト・リングバッファ・マスク）、ファイル操作、`stop`、期限、keepalive。
- M2b（並行）: AgentDO の本実装。
  - start / cancel / getEvents、phase、イベントの永続化、呼び出し前の予算判定、期限、検証、patch の保存。
  - ツールは、注入された factory から受け取る。
- M3: Gateway の統合と、通しの E2E。
  - start / cancel の配送の収束、イベントの取り込み、UserDO の月額予算、`task_result`、`verification_commands`。

## codex レビュー（M2、2026-10-18）を受けた決定

### 停止の保証はコンテナの破棄だけで行う

- コンテナ内の処理はすべて root で動き、信用できないコードと同じ権限を持つ。そのため、コンテナ内の reaper（`/proc` の走査）は偽装できる。
  - 偽装の例: `bash` を差し替える、`comm` に改行を入れてゾンビに見せかける。
- **停止を保証する必要がある場面では、必ず `container.destroy()` で止め、停止を確かめる。** 該当する場面は次のとおり。
  - bash のタイムアウト
  - cancel / terminate
  - 期限切れ
  - 予算超過
  - reaper の失敗
  - タイムアウトしたコマンドの未 commit の変更は失われる。モデルにはそう伝え、再 clone した作業ツリーで続けさせる。
- reaper は、正常に終わったコマンドの後に背景プロセスを片付ける「ベストエフォート」として残す。
  - `/proc/<pid>/stat` は最後の `) ` より後ろを厳密に解析する。解析できないものは「止める対象」として扱う（fail-closed）。
  - reaper の結果は保証として扱わない。正常に終わったコマンドの後に背景プロセスが偽装で生き残る可能性は、受け入れるリスクとする。生き残っても、コンテナの境界（資格情報なし、外向き通信は allowlist）の中にとどまり、終端では必ず破棄される。
- destroy の監視は、destroy の Promise を待つ前から期限を数え始める（destroy が返らない場合にも期限を効かせる）。

### 予算はハードキャップにする

- 入力トークン数の見積もりには、UTF-8 のバイト数を上限として使う。byte-level BPE では、1トークンは1バイト以上なので、トークン数がバイト数を超えることはない。
- 入力単価には、入力・キャッシュ書き込みのうち高い方と、価格帯の最大値を使う。出力は max_tokens 分を見積もる。
- 見積もりは過大になるので、早めに止まることがある。上限を超えないことを優先する。

### 終端の確定順序

- 停止の意図（cancel / deadline / budget）と、公開する終端の確定を分ける。
  - 停止の意図を記録したら、すぐに Sandbox の破棄と Pi の abort を始める（patch の取得より前に）。
  - モデルの停止を待って最終の usage を保存してから、終端を確定する。
- 終端を確定するトランザクションの中で、優先順位を判定する。順位は cancel > deadline > budget_exceeded > failed > completed。古い確定の指示をそのまま採用しない。
- 終端の後に usage が増えた場合は、単調増加の補正イベントとして記録し、Gateway は冪等に精算する。

### 検証の固定

- 保存済みの試行回数が上限（4回）に達していたら、実行する前に failed にする。
- 検証では、固定した SHA を checkout した状態で実行し、実行の前後で HEAD と作業ツリーが clean であることを確かめる。patch は base..検証済みの SHA で作る。
- `git status` などの終了コード・タイムアウト・切り詰めを確かめ、失敗は clean として扱わない。

## codex レビュー（M3、2026-10-18）と M4 での実装メモ

- cancel の契約: `cancel()` は `{stopped: boolean, finalSeq?: number}` を返す。`stopped: true` のときは、Sandbox の破棄とモデルの停止が確かめられ、最終の usage を含むすべてのイベントが永続化済みで、以後イベントは追加されない（`finalSeq` は最後のイベントの seq）。終端の後に呼ばれた cancel も同じ。モデルの停止と最終 usage の保存が済んでいなければ `stopped: false` を返し、Gateway が再送する。終端の後に補正の usage イベントを出す方式は採らない。
- 停止の意図（cancel / deadline / budget_exceeded）は `stop_intents` に記録し、記録した時点で Sandbox の破棄と Pi の abort を始める。公開する終端は、モデルの停止を待って最終 usage を保存してから、1 つのトランザクションの中で cancel > deadline > budget_exceeded > failed > completed の順に判定して確定する。停止の意図があるタスクでは Sandbox が既に破棄されているため、patch は保存しない。
- 検証: 固定した SHA を `git checkout --detach` した状態で実行し、前後で HEAD と追跡ファイルの変更の有無を確かめる（実行で生まれる未追跡の生成物は許す）。検証の後に作業ブランチを検証した SHA に戻し、patch は `base..検証済み SHA` で作る。
- 本番（`ENVIRONMENT` が test 以外）で `AI_GATEWAY_ID` が空なら、`start` は `rejected`（`ai_gateway_not_configured`）を返す。
