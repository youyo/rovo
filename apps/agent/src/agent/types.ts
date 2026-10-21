import type {
  SandboxInstance,
  SandboxPromotionReason,
  SandboxPromotionTrigger,
  SandboxRuleMatch,
} from "@rovo/models";
import type { DepsMissReason, DepsSpec } from "../deps-cache";

/** AgentDO の公開 RPC の型（戻り値は DTO。Pi の EntryRecord は返さない）。 */

export type Phase =
  | "starting"
  | "running"
  | "verifying"
  /** ask_parent で質問し、親の回答を待っている */
  | "input_required"
  | "completed"
  | "failed"
  | "budget_exceeded"
  | "cancelled";

export type TerminalPhase = Extract<
  Phase,
  "completed" | "failed" | "budget_exceeded" | "cancelled"
>;

export const TERMINAL_PHASES: readonly Phase[] = [
  "completed",
  "failed",
  "budget_exceeded",
  "cancelled",
];

export function isTerminal(phase: Phase | undefined): phase is TerminalPhase {
  return phase !== undefined && TERMINAL_PHASES.includes(phase);
}

export interface VerificationCommand {
  argv: string[];
  /** リポジトリのルートからの相対パス */
  cwd?: string;
  timeoutSeconds?: number;
}

/** GitHub の Installation Token と期限（epoch ms）。SandboxDO が暗号化して持ち、コンテナには入れない。 */
export interface GitCredential {
  token: string;
  expiresAt: number;
}

/** Gateway が認証済みの値から作って渡すタスク仕様。 */
export interface TaskSpec {
  taskId: string;
  userId: string;
  /** owner/name */
  repository: string;
  baseSha: string;
  /** 作業ブランチ名。`agent/task-<taskId>` と一致しなければ start を拒否する。 */
  branch: string;
  /** TaskDO が作った初期コミットの SHA（base_sha の上の空コミット。作業ブランチの先頭は最初これを指す）。 */
  initialSha: string;
  /**
   * push / clone 用の Installation Token。AgentDO は永続化せず、SandboxDO に暗号化して預ける。
   * start の同一性判定（fingerprint）には含めない（更新されうるため）。更新は setGitCredential で届く。
   */
  gitCredential: GitCredential;
  instructions: string;
  acceptanceCriteria?: string[];
  verificationCommands?: VerificationCommand[];
  constraints?: string[];
  /**
   * 子のモデル（"anthropic/claude-haiku-5-5" など。D10）。省略は env の AGENT_MODEL（既定 anthropic/claude-sonnet-5-5）。
   * env の AGENT_MODELS に無いモデルは start を拒否する（unknown_model）。
   */
  model?: string;
  /**
   * 子の Sandbox の大きさ（task_start の sandbox_instance。standard-1〜4）。**ある = 利用者が明示した**ので、このタスクの間はずっと
   * この大きさで起動する（後段の自動の昇格もしない）。省略は env の SANDBOX_INSTANCE の既定。standard-1〜4 以外は start を拒否する。
   */
  sandboxInstance?: string;
  /** このタスクに使える上限（USD） */
  budgetUsd: number;
  /** epoch ms。開始から 2 時間を超える値は 2 時間に丸める。 */
  deadlineAt: number;
  /**
   * 依存関係のキャッシュ（D14）の指定。gateway が base_sha 時点のルート直下の lockfile から作る。
   * lockfile が無い・読めなかったときは null（キャッシュなし）。形が不正・表に無い導入コマンドは SandboxDO が無視する。
   */
  deps?: DepsSpec | null;
}

export type StartResult =
  | { status: "accepted"; phase: Phase; alreadyAccepted: boolean }
  | { status: "conflict" }
  | { status: "cancelled" }
  | { status: "rejected"; reason: string };

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
  /** "anthropic/claude-sonnet-5-5" など。env の AGENT_MODELS の中だけ */
  model: string;
  system?: string;
  messages: ConsultMessage[];
  /** 出力の上限の希望。予約額から計算した上限でさらに絞る */
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

/** answer / steer の結果。ignored は「停止・終端のため何もしなかった」（Gateway は成功として扱う）。 */
export interface DeliveryResult {
  ok: boolean;
  ignored?: boolean;
}

export interface CancelResult {
  /**
   * true のときは、Sandbox の破棄とモデルの停止が確かめられ、最終の usage を含むすべてのイベントが
   * 永続化済み。以後イベントは追加されない。false なら Gateway が再送する。
   */
  stopped: boolean;
  /** stopped が true のとき、最後のイベントの seq（イベントが無ければ 0） */
  finalSeq?: number;
}

export interface UsageDto {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** 子が使った web の回数（タスクごとの累計）。web 自体の費用は costUsd に含めない */
  web: WebUsage;
  /** SandboxDO のカウンタ。読めなかったとき・読めない実装（fake）では無い。gateway が公開用の形に写す（M3） */
  sandbox?: SandboxMetrics;
}

/** SandboxDO のカウンタ（永続）。定義は sandbox-do.ts の「実行時間と起動世代のカウンタ」 */
export interface SandboxMetrics {
  /** コンテナを動かした時間の累計（ms） */
  runtimeMs: number;
  /** コンテナの作り直しの回数（2 回目以降の start） */
  restarts: number;
  /** 起動の確認点で止まった・破棄された試行の回数 */
  bootRetries: number;
  /**
   * 依存関係のキャッシュ（D14）の結果。hit: キャッシュから起動 / miss: 使えず今までどおり / built: 作って使った / disabled: 対象外。
   * 起動を一度も試みていなければ無い。
   */
  depsCache?: "hit" | "miss" | "built" | "disabled";
  /** depsCache が "miss" のときだけ: 使えなかった理由の固定コード（ログの deps_cache_miss: <reason> と同じ） */
  depsMissReason?: DepsMissReason;
  /** キャッシュを作ったタスクだけ: 作るのにかかった時間（ms）。runtimeMs（Sandbox の時間）にも含む */
  cacheBuildMs?: number;
  /** 最初にコンテナを start() した大きさ。一度も起動していなければ無い（Sandbox が必要になるまで起動しない）。昇格しても変わらない */
  instance?: string;
  /** 昇格した最終の大きさ（子が頼んだ・重いコマンドの規則・検証のどれでも）。昇格していなければ無い。上げる方向だけで、戻さない（作り直しも最終の大きさで起動する） */
  promotedTo?: string;
  /** 最初の昇格の時刻（epoch ms）。昇格していなければ無い */
  promotedAt?: number;
  /** 最初の昇格までの Sandbox の累計時間（ms）。昇格していなければ無い。区間ごとの時間は promotions の runtimeMsBefore から導く */
  runtimeMsBeforePromotion?: number;
  /** 昇格を見送った・失敗した理由の固定コード（packages/models の SANDBOX_PROMOTION_REASONS）。最後に残したもので、あとで昇格が成功しても消さない。設定で無効のときは無い */
  promotionReason?: SandboxPromotionReason;
  /** 成功した昇格だけを時系列に並べたもの（見送り・失敗は promotionReason）。子が頼んだ・規則・検証のどれかは trigger で分かる */
  promotions?: SandboxPromotionRecord[];
  /** 子が sandbox_scale_up で上げたあと、タスクの終了までに規則（heavy-command.ts の表）で重いと判定されたコマンドを実行した本数。子が上げていなければ 0。検証コマンドの heavy フラグは数えない */
  heavyCommandsAfterAgentScaleUp?: number;
  /**
   * heavyCommandsAfterAgentScaleUp のうち、実行の時点で「子が sandbox_scale_up で上げた大きさ」が規則の昇格先以上だったために、
   * 規則が昇格しなくて済んだ本数（子の見立てが当たった数）。子が上げていなければ無い。規則の昇格を無効にしているデプロイでは 0
   */
  heavyCommandsCoveredByAgent?: number;
  /** 昇格の試みが見送り・失敗になった記録（固定の trigger と理由コード。1 件ずつ、古い順。最大 8 件）。子が先に上げていて規則が見送った場合は入れない */
  promotionFailures?: SandboxPromotionFailure[];
}

/** 昇格の試みの見送り・失敗 1 件。値はどちらも固定の値 */
export interface SandboxPromotionFailure {
  trigger: SandboxPromotionTrigger;
  reason: SandboxPromotionReason;
}

/** 成功した昇格 1 回分。値はすべて固定の値か数値（子の自由文・argv の文字列は入らない） */
export interface SandboxPromotionRecord {
  /** 昇格した先の大きさ */
  to: SandboxInstance;
  /** 昇格した時刻（epoch ms） */
  at: number;
  trigger: SandboxPromotionTrigger;
  /** この昇格までの Sandbox の累計時間（ms）。1 つ前の昇格（無ければ起動）からこの昇格までが、1 つ前の大きさの区間 */
  runtimeMsBefore: number;
  /** trigger が rule のときだけ: 一致した重いコマンドの表の名前（固定の一覧） */
  ruleMatch?: SandboxRuleMatch;
}

export interface WebUsage {
  search: number;
  fetch: number;
  browse: number;
}

export interface AgentEventDto {
  seq: number;
  ts: number;
  type: string;
  /** JSON 文字列（RPC の型が深くなるのを避けるため） */
  data: string;
}

export interface EventsPage {
  events: AgentEventDto[];
  /** 返したイベントの最後の seq（無ければ afterSeq） */
  throughSeq: number;
  hasMore: boolean;
  phase: Phase | undefined;
  /** phase が確定したイベントの seq。Gateway はここまで取り込んでから終端を確定する */
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
  /** 検証コマンドを全部通したか。コマンドが無ければ false（未検証） */
  verified: boolean;
  attempts: number;
  commitSha?: string;
}

export type ResultDto =
  | { status: "not_ready" }
  | {
      status: Exclude<TerminalPhase, never>;
      reason?: string;
      summary: string;
      verification: VerificationSummary;
      warnings: string[];
      patch?: string;
      diffstat?: string;
      patchTooLarge: boolean;
      /**
       * 完了時に作業ブランチを検証済みの SHA に揃え、ls-remote で一致を確かめられたときだけ入る（その SHA）。
       * 入らない（push に失敗した、または completed 以外）ときは、Gateway は PR の head と比べない。
       */
      pushedSha?: string;
      usage: UsageDto;
    };
