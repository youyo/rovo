import type { CallContext, ModelEvaluation } from "../types";
import type { SafetyEvaluator } from "./types";

/** 評価器 1 回の呼び出しの期限。超えたら未完了（unknown）として扱う。 */
export const EVALUATOR_TIMEOUT_MS = 60_000;

function incomplete(evaluator: SafetyEvaluator, text: string, failure: string): ModelEvaluation {
  return {
    evaluator: evaluator.name,
    modelVersion: evaluator.modelVersion,
    complete: false,
    scores: {},
    evaluatedChars: 0,
    totalChars: text.length,
    failure,
  };
}

/**
 * 評価器を呼ぶ。次のどれも「評価できなかった」（complete: false → unknown）として扱い、返却に進ませない。
 * - 例外 / 期限切れ
 * - complete: true と言っているのに、評価した文字数が渡したテキストの全体に届いていない（一部のチャンクだけの評価）
 * 評価の範囲 = 返却の範囲という不変条件を、評価器の実装に頼らずここで保つ。
 */
export async function evaluateSafely(
  evaluator: SafetyEvaluator,
  text: string,
  ctx: CallContext,
  options: { timeoutMs?: number } = {},
): Promise<ModelEvaluation> {
  const timeoutMs = options.timeoutMs ?? EVALUATOR_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("evaluator_timeout")), timeoutMs);
    });
    const result = await Promise.race([evaluator.evaluate(text, ctx), timeout]);
    if (
      result.complete &&
      (result.evaluatedChars !== text.length || result.totalChars !== text.length)
    ) {
      return { ...result, complete: false, failure: "partial_evaluation" };
    }
    return result;
  } catch (cause) {
    return incomplete(
      evaluator,
      text,
      `evaluator_failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  } finally {
    clearTimeout(timer);
  }
}
