/**
 * Gateway から見た AgentDO（apps/agent）の RPC 契約。
 * apps/agent から import しない（Worker 間でビルド依存を作らない）ので、同等の型をここに持つ。
 * 乖離は test/contract/agent-contract.ts（型だけを比べるファイル。typecheck で検査）が検出する。
 */

export type AgentPhase =
  | "starting"
  | "running"
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
  budgetUsd: number;
  deadlineAt: number;
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
    };

/** AgentDO の公開 RPC。 */
export interface AgentRpc {
  start(spec: TaskSpec): Promise<StartResult>;
  cancel(): Promise<CancelResult>;
  getEvents(afterSeq: number, limit: number): Promise<EventsPage>;
  getResult(): Promise<ResultDto>;
}
