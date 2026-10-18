export const TASK_STATUSES = [
  "CREATING",
  "RUNNING",
  "INPUT_REQUIRED",
  "VERIFYING",
  "RECOVERING",
  "COMPLETED",
  "FAILED",
  "BUDGET_EXCEEDED",
  "CANCELLED",
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

const TERMINAL: ReadonlySet<TaskStatus> = new Set([
  "COMPLETED",
  "FAILED",
  "BUDGET_EXCEEDED",
  "CANCELLED",
]);

/** 終端状態からはどこへも遷移しない。 */
export function isTerminal(status: TaskStatus): boolean {
  return TERMINAL.has(status);
}

// 許可する遷移の一覧。Phase 1 の公開 API が使うのは「→ CANCELLED」だけだった。
// Phase 2 で CREATING → RUNNING などが、Phase 4 で RUNNING ⇄ INPUT_REQUIRED と
// INPUT_REQUIRED → FAILED（input_timeout）が使われる（TaskDO が AgentDO の phase を写すときに canTransition で確かめる）。
const TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  CREATING: ["RUNNING", "FAILED", "BUDGET_EXCEEDED", "CANCELLED"],
  RUNNING: [
    "INPUT_REQUIRED",
    "VERIFYING",
    "RECOVERING",
    "COMPLETED",
    "FAILED",
    "BUDGET_EXCEEDED",
    "CANCELLED",
  ],
  INPUT_REQUIRED: ["RUNNING", "RECOVERING", "FAILED", "BUDGET_EXCEEDED", "CANCELLED"],
  VERIFYING: [
    "RUNNING",
    "INPUT_REQUIRED",
    "RECOVERING",
    "COMPLETED",
    "FAILED",
    "BUDGET_EXCEEDED",
    "CANCELLED",
  ],
  RECOVERING: ["RUNNING", "INPUT_REQUIRED", "VERIFYING", "FAILED", "BUDGET_EXCEEDED", "CANCELLED"],
  COMPLETED: [],
  FAILED: [],
  BUDGET_EXCEEDED: [],
  CANCELLED: [],
};

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === "string" && (TASK_STATUSES as readonly string[]).includes(value);
}
