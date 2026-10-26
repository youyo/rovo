import {
  type AssistantMessage,
  createAssistantMessageEventStream,
  createProvider,
  type Model,
  type Provider,
  type ToolCall,
  type TranscriptContext,
} from "@earendil-works/pi-ai";

export interface ScriptToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

/** 台本の 1 ターン。モデルが 1 回返す応答（テキストと、任意でツール呼び出し 1 件）。 */
export interface ScriptStep {
  text?: string;
  toolCall?: ScriptToolCall;
  /** 1 つの応答で複数のツールを呼ぶ（toolCall より優先） */
  toolCalls?: ScriptToolCall[];
  /**
   * このターンで消費したトークン数。費用は scripted モデルの単価で計算する
   * （入出力 $1/100万、cacheRead $0.1/100万、cacheWrite $1.25/100万。apps/agent の TEST_MODEL_PRICES と同じ）。
   */
  usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
  /** error と一緒に使う。上流の HTTP ステータス（AI Gateway の失敗の diagnostics.details.status と同じ形で報告する） */
  status?: number;
  /** モデルの呼び出しの失敗を再現する（stopReason: error。usage があればそれまでの消費として報告する） */
  error?: string;
  /** 出力の上限で切れた応答を再現する（stopReason: length。道具の呼び出しがあっても length にする） */
  stopReason?: "length";
  /** 応答を返すまでの待ち（ms）。呼び出しの途中で cancel されるケースの再現用。abort しても応答は返る（usage が後から増える）。 */
  delayMs?: number;
}

export const SCRIPTED_PROVIDER_ID = "scripted";
export const SCRIPTED_MODEL_ID = "script-1";

export const SCRIPTED_MODEL: Model<string> = {
  id: SCRIPTED_MODEL_ID,
  name: "Scripted fake model",
  api: "scripted",
  provider: SCRIPTED_PROVIDER_ID,
  baseUrl: "http://scripted.invalid",
  input: ["text"],
  cost: { input: 1, output: 1, cacheRead: 0.1, cacheWrite: 1.25 },
  reasoning: false,
  contextWindow: 100_000,
  maxTokens: 4096,
};

function textOf(content: string | readonly { type: string; text?: string }[]): string {
  if (typeof content === "string") return content;
  return content.map((c) => (c.type === "text" ? (c.text ?? "") : "")).join("");
}

/**
 * 台本のキー。最初の user メッセージの先頭の text だけを使う
 * （クライアントからの追加の指示 = steer は、後ろの text として添えられるので、キーを変えない）。
 */
function userText(context: TranscriptContext): string {
  const first = context.messages.find((m) => m.role === "user");
  if (!first) return "";
  if (typeof first.content === "string") return first.content;
  const head = first.content.find((c) => c.type === "text");
  return head && head.type === "text" ? head.text : "";
}

/** transcript の user メッセージの本文（テストの観測用） */
function userTexts(context: TranscriptContext): string[] {
  return context.messages.flatMap((m) =>
    m.role === "user" ? [textOf(m.content as Parameters<typeof textOf>[0])] : [],
  );
}

/**
 * system メッセージの本文（テストの観測用）。Pi の prompt section は system メッセージの sections（key → 本文）に入る
 * （内容が変わった section だけが後ろに足される）。content と sections の本文を、出てきた順に改行でつなぐ。無ければ undefined。
 */
function systemText(context: TranscriptContext): string | undefined {
  const texts = context.messages.flatMap((m) => {
    if (m.role !== "system") return [];
    const sections = (m as { sections?: Record<string, string | null> }).sections;
    return [
      textOf(m.content as Parameters<typeof textOf>[0]),
      ...Object.values(sections ?? {}).filter((v): v is string => typeof v === "string"),
    ].filter((t) => t !== "");
  });
  return texts.length > 0 ? texts.join("\n") : undefined;
}

/** transcript のツール結果の本文（テストの観測用。ツールの結果がモデルに届いたことの確認） */
function toolResultTexts(context: TranscriptContext): string[] {
  return context.messages.flatMap((m) =>
    m.role === "toolResult" ? [textOf(m.content as Parameters<typeof textOf>[0])] : [],
  );
}

/**
 * そのとき transcript で使えるツールの名前（テストの観測用）。system メッセージを順に再生して、toolsAdded を足し、toolsRemoved を引く。
 * 「レビューのモデルに渡る道具」の確認に使う。
 */
function toolNamesOf(context: TranscriptContext): string[] {
  const names: string[] = [];
  for (const m of context.messages) {
    if (m.role !== "system") continue;
    for (const t of m.toolsAdded ?? []) if (!names.includes(t.name)) names.push(t.name);
    for (const r of m.toolsRemoved ?? []) {
      const i = names.indexOf(r.name);
      if (i >= 0) names.splice(i, 1);
    }
  }
  return names;
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
  onCall?: (context: {
    userTexts: string[];
    toolResults: string[];
    /** 呼び出し側が渡した maxTokens と metadata（consult の上限・AI Gateway の metadata の確認用） */
    maxTokens?: number;
    metadata?: Record<string, unknown>;
    systemText?: string;
    /** 呼び出し側が渡した思考レベル（options.reasoning。思考オフなら undefined） */
    reasoning?: string;
    /** このリクエストでモデルに渡った道具の名前 */
    toolNames?: string[];
  }) => void,
): Provider {
  const stream = (
    _model: Model<string>,
    context: TranscriptContext,
    options?: {
      signal?: AbortSignal;
      maxTokens?: number;
      metadata?: Record<string, unknown>;
      reasoning?: string;
    },
  ) => {
    const out = createAssistantMessageEventStream();
    onCall?.({
      userTexts: userTexts(context),
      toolResults: toolResultTexts(context),
      maxTokens: options?.maxTokens,
      metadata: options?.metadata,
      systemText: systemText(context),
      reasoning: options?.reasoning,
      toolNames: toolNamesOf(context),
    });
    const turn = context.messages.filter((m) => m.role === "assistant").length;
    const step = getScript(userText(context))[turn] ?? { text: "script exhausted" };
    const inTok = step.usage?.input ?? 0;
    const outTok = step.usage?.output ?? 0;
    const readTok = step.usage?.cacheRead ?? 0;
    const writeTok = step.usage?.cacheWrite ?? 0;
    const cost = {
      input: inTok / 1e6,
      output: outTok / 1e6,
      cacheRead: (readTok * SCRIPTED_MODEL.cost.cacheRead) / 1e6,
      cacheWrite: (writeTok * SCRIPTED_MODEL.cost.cacheWrite) / 1e6,
      total: 0,
    };
    cost.total = cost.input + cost.output + cost.cacheRead + cost.cacheWrite;
    const usage = {
      ...ZERO_USAGE,
      input: inTok,
      output: outTok,
      cacheRead: readTok,
      cacheWrite: writeTok,
      totalTokens: inTok + outTok + readTok + writeTok,
      cost,
    };
    const content: AssistantMessage["content"] = [];
    if (step.text) content.push({ type: "text", text: step.text });
    const calls = step.toolCalls ?? (step.toolCall ? [step.toolCall] : []);
    const toolCall = calls.length > 0 ? true : undefined;
    calls.forEach((c, i) => {
      content.push({
        type: "toolCall",
        id: calls.length > 1 ? `call_${turn}_${i}` : `call_${turn}`,
        name: c.name,
        arguments: c.arguments as ToolCall["arguments"],
      });
    });
    const message: AssistantMessage = {
      role: "assistant",
      content,
      api: "scripted",
      provider: SCRIPTED_PROVIDER_ID,
      model: SCRIPTED_MODEL_ID,
      usage,
      stopReason: step.stopReason ?? (toolCall ? "toolUse" : "stop"),
      timestamp: Date.now(),
    };
    const emit = () => {
      if (step.error !== undefined) {
        const failed: AssistantMessage = {
          ...message,
          content: [],
          stopReason: "error",
          errorMessage: step.error,
          ...(step.status !== undefined
            ? {
                diagnostics: [
                  {
                    type: "cloudflare-error",
                    timestamp: Date.now(),
                    error: { name: "CloudflareAIError", message: step.error },
                    details: { status: step.status },
                  },
                ],
              }
            : {}),
        };
        out.push({ type: "error", reason: "error", error: failed });
        out.end(failed);
        return;
      }
      if (!step.delayMs) out.push({ type: "start", partial: message });
      out.push({
        type: "done",
        reason: message.stopReason as "stop" | "toolUse" | "length",
        message,
      });
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
    models: [SCRIPTED_MODEL],
    api: { stream, streamSimple: stream },
  });
}
