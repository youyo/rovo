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

/** DoH（cloudflare-dns.com）の問い合わせに「公開アドレス」で答え、それ以外は元の fetch に渡す。web_fetch の事前検査を通すための fake。 */
export function withPublicDoh(
  inner: (input: string | URL | Request, init?: RequestInit) => Response | Promise<Response>,
  resolve: (host: string, type: string) => Response | null = () => null,
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const u = new URL(url);
    if (u.hostname === "cloudflare-dns.com") {
      const host = u.searchParams.get("name") ?? "";
      const type = u.searchParams.get("type") ?? "";
      const custom = resolve(host, type);
      if (custom) return custom;
      return Response.json({
        Status: 0,
        Answer: type === "A" ? [{ name: host, type: 1, data: "93.184.216.34" }] : [],
      });
    }
    return inner(input, init);
  }) as typeof fetch;
}
