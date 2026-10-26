import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { applyConsultCacheControl } from "../../src/pi/consult-cache";

const model = (api: string, id: string) => ({ api, id }) as unknown as Model<Api>;
const anthropic = model("anthropic-messages", "claude-sonnet-5-5");
const eph = { type: "ephemeral" };

describe("applyConsultCacheControl（consult の prompt caching）", () => {
  it("system の末尾と、最後の user より前の部分の末尾に cache_control を付ける", () => {
    const payload = {
      model: "claude-sonnet-5-5",
      system: [{ type: "text", text: "S", cache_control: eph }],
      messages: [
        { role: "user", content: [{ type: "text", text: "q1" }] },
        { role: "assistant", content: [{ type: "text", text: "a1" }] },
        { role: "user", content: [{ type: "text", text: "q2", cache_control: eph }] },
      ],
    };
    const out = applyConsultCacheControl(anthropic, payload) as typeof payload;
    expect(out.system[0]?.cache_control).toEqual(eph);
    // 最後の user の 1 つ前（assistant）の末尾ブロックにブレークポイント
    expect(out.messages[1]?.content[0]).toEqual({ type: "text", text: "a1", cache_control: eph });
    // 最後の user（毎回変わる）には付けない。pi が既定で付けるものも外す
    expect(out.messages[2]?.content[0]).toEqual({ type: "text", text: "q2" });
    expect(out.messages[0]?.content[0]).toEqual({ type: "text", text: "q1" });
  });

  it("system が文字列・system 無しでも壊れない。system があれば末尾ブロックに付ける", () => {
    const withSystem = applyConsultCacheControl(anthropic, {
      system: [
        { type: "text", text: "A" },
        { type: "text", text: "B" },
      ],
      messages: [{ role: "user", content: [{ type: "text", text: "q" }] }],
    }) as { system: { cache_control?: unknown }[] };
    expect(withSystem.system[0]?.cache_control).toBeUndefined();
    expect(withSystem.system[1]?.cache_control).toEqual(eph);
    const noSystem = applyConsultCacheControl(anthropic, {
      messages: [{ role: "user", content: [{ type: "text", text: "q" }] }],
    }) as { system?: unknown };
    expect(noSystem.system).toBeUndefined();
  });

  it("user が 1 つだけなら、メッセージには付けない（system だけ）", () => {
    const out = applyConsultCacheControl(anthropic, {
      system: [{ type: "text", text: "S" }],
      messages: [{ role: "user", content: [{ type: "text", text: "q", cache_control: eph }] }],
    }) as { messages: { content: { cache_control?: unknown }[] }[] };
    expect(out.messages[0]?.content[0]?.cache_control).toBeUndefined();
  });

  it("最後の user より前のメッセージの content が文字列なら、ブロックに直して付ける", () => {
    const out = applyConsultCacheControl(anthropic, {
      messages: [
        { role: "user", content: "q1" },
        { role: "assistant", content: "a1" },
        { role: "user", content: "q2" },
      ],
    }) as { messages: { content: unknown }[] };
    expect(out.messages[1]?.content).toEqual([{ type: "text", text: "a1", cache_control: eph }]);
    expect(out.messages[2]?.content).toBe("q2");
  });

  it("最後の user の前に付けたブレークポイントは 1 つだけ（messages のほかの cache_control は外す）", () => {
    const out = applyConsultCacheControl(anthropic, {
      messages: [
        { role: "user", content: [{ type: "text", text: "q1", cache_control: eph }] },
        { role: "assistant", content: [{ type: "text", text: "a1", cache_control: eph }] },
        { role: "user", content: [{ type: "text", text: "q2", cache_control: eph }] },
      ],
    }) as { messages: { content: { cache_control?: unknown }[] }[] };
    const marked = out.messages.flatMap((m) => m.content).filter((b) => b.cache_control);
    expect(marked).toHaveLength(1);
    expect(out.messages[1]?.content[0]?.cache_control).toEqual(eph);
  });

  it("道具の往復の歩（lastMessage）: 最後のメッセージの末尾にも付け、次の歩で道具の結果まで読めるようにする。合計 4 個以内", () => {
    const payload = {
      system: [
        { type: "text", text: "S0", cache_control: eph },
        { type: "text", text: "S1", cache_control: eph },
      ],
      tools: [
        { name: "web_search", input_schema: {} },
        { name: "web_fetch", input_schema: {}, cache_control: eph },
      ],
      messages: [
        { role: "user", content: [{ type: "text", text: "q1" }] },
        {
          role: "assistant",
          content: [
            { type: "text", text: "a1" },
            { type: "tool_use", id: "c1", name: "web_search", input: {} },
          ],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "c1", content: "r", cache_control: eph }],
        },
      ],
    };
    const out = applyConsultCacheControl(anthropic, payload, { lastMessage: true }) as {
      system: { cache_control?: unknown }[];
      tools: { cache_control?: unknown }[];
      messages: { content: { cache_control?: unknown }[] }[];
    };
    // 最後の user（道具の結果）の直前の assistant と、最後のメッセージの末尾
    expect(out.messages[1]?.content[1]?.cache_control).toEqual(eph);
    expect(out.messages[2]?.content[0]?.cache_control).toEqual(eph);
    expect(out.messages[0]?.content[0]?.cache_control).toBeUndefined();
    // system は末尾だけ（4 個の上限に収める）
    expect(out.system[0]?.cache_control).toBeUndefined();
    expect(out.system[1]?.cache_control).toEqual(eph);
    const count = [...out.system, ...out.tools, ...out.messages.flatMap((m) => m.content)].filter(
      (b) => b.cache_control !== undefined,
    ).length;
    expect(count).toBeLessThanOrEqual(4);
    expect(count).toBe(4);
  });

  it("lastMessage を付けないとき（道具なしの consult）は、最後のメッセージに付けない（従来どおり）", () => {
    const out = applyConsultCacheControl(anthropic, {
      messages: [
        { role: "user", content: [{ type: "text", text: "q1" }] },
        { role: "assistant", content: [{ type: "text", text: "a1" }] },
        { role: "user", content: [{ type: "text", text: "q2", cache_control: eph }] },
      ],
    }) as { messages: { content: { cache_control?: unknown }[] }[] };
    expect(out.messages[2]?.content[0]?.cache_control).toBeUndefined();
  });

  it("元の payload を書き換えない", () => {
    const payload = {
      messages: [
        { role: "user", content: [{ type: "text", text: "q1" }] },
        { role: "user", content: [{ type: "text", text: "q2" }] },
      ],
    };
    const snapshot = JSON.stringify(payload);
    applyConsultCacheControl(anthropic, payload);
    expect(JSON.stringify(payload)).toBe(snapshot);
  });

  it("Anthropic 以外（OpenAI は自動キャッシュ）と、形の合わない payload はそのまま返す", () => {
    const payload = { input: [{ role: "user", content: "x" }], messages: [{ role: "user" }] };
    expect(applyConsultCacheControl(model("openai-responses", "gpt-6-sol"), payload)).toBe(payload);
    expect(applyConsultCacheControl(anthropic, null)).toBeNull();
    expect(applyConsultCacheControl(anthropic, "x")).toBe("x");
    const noMessages = { system: [] };
    expect(applyConsultCacheControl(anthropic, noMessages)).toBe(noMessages);
  });
});
