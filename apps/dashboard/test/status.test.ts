import { TASK_STATUSES, type VisibleTaskDto } from "@rovo/dashboard-contract";
import { overviewFixture } from "@rovo/dashboard-contract/fixtures";
import { describe, expect, it } from "vitest";
import { MARKS, markKindOf, markOf } from "../src/status";

const base = overviewFixture.tasks[0] as VisibleTaskDto;
const task = (status: VisibleTaskDto["status"], pr: VisibleTaskDto["pr"]): VisibleTaskDto => ({
  ...base,
  status,
  pr,
});
const pr = (merged: boolean) => ({
  number: 1,
  url: "https://github.com/a/b/pull/1",
  draft: false,
  merged,
});

describe("状態の印（色だけで区別しない。形 + 文字）", () => {
  it("契約の全状態に印と文字がある", () => {
    for (const s of TASK_STATUSES) {
      const m = markOf(task(s, null));
      expect(m.label.length, s).toBeGreaterThan(0);
    }
  });

  it("COMPLETED は PR のマージ済みで分ける（マージ済み / レビュー待ち / PR なしは完了）", () => {
    expect(markKindOf(task("COMPLETED", pr(true)))).toBe("merged");
    expect(markKindOf(task("COMPLETED", pr(false)))).toBe("review");
    expect(markKindOf(task("COMPLETED", null))).toBe("done");
    expect(MARKS.merged.label).toBe("マージ済み");
    expect(MARKS.review.label).toBe("レビュー待ち");
    expect(MARKS.failed.label).toBe("失敗");
  });

  it("見本どおり: マージ済み=塗り青、レビュー待ち=中空青、失敗=中空オレンジ", () => {
    expect(MARKS.merged).toMatchObject({ tone: "blue", fill: "solid" });
    expect(MARKS.review).toMatchObject({ tone: "blue", fill: "hollow" });
    expect(MARKS.failed).toMatchObject({ tone: "orange", fill: "hollow" });
  });

  it("すべての印は (色, 塗り, 縁) の組が互いに違い、文字も違う（色を無視しても区別できる）", () => {
    const marks = Object.values(MARKS);
    expect(new Set(marks.map((m) => `${m.tone}/${m.fill}/${m.edge}`)).size).toBe(marks.length);
    expect(new Set(marks.map((m) => m.label)).size).toBe(marks.length);
  });

  it("実行中・準備中・入力待ち・キャンセル・予算超過にも固有の文字がある", () => {
    expect(markOf(task("RUNNING", null)).label).toBe("実行中");
    expect(markOf(task("CREATING", null)).label).toBe("準備中");
    expect(markOf(task("INPUT_REQUIRED", null)).label).toBe("入力待ち");
    expect(markOf(task("CANCELLED", null)).label).toBe("キャンセル");
    expect(markOf(task("BUDGET_EXCEEDED", null)).label).toBe("予算超過");
  });
});
