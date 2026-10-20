import { describe, expect, it } from "vitest";
import { INDEX_BACKOFF, indexBackoffMs } from "../../src/directory/backoff";

describe("indexBackoffMs（Directory への配送の再試行間隔）", () => {
  const mid = () => 0.5; // ジッター係数 1.0

  it("10 秒から倍々で伸び、上限は 5 分", () => {
    expect(indexBackoffMs(1, mid)).toBe(10_000);
    expect(indexBackoffMs(2, mid)).toBe(20_000);
    expect(indexBackoffMs(3, mid)).toBe(40_000);
    expect(indexBackoffMs(6, mid)).toBe(INDEX_BACKOFF.maxMs);
    expect(indexBackoffMs(9, mid)).toBe(INDEX_BACKOFF.maxMs);
  });

  it("失敗が続いたら（10 回）上限を 1 時間に延ばす。打ち切らない", () => {
    expect(indexBackoffMs(10, mid)).toBe(INDEX_BACKOFF.slowMaxMs);
    expect(indexBackoffMs(500, mid)).toBe(INDEX_BACKOFF.slowMaxMs);
    expect(INDEX_BACKOFF.slowMaxMs).toBe(60 * 60_000);
  });

  it("ジッターは ±20% の範囲に収まる（乱数は差し替えられる）", () => {
    expect(indexBackoffMs(1, () => 0)).toBe(8_000);
    expect(indexBackoffMs(1, () => 1)).toBe(12_000);
    expect(indexBackoffMs(10, () => 0)).toBe(0.8 * INDEX_BACKOFF.slowMaxMs);
    for (const r of [0, 0.1, 0.37, 0.5, 0.9, 0.999]) {
      const v = indexBackoffMs(4, () => r);
      expect(v).toBeGreaterThanOrEqual(80_000 * 0.8 - 1);
      expect(v).toBeLessThanOrEqual(80_000 * 1.2 + 1);
    }
  });
});
