// E2E 用の偽の Workers AI。gateway の AI バインディングを、この WorkerEntrypoint への service binding に差し替えて使う
// （test/support/gateway-server.ts の writeE2eConfig）。本物の Workers AI（リモート）は呼ばない。
// モデルの自動選択（Clef）の質問は 1 問の score（段 = 候補の数）なので、state の目印で答える段を変える:
//   目印なし = 普通の実装（2 段目）、FAKE_AI_LIGHT = 軽い（最初の段）、FAKE_AI_HEAVY = 重い（最後の段）、
//   FAKE_AI_FAIL = 例外、FAKE_AI_HANG = 20 秒待つ（gateway の時間切れを確かめる）、FAKE_AI_INVALID = 想定外の形。
import { WorkerEntrypoint } from "cloudflare:workers";

type TierQuestion = { criteria: unknown[] };
type RunInput = { model?: string; state?: string; questions?: { tier?: TierQuestion } };

export class FakeAI extends WorkerEntrypoint {
  async run(_model: string, input: RunInput, _options?: unknown): Promise<unknown> {
    const state = input.state ?? "";
    if (state.includes("FAKE_AI_FAIL")) throw new Error("fake ai failure");
    // 返らない Promise は workerd が「ハング」として中断してしまう（時間切れではなく例外になる）ので、長く待つ
    if (state.includes("FAKE_AI_HANG")) await new Promise((resolve) => setTimeout(resolve, 20_000));
    if (state.includes("FAKE_AI_INVALID")) return { answers: {} };
    const tiers = input.questions?.tier?.criteria.length ?? 2;
    const pick = state.includes("FAKE_AI_LIGHT")
      ? 0
      : state.includes("FAKE_AI_HEAVY")
        ? tiers - 1
        : Math.min(1, tiers - 1);
    const probabilities: Record<string, number> = {};
    for (let i = 0; i < tiers; i++)
      probabilities[String(i)] = i === pick ? 0.92 : 0.08 / (tiers - 1);
    return {
      model: input.model ?? "clef-flash",
      answers: {
        tier: {
          type: "score",
          score: pick / Math.max(1, tiers - 1),
          probabilities,
          confidence: 0.9,
        },
      },
      usage: { input_tokens: 400, output_tokens: 0 },
    };
  }
}
