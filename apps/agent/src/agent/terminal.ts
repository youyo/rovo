import type { TerminalPhase } from "./types";

/** 停止の意図。記録した時点で Sandbox の破棄と Pi の abort を始めるが、公開する終端は別に確定する。 */
export type StopIntent =
  | "cancel"
  | "deadline"
  | "input_timeout"
  /** 予算の延長の質問（kind: budget_extension）に答えが無いまま、回答待ちの上限に達した。終端は budget_exceeded */
  | "budget_extension_timeout"
  | "budget_exceeded";

/** 通常の経路（完了・失敗）が求める終端 */
export interface TerminalRequest {
  phase: "completed" | "failed";
  reason?: string;
  /** patch の元にする検証済みの commit SHA（無ければ HEAD） */
  sha?: string;
  skipPatch?: boolean;
}

export interface TerminalDecision {
  phase: TerminalPhase;
  reason?: string;
}

/**
 * 確定のトランザクションの中で呼ぶ。優先順位は cancel > deadline > input_timeout > budget_extension_timeout > budget_exceeded > failed > completed。
 * 先に作られた確定の指示（古い FinalizeOptions）をそのまま採用しないために、意図と要求を全部見て決める。
 */
export function decideTerminal(
  intents: readonly StopIntent[],
  requests: readonly TerminalRequest[],
): TerminalDecision {
  if (intents.includes("cancel")) return { phase: "cancelled", reason: "cancelled" };
  if (intents.includes("deadline")) return { phase: "failed", reason: "deadline" };
  if (intents.includes("input_timeout")) return { phase: "failed", reason: "input_timeout" };
  // 予算の延長の質問への無応答。終端は budget_exceeded のまま、reason で「予算の枠ではなく無応答で止まった」と区別する
  if (intents.includes("budget_extension_timeout")) {
    return { phase: "budget_exceeded", reason: "budget_extension_timeout" };
  }
  if (intents.includes("budget_exceeded")) {
    return { phase: "budget_exceeded", reason: "budget_exceeded" };
  }
  const failed = requests.find((r) => r.phase === "failed");
  if (failed) {
    return failed.reason === undefined
      ? { phase: "failed" }
      : { phase: "failed", reason: failed.reason };
  }
  return { phase: "completed" };
}
