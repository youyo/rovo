import { TASK_STATUSES, type VisibleTaskDto } from "@rovo/dashboard-contract";
import { overviewFixture } from "@rovo/dashboard-contract/fixtures";
import { describe, expect, it } from "vitest";
import { MARKS, type MarkKind, markDescription, markKindOf, markOf } from "../src/status";

const base = overviewFixture.tasks[0] as VisibleTaskDto;
const task = (status: VisibleTaskDto["status"], pr: VisibleTaskDto["pr"]): VisibleTaskDto => ({
  ...base,
  status,
  pr,
});
const pr = (merged: boolean, state?: NonNullable<VisibleTaskDto["pr"]>["state"]) => ({
  number: 1,
  url: "https://github.com/a/b/pull/1",
  draft: false,
  merged,
  state: state ?? (merged ? ("merged" as const) : ("open" as const)),
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

  it("COMPLETED + PR の状態: merged=マージ済み / open=レビュー待ち / closed=閉じた / unknown=今の判定（pr_merged があればマージ済み、なければ PR あり）", () => {
    expect(markKindOf(task("COMPLETED", pr(false, "merged")))).toBe("merged");
    expect(markKindOf(task("COMPLETED", pr(false, "open")))).toBe("review");
    expect(markKindOf(task("COMPLETED", pr(false, "closed")))).toBe("closed");
    expect(markKindOf(task("COMPLETED", pr(false, "unknown")))).toBe("pr");
    expect(markKindOf(task("COMPLETED", pr(true, "unknown")))).toBe("merged");
    // rovo の記録（pr_merged）が先。GitHub が open と答えても、マージ済みの記録を覆さない
    expect(markKindOf(task("COMPLETED", pr(true, "open")))).toBe("merged");
    expect(MARKS.closed.label).toBe("閉じた");
    expect(MARKS.pr.label).toBe("PR あり");
  });

  it("COMPLETED 以外は PR の状態に影響されない（失敗したタスクの closed な PR は失敗のまま）", () => {
    expect(markKindOf(task("FAILED", pr(false, "closed")))).toBe("failed");
    expect(markKindOf(task("RUNNING", pr(false, "open")))).toBe("running");
  });

  it("閉じた=灰の中空、マージ済みの塗り青とも、レビュー待ちの中空青とも形が違う", () => {
    expect(MARKS.closed).toMatchObject({ tone: "gray", fill: "hollow", edge: "solid" });
    expect(MARKS.pr).toMatchObject({ tone: "ink", fill: "hollow", edge: "dotted" });
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

describe("短い label（レール・見出し・バッジ）と、長い説明（凡例・点の title）", () => {
  it("狭い場所で使う label は短いまま（閉じた・PR あり・準備中 など）", () => {
    expect(MARKS.closed.label).toBe("閉じた");
    expect(MARKS.pr.label).toBe("PR あり");
    expect(MARKS.preparing.label).toBe("準備中");
    for (const [k, m] of Object.entries(MARKS)) {
      expect(m.label.length, `${k} の label は 8 文字以内`).toBeLessThanOrEqual(8);
    }
  });

  it("閉じた は説明で「マージせず」を足す（初めて見た人にも分かる）", () => {
    expect(markDescription("closed")).toBe("閉じた（マージせず）");
  });

  it("説明が無い印は、label がそのまま説明", () => {
    expect(markDescription("merged")).toBe("マージ済み");
    expect(markDescription("running")).toBe("実行中");
  });

  it("説明はどれも label から始まり、説明どうしも重ならない", () => {
    const kinds = Object.keys(MARKS) as MarkKind[];
    for (const k of kinds) expect(markDescription(k).startsWith(MARKS[k].label), k).toBe(true);
    expect(new Set(kinds.map(markDescription)).size).toBe(kinds.length);
  });
});

describe("状態の印の形（記号）。色や濃さに頼らず、形だけで区別できる", () => {
  it("すべての印の記号（shape）が互いに違う", () => {
    const shapes = Object.values(MARKS).map((m) => m.shape);
    expect(new Set(shapes).size).toBe(shapes.length);
  });

  it("同じ色（tone）の印どうしも、記号が違う", () => {
    for (const tone of ["blue", "orange", "gray", "ink"] as const) {
      const same = Object.values(MARKS).filter((m) => m.tone === tone);
      expect(new Set(same.map((m) => m.shape)).size, tone).toBe(same.length);
    }
  });

  it("実行中とマージ済みは、記号が違う（濃さの差だけにしない）", () => {
    expect(MARKS.running.shape).not.toBe(MARKS.merged.shape);
    expect(MARKS.running.fill).not.toBe(MARKS.merged.fill);
  });

  it("動いている状態（準備中・実行中・検証中・復旧中）だけ live", () => {
    const live = (Object.keys(MARKS) as MarkKind[]).filter((k) => MARKS[k].live);
    expect(live.sort()).toEqual(["preparing", "recovering", "running", "verifying"]);
  });
});
