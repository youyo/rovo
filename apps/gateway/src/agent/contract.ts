/**
 * Gateway から見た AgentDO（apps/agent）の RPC 契約。
 * apps/agent から import しない（Worker 間でビルド依存を作らない）ので、同等の型をここに持つ。
 * 乖離は gateway の test/contract/agent-contract.ts（DTO の型）と、apps/agent の test/contract/gateway-contract.ts
 * （AgentDO の実際のメソッドの型との比較）が検出する（どちらも typecheck で検査）。
 */

import type {
  SandboxInstance,
  SandboxPromotionReason,
  SandboxPromotionTrigger,
  SandboxRuleMatch,
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
  /** 子のモデル（D10。"anthropic/claude-haiku-5-5" など）。省略は AgentDO の env の AGENT_MODEL */
  model?: string;
  /**
   * 子の Sandbox の大きさ（task_start の sandbox_instance。standard-1〜4）。**ある = 利用者が明示した**ので、そのタスクの間はずっとその大きさ
   * （後段の自動の昇格もしない）。省略は agent の env の既定（SANDBOX_INSTANCE）で、省略したときはこの項目自体を付けない（spec の同一性を変えない）。
   */
  sandboxInstance?: string;
  budgetUsd: number;
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
  /** 子が使った web の回数（タスクごとの累計。Phase 5）。web 自体の費用は costUsd に含めない */
  web: WebUsageDto;
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
  /** 昇格した最終の大きさ（子の要求・規則・検証のどれでも）。昇格していなければ無い */
  promotedTo?: string;
  /** 最初の昇格の時刻（epoch ms） */
  promotedAt?: number;
  /** 最初の昇格までの Sandbox の累計時間（ms）。区間ごとの時間は promotions の runtimeMsBefore から導く */
  runtimeMsBeforePromotion?: number;
  /** 昇格を見送った・失敗した理由の固定コード（packages/models の SANDBOX_PROMOTION_REASONS）。最後に残したもの。設定で無効のときは無い */
  promotionReason?: SandboxPromotionReason;
  /** 成功した昇格だけの履歴（古い順）。trigger は固定の 3 値、ruleMatch は規則で上がったときだけ（固定の表の名前） */
  promotions?: {
    to: SandboxInstance;
    at: number;
    trigger: SandboxPromotionTrigger;
    runtimeMsBefore: number;
    ruleMatch?: SandboxRuleMatch;
  }[];
  /** 子が sandbox_scale_up で上げたあと、規則で重いと判定されたコマンドを実行した本数。子が上げていなければ無い */
  heavyCommandsAfterAgentScaleUp?: number;
  /** そのうち、子が規則の昇格先以上に上げていたために、規則が昇格しなくて済んだ本数（子の見立ての的中）。子が上げていなければ無い */
  heavyCommandsCoveredByAgent?: number;
  /** 昇格の試みが見送り・失敗になった記録（固定の trigger と理由コード。古い順、最大 8 件）。子が先に上げていて規則が見送った場合は入らない */
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
   * 子の質問への回答。question_id で冪等。ok:false なら TaskDO が再送する。
   * ignored:true は「もう効果が無い」（回答済み・終端・cancel 済み）ことを示し、TaskDO は再送をやめる。
   */
  answer(questionId: string, answer: string): Promise<{ ok: boolean; ignored?: boolean }>;
  /** 追加の指示。steer_id（Gateway が発行）で冪等。ok:false なら TaskDO が再送する */
  steer(steerId: string, message: string): Promise<{ ok: boolean; ignored?: boolean }>;
  /** セカンドオピニオン（D10）。Sandbox もタスクも使わない、1 回で完結するモデル呼び出し */
  consult(request: ConsultRequest): Promise<ConsultResult>;
}
