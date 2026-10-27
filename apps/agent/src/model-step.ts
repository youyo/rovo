import {
  type Api,
  type AssistantMessage,
  type JsonObject,
  type Message,
  type Model,
  normalizeContext,
  type Provider,
  type ThinkingLevel,
  type TSchema,
} from "@earendil-works/pi-ai";
import { computeCostUsd, type ModelPrice } from "@rovo/models";
import { guardProvider, isRequestRejection, upstreamStatus } from "./pi/guard-provider";

/**
 * Pi のセッションを使わない「モデルを 1 回呼ぶ」歩（レビューのモデルと consult が共有する）。
 * 会話を Pi の Context に組み、guardProvider（thinking の補正・maxTokens の上限・metadata）を通して呼び、
 * usage と実費（単価表とプロバイダーの報告の大きい方）・テキスト・道具の呼び出しを返す。
 * 失敗の分類と費用の計上の規則（予約額で数えるか・見積額で数えるか）は呼び出し側が決める。
 */

const finiteCount = (v: unknown): number =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;

export interface StepToolDef {
  name: string;
  description: string;
  parameters: TSchema;
}

export interface StepToolCall {
  id: string;
  name: string;
  arguments: JsonObject;
}

/**
 * 歩に渡すメッセージ。user の content は文字列（consult）か text ブロックの並び（レビュー）。
 * assistant の toolCalls は、その応答で呼んだ道具。toolResult はその結果（呼び出しごとに 1 件）
 */
export type StepMessage =
  | { role: "user"; content: string | string[] }
  | {
      role: "assistant";
      text: string;
      toolCalls?: StepToolCall[];
      /**
       * 前の歩でモデルが返した assistant の content そのもの（#135）。あればこれで組み立てる（text と toolCalls は使わない）。
       * 署名つきの thinking（Anthropic）や reasoning のアイテム（OpenAI。thinkingSignature の JSON）を落とすと、
       * thinking が有効なときに道具の結果を渡す歩がプロバイダーに拒否される
       */
      content?: AssistantMessage["content"];
    }
  | { role: "toolResult"; id: string; name: string; text: string; isError: boolean };

export interface ModelStepRequest {
  provider: Provider;
  model: Model<Api>;
  price: ModelPrice;
  system?: string;
  /** 渡したときだけ、モデルに道具の定義を見せ、呼んだ道具を toolCalls に返す */
  tools?: StepToolDef[];
  messages: StepMessage[];
  maxTokens: number;
  metadata: Record<string, unknown>;
  reasoning?: ThinkingLevel;
  onPayload?: (payload: unknown, model: Model<Api>) => unknown;
  /** 応答を待つ上限（ms）。無ければ待ち続ける（例外は呼び出し側に投げる） */
  timeoutMs?: number;
  /** 上流を呼ぶ直前（guardProvider の中）に呼ぶ。レビューのモデル呼び出しの回数を数える */
  onCall?: () => void;
  /** 会話の時刻（Pi のメッセージの timestamp） */
  now: number;
}

export interface StepUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export type ModelStepOutcome =
  /** timeoutMs を過ぎた・呼び出しが例外で終わった（呼んだかどうかも実費も分からない） */
  | { kind: "timeout" }
  | {
      kind: "error";
      /** 4xx（リクエストの中身の問題。生成の前に拒否されたので課金されない） */
      rejected: boolean;
      stopReason: "error" | "aborted";
      /** 上流の HTTP ステータス（分かるときだけ。記録用） */
      status?: number;
      usage: StepUsage;
      costUsd: number;
      /** usage が返った（トークンが 1 以上） */
      reported: boolean;
    }
  | {
      kind: "ok";
      text: string;
      /** モデルが返した assistant の content（thinking・署名を含む。次の歩で戻す） */
      content: AssistantMessage["content"];
      toolCalls: StepToolCall[];
      /** 出力の上限で切れた */
      truncated: boolean;
      usage: StepUsage;
      costUsd: number;
      reported: boolean;
    };

const ZERO = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function toPiMessages(model: Model<Api>, messages: StepMessage[], now: number): Message[] {
  return messages.flatMap((m): Message[] => {
    if (m.role === "user") {
      return [
        {
          role: "user" as const,
          content:
            typeof m.content === "string"
              ? m.content
              : m.content.map((text) => ({ type: "text" as const, text })),
          timestamp: now,
        },
      ];
    }
    if (m.role === "toolResult") {
      return [
        {
          role: "toolResult" as const,
          toolCallId: m.id,
          toolName: m.name,
          content: [{ type: "text" as const, text: m.text }],
          isError: m.isError,
          timestamp: now,
        },
      ];
    }
    const calls = m.toolCalls ?? [];
    const stopReason = calls.length > 0 ? ("toolUse" as const) : ("stop" as const);
    if (m.content) {
      return [
        {
          role: "assistant" as const,
          content: m.content,
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: ZERO,
          stopReason,
          timestamp: now,
        },
      ];
    }
    return [
      {
        role: "assistant" as const,
        content: [
          ...(m.text !== "" || calls.length === 0 ? [{ type: "text" as const, text: m.text }] : []),
          ...calls.map((c) => ({
            type: "toolCall" as const,
            id: c.id,
            name: c.name,
            arguments: c.arguments,
          })),
        ],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: ZERO,
        stopReason: calls.length > 0 ? ("toolUse" as const) : ("stop" as const),
        timestamp: now,
      },
    ];
  });
}

export async function runModelStep(req: ModelStepRequest): Promise<ModelStepOutcome> {
  const context = normalizeContext({
    ...(req.system ? { systemPrompt: req.system } : {}),
    ...(req.tools
      ? {
          tools: req.tools.map((t) => ({
            name: t.name,
            description: t.description,
            parameters: t.parameters,
          })),
        }
      : {}),
    messages: toPiMessages(req.model, req.messages, req.now),
  });
  const guarded = guardProvider(req.provider, async () => {
    req.onCall?.();
    return {
      maxTokens: req.maxTokens,
      metadata: req.metadata,
      ...(req.reasoning !== undefined ? { reasoning: req.reasoning } : {}),
    };
  });
  const call = () =>
    guarded
      .streamSimple(req.model, context, {
        maxTokens: req.maxTokens,
        ...(req.onPayload ? { onPayload: req.onPayload } : {}),
      })
      .result();
  let message: AssistantMessage;
  if (req.timeoutMs === undefined) {
    message = await call();
  } else {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      message = await Promise.race([
        call(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("model step timeout")), req.timeoutMs);
        }),
      ]);
    } catch {
      return { kind: "timeout" };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
  const usage: StepUsage = {
    input: finiteCount(message.usage?.input),
    output: finiteCount(message.usage?.output),
    cacheRead: finiteCount(message.usage?.cacheRead),
    cacheWrite: finiteCount(message.usage?.cacheWrite),
  };
  // 実費は単価表（カタログ由来）から計算し、プロバイダー側の報告がそれより大きければそちらを採る（少なく数えない）
  const costUsd = Math.max(
    computeCostUsd(req.price, usage),
    finiteCount(message.usage?.cost?.total),
  );
  const reported = usage.input + usage.output + usage.cacheRead + usage.cacheWrite > 0;
  if (message.stopReason === "error" || message.stopReason === "aborted") {
    const status = message.stopReason === "error" ? upstreamStatus(message) : undefined;
    return {
      kind: "error",
      rejected: isRequestRejection(status),
      stopReason: message.stopReason,
      ...(status !== undefined ? { status } : {}),
      usage,
      costUsd,
      reported,
    };
  }
  const text = message.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("");
  const toolCalls = req.tools
    ? message.content.flatMap((c) =>
        c.type === "toolCall" ? [{ id: c.id, name: c.name, arguments: c.arguments }] : [],
      )
    : [];
  return {
    kind: "ok",
    text,
    content: message.content,
    toolCalls,
    truncated: message.stopReason === "length",
    usage,
    costUsd,
    reported,
  };
}
