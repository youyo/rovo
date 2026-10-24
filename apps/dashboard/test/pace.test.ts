import { describe, expect, it } from "vitest";
import { monthPace } from "../src/pace";

const DAY = 86_400_000;
const START = "2026-10-01T00:00:00.000Z";
const END = "2026-11-01T00:00:00.000Z"; // 31 日
const s = Date.parse(START);
const base = { periodStart: START, periodEnd: END, limitUsd: 200 as number | null };

describe("月のペース（UTC の月。使った額から月末の見込みを出す）", () => {
  it("月の途中: N 日目と、日割りで月末まで延ばした見込み", () => {
    // 10 日目の半ば（9.5 日経過）で $38 → 1 日 $4 → 31 日で $124
    const p = monthPace({ ...base, spentUsd: 38, nowMs: s + 9.5 * DAY });
    expect(p).toEqual({ kind: "ok", day: 10, spent: 38, projected: 124, limit: 200, over: false });
  });

  it("月初（1 日未満）は見込みを出さない（early）。ちょうど 1 日経過から出す", () => {
    expect(monthPace({ ...base, spentUsd: 5, nowMs: s })).toEqual({ kind: "early" });
    expect(monthPace({ ...base, spentUsd: 5, nowMs: s + DAY - 1 })).toEqual({ kind: "early" });
    const p = monthPace({ ...base, spentUsd: 5, nowMs: s + DAY });
    expect(p.kind).toBe("ok");
    if (p.kind === "ok") {
      expect(p.day).toBe(2);
      expect(p.projected).toBeCloseTo(155, 6);
    }
  });

  it("月末: 見込みは使った額に近づく。期間を過ぎた古い時刻でも月全体で頭打ち（最終日）", () => {
    const last = monthPace({ ...base, spentUsd: 150, nowMs: s + 31 * DAY - 1 });
    expect(last.kind).toBe("ok");
    if (last.kind === "ok") {
      expect(last.day).toBe(31);
      expect(last.projected).toBeCloseTo(150, 3);
    }
    const past = monthPace({ ...base, spentUsd: 150, nowMs: s + 40 * DAY });
    expect(past).toEqual({
      kind: "ok",
      day: 31,
      spent: 150,
      projected: 150,
      limit: 200,
      over: false,
    });
  });

  it("上限を超える見込みなら over。ちょうど上限は超えない。上限が無い（null）なら over にしない", () => {
    const over = monthPace({ ...base, spentUsd: 100, nowMs: s + 10 * DAY });
    expect(over.kind === "ok" && over.over).toBe(true); // 100 / 10 * 31 = 310
    const exact = monthPace({ ...base, limitUsd: 310, spentUsd: 100, nowMs: s + 10 * DAY });
    expect(exact.kind === "ok" && exact.over).toBe(false);
    const none = monthPace({ ...base, limitUsd: null, spentUsd: 100, nowMs: s + 10 * DAY });
    expect(none).toMatchObject({ kind: "ok", limit: null, over: false });
  });

  it("0 円なら見込みも 0 円（over にならない）", () => {
    const p = monthPace({ ...base, spentUsd: 0, nowMs: s + 5 * DAY });
    expect(p).toEqual({ kind: "ok", day: 6, spent: 0, projected: 0, limit: 200, over: false });
  });

  it("上限が 0 のとき、見込みが 0 を超えれば over", () => {
    expect(monthPace({ ...base, limitUsd: 0, spentUsd: 1, nowMs: s + 5 * DAY })).toMatchObject({
      over: true,
    });
  });

  it("入力が壊れていたら early（期間の形が不正・時刻が NaN・期間の前・使った額が負や NaN）", () => {
    const bad = [
      { ...base, periodStart: "x", spentUsd: 1, nowMs: s + 5 * DAY },
      { ...base, periodEnd: START, spentUsd: 1, nowMs: s + 5 * DAY },
      { ...base, spentUsd: 1, nowMs: Number.NaN },
      { ...base, spentUsd: 1, nowMs: s - DAY },
      { ...base, spentUsd: -1, nowMs: s + 5 * DAY },
      { ...base, spentUsd: Number.NaN, nowMs: s + 5 * DAY },
    ];
    for (const b of bad) expect(monthPace(b)).toEqual({ kind: "early" });
  });
});
