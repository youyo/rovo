import type { CallContext, ModelEvaluation } from "../types";
import type { SafetyEvaluator } from "./types";

/** 評価器が例外を投げても、未完了の評価（→ unknown）として扱う。 */
export async function evaluateSafely(
  evaluator: SafetyEvaluator,
  text: string,
  ctx: CallContext,
): Promise<ModelEvaluation> {
  try {
    return await evaluator.evaluate(text, ctx);
  } catch (cause) {
    return {
      evaluator: evaluator.name,
      modelVersion: evaluator.modelVersion,
      complete: false,
      scores: {},
      evaluatedChars: 0,
      totalChars: text.length,
      failure: `evaluator_failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }
}
