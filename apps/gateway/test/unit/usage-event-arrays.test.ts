import { describe, expect, it } from "vitest";
import { expandUsageArrays } from "../../src/tasks/service";

const ev = (payload: Record<string, string | number | boolean | null>) => ({
  seq: 1,
  type: "usage",
  payload,
  created_at: "2026-10-22T00:00:00.000Z",
});

describe("expandUsageArrays: usage イベントの履歴を配列で返す", () => {
  it("オブジェクトの配列の JSON 文字列は配列にする。ほかの項目はそのまま", () => {
    const out = expandUsageArrays(
      ev({
        cost_usd: 1,
        sandbox_promotions: JSON.stringify([{ to: "standard-3", at: 1 }]),
        sandbox_promotion_failures: "[]",
      }),
    );
    expect(out.payload).toEqual({
      cost_usd: 1,
      sandbox_promotions: [{ to: "standard-3", at: 1 }],
      sandbox_promotion_failures: [],
    });
  });

  it("壊れた JSON・配列でない JSON・オブジェクトでない要素を含む配列は、そのキーを外す（文字列のまま返さない）", () => {
    for (const bad of [
      "{not json",
      '{"a":1}',
      "5",
      "null",
      '[{"a":1}, "x"]',
      "[1]",
      "[null]",
      "[[1]]",
    ]) {
      const out = expandUsageArrays(ev({ cost_usd: 1, sandbox_promotions: bad }));
      expect(out.payload, bad).toEqual({ cost_usd: 1 });
    }
  });

  it("文字列でない値（欠け）には触らない", () => {
    expect(expandUsageArrays(ev({ cost_usd: 1 })).payload).toEqual({ cost_usd: 1 });
  });
});
