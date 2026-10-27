import {
  type Api,
  type AssistantMessage,
  createProvider,
  type Model,
  type Provider,
} from "@earendil-works/pi-ai";
import * as anthropicApi from "@earendil-works/pi-ai/api/anthropic-messages";
import * as responsesApi from "@earendil-works/pi-ai/api/openai-responses";
import { CLOUDFLARE_AI_GATEWAY_MODELS } from "@earendil-works/pi-ai/providers/cloudflare-ai-gateway.models";
import { describe, expect, it } from "vitest";
import { runModelStep, type StepMessage } from "../../src/model-step";

// 道具の往復（#135）で、前の歩の assistant の content（署名つきの thinking・OpenAI の reasoning のアイテム）を
// 次の歩でそのまま戻せること。pi-ai の本物のペイロード変換（anthropic-messages / openai-responses）を通し、
// onPayload で送る直前のペイロードを捕まえて止める（ネットワークには出ない）。

const STOP = "captured";

function catalogModel(id: string, api: string): Model<Api> {
  const m = Object.values(
    CLOUDFLARE_AI_GATEWAY_MODELS as unknown as Record<string, Model<Api>>,
  ).find((x) => x.id === id && x.api === api);
  if (!m) throw new Error(`no catalog model ${id}`);
  // 送り先は使わない（onPayload で止める）
  return { ...m, baseUrl: "http://payload.invalid" };
}

function providerOf(id: string, api: typeof anthropicApi | typeof responsesApi): Provider {
  return createProvider({
    id,
    name: id,
    auth: { apiKey: { name: "none", resolve: async () => ({ auth: { apiKey: "unused" } }) } },
    models: [],
    // 鍵は使わない（onPayload で止める）が、pi-ai は鍵が無いと呼ぶ前に断るので仮の値を渡す
    api: {
      stream: (m: never, c: never, o?: Record<string, unknown>) =>
        api.stream(m, c, { ...o, apiKey: "unused" } as never),
      streamSimple: (m: never, c: never, o?: Record<string, unknown>) =>
        api.streamSimple(m, c, { ...o, apiKey: "unused" } as never),
    } as never,
  });
}

async function capture(model: Model<Api>, provider: Provider, messages: StepMessage[]) {
  let payload: Record<string, unknown> | undefined;
  const out = await runModelStep({
    provider,
    model,
    price: {
      inputPerMTok: 1,
      outputPerMTok: 1,
      cacheReadPerMTok: 0,
      cacheWritePerMTok: 1,
      tiers: [],
    },
    system: "S",
    tools: [
      {
        name: "web_search",
        description: "d",
        parameters: { type: "object", properties: { query: { type: "string" } } } as never,
      },
    ],
    messages,
    maxTokens: 1000,
    metadata: {},
    reasoning: "medium",
    onPayload: (p: unknown) => {
      payload = p as Record<string, unknown>;
      throw new Error(STOP);
    },
    timeoutMs: 5_000,
    now: 0,
  });
  if (!payload) throw new Error(`payload was not captured: ${JSON.stringify(out)}`);
  return payload;
}

const transcript = (content?: AssistantMessage["content"]): StepMessage[] => [
  { role: "user", content: "question" },
  {
    role: "assistant",
    text: "",
    toolCalls: [{ id: "toolu_1", name: "web_search", arguments: { query: "q" } }],
    ...(content ? { content } : {}),
  },
  { role: "toolResult", id: "toolu_1", name: "web_search", text: "result", isError: false },
];

describe("runModelStep: 前の歩の assistant の content を戻す（#135）", () => {
  it("anthropic-messages: 署名つきの thinking → tool_use の順で assistant に入る（無いと thinking が落ちる）", async () => {
    const model = catalogModel("claude-sonnet-5-5", "anthropic-messages");
    const provider = providerOf(model.provider, anthropicApi);
    const content: AssistantMessage["content"] = [
      { type: "thinking", thinking: "I should search.", thinkingSignature: "SIG-abc" },
      { type: "thinking", thinking: "", thinkingSignature: "REDACTED-xyz", redacted: true },
      { type: "toolCall", id: "toolu_1", name: "web_search", arguments: { query: "q" } },
    ];
    const payload = await capture(model, provider, transcript(content));
    const messages = payload.messages as { role: string; content: { type: string }[] }[];
    const assistant = messages.find((m) => m.role === "assistant");
    expect(assistant?.content.map((b) => b.type)).toEqual([
      "thinking",
      "redacted_thinking",
      "tool_use",
    ]);
    expect(assistant?.content[0]).toMatchObject({
      thinking: "I should search.",
      signature: "SIG-abc",
    });
    expect(assistant?.content[1]).toMatchObject({ data: "REDACTED-xyz" });

    // 戻さないと thinking が無い（Anthropic は thinking が有効なとき 400 を返す）
    const bare = await capture(model, provider, transcript());
    const bareAssistant = (bare.messages as { role: string; content: { type: string }[] }[]).find(
      (m) => m.role === "assistant",
    );
    expect(bareAssistant?.content.map((b) => b.type)).toEqual(["tool_use"]);
  });

  it("openai-responses: reasoning のアイテム（thinkingSignature の JSON）が input に戻る", async () => {
    const model = catalogModel("gpt-6-sol", "openai-responses");
    const provider = providerOf(model.provider, responsesApi);
    const reasoning = {
      type: "reasoning",
      id: "rs_1",
      summary: [],
      encrypted_content: "ENC-123",
    };
    const content: AssistantMessage["content"] = [
      { type: "thinking", thinking: "", thinkingSignature: JSON.stringify(reasoning) },
      { type: "toolCall", id: "call_1|fc_1", name: "web_search", arguments: { query: "q" } },
    ];
    const messages: StepMessage[] = [
      { role: "user", content: "question" },
      {
        role: "assistant",
        text: "",
        toolCalls: [{ id: "call_1|fc_1", name: "web_search", arguments: { query: "q" } }],
        content,
      },
      { role: "toolResult", id: "call_1|fc_1", name: "web_search", text: "result", isError: false },
    ];
    const payload = await capture(model, provider, messages);
    const input = payload.input as { type?: string; encrypted_content?: string }[];
    expect(input.some((i) => i.type === "reasoning" && i.encrypted_content === "ENC-123")).toBe(
      true,
    );
  });
});
