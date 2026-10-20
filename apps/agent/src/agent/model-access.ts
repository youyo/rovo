import type { Api, Model, Provider } from "@earendil-works/pi-ai";
import { piModelId } from "@rovo/models";
import { createAI } from "agents/models/pi-ai";

/**
 * 本番のモデルを呼ぶ口（AI バインディング経由の AI Gateway。agents の createAI）。
 *
 * Workers AI のモデル（"workers-ai/@cf/openai/gpt-oss-120b" など。D10b）は、createAI に `@cf/...` の id で渡す
 * （`workers-ai/...` の specifier は createAI が TypeError で拒否する）。api は cloudflare-ai で、env.AI.run に
 * tools / reasoning_effort / max_tokens 付きの chat completions として流れる。Anthropic / OpenAI は AI Gateway の
 * universal endpoint（BYOK のキー）。
 */
export function createModelAccess(env: { AI?: Ai; AI_GATEWAY_ID?: string }): {
  provider: Provider;
  model: (rovoModelId: string) => Model<Api>;
} {
  if (!env.AI) throw new Error("AI binding is not configured");
  const ai = createAI({ binding: env.AI, id: env.AI_GATEWAY_ID || undefined });
  return { provider: ai.provider, model: (id) => ai(piModelId(id)) as Model<Api> };
}

/** Pi のセッションに設定するモデルの参照（rovo の id → Pi の registry の id）。 */
export function sessionModelRef(rovoModelId: string): { provider: string; id: string } {
  return { provider: "cloudflare", id: piModelId(rovoModelId) };
}
