import { describe, expect, it } from "vitest";
import {
  formatClock,
  formatClockSeconds,
  formatCount,
  formatDayHeading,
  formatDuration,
  formatUsd,
} from "../src/format";
import { hourTicks } from "../src/timeline";
import { tEn, tJa } from "./lang";

// ローカル時刻の 2026-10-22 14:05:03
const at = new Date(2026, 9, 22, 14, 5, 3).getTime();

describe("書式は言語（Intl のロケール）で変わる", () => {
  it("日付: en は October 22、ja は 10月22日", () => {
    expect(formatDayHeading(at, tEn)).toBe("October 22");
    expect(formatDayHeading(at, tJa)).toBe("10月22日");
  });

  it("時刻: ja は 24 時間、en は 12 時間（AM / PM）", () => {
    expect(formatClock(at, tJa)).toBe("14:05");
    expect(formatClockSeconds(at, tJa)).toBe("14:05:03");
    expect(formatClock(at, tEn)).toMatch(/^02:05\sPM$/);
    expect(formatClockSeconds(at, tEn)).toMatch(/^02:05:03\sPM$/);
  });

  it("経過時間: 単位の語が言語で変わる", () => {
    expect(formatDuration(500, tEn)).toBe("<1s");
    expect(formatDuration(500, tJa)).toBe("1 秒未満");
    expect(formatDuration(42_000, tEn)).toBe("42s");
    expect(formatDuration(125_000, tEn)).toBe("2m 5s");
    expect(formatDuration(125_000, tJa)).toBe("2 分 5 秒");
    expect(formatDuration(3_900_000, tEn)).toBe("1h 5m");
    expect(formatDuration(3_900_000, tJa)).toBe("1 時間 5 分");
  });

  it("金額: どちらの言語でも $ で、桁区切りはロケールに従う", () => {
    expect(formatUsd(0, tEn)).toBe("$0");
    expect(formatUsd(1.5, tEn)).toBe("$1.50");
    expect(formatUsd(1.5, tJa)).toBe("$1.50");
    expect(formatUsd(1234.5, tEn)).toBe("$1,234.50");
    expect(formatUsd(0.0123, tEn)).toBe("$0.0123");
    expect(formatUsd(0.5, tJa)).toBe("$0.50");
    expect(formatUsd(0.00001, tEn)).toBe("<$0.0001");
  });

  it("数: 桁区切り", () => {
    expect(formatCount(1234567, tEn)).toBe("1,234,567");
    expect(formatCount(1234567, tJa)).toBe("1,234,567");
  });

  it("タイムラインの時刻の目盛りも言語で変わる", () => {
    const start = new Date(2026, 9, 22, 13, 0, 0).getTime();
    const d = { start, end: start + 3 * 3_600_000 };
    expect(hourTicks(d, tJa).map((t) => t.label)).toEqual(["13:00", "14:00", "15:00", "16:00"]);
    expect(hourTicks(d, tEn).map((t) => t.label.replace(/\s/g, " "))).toEqual([
      "1:00 PM",
      "2:00 PM",
      "3:00 PM",
      "4:00 PM",
    ]);
  });
});
