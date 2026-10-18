/** AgentDO の公開 RPC の型（戻り値は DTO。Pi の EntryRecord は返さない）。 */

export type Phase =
  | "starting"
  | "running"
  | "verifying"
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

/** Gateway が認証済みの値から作って渡すタスク仕様。 */
export interface TaskSpec {
  taskId: string;
  userId: string;
  /** owner/name */
  repository: string;
  baseSha: string;
  instructions: string;
  acceptanceCriteria?: string[];
  verificationCommands?: VerificationCommand[];
  constraints?: string[];
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

export interface CancelResult {
  stopped: boolean;
}

export interface UsageDto {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
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
      usage: UsageDto;
    };
