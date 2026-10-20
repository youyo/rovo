import {
  type Api,
  type AssistantMessage,
  createAssistantMessageEventStream,
  type Model,
  type Provider,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { capOutputTokens, guardProvider } from "../../src/pi/guard-provider";

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

  it("sonnet は rovo の id（接頭辞つき）で来ても置き換える", async () => {
    const m = { ...anthropicModel, id: "anthropic/claude-sonnet-5-5" } as unknown as Model<Api>;
    const seen = await run(m, { messages: [], thinking: { type: "disabled" } }, "streamSimple");
    expect(seen.thinking).toEqual({ type: "between_tools" });
  });

  it("haiku は between_tools を 400 で拒否するので、disabled のまま送る", async () => {
    for (const id of ["claude-haiku-5-5", "anthropic/claude-haiku-5-5"]) {
      const m = { ...anthropicModel, id } as unknown as Model<Api>;
      const payload = { messages: [], thinking: { type: "disabled" } };
      expect(await run(m, payload, "streamSimple")).toEqual(payload);
    }
  });

  it("表に無い Anthropic のモデルは置き換えない（Pi の disabled のまま）", async () => {
    const m = { ...anthropicModel, id: "claude-unknown-9" } as unknown as Model<Api>;
    const payload = { messages: [], thinking: { type: "disabled" } };
    expect(await run(m, payload, "streamSimple")).toEqual(payload);
  });

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

/** 上流の streamSimple / stream が受け取った options を記録する */
async function runOptions(
  verdict: { maxTokens: number; metadata: Record<string, unknown>; reasoning?: string },
  via: "stream" | "streamSimple",
  options: Record<string, unknown> = {},
) {
  let seen: Record<string, unknown> = {};
  const inner = {
    stream: (m: Model<Api>, _c: unknown, o?: Record<string, unknown>) => call(m, o),
    streamSimple: (m: Model<Api>, _c: unknown, o?: Record<string, unknown>) => call(m, o),
  } as unknown as Provider;
  const call = (m: Model<Api>, o?: Record<string, unknown>) => {
    seen = o ?? {};
    const out = createAssistantMessageEventStream();
    out.end(message(m));
    return out;
  };
  const guarded = guardProvider(inner, async () => verdict as never);
  await guarded[via](anthropicModel, context, options as never).result();
  return seen;
}

describe("guardProvider の思考レベル（reasoning）", () => {
  it("guard が返した reasoning を streamSimple の options.reasoning に渡す", async () => {
    for (const level of ["minimal", "low", "medium", "high", "xhigh", "max"]) {
      const seen = await runOptions(
        { maxTokens: 100, metadata: {}, reasoning: level },
        "streamSimple",
      );
      expect(seen.reasoning).toBe(level);
    }
  });

  it("reasoning が無い（= off）なら渡さない。呼び出し側が渡していても消す（モデルごとの固定を優先）", async () => {
    const none = await runOptions({ maxTokens: 100, metadata: {} }, "streamSimple");
    expect("reasoning" in none).toBe(false);
    const overridden = await runOptions({ maxTokens: 100, metadata: {} }, "streamSimple", {
      reasoning: "high",
    });
    expect(overridden.reasoning).toBeUndefined();
    const replaced = await runOptions(
      { maxTokens: 100, metadata: {}, reasoning: "low" },
      "streamSimple",
      { reasoning: "high" },
    );
    expect(replaced.reasoning).toBe("low");
  });

  it("stream（簡易でない経路）には reasoning を足さない", async () => {
    const seen = await runOptions({ maxTokens: 100, metadata: {}, reasoning: "high" }, "stream");
    expect("reasoning" in seen).toBe(false);
  });

  it("maxTokens は guard の上限を超えない（思考を含めた出力の上限）", async () => {
    const seen = await runOptions(
      { maxTokens: 100, metadata: {}, reasoning: "high" },
      "streamSimple",
      { maxTokens: 5000 },
    );
    expect(seen.maxTokens).toBe(100);
  });
});

describe("guardProvider の出力上限の二重化（payload）", () => {
  it("送る直前の payload の max_tokens / max_output_tokens が guard の上限を超えていたら上限へ下げる", async () => {
    const m = anthropicModel;
    let seen: unknown;
    const inner = {
      streamSimple: (
        mm: Model<Api>,
        _c: unknown,
        o?: { onPayload?: (p: unknown, m: Model<Api>) => unknown },
      ) => {
        const out = createAssistantMessageEventStream();
        void (async () => {
          seen = await o?.onPayload?.(
            { max_tokens: 5000, max_output_tokens: 7000, messages: [] },
            mm,
          );
          out.end(message(mm));
        })();
        return out;
      },
    } as unknown as Provider;
    const guarded = guardProvider(
      inner,
      async () => ({ maxTokens: 100, metadata: {}, reasoning: "high" }) as never,
    );
    await guarded.streamSimple(m, context, {} as never).result();
    expect(seen).toEqual({ max_tokens: 100, max_output_tokens: 100, messages: [] });
  });

  it("max_completion_tokens（Workers AI の一部のモデルの quirk が書き換える先）も上限へ下げる（D10b）", async () => {
    let seen: unknown;
    const inner = {
      streamSimple: (
        mm: Model<Api>,
        _c: unknown,
        o?: { onPayload?: (p: unknown, m: Model<Api>) => unknown },
      ) => {
        const out = createAssistantMessageEventStream();
        void (async () => {
          seen = await o?.onPayload?.({ max_completion_tokens: 9000, messages: [] }, mm);
          out.end(message(mm));
        })();
        return out;
      },
    } as unknown as Provider;
    const guarded = guardProvider(inner, async () => ({ maxTokens: 100, metadata: {} }));
    await guarded.streamSimple(anthropicModel, context, {} as never).result();
    expect(seen).toEqual({ max_completion_tokens: 100, messages: [] });
  });

  it("上限以下なら変えない", async () => {
    const payload = { max_tokens: 50, messages: [] };
    let seen: unknown;
    const inner = {
      streamSimple: (
        mm: Model<Api>,
        _c: unknown,
        o?: { onPayload?: (p: unknown, m: Model<Api>) => unknown },
      ) => {
        const out = createAssistantMessageEventStream();
        void (async () => {
          seen = await o?.onPayload?.(payload, mm);
          out.end(message(mm));
        })();
        return out;
      },
    } as unknown as Provider;
    const guarded = guardProvider(inner, async () => ({ maxTokens: 100, metadata: {} }));
    await guarded.streamSimple(anthropicModel, context, {} as never).result();
    expect(seen).toEqual(payload);
  });
});

describe("capOutputTokens: budget 方式の thinking", () => {
  it("max_tokens を下げたとき、budget_tokens が max_tokens 未満になるよう下げる", () => {
    const out = capOutputTokens(
      { max_tokens: 16_000, thinking: { type: "enabled", budget_tokens: 8_000 } },
      6_000,
    ) as { max_tokens: number; thinking: { type: string; budget_tokens?: number } };
    expect(out.max_tokens).toBe(6_000);
    expect(out.thinking.type).toBe("enabled");
    expect(out.thinking.budget_tokens).toBeLessThan(6_000);
    expect(out.thinking.budget_tokens).toBeGreaterThanOrEqual(1_024);
  });

  it("下げた budget が最小（1,024）を割るなら、thinking を無効にする", () => {
    const out = capOutputTokens(
      { max_tokens: 16_000, thinking: { type: "enabled", budget_tokens: 8_000 } },
      1_500,
    ) as { max_tokens: number; thinking: { type: string; budget_tokens?: number } };
    expect(out.max_tokens).toBe(1_500);
    expect(out.thinking).toEqual({ type: "disabled" });
  });

  it("budget が max_tokens 未満のままなら触らない。thinking が無い payload も触らない", () => {
    const a = { max_tokens: 4_000, thinking: { type: "enabled", budget_tokens: 2_000 } };
    expect(capOutputTokens(a, 6_000)).toBe(a);
    const b = { max_tokens: 16_000 };
    expect(capOutputTokens(b, 6_000)).toEqual({ max_tokens: 6_000 });
  });
});
