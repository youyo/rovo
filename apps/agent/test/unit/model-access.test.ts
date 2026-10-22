import { normalizeContext, Type } from "@earendil-works/pi-ai";
import { type Effort, isEffort } from "@rovo/models";
import { describe, expect, it } from "vitest";
import { modelEffort, reasoningFor } from "../../src/agent/config";
import { createModelAccess, sessionModelRef } from "../../src/agent/model-access";
import { guardProvider } from "../../src/pi/guard-provider";

// D10b: Workers AI のモデルが、AI バインディング（env.AI.run）経由で、tool calling と思考レベルつきで動くことを確かめる。
// 実 AI は呼ばず、バインディングは偽物（run の引数を記録し、chat completions の SSE を返す）。

const OSS = "workers-ai/@cf/openai/gpt-oss-120b";

type RunCall = { model: string; input: Record<string, unknown>; options: Record<string, unknown> };

function sse(chunks: unknown[]): Response {
  const body = `${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

function fakeAI(response: () => Response) {
  const calls: RunCall[] = [];
  const binding = {
    run: async (
      model: string,
      input: Record<string, unknown>,
      options: Record<string, unknown>,
    ) => {
      calls.push({ model, input, options });
      return response();
    },
    aiGatewayLogId: null,
  };
  return { binding, calls };
}

// stream_options.include_usage の形: 最後に choices が空で usage だけのチャンクが来る（agents の Workers AI 用の正規化が読む）
const toolCallResponse = () =>
  sse([
    {
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "call_1",
                type: "function",
                function: { name: "report_completion", arguments: '{"summary":"done"}' },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    },
    { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    { choices: [], usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 } },
  ]);

const context = () =>
  normalizeContext({
    systemPrompt: "you are an agent",
    messages: [{ role: "user", content: "finish the task", timestamp: 1 }],
    tools: [
      {
        name: "report_completion",
        description: "report",
        parameters: Type.Object({ summary: Type.String() }),
      },
    ],
  });

describe("sessionModelRef / piModelId: Pi に渡す id", () => {
  it("Workers AI は @cf/ の id（createAI は workers-ai/ の specifier を TypeError で拒否する）、他は rovo の id のまま", () => {
    expect(sessionModelRef(OSS)).toEqual({ provider: "cloudflare", id: "@cf/openai/gpt-oss-120b" });
    expect(sessionModelRef("anthropic/claude-sonnet-5-5")).toEqual({
      provider: "cloudflare",
      id: "anthropic/claude-sonnet-5-5",
    });
  });
});

describe("createModelAccess: Workers AI のモデル（AI バインディング経由）", () => {
  it("model() が @cf/ の id のモデル（api: cloudflare-ai）を返し、Anthropic の id は AI Gateway のモデルのまま", () => {
    const { binding } = fakeAI(toolCallResponse);
    const access = createModelAccess({ AI: binding as never, AI_GATEWAY_ID: "gw-1" });
    const m = access.model(OSS);
    expect(m.id).toBe("@cf/openai/gpt-oss-120b");
    expect(m.api).toBe("cloudflare-ai");
    const c = access.model("anthropic/claude-sonnet-5-5");
    expect(c.api).toBe("anthropic-messages");
  });

  it("tool calling: ツール定義を送り、tool_calls の応答を toolUse の tool call として読む。AI Gateway の ID を渡す", async () => {
    const { binding, calls } = fakeAI(toolCallResponse);
    const access = createModelAccess({ AI: binding as never, AI_GATEWAY_ID: "gw-1" });
    const result = await access.provider
      .streamSimple(access.model(OSS), context(), { maxTokens: 500 })
      .result();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.model).toBe("@cf/openai/gpt-oss-120b");
    expect(calls[0]?.options).toMatchObject({ gateway: { id: "gw-1" }, returnRawResponse: true });
    const tools = calls[0]?.input.tools as { type: string; function: { name: string } }[];
    expect(tools.map((t) => [t.type, t.function.name])).toEqual([
      ["function", "report_completion"],
    ]);
    expect(result.stopReason).toBe("toolUse");
    expect(result.content.find((c) => c.type === "toolCall")).toMatchObject({
      name: "report_completion",
      arguments: { summary: "done" },
    });
    expect(result.usage).toMatchObject({ input: 120, output: 30 });
  });

  it("guardProvider 越し: 思考レベル（low）は reasoning_effort で渡り、出力上限は max_tokens に掛かる。thinking の補正は何もしない", async () => {
    const { binding, calls } = fakeAI(toolCallResponse);
    const access = createModelAccess({ AI: binding as never, AI_GATEWAY_ID: "gw-1" });
    const guarded = guardProvider(access.provider, async () => ({
      maxTokens: 300,
      metadata: { taskId: "t1" },
      reasoning: "low",
    }));
    const result = await guarded
      .streamSimple(access.model(OSS), context(), { maxTokens: 9999 })
      .result();
    expect(result.stopReason).toBe("toolUse");
    const input = calls[0]?.input ?? {};
    expect(input.reasoning_effort).toBe("low");
    expect(input.max_tokens).toBe(300);
    expect(input).not.toHaveProperty("thinking");
  });

  it("思考オフ（reasoning を渡さない）なら reasoning_effort も送らない", async () => {
    const { binding, calls } = fakeAI(toolCallResponse);
    const access = createModelAccess({ AI: binding as never, AI_GATEWAY_ID: "gw-1" });
    const guarded = guardProvider(access.provider, async () => ({ maxTokens: 300, metadata: {} }));
    await guarded.streamSimple(access.model(OSS), context(), {}).result();
    expect(calls[0]?.input).not.toHaveProperty("reasoning_effort");
  });

  it("上流の 4xx は cloudflare-error の diagnostic に status が載る（consult の model_rejected が判定に使う）", async () => {
    const { binding } = fakeAI(
      () => new Response(JSON.stringify({ error: { message: "bad" } }), { status: 400 }),
    );
    const access = createModelAccess({ AI: binding as never, AI_GATEWAY_ID: "gw-1" });
    const result = await access.provider
      .streamSimple(access.model(OSS), context(), { maxTokens: 100 })
      .result();
    expect(result.stopReason).toBe("error");
    const d = (result.diagnostics ?? []).find((x) => x.type === "cloudflare-error");
    expect((d?.details as { status?: number } | undefined)?.status).toBe(400);
  });

  it("AI バインディングが無ければエラー", () => {
    expect(() => createModelAccess({})).toThrow("AI binding is not configured");
  });
});

// タスクの spec.effort（task_start の effort）を reasoningFor で Pi の reasoning にし、guardProvider 越しに Workers AI の
// reasoning_effort として送るまで。gpt-oss-120b の既定は low（EFFORTS の初期値）。
describe("spec.effort（タスクごとの思考レベル）→ reasoning → Workers AI の reasoning_effort", () => {
  /** そのタスクの spec.effort（無ければ undefined）で 1 回呼び、AI.run に渡った input を返す */
  async function runWith(specEffort: Effort | undefined, modelEfforts?: string) {
    const { binding, calls } = fakeAI(toolCallResponse);
    const access = createModelAccess({ AI: binding as never, AI_GATEWAY_ID: "gw-1" });
    const reasoning = reasoningFor(specEffort, modelEffort({}, OSS, modelEfforts));
    const guarded = guardProvider(access.provider, async () => ({
      maxTokens: 300,
      metadata: { taskId: "t1" },
      ...(reasoning !== undefined ? { reasoning } : {}),
    }));
    await guarded.streamSimple(access.model(OSS), context(), {}).result();
    return calls[0]?.input ?? {};
  }

  it("spec.effort があれば、モデルの既定（low）より優先して reasoning_effort に渡る", async () => {
    for (const effort of ["medium", "high"] as const) {
      expect((await runWith(effort)).reasoning_effort, effort).toBe(effort);
    }
  });

  it("MODEL_EFFORTS の上書きよりも spec.effort が優先する", async () => {
    expect((await runWith("high", `${OSS}=medium`)).reasoning_effort).toBe("high");
    expect((await runWith(undefined, `${OSS}=medium`)).reasoning_effort).toBe("medium");
  });

  it("spec.effort が off なら reasoning を渡さない（reasoning_effort も送らない）。既定が low でも", async () => {
    expect(reasoningFor("off", "low")).toBeUndefined();
    expect(await runWith("off")).not.toHaveProperty("reasoning_effort");
  });

  it("spec.effort が無ければ従来どおりモデルの既定（low）。既定が off なら渡さない", async () => {
    expect(reasoningFor(undefined, "low")).toBe("low");
    expect((await runWith(undefined)).reasoning_effort).toBe("low");
    expect(reasoningFor(undefined, "off")).toBeUndefined();
    expect(reasoningFor(undefined, undefined)).toBeUndefined();
  });

  it("start の検査（isEffort）: 既知のレベルだけ通し、知らない値は拒否する", () => {
    for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
      expect(isEffort(level), level).toBe(true);
    }
    for (const bad of ["turbo", "", "HIGH", "none", 3, null, ["high"]]) {
      expect(isEffort(bad), JSON.stringify(bad)).toBe(false);
    }
  });
});
