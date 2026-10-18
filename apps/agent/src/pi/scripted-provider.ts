import {
  type AssistantMessage,
  createAssistantMessageEventStream,
  createProvider,
  type Model,
  type Provider,
  type ToolCall,
  type TranscriptContext,
} from "@earendil-works/pi-ai";

/** 台本の 1 ターン。モデルが 1 回返す応答（テキストと、任意でツール呼び出し 1 件）。 */
export interface ScriptStep {
  text?: string;
  toolCall?: { name: string; arguments: Record<string, string | number | boolean> };
}

export const SCRIPTED_PROVIDER_ID = "scripted";
export const SCRIPTED_MODEL_ID = "script-1";

const MODEL: Model<string> = {
  id: SCRIPTED_MODEL_ID,
  name: "Scripted fake model",
  api: "scripted",
  provider: SCRIPTED_PROVIDER_ID,
  baseUrl: "http://scripted.invalid",
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  reasoning: false,
  contextWindow: 100_000,
  maxTokens: 4096,
};

const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/**
 * 台本付きの fake provider（本物のモデルを呼ばないテスト用）。
 * 何番目の応答かは「transcript 中の assistant メッセージ数」で決めるので、DO が再起動しても
 * 内部状態に依存せず同じ台本を進められる。台本を使い切ったら "script exhausted" で止まる。
 */
export function createScriptedProvider(getScript: () => readonly ScriptStep[]): Provider {
  const stream = (_model: Model<string>, context: TranscriptContext) => {
    const out = createAssistantMessageEventStream();
    const turn = context.messages.filter((m) => m.role === "assistant").length;
    const step = getScript()[turn] ?? { text: "script exhausted" };
    const content: AssistantMessage["content"] = [];
    if (step.text) content.push({ type: "text", text: step.text });
    let toolCall: ToolCall | undefined;
    if (step.toolCall) {
      toolCall = {
        type: "toolCall",
        id: `call_${turn}`,
        name: step.toolCall.name,
        arguments: step.toolCall.arguments,
      };
      content.push(toolCall);
    }
    const message: AssistantMessage = {
      role: "assistant",
      content,
      api: "scripted",
      provider: SCRIPTED_PROVIDER_ID,
      model: SCRIPTED_MODEL_ID,
      usage: ZERO_USAGE,
      stopReason: toolCall ? "toolUse" : "stop",
      timestamp: Date.now(),
    };
    queueMicrotask(() => {
      out.push({ type: "start", partial: message });
      out.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
      out.end(message);
    });
    return out;
  };
  return createProvider({
    id: SCRIPTED_PROVIDER_ID,
    name: "Scripted",
    auth: {
      apiKey: { name: "none", resolve: async () => ({ auth: { apiKey: "unused" } }) },
    },
    models: [MODEL],
    api: { stream, streamSimple: stream },
  });
}
