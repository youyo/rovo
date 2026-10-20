import {
  type Api,
  type AssistantMessage,
  createAssistantMessageEventStream,
  type Model,
  type Provider,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { guardProvider } from "../../src/pi/guard-provider";

const message = (model: Model<Api>): AssistantMessage => ({
  role: "assistant",
  content: [],
  api: model.api,
  provider: model.provider,
  model: model.id,
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "stop",
  timestamp: 0,
});

const anthropicModel = {
  id: "claude-sonnet-5-5",
  api: "anthropic-messages",
  provider: "cloudflare",
} as unknown as Model<Api>;
const scriptedModel = {
  id: "script",
  api: "scripted",
  provider: "scripted",
} as unknown as Model<Api>;
const context = { messages: [] } as unknown as TranscriptContext;

/** 上流が onPayload に payload を渡し、差し替え後の payload を返す fake */
async function run(model: Model<Api>, payload: unknown, via: "stream" | "streamSimple") {
  let seen: unknown;
  const inner = {
    stream: (
      m: Model<Api>,
      _c: unknown,
      o?: { onPayload?: (p: unknown, m: Model<Api>) => unknown },
    ) => call(m, o),
    streamSimple: (
      m: Model<Api>,
      _c: unknown,
      o?: { onPayload?: (p: unknown, m: Model<Api>) => unknown },
    ) => call(m, o),
  } as unknown as Provider;
  const call = (m: Model<Api>, o?: { onPayload?: (p: unknown, m: Model<Api>) => unknown }) => {
    const out = createAssistantMessageEventStream();
    void (async () => {
      const replaced = await o?.onPayload?.(payload, m);
      seen = replaced === undefined ? payload : replaced;
      out.end(message(m));
    })();
    return out;
  };
  const guarded = guardProvider(inner, async () => ({ maxTokens: 100, metadata: {} }));
  const s = guarded[via](model, context, {} as never);
  await s.result();
  return seen as Record<string, unknown>;
}

describe("guardProvider の thinking 補正", () => {
  for (const via of ["stream", "streamSimple"] as const) {
    it(`Anthropic の thinking: disabled を between_tools にする (${via})`, async () => {
      const seen = await run(
        anthropicModel,
        { model: "claude-sonnet-5-5", messages: [], thinking: { type: "disabled" } },
        via,
      );
      expect(seen.thinking).toEqual({ type: "between_tools" });
      expect(seen.model).toBe("claude-sonnet-5-5");
    });
  }

  it("thinking が disabled 以外なら変えない", async () => {
    const payload = { messages: [], thinking: { type: "adaptive", display: "summarized" } };
    expect(await run(anthropicModel, payload, "streamSimple")).toEqual(payload);
  });

  it("thinking が無ければ変えない", async () => {
    const payload = { messages: [] };
    expect(await run(anthropicModel, payload, "streamSimple")).toEqual(payload);
  });

  it("Anthropic 以外のモデルでは disabled でも変えない", async () => {
    const payload = { messages: [], thinking: { type: "disabled" } };
    expect(await run(scriptedModel, payload, "streamSimple")).toEqual(payload);
  });

  it("OpenAI（openai-responses。D10）の payload には触らない（thinking の補正は Anthropic だけ）", async () => {
    const openaiModel = {
      id: "openai/gpt-6-sol",
      api: "openai-responses",
      provider: "cloudflare",
    } as unknown as Model<Api>;
    const payload = {
      model: "gpt-6-sol",
      input: [],
      reasoning: { effort: "none" },
      thinking: { type: "disabled" },
    };
    for (const via of ["stream", "streamSimple"] as const) {
      expect(await run(openaiModel, payload, via)).toEqual(payload);
    }
  });

  it("呼び出し側の onPayload を先に実行し、その結果にも補正を掛ける", async () => {
    let seen: unknown;
    const inner = {
      streamSimple: (
        m: Model<Api>,
        _c: unknown,
        o?: { onPayload?: (p: unknown, m: Model<Api>) => unknown },
      ) => {
        const out = createAssistantMessageEventStream();
        void (async () => {
          seen = await o?.onPayload?.({ messages: [], thinking: { type: "disabled" } }, m);
          out.end(message(m));
        })();
        return out;
      },
    } as unknown as Provider;
    const guarded = guardProvider(inner, async () => ({ maxTokens: 1, metadata: {} }));
    const s = guarded.streamSimple(anthropicModel, context, {
      onPayload: (p: unknown) => ({ ...(p as object), extra: 1 }),
    } as never);
    await s.result();
    expect(seen).toEqual({ messages: [], thinking: { type: "between_tools" }, extra: 1 });
  });
});
