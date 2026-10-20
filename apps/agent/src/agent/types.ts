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
  /** このタスクに使える上限（USD） */
  budgetUsd: number;
  /** epoch ms。開始から 2 時間を超える値は 2 時間に丸める。 */
  deadlineAt: number;
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
  | "model_error";

export type ConsultResult =
  | { ok: true; text: string; model: string; usage: ConsultUsage; costUsd: number }
  /** 失敗。costUsd はそれまでにかかった実費（モデルを呼ぶ前の失敗は 0） */
  | { ok: false; code: ConsultErrorCode; message: string; costUsd: number };

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
