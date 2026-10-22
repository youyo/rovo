import { describe, expect, it } from "vitest";
import { dayHref, dayOfTask, dayRange, resolveDay, shiftDay } from "../src/day";

const NOW = new Date(2026, 9, 23, 15, 40, 12).getTime(); // 2026-10-23 15:40 ローカル

describe("resolveDay（URL の day → 表示する日。今日・未来・不正は null）", () => {
  it("過去の日はそのまま", () => {
    expect(resolveDay("?day=2026-10-22", NOW)).toBe("2026-10-22");
  });
  it("今日・未来・不正・無しは null（今日に追従する）", () => {
    for (const s of ["?day=2026-10-23", "?day=2026-10-24", "?day=2099-01-01", "?day=zz", ""]) {
      expect(resolveDay(s, NOW), s).toBeNull();
    }
  });
});

describe("shiftDay（前後送り）", () => {
  it("今日の前は昨日", () => {
    expect(shiftDay(null, -1, NOW)).toBe("2026-10-22");
  });
  it("月・年をまたぐ", () => {
    expect(shiftDay("2026-10-01", -1, NOW)).toBe("2026-09-30");
    expect(shiftDay("2026-01-01", -1, NOW)).toBe("2025-12-31");
    expect(shiftDay("2024-03-01", -1, NOW)).toBe("2024-02-29");
  });
  it("昨日の次は今日（null）。今日の次へは行けない（null のまま）", () => {
    expect(shiftDay("2026-10-22", 1, NOW)).toBeNull();
    expect(shiftDay(null, 1, NOW)).toBeNull();
  });
});

describe("dayRange（過去の日はローカル 0 時〜翌日 0 時、今日は 0 時〜いま）", () => {
  it("過去の日", () => {
    expect(dayRange("2026-10-22", NOW)).toEqual({
      from: new Date(2026, 9, 22, 0, 0, 0, 0).getTime(),
      to: new Date(2026, 9, 23, 0, 0, 0, 0).getTime(),
    });
  });
  it("今日は従来どおり 0 時〜いま", () => {
    expect(dayRange(null, NOW)).toEqual({ from: new Date(2026, 9, 23).getTime(), to: NOW });
  });
  it("どの日でも幅は 0 より大きく gateway の上限（36 時間）に収まる（夏時間の 25 時間の日も）", () => {
    for (let m = 0; m < 12; m++) {
      for (let d = 1; d <= 28; d++) {
        const key = `2025-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
        const r = dayRange(key, NOW);
        expect(r.to - r.from, key).toBeGreaterThan(0);
        expect(r.to - r.from, key).toBeLessThanOrEqual(36 * 3_600_000);
      }
    }
  });
});

describe("dayHref", () => {
  it("今日はクエリ無し、過去の日は ?day=", () => {
    expect(dayHref("/dashboard/", null)).toBe("/dashboard/");
    expect(dayHref("/dashboard/", "2026-10-22")).toBe("/dashboard/?day=2026-10-22");
  });
});

describe("dayOfTask（タスクが始まったローカルの日。今日・取れないときは null）", () => {
  const at = (y: number, mo: number, d: number, h = 12) => new Date(y, mo - 1, d, h).toISOString();
  it("started_at のローカルの暦日", () => {
    expect(dayOfTask({ created_at: at(2026, 10, 20), started_at: at(2026, 10, 21) }, NOW)).toBe(
      "2026-10-21",
    );
  });
  it("started_at が無ければ created_at", () => {
    expect(dayOfTask({ created_at: at(2026, 10, 20), started_at: null }, NOW)).toBe("2026-10-20");
  });
  it("ローカルの 0 時直後・23 時台はその日のまま（UTC の日付ではない）", () => {
    expect(dayOfTask({ created_at: at(2026, 10, 20, 0), started_at: null }, NOW)).toBe(
      "2026-10-20",
    );
    expect(dayOfTask({ created_at: at(2026, 10, 20, 23), started_at: null }, NOW)).toBe(
      "2026-10-20",
    );
  });
  it("今日・未来・壊れた日時は null（今日）", () => {
    expect(dayOfTask({ created_at: at(2026, 10, 23, 1), started_at: null }, NOW)).toBeNull();
    expect(dayOfTask({ created_at: at(2026, 10, 25), started_at: null }, NOW)).toBeNull();
    expect(dayOfTask({ created_at: "zz", started_at: "yy" }, NOW)).toBeNull();
  });
});
