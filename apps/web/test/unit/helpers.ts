import { vi } from "vitest";
import type { SafetyEvaluator } from "../../src/safety/types";
import { CATEGORIES, type ModelEvaluation } from "../../src/types";

export function lowScores(v = 0.01): ModelEvaluation["scores"] {
  return Object.fromEntries(CATEGORIES.map((c) => [c, v]));
}

export function okEvaluation(over: Partial<ModelEvaluation> = {}): ModelEvaluation {
  return {
    evaluator: "fake",
    modelVersion: "fake-1",
    complete: true,
    scores: lowScores(),
    evaluatedChars: 0,
    totalChars: 0,
    ...over,
  };
}

/** 台本付きの SafetyEvaluator。呼び出しを記録する。 */
export function fakeEvaluator(
  script: (text: string, call: number) => Partial<ModelEvaluation> | Error = () => ({}),
) {
  const calls: { text: string; ctx: unknown }[] = [];
  const evaluate = vi.fn(async (text: string, ctx: unknown) => {
    const n = calls.length;
    calls.push({ text, ctx });
    const r = script(text, n);
    if (r instanceof Error) throw r;
    return okEvaluation({ evaluatedChars: text.length, totalChars: text.length, ...r });
  });
  const evaluator: SafetyEvaluator = { name: "fake", modelVersion: "fake-1", evaluate };
  return { evaluator, calls, evaluate };
}
