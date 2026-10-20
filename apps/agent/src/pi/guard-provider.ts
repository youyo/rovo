import {
  type Api,
  type AssistantMessage,
  createAssistantMessageEventStream,
  type Model,
  type Provider,
  type SimpleStreamOptions,
  type StreamOptions,
  type TranscriptContext,
} from "@earendil-works/pi-ai";

/** モデル呼び出しの直前に呼ばれる。block を返すと、モデルを呼ばずにエラー応答にする。 */
export type CallGuard = (
  model: Model<Api>,
  context: TranscriptContext,
  options: StreamOptions | undefined,
) => Promise<{ block: string } | { maxTokens: number; metadata: Record<string, unknown> }>;

const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const isAnthropicModel = (model: Model<Api>): boolean =>
  model.api === "anthropic-messages" || /claude/i.test(model.id);

/**
 * Pi 1.3.0 は思考を使わないとき（reasoning 未指定）に thinking: {type:"disabled"} を送るが、
 * claude-sonnet-5-5 はこれを 400 で拒否し、"between_tools" を要求する。送る直前に置き換える。
 * Anthropic のモデルで thinking.type が "disabled" のときだけ変え、それ以外の payload は触らない。
 */
export function fixAnthropicThinking(model: Model<Api>, payload: unknown): unknown {
  if (!isAnthropicModel(model) || typeof payload !== "object" || payload === null) return payload;
  const thinking = (payload as { thinking?: { type?: unknown } }).thinking;
  if (typeof thinking !== "object" || thinking === null || thinking.type !== "disabled") {
    return payload;
  }
  return { ...payload, thinking: { type: "between_tools" } };
}

/** 呼び出し側の onPayload を先に実行し、その結果（なければ元の payload）に補正を掛ける。 */
function withThinkingFix<O extends StreamOptions>(options: O | undefined): O {
  const original = options?.onPayload;
  return {
    ...options,
    onPayload: async (payload: unknown, model: Model<Api>) => {
      const replaced = await original?.(payload, model);
      return fixAnthropicThinking(model, replaced === undefined ? payload : replaced);
    },
  } as O;
}

/** 「モデル呼び出し前」のフック。provider を包み、guard が拒否したら上流を呼ばない。 */
export function guardProvider(inner: Provider, guard: CallGuard): Provider {
  const wrap =
    <O extends StreamOptions>(
      call: (
        model: Model<Api>,
        context: TranscriptContext,
        options?: O,
      ) => ReturnType<Provider["stream"]>,
    ) =>
    (model: Model<Api>, context: TranscriptContext, options?: O) => {
      const out = createAssistantMessageEventStream();
      void (async () => {
        try {
          const verdict = await guard(model, context, options);
          if ("block" in verdict) {
            const message: AssistantMessage = {
              role: "assistant",
              content: [],
              api: model.api,
              provider: model.provider,
              model: model.id,
              usage: ZERO_USAGE,
              stopReason: "error",
              errorMessage: `rovo: model call blocked (${verdict.block})`,
              timestamp: Date.now(),
            };
            out.push({ type: "error", reason: "error", error: message });
            out.end(message);
            return;
          }
          const upstream = call(model, context, {
            ...withThinkingFix(options),
            maxTokens: Math.min(options?.maxTokens ?? verdict.maxTokens, verdict.maxTokens),
            metadata: { ...options?.metadata, ...verdict.metadata },
          } as O);
          for await (const event of upstream) out.push(event);
          out.end(await upstream.result());
        } catch (e) {
          const message: AssistantMessage = {
            role: "assistant",
            content: [],
            api: model.api,
            provider: model.provider,
            model: model.id,
            usage: ZERO_USAGE,
            stopReason: "error",
            errorMessage: `rovo: ${e instanceof Error ? e.message : String(e)}`,
            timestamp: Date.now(),
          };
          out.push({ type: "error", reason: "error", error: message });
          out.end(message);
        }
      })();
      return out;
    };

  return new Proxy(inner, {
    get(target, key) {
      if (key === "stream") return wrap<StreamOptions>((m, c, o) => target.stream(m, c, o));
      if (key === "streamSimple") {
        return wrap<SimpleStreamOptions>((m, c, o) => target.streamSimple(m, c, o));
      }
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
