import { describe, expect, it } from "vitest";
import { consultToolsBudgetUsd, DEFAULT_CONSULT_TOOLS_BUDGET_USD } from "../../src/tasks/budget";
import { consultInputSchema } from "../../src/tasks/validation";

// consult の道具（#135）: 入力の tools と、道具つきの予約額

const base = { messages: [{ role: "user", content: "q" }] };

describe("consultInputSchema の tools", () => {
  it("web_search / web_fetch を受け付ける。空の配列は道具なしと同じ（そのまま通す）", () => {
    for (const tools of [["web_search"], ["web_fetch"], ["web_search", "web_fetch"], []]) {
      const r = consultInputSchema.safeParse({ ...base, tools });
      expect(r.success, JSON.stringify(tools)).toBe(true);
      expect(r.data?.tools).toEqual(tools);
    }
    expect(consultInputSchema.safeParse(base).data?.tools).toBeUndefined();
  });

  it("重複・web_browse・知らない道具・配列でない値は invalid", () => {
    for (const tools of [
      ["web_search", "web_search"],
      ["web_browse"],
      ["bash"],
      "web_search",
      [1],
    ]) {
      const r = consultInputSchema.safeParse({ ...base, tools });
      expect(r.success, JSON.stringify(tools)).toBe(false);
    }
    const dup = consultInputSchema.safeParse({ ...base, tools: ["web_fetch", "web_fetch"] });
    expect(dup.error?.issues.map((i) => i.path.join("."))).toContain("tools");
  });
});

describe("consultToolsBudgetUsd（env の CONSULT_TOOLS_BUDGET_USD）", () => {
  it("既定 1。未設定・数でない・0 以下は既定に戻す", () => {
    expect(DEFAULT_CONSULT_TOOLS_BUDGET_USD).toBe(1);
    expect(consultToolsBudgetUsd({})).toBe(1);
    expect(consultToolsBudgetUsd({ CONSULT_TOOLS_BUDGET_USD: "" })).toBe(1);
    expect(consultToolsBudgetUsd({ CONSULT_TOOLS_BUDGET_USD: "abc" })).toBe(1);
    expect(consultToolsBudgetUsd({ CONSULT_TOOLS_BUDGET_USD: "0" })).toBe(1);
    expect(consultToolsBudgetUsd({ CONSULT_TOOLS_BUDGET_USD: "-2" })).toBe(1);
    expect(consultToolsBudgetUsd({ CONSULT_TOOLS_BUDGET_USD: "Infinity" })).toBe(1);
    expect(consultToolsBudgetUsd({ CONSULT_TOOLS_BUDGET_USD: "2.5" })).toBe(2.5);
  });
});
