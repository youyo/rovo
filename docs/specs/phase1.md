# Phase 1 実装計画: Task Gateway / Remote MCP

設計書 `design.md` の Phase 1（12章）を具体化したもの。15章の決定事項と、codex レビュー（2026-10-18）の指摘を反映している。

## ゴール

Claude Code / Cowork から Remote MCP 経由でタスクを作成・状態確認・待機・キャンセルできる。

- ワーカーはまだ無い。`task_start` で作ったタスクは `CREATING` のまま止まる。
- Draft PR も作られない（`draft_pr_url: null`）。
- これらはツールの応答と README に明記する。

## 技術構成

- pnpm + TypeScript のモノレポ。Phase 1 は `apps/gateway`（Cloudflare Worker 1つ）だけを作る。
- `mise.toml` で node / pnpm を固定する。タスクは `test` / `test:unit` / `test:e2e` / `lint` / `fmt` / `build` / `dev`。
- ルーティングは **Hono**（ユーザー指定）。
- 認証は `@cloudflare/workers-oauth-provider`。
  - Worker 全体を `OAuthProvider` で包み、保護された `apiHandler` に Hono アプリを置く。
  - `defaultHandler` も Hono で書き、`/authorize`（同意画面）と `/callback` を扱う。
- MCP は Hono のルート上で動かす。
  - 第一候補は Cloudflare 公式 v2 の `createMcpHandler`（`agents/mcp/server`）+ `@modelcontextprotocol/server` を Hono に組み込む形。
    - スパイクでは、OAuthProvider → Hono → handler の経路で ExecutionContext とリクエスト単位の props を渡せることも確かめる。
  - 次点は `@hono/mcp` + `@modelcontextprotocol/sdk`。
  - **`McpAgent` は使わない**（deprecated / feature-frozen）。
  - 採用前に、最小構成で疎通確認するスパイクを行う。
- 認証情報（props）はリクエスト単位で扱う。共有の McpServer インスタンスやモジュール変数にユーザー情報を保存しない。

## 認証・認可

### ログイン（GitHub App のユーザー認可）

- 上流の認証は **GitHub App のユーザー認可（user-to-server トークン）** を使う。OAuth App は使わない。
  - 理由: このトークンで利用者の push 権限と App の Installation の両方を確かめられ、OAuth App の `repo` scope のような強い権限が不要になる。
  - 注意: user-to-server トークンでも公開リポジトリは読めてしまう。そのため `GET /repos/...` が 200 を返しても、Installation の証明にはならない。
  - GitHub App 側には org の Members: Read 権限を付け、org の active メンバー（`ALLOWED_ORG` だけのとき）または team 所属（`ALLOWED_TEAM` も設定したとき）の確認に使う。（#124、2026-10-27 で、当初の「org と team の対」から org だけの許可にも対応）
- callback では次を行う。
  1. state を検証する（不一致や再利用は拒否）。
  2. code をトークンに交換する。
  3. `GET /user` で id と login を得る。
  4. 指定 org・指定 team への所属を `GET /orgs/{org}/teams/{team_slug}/memberships/{username}` で確かめる。`state == "active"` だけを許可する。（#124、2026-10-27 で追記: `ALLOWED_TEAM` を設定しないときは、`GET /user/memberships/orgs/{org}` で org の active メンバーかを確かめる。）
- props には `githubUserId` と `login` だけを入れる。
  - GitHub のトークンは UserDO に保存する（後述）。
  - トークンはログに出さない。
- GitHub のユーザートークンの期限は、App の設定とトークン応答の `expires_in` に従って保存する（8時間と決め打ちしない）。
- **GitHub トークンのリフレッシュは Phase 1 で実装する。**
  - 資格情報の正本は UserDO に置く。props には置かない。
    - UserDO が持つもの: access token、refresh token、それぞれの期限、version。
    - 理由: GitHub のリフレッシュはトークンを入れ替える。旧 access token と旧 refresh token はその時点で無効になる。MCP の grant ごとに props へコピーすると、古いコピーが残ってしまう。
    - 同じユーザーの MCP grant が複数あっても、UserDO の1つの資格を共有する。
  - 保存時は、Worker Secret の鍵（`TOKEN_ENC_KEY`）を使い AES-GCM で暗号化する。
  - アクセス時の流れ
    - UserDO の `getGitHubToken()` を呼ぶ。期限切れ、または期限まで残り5分未満なら、UserDO 内でリフレッシュしてから返す。
    - DO は処理を直列化するので、リフレッシュは自然に single-flight になる。ただし fetch の await 中に入ってきた別の呼び出しは、進行中の Promise を共有させる。二重にリフレッシュさせない。
    - GitHub API が 401 を返したら、1回だけ強制リフレッシュして再試行する。
  - 失敗時の扱い
    - リフレッシュが `bad_refresh_token` などで失敗した場合（refresh token の期限切れ・失効）は、資格を消して `reauth_required` を返す。
    - GitHub が 5xx の場合は、資格を残したまま `upstream_unavailable` を返す。
  - 再ログイン（新しい GitHub 認可）で得た資格は、UserDO の資格を上書きする（新しいものが勝つ）。
  - MCP トークンの期限と GitHub 資格の期限は別物として扱う。MCP トークンが有効でも、GitHub 資格を回復できなければ `reauth_required` になる。
  - 期限は、トークン応答の `expires_in` / `refresh_token_expires_in` から計算する。期限切れにならないトークン（App の設定で期限を無効にした場合）にも対応する。
- org / team 所属の再検証
  - ログイン時だけでなく、全ツールの呼び出しで確かめる。
  - 結果は UserDO に短時間（TTL 5分）キャッシュする。org / team から外れてから使えなくなるまでの遅れは最大5分。キャッシュは org/team の設定の指紋で区別し、設定を変えると古い結果は使わない（#124）。
  - GitHub API の障害時は拒否する（fail-closed）。
  - 401 は `reauth_required`、403 / 404 は `forbidden`、429 / 5xx は `upstream_unavailable` に分けて返す。
  - team API はワーカー team への所属も含めて判定するので、ワーカー team のメンバーも許可される（仕様として明記する）。
- **同意画面（confused deputy 対策）**
  - DCR が有効なため、悪意あるクライアントが `/authorize` を開始し、GitHub 側が自動承認すると、利用者の MCP アクセストークンが攻撃者の `redirect_uri` に渡りうる。これを防ぐため、`/authorize` は GitHub へ行く前に必ず同意画面を表示する。
  - 流れ（`@cloudflare/workers-oauth-provider` 1.2.3 の `parseAuthRequest` → `describeConsent` → `beginConsent` → `approveConsent` / `denyConsent` → `beginUpstream`）
    1. `GET /authorize`: request を検証し、同意画面（HTML）を返す。この時点では state を発行せず、GitHub にも行かない。
    2. `POST /authorize`（フォーム: `handle`, `decision`）
       - `decision=approve` だけを承認として扱う。それ以外の値はすべて拒否。
       - 承認: `approveConsent` で同意を消費し、その request で `beginUpstream` を呼んで GitHub へ redirect する。
       - 拒否: `denyConsent` が返す、client の `redirect_uri` への `error=access_denied`（state・iss 付き）へ redirect する。redirect 先は保存済みの request から作られ、フォームの値は使わない。
  - 表示内容: クライアント名（DCR の `client_name`。無ければ `client_id`。自己申告で未検証である旨も表示）、`redirect_uri` のホスト（目立たせる）とフル URI、要求 scope、「このアプリにあなたの rovo タスクの作成・操作を許可しますか」。loopback 宛ては警告を出す。client 由来の文字列は全てエスケープする。
  - CSRF 対策: フォームの `handle` はワンタイムの値（10 分・1 回限り）で、`__Host-oauth-consent-*` Cookie（Secure・HttpOnly・SameSite=Lax）と突き合わせる。Cookie が無い・別のブラウザ・別の画面の Cookie・でたらめな handle・使用済み・期限切れの POST は 400 で拒否し、GitHub へは行かない。承認時の scope はフォームから受け取らない（client が要求した範囲のまま）。
  - ヘッダ: `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'`、`X-Frame-Options: DENY`、`Cache-Control: no-store`、`Referrer-Policy: no-referrer`、`X-Content-Type-Options: nosniff`。
    - CSP に `form-action 'self'` は付けない。Chrome は `form-action` を POST 後の redirect 先にも適用するため、承認後の GitHub への redirect と、拒否時の client の `redirect_uri` への redirect が壊れる。フォームの送信先は相対パス固定で、`base-uri 'none'` により `<base>` での差し替えも封じている。
  - 承認の記憶（`approveConsent` の `remember`）は Phase 1 では使わない。毎回、同意画面を出す。
- state は期限付き（10分）にし、開始したブラウザとの紐付けは `__Host-` Cookie で行う。
  - 実装には workers-oauth-provider の `beginUpstream` / `finishUpstream` を使う。
  - 逐次の再使用は拒否される。ただし KV の get と delete は原子的でないため、同じブラウザから同じ state で並行して callback すると、両方が通る可能性がある。
  - その場合でも GitHub の認可コードは1回しか交換できないので、二重の grant にはならないと判断し、許容する。
- 設定値（env）: `GITHUB_APP_CLIENT_ID`、`GITHUB_APP_CLIENT_SECRET`（secret）、`ALLOWED_ORG`、`ALLOWED_TEAM`（任意。無ければ org の全員を許可。team だけは不正）。
- GitHub の URL（`GITHUB_OAUTH_BASE` / `GITHUB_API_BASE`）は E2E でだけ差し替えられるようにする。
  - 本番では既定値（`https://github.com` / `https://api.github.com`）以外を拒否する。たとえば `ENVIRONMENT=test` のときだけ上書きを許す。

### ツールごとの認可

- 4つのツールすべてで owner を確認する。`task_wait` も例外にしない。
  - タスクの `ownerId`（GitHub user id）とリクエストの props の user id を照合する。
  - 一致しなければ、存在を隠すために `not_found` と同じエラーを返す。
- `task_start` では毎回、利用者のトークンで次を確かめる。
  1. `GET /user/installations` で、この App の Installation を列挙する。
  2. 各 Installation について `GET /user/installations/{installation_id}/repositories` をページ送りしながら走査し、対象リポジトリ（repository ID で照合）が含まれるかを確かめる。
     - 応答に含まれる `permissions.push === true` も確かめる。
  3. 見つからなければ `forbidden`。メッセージは「App が未導入、選択対象外、または権限がない」として区別しない。
  4. 見つかった repository ID と installation ID は TaskDO に保存する。

## Durable Objects

### TaskDO（タスクごと、SQLite バックエンド）

- テーブル
  - `task`（1行）: id, owner_id, owner_login, repository, base_ref, base_sha, title, instructions, acceptance_criteria(JSON), constraints(JSON), status, draft_pr_url, created_at, updated_at
  - `events`: seq（INTEGER、1から連番）, type, payload(JSON), created_at
- **状態変更・seq の採番・イベントの挿入は同じトランザクションで行う**（`ctx.storage.transactionSync` など）。
- 冪等な作成 `ensureCreated(input)`
  - 未作成なら作り、`created` イベントを追加する。
  - 作成済みで入力が同じなら、既存の内容を返す。
  - 作成済みで入力が異なれば `conflict` を返す。
  - tombstone 済みなら `expired` を返す（後述）。
- tombstone `abandonIfUncreated()`
  - 未作成なら、取り消せない tombstone を記録して `abandoned` を返す。
  - 作成済みなら何もせず、現在の状態を返す。
  - 作成と tombstone は、同じ TaskDO の中で直列化されている。
- **TaskDO は UserDO を呼ばない。** DO 間の呼び出しは「Gateway → UserDO」「Gateway → TaskDO」「UserDO → TaskDO（照合のみ）」に限り、循環させない。

### 状態遷移（Phase 1 で公開するもの）

| from | to | きっかけ |
|---|---|---|
| (なし) | CREATING | task_start |
| CREATING | CANCELLED | task_cancel |
| RUNNING / INPUT_REQUIRED / VERIFYING / RECOVERING | CANCELLED | task_cancel（Phase 2 以降で到達する） |

- 終端状態は `COMPLETED` / `FAILED` / `BUDGET_EXCEEDED` / `CANCELLED`。終端からはどこへも遷移しない。
- 終端状態への `task_cancel` は冪等に成功し、現在の状態を返す。イベントは追加しない。
- 遷移表は純粋関数（`canTransition(from, to)`）として実装し、Unit テストで網羅する。
- Phase 2 以降の遷移（CREATING→RUNNING など）も表には定義しておく。ただし Phase 1 の公開 API からは使わない。

### イベントとカーソル

- cursor は不透明な文字列として返す。中身は `"<seq>"` でよいが、クライアントは解釈しない前提にする。
- `task_wait(cursor?)` は `seq > cursor` のイベントを、最大 N 件（例: 100）返す。
  - cursor が省略されたら先頭から返す。
  - 返り値の `cursor` は、返した最後のイベントの seq。イベントが無ければ入力の cursor をそのまま返す。
  - 不正な cursor は `invalid_cursor` エラーにする。
    - 不正とは、10進の非負の整数でないもの（負数、小数、安全整数の範囲を超えるもの）と、未来の cursor（最新の seq より大きいもの）。
  - `timeout_seconds` は 0 以上の整数とする。負数と小数は `invalid_input` にする。
- 待機（bounded long polling）
  - イベントがあれば即座に返す。
  - 無ければ最大 `timeout_seconds` 待つ。既定は 30 秒、上限は 60 秒にクランプする。
  - 待機者は DO 内で Promise として保持する。複数の待機者がそれぞれのカーソルで独立に起きるようにし、通知を一人が消費して終わる形にしない。
  - 取りこぼしを防ぐため、「待機者を登録してから再読する」順にする。
  - タイムアウトしたときは、待機者を片付ける。
    - DO の RPC では、呼び出し側の切断を検知できない。そのため切断しても待機者はすぐには消えず、タイマー（最大60秒）で必ず解放される。
    - つまり切断した待機者は、同時待機の枠を最大60秒占有する。
  - DO ごとの同時待機数に上限を設ける（例: 16）。超えたら即座に空の結果を返す。
    - その応答には `retry_after_seconds` を含め、クライアントが連打しないようにする。
  - 待機全体を `blockConcurrencyWhile` で包まない（cancel などを妨げるため）。
  - 終端状態のタスクで新しいイベントが無ければ、待たずに即座に返す。
  - デプロイや再起動で待機は失われるが、イベントは永続化されている。クライアントは同じ cursor で再試行すればよい、という約束にする。

### UserDO（ユーザーごと）

- 同時実行は1件まで（15.4）。月額予算は Phase 2 で入れる（Phase 1 では枠だけ用意する）。
- テーブル
  - `requests`: request_key, task_id, fingerprint(入力のハッシュ), created_at
    - 保存期間は 7日。
  - `reservation`（1行）: active_task_id or NULL, reserved_at, version
  - `membership_cache`: checked_at, result
  - `github_credential`（1行）: 暗号化した access_token / refresh_token, access_expires_at, refresh_expires_at, version, updated_at
- `idempotency_key` の扱い
  - 1〜128文字の `[A-Za-z0-9_-]` とする。
  - 省略された場合は、再試行の重複排除を保証しない（ツールの説明に明記する）。
  - fingerprint は、repository / base_ref / base_sha / title / instructions / acceptance_criteria / constraints を、決まった順に並べた JSON の SHA-256 とする。
- `task_start` の流れ
  1. Gateway が `request_key` を決める。クライアントが渡す `idempotency_key` があればそれを使い、無ければサーバーで生成する。
  2. UserDO `reserve(request_key, fingerprint)` を呼ぶ。
     - 同じキーで fingerprint も同じなら、既存の task_id を返す（再試行）。
     - 同じキーで fingerprint が異なれば `conflict`。
     - 実行中の予約が別のタスクにあれば `concurrency_limit`。
     - どれでもなければ新しい task_id（ULID）を発行し、`requests` と `reservation` に記録して返す。
  3. TaskDO(task_id) の `ensureCreated(input)` を呼ぶ。冪等なので再試行してよい。
  4. 3 が失敗しても予約は**すぐには解放しない**（成否が分からないため）。クライアントは同じ `idempotency_key` で再試行できる。
- 予約の照合
  - `reserve` のとき、既存の予約先 TaskDO の状態を確かめる。
    - 終端状態なら、予約を解放してから続ける。
    - 予約から一定時間（10分）経っても未作成なら、TaskDO の `abandonIfUncreated()` を呼ぶ。`abandoned` が返ったときだけ解放する。作成済みが返れば解放しない。
    - 10分は安全性の根拠ではなく、回収を始めるまでの運用値。安全性は tombstone が保証する。古いキーでの再試行や、遅れて届いた `ensureCreated` は `expired` で拒否される。
    - 古いキーは tombstone 済みの task_id に固定されたままになる。新しく始めるには新しいキーが必要。
  - 照合（TaskDO の呼び出し）は UserDO のトランザクションの外で行う。結果を反映するときに、予約の task_id と version が変わっていないかを確かめ直す。外部呼び出しを待っている間に、別の reserve や release が進んでいる可能性があるため。
- `task_cancel` の流れ
  1. TaskDO を先に `CANCELLED` に確定させる。
  2. UserDO `release(task_id)` を呼ぶ。予約先が同じ task_id のときだけ解放する（compare-and-clear）。
  3. 2 が失敗した場合
     - 同じ `task_cancel` を再試行すれば、1 は冪等に成功し、2 の解放も再試行される。
     - 再試行されなくても、次の `reserve` 時の照合で回収される。

## MCP ツール（Phase 1）

| Tool | 入力 | 出力 |
|---|---|---|
| `task_start` | design.md 4.3 の入力 + 任意で `idempotency_key` | `{task_id, status, draft_pr_url: null, note}` |
| `task_status` | `{task_id}` | `{task_id, status, repository, title, draft_pr_url, created_at, updated_at, latest_cursor}` |
| `task_wait` | `{task_id, cursor?, timeout_seconds?}` | `{task_id, status, cursor, events[]}` |
| `task_cancel` | `{task_id}` | `{task_id, status}` |

- 入力は zod で検証する。repository は `owner/name` 形式、base_sha は 7〜40桁の16進。
- エラーは MCP のツールエラー（`isError: true`）として、`code` を含む JSON で返す。
  - `code` は `not_found` / `conflict` / `expired` / `concurrency_limit` / `invalid_cursor` / `forbidden` / `reauth_required` / `upstream_unavailable` / `invalid_input` / `internal` のいずれか。
  - `internal` は想定外の例外に使い、メッセージは固定にする。スタックやトークンは含めない。
  - SDK の入力スキーマに合わない入力（必須項目の欠落・型の不正）も `invalid_input` として返す。
- `task_answer` / `task_steer` / `task_result` は Phase 4 以降で追加する。

## テスト

### Unit（vitest + `@cloudflare/vitest-pool-workers`）

- 状態遷移表（全組み合わせ）
- TaskDO
  - 冪等な作成（同じ入力・異なる入力）
  - イベントの seq 採番
  - wait（即座に返る場合、タイムアウト、待機中にイベントが追加されて起きる場合、複数の待機者、不正・未来の cursor、終端状態、同時待機数の上限）
  - 再起動後にイベントを再読できること
- UserDO
  - reserve（新規、再試行、競合、同時実行の制限、同時の reserve）
  - release の compare-and-clear
  - 照合による回収（終端状態、未作成で10分経過した場合）
  - 回収後に古いキーで再試行すると expired
  - 遅れて届いた ensureCreated が expired
  - 照合中に release や別の reserve が進んでも、version の確認で不整合にならない
  - RPC は成功したが応答が失われた場合の再試行
  - cancel の後に release が失敗しても、cancel の再試行で解放される
- 認可
  - owner の不一致は not_found
  - 公開リポジトリだが App が未導入、導入済みだが選択対象外、push 権限がない、のいずれも forbidden
  - GitHub が 401 なら reauth_required、403 なら forbidden、429 / 5xx なら upstream_unavailable
  - team に所属していない、または `state=pending` なら拒否（`ALLOWED_ORG` だけのときは、org の active メンバーでない、または `state=pending` なら拒否。#124）
  - ログイン後に team から外された場合、TTL が切れた後の呼び出しで拒否される
  - GitHub 資格の期限切れ
    - refresh token が有効なら、自動でリフレッシュして成功する
    - refresh token も無効なら reauth_required
  - リフレッシュで入れ替わった後の旧トークンが使われない
  - 同時に呼び出してもリフレッシュは1回だけ（single-flight）
  - 401 を受けたら1回だけ強制リフレッシュして再試行する
  - 再ログインで資格が上書きされる
  - 保存されている資格が暗号化されている（平文が DO に無い）
- 入力検証
  - cursor が負数・小数・安全整数を超える値・未来の値
  - timeout が負数・小数
  - idempotency_key の長さと文字種

#### 同意画面（Unit）

- `GET /authorize` が同意画面を返し、承認前に `beginUpstream` を呼ばない・GitHub へ redirect しない
- client 名・redirect_uri のホストとフル URI・scope が表示され、client 由来の文字列がエスケープされる
- CSP / `X-Frame-Options: DENY` / `no-store` が付く
- 承認で GitHub へ redirect、拒否で `access_denied`、`approve` 以外の `decision` は拒否扱い
- handle の欠落・重複、form 以外の Content-Type は 400
- 実際の OAuthProvider で、Cookie 無し・別画面の Cookie・でたらめな handle・使用済み handle の POST が 400

### E2E

- `wrangler dev` で実際の Worker を起動する。偽の GitHub サーバー（Node の小さな HTTP サーバー）も起動し、`ENVIRONMENT=test` で `GITHUB_*_BASE` をそこへ向ける。
- OAuth のフローは本物を通す。OAuthProvider の DCR → `/authorize`（同意画面の承認 POST）→ 偽 GitHub → `/callback` → トークン交換（PKCE）。
- MCP SDK の Client（Streamable HTTP）で4つのツールを呼ぶ。
  - start → status → wait（タイムアウト）→ cancel → wait（cancelled イベントが即座に返る）
  - 同じ idempotency_key での再試行で、同じ task_id が返る
  - 同時実行の制限
  - 別ユーザーからの操作が not_found になる
  - 同意画面が出て、承認するまで偽 GitHub に何も届かない。拒否で `access_denied`。Cookie 無し・handle 不一致・再使用の承認 POST は拒否される
  - team に所属していないユーザーはログインできない
  - state の不一致・再使用は拒否される
  - 公開リポジトリだが App が未導入なら、task_start は forbidden
  - 偽 GitHub でアクセストークンを期限切れにすると、自動でリフレッシュされてツール呼び出しが成功する
  - 偽 GitHub で refresh token を失効させると reauth_required
- 偽 GitHub サーバーはテストからユーザー・team・権限を設定できるようにする。

### 受入試験（手動。自動化できないため記録だけ残す）

- MCP Server Portal 経由で、Claude Code と Cowork の両方からタスクの作成と状態確認ができること。
- バックグラウンドでの `task_wait` の挙動。
- Portal 経由で 30〜60秒の待機がタイムアウトせずに通るか（実測して既定値を決める）。

これらは実環境（Cloudflare アカウント、GitHub App、Portal）が必要なので、Phase 1 のコードが完成した後にユーザーと一緒に行う。結果は `docs/specs/acceptance.md` に記録する。

## Phase 1 でやらないこと

- ワーカー、Sandbox、Draft PR 作成、Token Broker、Web Research、予算の本実装、R2
- Portal / Access の設定（IaC のリポジトリの Terraform で管理し、別途登録する）
- 実 Cloudflare 環境へのデプロイ（ユーザーの指示があるまで行わない）
