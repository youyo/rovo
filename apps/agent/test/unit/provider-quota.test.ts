import { normalizeContext } from "@earendil-works/pi-ai";
import { modelInfo } from "@rovo/models";
import { describe, expect, it } from "vitest";
import { createModelAccess } from "../../src/agent/model-access";
import { runModelStep } from "../../src/model-step";
import {
  guardProvider,
  isProviderQuotaExhausted,
  upstreamStatus,
} from "../../src/pi/guard-provider";

// プロバイダーの残高切れ（OpenAI の response.failed の insufficient_quota / credit_balance_exhausted）の判定。
// 手書きの AssistantMessage ではなく、偽の AI バインディングから実際の SSE を流し、createAI（agents）→ pi-ai の
// processResponsesStream の経路を通して作られたメッセージで確かめる（pi-ai / agents の版が変わって形が変われば赤くなる）。

const OPENAI = "openai/gpt-6-sol";

function sse(events: unknown[]): Response {
  const body = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

/** OpenAI Responses の response.failed（error.code / error.message）を返す SSE */
function failedSse(code: string, message: string): Response {
  return sse([
    { type: "response.created", response: { id: "resp_1", status: "in_progress" } },
    {
      type: "response.failed",
      response: { id: "resp_1", status: "failed", error: { code, message } },
    },
  ]);
}

/** 偽の AI バインディング。Workers AI は run、ベンダーのモデル（AI Gateway の universal）は gateway(id).run を通る */
function fakeAI(response: () => Response) {
  const calls: { kind: "run" | "gateway"; input: unknown }[] = [];
  const binding = {
    run: async (_model: string, input: unknown) => {
      calls.push({ kind: "run", input });
      return response();
    },
    gateway: (_id: string) => ({
      run: async (input: unknown) => {
        calls.push({ kind: "gateway", input });
        return response();
      },
    }),
    aiGatewayLogId: null,
  };
  return { binding, calls };
}

const context = () =>
  normalizeContext({
    systemPrompt: "you are an architect",
    messages: [{ role: "user", content: "question", timestamp: 1 }],
  });

async function callModel(model: string, response: () => Response) {
  const { binding, calls } = fakeAI(response);
  const access = createModelAccess({ AI: binding as never, AI_GATEWAY_ID: "gw-1" });
  const message = await access.provider
    .streamSimple(access.model(model), context(), { maxTokens: 100 })
    .result();
  return { message, calls };
}
const callOpenAI = (response: () => Response) => callModel(OPENAI, response);

describe("response.failed の形（createAI の経路）", () => {
  it("insufficient_quota: api は openai-responses、status は無し、errorMessage は「<code>: <message>」", async () => {
    const { message, calls } = await callOpenAI(() =>
      failedSse("insufficient_quota", "You exceeded your current quota."),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.kind).toBe("gateway");
    expect(message.stopReason).toBe("error");
    expect(message.api).toBe("openai-responses");
    expect(upstreamStatus(message)).toBeUndefined();
    expect(message.errorMessage).toBe("insufficient_quota: You exceeded your current quota.");
  });
});

describe("isProviderQuotaExhausted（残高切れの判定。createAI の経路で作ったメッセージ）", () => {
  it("response.failed の insufficient_quota と credit_balance_exhausted は真", async () => {
    for (const code of ["insufficient_quota", "credit_balance_exhausted"]) {
      const { message } = await callOpenAI(() => failedSse(code, "Please try your request again."));
      expect(isProviderQuotaExhausted(message), code).toBe(true);
    }
  });

  it("別のコード・部分一致・大文字違いの response.failed は偽（今までどおり model_error）", async () => {
    for (const code of [
      "server_error",
      "rate_limit_exceeded",
      "insufficient_quota_soon",
      "x_insufficient_quota",
      "Insufficient_Quota",
      "",
    ]) {
      const { message } = await callOpenAI(() => failedSse(code, "insufficient_quota"));
      expect(message.stopReason, code).toBe("error");
      expect(isProviderQuotaExhausted(message), code).toBe(false);
    }
  });

  it("message の本文に insufficient_quota があっても、コードが違えば偽（本文は見ない）", async () => {
    const { message } = await callOpenAI(() =>
      failedSse("server_error", "insufficient_quota: credit_balance_exhausted"),
    );
    expect(isProviderQuotaExhausted(message)).toBe(false);
  });

  it("SSE の error イベント（「Error Code insufficient_quota: ...」になる）は偽", async () => {
    const { message } = await callOpenAI(() =>
      sse([{ type: "error", code: "insufficient_quota", message: "You exceeded your quota." }]),
    );
    expect(message.stopReason).toBe("error");
    expect(message.errorMessage).toMatch(/^Error Code insufficient_quota/);
    expect(isProviderQuotaExhausted(message)).toBe(false);
  });

  it("HTTP 429 の insufficient_quota は偽（status がある。再試行できる 429 のまま）", async () => {
    const { message } = await callOpenAI(
      () =>
        new Response(
          JSON.stringify({
            error: { type: "insufficient_quota", code: "insufficient_quota", message: "quota" },
          }),
          { status: 429, headers: { "content-type": "application/json" } },
        ),
    );
    expect(message.stopReason).toBe("error");
    expect(upstreamStatus(message)).toBe(429);
    expect(isProviderQuotaExhausted(message)).toBe(false);
  });

  it("Anthropic の 400「credit balance is too low」は偽（model_rejected のまま）", async () => {
    const { message } = await callModel(
      "anthropic/claude-sonnet-5-5",
      () =>
        new Response(
          JSON.stringify({
            type: "error",
            error: {
              type: "invalid_request_error",
              message: "Your credit balance is too low to access the Anthropic API.",
            },
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        ),
    );
    expect(message.stopReason).toBe("error");
    expect(message.api).toBe("anthropic-messages");
    expect(upstreamStatus(message)).toBe(400);
    expect(isProviderQuotaExhausted(message)).toBe(false);
    // Anthropic の経路は pi-ai の anthropic-messages を初回に遅延 import する。全体のテストを並べて流すと 5 秒を超えることがある
  }, 30_000);

  it("成功した応答は偽", async () => {
    const { message } = await callOpenAI(() =>
      sse([
        {
          type: "response.completed",
          response: {
            id: "resp_1",
            status: "completed",
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          },
        },
      ]),
    );
    expect(message.stopReason).not.toBe("error");
    expect(isProviderQuotaExhausted(message)).toBe(false);
  });

  it("前置きの「rovo: 」（guardProvider が例外を包んだ形）は外して判定する。api が openai-responses でなければ偽", async () => {
    const { message } = await callOpenAI(() => failedSse("insufficient_quota", "quota"));
    expect(
      isProviderQuotaExhausted({ ...message, errorMessage: `rovo: ${message.errorMessage}` }),
    ).toBe(true);
    expect(isProviderQuotaExhausted({ ...message, api: "anthropic-messages" })).toBe(false);
    expect(isProviderQuotaExhausted({ ...message, stopReason: "aborted" })).toBe(false);
    expect(isProviderQuotaExhausted({ ...message, errorMessage: undefined })).toBe(false);
  });
});

describe("runModelStep（consult とレビューの 1 歩）: 残高切れ", () => {
  it("quotaExhausted を立てて返し、上流は 1 回しか呼ばない（再試行しない）。usage が 0 なら費用 0", async () => {
    const { binding, calls } = fakeAI(() => failedSse("insufficient_quota", "quota"));
    const access = createModelAccess({ AI: binding as never, AI_GATEWAY_ID: "gw-1" });
    const price = modelInfo(OPENAI)?.price;
    if (!price) throw new Error("no price");
    const step = await runModelStep({
      provider: access.provider,
      model: access.model(OPENAI),
      price,
      messages: [{ role: "user", content: "question" }],
      maxTokens: 100,
      metadata: {},
      now: 1,
    });
    expect(calls).toHaveLength(1);
    expect(step).toMatchObject({
      kind: "error",
      quotaExhausted: true,
      rejected: false,
      reported: false,
      costUsd: 0,
    });
  });

  it("別のコードの response.failed は quotaExhausted が偽", async () => {
    const { binding } = fakeAI(() => failedSse("server_error", "boom"));
    const access = createModelAccess({ AI: binding as never, AI_GATEWAY_ID: "gw-1" });
    const price = modelInfo(OPENAI)?.price;
    if (!price) throw new Error("no price");
    const step = await runModelStep({
      provider: guardProvider(access.provider, async () => ({ maxTokens: 100, metadata: {} })),
      model: access.model(OPENAI),
      price,
      messages: [{ role: "user", content: "question" }],
      maxTokens: 100,
      metadata: {},
      now: 1,
    });
    expect(step).toMatchObject({ kind: "error", quotaExhausted: false });
  });
});
