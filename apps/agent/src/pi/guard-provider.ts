import {
  type Api,
  type AssistantMessage,
  createAssistantMessageEventStream,
  type Model,
  type Provider,
  type SimpleStreamOptions,
  type StreamOptions,
  type ThinkingLevel,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { priceOverrideFor, thinkingOffFor } from "@rovo/models";

/**
 * 失敗したモデル呼び出しの上流の HTTP ステータス。agents の pi-ai 経路は、非 2xx の応答を CloudflareAIError にして、
 * メッセージの diagnostics（type: "cloudflare-error"）の details.status に載せる。エラー文は解釈しない。
 * 無ければ undefined（ストリームの途中の失敗・ネットワーク・中断など）。
 */
export function upstreamStatus(message: AssistantMessage): number | undefined {
  for (const d of message.diagnostics ?? []) {
    if (d.type !== "cloudflare-error") continue;
    const status = (d.details as { status?: unknown } | undefined)?.status;
    if (typeof status === "number" && Number.isFinite(status)) return status;
  }
  return undefined;
}

/**
 * リクエストの中身が拒否された応答か（待っても再試行しても直らない 4xx）。
 * 408（タイムアウト）・425・429（レート制限）は一時的なので含めない。
 * HTTP の 4xx はリクエストが生成の前に拒否された応答で、課金されない。
 */
export function isRequestRejection(status: number | undefined): boolean {
  return (
    status !== undefined &&
    status >= 400 &&
    status < 500 &&
    status !== 408 &&
    status !== 425 &&
    status !== 429
  );
}

/** モデル呼び出しの直前に呼ばれる。block を返すと、モデルを呼ばずにエラー応答にする。 */
export type CallGuard = (
  model: Model<Api>,
  context: TranscriptContext,
  options: StreamOptions | undefined,
) => Promise<CallVerdict>;

/**
 * guard が許可したときの返り値。reasoning は、このモデルの思考レベル（minimal / low / medium / high / xhigh / max）。
 * 無ければ思考オフで、Pi の options.reasoning を渡さない（thinking の値は THINKING_OFF の表で補正する）。
 */
export type CallVerdict =
  | { block: string }
  | { maxTokens: number; metadata: Record<string, unknown>; reasoning?: ThinkingLevel };

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
 * Pi 1.3.0 は思考を使わないとき（reasoning 未指定）に thinking: {type:"disabled"} を送る。
 * sonnet-5-5 はこれを 400 で拒否し "between_tools" を要求するが、haiku-5-5 は逆に between_tools を拒否する。
 * そのため @rovo/models の THINKING_OFF（モデルごとの表）に載っているモデルだけ、表の値へ置き換える。
 * 表に無いモデル（fable・未知のモデル）、disabled 以外の payload は触らない。
 */
export function fixAnthropicThinking(model: Model<Api>, payload: unknown): unknown {
  if (!isAnthropicModel(model) || typeof payload !== "object" || payload === null) return payload;
  const thinking = (payload as { thinking?: { type?: unknown } }).thinking;
  if (typeof thinking !== "object" || thinking === null || thinking.type !== "disabled") {
    return payload;
  }
  const off = thinkingOffFor(model.id);
  if (off === undefined || off === "disabled") return payload;
  return { ...payload, thinking: { type: off } };
}

/**
 * 送る直前の payload の出力上限（Anthropic の max_tokens / OpenAI の max_output_tokens）を maxTokens 以下に抑える。
 * 思考のトークンは出力として課金され、この上限の中に含まれる。Pi は budget 方式の思考（forceAdaptiveThinking でないモデル）で
 * maxTokens に思考の budget を足して送るので、その場合でも予約した額を超えないようにする（二重の防御）。
 */
export function capOutputTokens(payload: unknown, maxTokens: number): unknown {
  if (typeof payload !== "object" || payload === null) return payload;
  const p = payload as Record<string, unknown>;
  let out: Record<string, unknown> | undefined;
  for (const key of ["max_tokens", "max_output_tokens", "max_completion_tokens"]) {
    const v = p[key];
    if (typeof v === "number" && v > maxTokens) {
      out ??= { ...p };
      out[key] = maxTokens;
    }
  }
  // budget 方式の thinking は budget_tokens < max_tokens でないと 400 になる（費用ではなく model_error になる）。
  // max_tokens を絞ったら budget も合わせて下げる。Anthropic の最小（1,024）を割るなら思考を無効にする
  const thinking = (out ?? p).thinking as { type?: unknown; budget_tokens?: unknown } | undefined;
  const max = (out ?? p).max_tokens;
  if (
    out !== undefined &&
    typeof max === "number" &&
    thinking?.type === "enabled" &&
    typeof thinking.budget_tokens === "number" &&
    thinking.budget_tokens >= max
  ) {
    const budget = Math.floor(max / 2);
    out.thinking =
      budget >= MIN_THINKING_BUDGET ? { ...thinking, budget_tokens: budget } : { type: "disabled" };
  }
  return out ?? payload;
}

/** Anthropic の budget 方式の thinking の budget_tokens の最小値 */
const MIN_THINKING_BUDGET = 1_024;

/** 呼び出し側の onPayload を先に実行し、その結果（なければ元の payload）に補正と出力上限を掛ける。 */
function withPayloadFixes<O extends StreamOptions>(options: O | undefined, maxTokens: number): O {
  const original = options?.onPayload;
  return {
    ...options,
    onPayload: async (payload: unknown, model: Model<Api>) => {
      const replaced = await original?.(payload, model);
      return capOutputTokens(
        fixAnthropicThinking(model, replaced === undefined ? payload : replaced),
        maxTokens,
      );
    },
  } as O;
}

/**
 * カタログの単価の誤り（@rovo/models の PRICE_OVERRIDES）を直した Model を返す。Pi が usage.cost を計算するとき
 * （calculateCost(model, usage)）に使う model.cost に重ねるので、Pi の cost.total（タスク・review・consult の費用）も
 * 上書き後の単価になる。上書きが無ければ元の model をそのまま返す。呼び出し側のオブジェクトは書き換えない。
 */
export function withPriceOverride(model: Model<Api>): Model<Api> {
  const override = priceOverrideFor(model.id);
  if (!override) return model;
  // スプレッドで、agents が付けたルーティング用の（列挙可能な）タグも引き継ぐ
  return { ...model, cost: { ...model.cost, ...override } };
}

/** 「モデル呼び出し前」のフック。provider を包み、guard が拒否したら上流を呼ばない。 */
export function guardProvider(
  inner: Provider,
  guard: CallGuard,
  hooks: { onResult?: (message: AssistantMessage) => void } = {},
): Provider {
  const wrap =
    <O extends StreamOptions>(
      call: (
        model: Model<Api>,
        context: TranscriptContext,
        options?: O,
      ) => ReturnType<Provider["stream"]>,
      simple: boolean,
    ) =>
    (rawModel: Model<Api>, context: TranscriptContext, options?: O) => {
      const model = withPriceOverride(rawModel);
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
          const maxTokens = Math.min(options?.maxTokens ?? verdict.maxTokens, verdict.maxTokens);
          const { reasoning: _callerReasoning, ...rest } = withPayloadFixes(
            options,
            maxTokens,
          ) as O & { reasoning?: ThinkingLevel };
          const upstream = call(model, context, {
            ...rest,
            maxTokens,
            metadata: { ...options?.metadata, ...verdict.metadata },
            // 思考レベルはモデルごとに固定（呼び出し側の値より優先）。無ければオフ（reasoning を渡さない）
            ...(simple && verdict.reasoning !== undefined ? { reasoning: verdict.reasoning } : {}),
          } as O);
          for await (const event of upstream) out.push(event);
          const result = await upstream.result();
          hooks.onResult?.(result);
          out.end(result);
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
      if (key === "stream") return wrap<StreamOptions>((m, c, o) => target.stream(m, c, o), false);
      if (key === "streamSimple") {
        return wrap<SimpleStreamOptions>((m, c, o) => target.streamSimple(m, c, o), true);
      }
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
