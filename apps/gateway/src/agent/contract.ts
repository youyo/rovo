/**
 * Gateway から見た AgentDO（apps/agent）の RPC 契約。
 * apps/agent から import しない（Worker 間でビルド依存を作らない）ので、同等の型をここに持つ。
 * 乖離は gateway の test/contract/agent-contract.ts（DTO の型）と、apps/agent の test/contract/gateway-contract.ts
 * （AgentDO の実際のメソッドの型との比較）が検出する（どちらも typecheck で検査）。
 */

import type {
  Effort,
  SandboxInstance,
  SandboxPromotionReason,
  SandboxPromotionTrigger,
} from "@rovo/models";

export type AgentPhase =
  | "starting"
  | "running"
  | "input_required"
  | "verifying"
  | "completed"
  | "failed"
  | "budget_exceeded"
  | "cancelled";

export interface VerificationCommand {
  argv: string[];
  /** リポジトリのルートからの相対パス */
  cwd?: string;
  timeoutSeconds?: number;
}

export interface TaskSpec {
  taskId: string;
  userId: string;
  repository: string;
  baseSha: string;
  instructions: string;
  acceptanceCriteria?: string[];
  verificationCommands?: VerificationCommand[];
  constraints?: string[];
  /** ワーカーのモデル（D10。"anthropic/claude-haiku-5-5" など）。省略は AgentDO の env の AGENT_MODEL */
  model?: string;
  /**
   * ワーカーのモデルの思考レベル（task_start の effort。そのモデルが受け付けるレベルだけを TaskDO が通している）。**ある = 利用者がこのタスクで指定した**
   * ので、モデルごとの既定（AgentDO の env の MODEL_EFFORTS）より優先する。off なら AgentDO は reasoning を渡さない。
   * 省略したときはこの項目自体を付けない（AgentDO が従来どおり MODEL_EFFORTS から決める。spec の同一性も変えない）。
   */
  effort?: Effort;
  /**
   * ワーカーの Sandbox の大きさ（task_start の sandbox_instance。standard-1〜4）。**ある = 利用者が明示した**ので、そのタスクの間はずっとその大きさ
   * （後段の自動の昇格もしない）。省略は agent の env の既定（SANDBOX_INSTANCE）で、省略したときはこの項目自体を付けない（spec の同一性を変えない）。
   */
  sandboxInstance?: string;
  budgetUsd: number;
  /**
   * 予算に近づいたときの扱い（task_start の budget_policy）。ask: 止めずにクライアントへ「あと budgetUsd 使って続けるか」を聞く
   * （延長は 1 タスク 2 回まで。承認の予約は TaskDO が月の枠から行う）/ stop: 今までどおり budget_exceeded で止まる。
   * AgentDO は無ければ stop として扱う。
   */
  budgetPolicy?: "ask" | "stop";
  deadlineAt: number;
  /** 作業ブランチ名（agent/task-<id>）。TaskDO が AgentDO.start より前に作っている */
  branch: string;
  /** 決定的な初期コミットの SHA（作業ブランチの出発点。空コミット） */
  initialSha: string;
  /** Installation Access Token と期限（epoch ms）。ログに出さない */
  gitCredential: GitCredential;
  /**
   * 依存関係のキャッシュ（D14）の指定。base_sha 時点のルート直下の lockfile から gateway が作る。
   * lockfile が無い・読めなかった（GitHub の API の失敗を含む）ときは null（キャッシュなし）。
   */
  deps?: DepsDto | null;
  /**
   * ワーカーの commit の作者（GitHub App の bot）。TaskDO が初期コミットと同じものを渡す。
   * 引けなかったときは `rovo <rovo@noreply.invalid>`（GitHub のアカウントに結び付かない）。
   */
  commitAuthor?: { name: string; email: string };
  /**
   * タスクの種類。省略は通常のタスク（ワーカーの LLM が作業する）。"review" は task_review（docs/specs/worker-review.md）:
   * ワーカーは動かさず、review の PR の head で review_commands を流し、レビューのモデルを 1 回呼んで、投稿する本文を結果に返す。
   * review のとき branch は空（作業ブランチを持たない = push の経路が無い）、initialSha は review.headSha。
   */
  kind?: "review";
  /** kind が "review" のときだけ（必須）。TaskDO が PR を読んで作る */
  review?: ReviewSpec;
  /**
   * worker_review（task_start の review_policy: "worker_review"。docs/specs/worker-review.md）のときだけ付く（通常のタスクの kind は省略のまま）。
   * ワーカーの report_completion で verification_commands が通ったあと、完了にする前に、同じ固定 SHA で commands を流し、model でレビューして
   * 結果の review に本文を残す。省略 = client_review（レビューの段は動かない）。
   */
  workerReview?: WorkerReviewSpec;
}

/** worker_review の指定（TaskDO が task_start の入力から作る） */
export interface WorkerReviewSpec {
  /** レビューを書くモデル（AGENT_MODELS の中だけ。作業の model とは独立） */
  model: string;
  /** 全体のテスト。失敗しても止めずに全部流す。空なら差分と読み取りの道具だけのレビュー */
  commands: VerificationCommand[];
  /**
   * レビューのあとに直す回数の上限。0 はコメントだけ、1 は must_fix があればワーカーが 1 回直す（修正の回）。
   * 2 以上は受け付けない（修正のあとに 2 回目のレビューはしない）
   */
  fixRounds: 0 | 1;
}

/** task_review のレビューの段の指定。値はすべて TaskDO が GitHub から読んだもの（PR の本文・差分は非信頼データ） */
export interface ReviewSpec {
  /** base リポジトリの PR の番号（refs/pull/<n>/head を取り出す） */
  pullNumber: number;
  /** レビューする head の SHA（task_review を受けた時点で固定） */
  headSha: string;
  /** PR の base の SHA */
  baseSha: string;
  /** レビューを書くモデル（AGENT_MODELS の中だけ） */
  model: string;
  /** 全体のテスト。失敗しても止めずに全部流す。空なら差分だけのレビュー */
  commands: VerificationCommand[];
  title: string;
  body: string;
  /** base...head の unified diff */
  diff: string;
  /** gateway が取得の段階で差分を上限で切った */
  diffTruncated: boolean;
}

/** review_commands の 1 本の結果。output は伏せ字・切り詰め済み */
export interface ReviewCommandResultDto {
  argv: string[];
  exitCode: number;
  timedOut: boolean;
  output: string;
  durationMs?: number;
  /** 段の時間の上限で実行しなかった */
  skipped?: boolean;
}

/** レビューに使った費用（作業の費用と分けて見せる）。estimated は実費が分からず見積額で数えた */
export interface ReviewUsageDto {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estimated: boolean;
}

/** レビューの段の結果（ResultDto の review）。body は投稿する本文（検査済みの JSON から組み立て、伏せ字済み） */
export interface ReviewResultDto {
  /** done: レビューが得られた / skipped: 予算・失敗で飛ばした */
  stage: "done" | "skipped";
  model: string;
  headSha: string;
  body?: string;
  mustFixCount: number;
  suggestionCount: number;
  commands: ReviewCommandResultDto[];
  commandsUnavailable: boolean;
  /** 飛ばした理由の固定コード（model_error / model_rejected / timeout / budget / invalid_response / tool_rounds_exceeded） */
  failure?: string;
  usage: ReviewUsageDto;
  /** worker_review の修正の回に入った（must_fix をワーカーに渡した）。直したかどうかは fixApplied */
  fixRequested?: boolean;
  /** 修正の回で直した commit の SHA（修正の commit が無かった・修正の回に入らなかったときは無い） */
  fixApplied?: string;
  /** 修正のあとの再実行の結果（修正しなかったときは無い） */
  final?: ReviewFinalDto;
}

/** worker_review の修正のあとの再実行の結果（ReviewResultDto の final） */
export interface ReviewFinalDto {
  /** 修正の commit で verification_commands が通った（通らなければ完了にならないので、ここに来るときは常に true） */
  verificationCommandsPassed: boolean;
  /** 修正の commit で review_commands が全部通った（空なら true） */
  reviewCommandsPassed: boolean;
  /** 再実行した review_commands の結果（出力は伏せ字・切り詰め済み） */
  commands: ReviewCommandResultDto[];
  /** Sandbox を用意できず、review_commands を流せなかった */
  commandsUnavailable: boolean;
}

/** ルート直下の lockfile から作る、依存関係のキャッシュの指定（agent の DepsSpec と同じ形） */
export interface DepsDto {
  /** GitHub のリポジトリの数値 ID */
  repositoryId: number;
  /** pnpm-lock.yaml / package-lock.json / yarn.lock のいずれか（ルート直下だけ） */
  lockfilePath: string;
  /** base_sha 時点の lockfile の blob SHA */
  blobSha: string;
  /** "pnpm install --frozen-lockfile" / "npm ci" / "yarn install --frozen-lockfile" */
  installCommand: string;
  /** base_sha 時点のルートの package.json の blob SHA */
  packageJsonSha: string;
  /** ルートの pnpm-workspace.yaml の blob SHA（無ければ null） */
  workspaceSha: string | null;
  /** 入れ子の package.json の「パスと blob SHA の一覧」の sha256（無ければ null） */
  manifestsSha: string | null;
}

export interface GitCredential {
  token: string;
  /** epoch ms */
  expiresAt: number;
}

export type StartResult =
  | { status: "accepted"; phase: AgentPhase; alreadyAccepted: boolean }
  | { status: "conflict" }
  | { status: "cancelled" }
  | { status: "rejected"; reason: string };

export interface CancelResult {
  stopped: boolean;
  /**
   * stopped が true のときだけ付く。最後のイベントの seq。
   * stopped:true を返した時点で、最終 usage を含むすべてのイベントが永続化済みで、以後イベントは追加されない。
   * Gateway は取り込みカーソルがこの seq に達するまで取り込んでから終了処理（finishTask）に進む。
   */
  finalSeq?: number;
}

export interface UsageDto {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** ワーカーが使った web の回数（タスクごとの累計。Phase 5）。web 自体の費用は costUsd に含めない */
  web: WebUsageDto;
  /** AI Gateway に送ったモデル呼び出しの累計回数（費用の確定でログの件数と照合する）。古い agent・0 回なら無い */
  modelCalls?: number;
  /**
   * Sandbox のカウンタ（Phase 6 M2。agent が読めたときだけ付く）。公開用の形への写しは M3（agent-events.ts）。
   * runtimeMs: コンテナを動かした累計 ms / restarts: コンテナの作り直しの回数 / bootRetries: 起動の確認点で止まった・破棄された試行の回数
   * depsCache / cacheBuildMs: 依存関係のキャッシュ（D14）の結果と、作ったときの所要時間
   */
  sandbox?: SandboxUsageDto;
}

export interface SandboxUsageDto {
  runtimeMs: number;
  restarts: number;
  bootRetries: number;
  /** 依存関係のキャッシュ（D14）の結果。起動を試みていなければ無い */
  depsCache?: "hit" | "miss" | "built" | "disabled";
  /** depsCache が "miss" のときだけ: 使えなかった理由の固定コード（ログの deps_cache_miss: <reason> と同じ。build_failed / cooldown など） */
  depsMissReason?:
    | "ensure_failed"
    | "ensure_timeout"
    | "build_failed"
    | "build_timeout"
    | "cooldown"
    | "snapshot_unsupported"
    | "snapshot_failed"
    | "restore_failed"
    | "cert_missing"
    | "move_failed"
    | "invalid_deps";
  /** キャッシュを作ったタスクだけ: 作るのにかかった時間（ms。runtimeMs にも含む） */
  cacheBuildMs?: number;
  /** 最初にコンテナを起動した大きさ（standard-2 など）。一度も起動していなければ無い（Sandbox が必要になるまで起動しない）。昇格しても変わらない */
  instance?: string;
  /** 昇格した最終の大きさ（Clef が上げると判断した先）。昇格していなければ無い */
  promotedTo?: string;
  /** 最初の昇格の時刻（epoch ms） */
  promotedAt?: number;
  /** 最初の昇格までの Sandbox の累計時間（ms）。区間ごとの時間は promotions の runtimeMsBefore から導く */
  runtimeMsBeforePromotion?: number;
  /** 昇格を見送った・失敗した理由の固定コード（packages/models の SANDBOX_PROMOTION_REASONS）。最後に残したもの。設定で無効のときは無い */
  promotionReason?: SandboxPromotionReason;
  /** 成功した昇格だけの履歴（古い順）。trigger は clef（古い agent は agent / rule / verification） */
  promotions?: {
    to: SandboxInstance;
    at: number;
    trigger: SandboxPromotionTrigger;
    runtimeMsBefore: number;
  }[];
  /** Clef の判断の集計。Clef を呼んだタスクだけ。agent は終端の確定のときだけ付ける */
  scaleStats?: {
    decisions: number;
    raised: number;
    clefFailures: number;
    slowNotRaised: number;
    /** 明らかに軽いコマンドで Clef を呼ばなかった回数 */
    skippedLight: number;
  };
  /** Clef の判断ごとの記録（古い順、直近 50 件まで）。agent は終端の確定のときだけ付ける。コマンドは argv[0] の basename だけ */
  scaleDecisions?: {
    at: number;
    from: SandboxInstance;
    to: SandboxInstance | null;
    heavy?: number;
    fast4?: number;
    choice?: number[];
    model?: "flash" | "clef";
    failed?: true;
    clefMs: number;
    cmdMs?: number;
    exitCode?: number;
    cmd: string;
  }[];
  /** 昇格の試みが見送り・失敗になった記録（固定の trigger と理由コード。古い順、最大 8 件）。Clef の失敗（判断できなかった）は入らない（scaleStats.clefFailures） */
  promotionFailures?: { trigger: SandboxPromotionTrigger; reason: SandboxPromotionReason }[];
}

export interface WebUsageDto {
  search: number;
  fetch: number;
  browse: number;
}

export interface AgentEventDto {
  seq: number;
  ts: number;
  type: string;
  /** JSON 文字列 */
  data: string;
}

export interface EventsPage {
  events: AgentEventDto[];
  throughSeq: number;
  hasMore: boolean;
  phase: AgentPhase | undefined;
  phaseAsOfSeq: number;
  usage: UsageDto;
}

export interface VerificationCommandResult {
  argv: string[];
  exitCode: number;
  timedOut: boolean;
  output: string;
  /** コマンド 1 本の開始から終了（タイムアウトを含む）までの ms。古い agent の結果には無い */
  durationMs?: number;
}

export interface VerificationSummary {
  commands: VerificationCommand[];
  results: VerificationCommandResult[];
  verified: boolean;
  attempts: number;
  commitSha?: string;
}

export type TerminalAgentPhase = "completed" | "failed" | "budget_exceeded" | "cancelled";

export type ResultDto =
  | { status: "not_ready" }
  | {
      status: TerminalAgentPhase;
      reason?: string;
      summary: string;
      verification: VerificationSummary;
      warnings: string[];
      patch?: string;
      diffstat?: string;
      patchTooLarge: boolean;
      usage: UsageDto;
      /** 完了時に push して ls-remote で確かめた SHA（補助情報。真偽は GitHub から読んだ PR の head を正とする） */
      pushedSha?: string;
      /** task_review（kind: "review"）と worker_review（workerReview あり）の結果。client_review の通常のタスクには付かない */
      review?: ReviewResultDto;
    };

/** consult（D10）の 1 メッセージ。rovo は会話を保存しない（呼び出し元が毎回すべて渡す）。 */
export interface ConsultMessage {
  role: "user" | "assistant";
  content: string;
}

/** AgentDO.consult の依頼。consult ごとに別の AgentDO インスタンス（名前は consultId）で動く。 */
export interface ConsultRequest {
  /** `consult-<ULID>`。AgentDO のインスタンス名と同じ。AI Gateway の metadata に載せる */
  consultId: string;
  userId: string;
  /** "anthropic/claude-sonnet-5-5" など。AgentDO の env の AGENT_MODELS の中だけ */
  model: string;
  system?: string;
  messages: ConsultMessage[];
  /** 出力の上限の希望。AgentDO が予約額から計算した上限でさらに絞る */
  maxOutputTokens?: number;
  /** 思考レベル（gateway が検査・既定の解決済み。無ければモデルごとの既定）。思考のトークンは maxOutputTokens の中に収まる */
  effort?: Effort;
  /** この consult に使える上限（USD）。UserDO で月の枠から予約した額 */
  budgetUsd: number;
}

export interface ConsultUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export type ConsultErrorCode =
  | "unknown_model"
  | "input_too_large"
  | "invalid_request"
  | "model_error"
  /** モデルがリクエストの中身を拒否した（4xx。待っても再試行しても直らない）。model_error は再試行してよい失敗 */
  | "model_rejected";

export type ConsultResult =
  | {
      ok: true;
      text: string;
      model: string;
      usage: ConsultUsage;
      costUsd: number;
      /** 実際に使った思考レベル */
      effort?: Effort;
      /** 成功なのにプロバイダーが usage を返さなかった（トークンが 0）。costUsd は呼ぶ前の最悪の場合の見積り */
      usageMissing?: true;
      /** costUsd が実費ではなく見積もり（最悪の場合の見積り）。budget_status の estimated_usd に数える */
      costEstimated?: true;
    }
  /**
   * 失敗。costUsd はそれまでにかかった実費（モデルを呼ぶ前の失敗は 0）。
   * 実費が分からず予約額を返したときは costEstimated を立てる
   */
  | { ok: false; code: ConsultErrorCode; message: string; costUsd: number; costEstimated?: true };

/** AgentDO の公開 RPC。 */
export interface AgentRpc {
  start(spec: TaskSpec): Promise<StartResult>;
  cancel(): Promise<CancelResult>;
  getEvents(afterSeq: number, limit: number): Promise<EventsPage>;
  getResult(): Promise<ResultDto>;
  /** Installation Token の更新。冪等で、成功（ok:true）するまで TaskDO が再送する */
  setGitCredential(c: GitCredential): Promise<{ ok: boolean }>;
  /**
   * ワーカーの質問への回答。question_id で冪等。ok:false なら TaskDO が再送する。
   * ignored:true は「もう効果が無い」（回答済み・終端・cancel 済み）ことを示し、TaskDO は再送をやめる。
   */
  answer(questionId: string, answer: string): Promise<{ ok: boolean; ignored?: boolean }>;
  /** 追加の指示。steer_id（Gateway が発行）で冪等。ok:false なら TaskDO が再送する */
  steer(steerId: string, message: string): Promise<{ ok: boolean; ignored?: boolean }>;
  /** セカンドオピニオン（D10）。Sandbox もタスクも使わない、1 回で完結するモデル呼び出し */
  consult(request: ConsultRequest): Promise<ConsultResult>;
}
