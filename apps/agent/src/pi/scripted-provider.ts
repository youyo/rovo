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
  /** このターンで消費したトークン数。費用は scripted モデルの単価（$1/100万トークン）で計算する。 */
  usage?: { input?: number; output?: number };
  /** 応答を返すまでの待ち（ms）。呼び出しの途中で cancel されるケースの再現用。abort しても応答は返る（usage が後から増える）。 */
  delayMs?: number;
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
  cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
  reasoning: false,
  contextWindow: 100_000,
  maxTokens: 4096,
};

function userText(context: TranscriptContext): string {
  const first = context.messages.find((m) => m.role === "user");
  if (!first) return "";
  if (typeof first.content === "string") return first.content;
  return first.content.map((c) => (c.type === "text" ? c.text : "")).join("");
}

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
 * 台本は「最初の user メッセージの本文」(= operation の入力) をキーに引くので、同じ DO で複数の
 * operation を流しても台本が干渉しない。
 */
export function createScriptedProvider(
  getScript: (key: string) => readonly ScriptStep[],
  onCall?: () => void,
): Provider {
  const stream = (
    _model: Model<string>,
    context: TranscriptContext,
    options?: { signal?: AbortSignal },
  ) => {
    const out = createAssistantMessageEventStream();
    onCall?.();
    const turn = context.messages.filter((m) => m.role === "assistant").length;
    const step = getScript(userText(context))[turn] ?? { text: "script exhausted" };
    const inTok = step.usage?.input ?? 0;
    const outTok = step.usage?.output ?? 0;
    const usage = {
      ...ZERO_USAGE,
      input: inTok,
      output: outTok,
      totalTokens: inTok + outTok,
      cost: {
        ...ZERO_USAGE.cost,
        input: inTok / 1e6,
        output: outTok / 1e6,
        total: (inTok + outTok) / 1e6,
      },
    };
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
      usage,
      stopReason: toolCall ? "toolUse" : "stop",
      timestamp: Date.now(),
    };
    const emit = () => {
      if (!step.delayMs) out.push({ type: "start", partial: message });
      out.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
      out.end(message);
    };
    if (step.delayMs) {
      // 実際の provider と同じく、abort されると「中断」で終わり、それまでに消費した usage を報告する
      const signal = options?.signal;
      let settled = false;
      // 生成の途中経過（内容と、それまでの usage）を先に報告する。abort されても Pi はこの途中経過を usage に計上する
      queueMicrotask(() => out.push({ type: "start", partial: message }));
      const timer = setTimeout(() => {
        settled = true;
        emit();
      }, step.delayMs);
      signal?.addEventListener(
        "abort",
        () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          // 中断の応答が返るまで少し遅れる（abort の後に usage が確定する）
          setTimeout(() => {
            const aborted: AssistantMessage = { ...message, content: [], stopReason: "aborted" };
            out.push({ type: "error", reason: "aborted", error: aborted });
            out.end(aborted);
          }, 150);
        },
        { once: true },
      );
    } else queueMicrotask(emit);
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
