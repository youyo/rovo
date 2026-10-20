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
