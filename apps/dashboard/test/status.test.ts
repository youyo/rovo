import { TASK_STATUSES, type VisibleTaskDto } from "@rovo/dashboard-contract";
import { overviewFixture } from "@rovo/dashboard-contract/fixtures";
import { describe, expect, it } from "vitest";
import { MARKS, type MarkKind, markDescription, markKindOf, markLabel } from "../src/status";
import { tJa } from "./lang";

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
      const kind = markKindOf(task(s, null));
      expect(markLabel(kind, tJa).length, s).toBeGreaterThan(0);
    }
  });

  it("COMPLETED は PR のマージ済みで分ける（マージ済み / レビュー待ち / PR なしは完了）", () => {
    expect(markKindOf(task("COMPLETED", pr(true)))).toBe("merged");
    expect(markKindOf(task("COMPLETED", pr(false)))).toBe("review");
    expect(markKindOf(task("COMPLETED", null))).toBe("done");
    expect(markLabel("merged", tJa)).toBe("マージ済み");
    expect(markLabel("review", tJa)).toBe("レビュー待ち");
    expect(markLabel("failed", tJa)).toBe("失敗");
  });

  it("COMPLETED + PR の状態: merged=マージ済み / open=レビュー待ち / closed=閉じた / unknown=今の判定（pr_merged があればマージ済み、なければ PR あり）", () => {
    expect(markKindOf(task("COMPLETED", pr(false, "merged")))).toBe("merged");
    expect(markKindOf(task("COMPLETED", pr(false, "open")))).toBe("review");
    expect(markKindOf(task("COMPLETED", pr(false, "closed")))).toBe("closed");
    expect(markKindOf(task("COMPLETED", pr(false, "unknown")))).toBe("pr");
    expect(markKindOf(task("COMPLETED", pr(true, "unknown")))).toBe("merged");
    // rovo の記録（pr_merged）が先。GitHub が open と答えても、マージ済みの記録を覆さない
    expect(markKindOf(task("COMPLETED", pr(true, "open")))).toBe("merged");
    expect(markLabel("closed", tJa)).toBe("閉じた");
    expect(markLabel("pr", tJa)).toBe("PR あり");
  });

  it("COMPLETED 以外は PR の状態に影響されない（失敗したタスクの closed な PR は失敗のまま）", () => {
    expect(markKindOf(task("FAILED", pr(false, "closed")))).toBe("failed");
    expect(markKindOf(task("RUNNING", pr(false, "open")))).toBe("running");
  });

  it("閉じた=灰の中空。マージ済みの緑・レビュー待ちの青とも色が違う", () => {
    expect(MARKS.closed).toMatchObject({ tone: "skip", fill: "hollow", edge: "solid" });
    expect(MARKS.pr).toMatchObject({ tone: "wait", fill: "hollow", edge: "dotted" });
  });

  it("見本どおり: マージ済み=緑、レビュー待ち=青、失敗=赤、実行中=黄、閉じた・キャンセル=灰", () => {
    expect(MARKS.merged).toMatchObject({ tone: "ok", fill: "solid" });
    expect(MARKS.done).toMatchObject({ tone: "ok" });
    expect(MARKS.review).toMatchObject({ tone: "wait", fill: "hollow" });
    expect(MARKS.failed).toMatchObject({ tone: "bad", fill: "hollow" });
    expect(MARKS.running).toMatchObject({ tone: "run" });
    expect(MARKS.cancelled).toMatchObject({ tone: "skip" });
  });

  it("すべての印は (色, 塗り, 縁) の組が互いに違い、文字も違う（タイムラインの棒は色を無視しても区別できる）", () => {
    const marks = Object.values(MARKS);
    expect(new Set(marks.map((m) => `${m.tone}/${m.fill}/${m.edge}`)).size).toBe(marks.length);
    expect(new Set((Object.keys(MARKS) as MarkKind[]).map((k) => markLabel(k, tJa))).size).toBe(
      marks.length,
    );
  });

  it("実行中・準備中・入力待ち・キャンセル・予算超過にも固有の文字がある", () => {
    expect(markLabel(markKindOf(task("RUNNING", null)), tJa)).toBe("実行中");
    expect(markLabel(markKindOf(task("CREATING", null)), tJa)).toBe("準備中");
    expect(markLabel(markKindOf(task("INPUT_REQUIRED", null)), tJa)).toBe("入力待ち");
    expect(markLabel(markKindOf(task("CANCELLED", null)), tJa)).toBe("キャンセル");
    expect(markLabel(markKindOf(task("BUDGET_EXCEEDED", null)), tJa)).toBe("予算超過");
  });
});

describe("短い label（レール・見出し・バッジ）と、長い説明（凡例・点の title）", () => {
  it("狭い場所で使う label は短いまま（閉じた・PR あり・準備中 など）", () => {
    expect(markLabel("closed", tJa)).toBe("閉じた");
    expect(markLabel("pr", tJa)).toBe("PR あり");
    expect(markLabel("preparing", tJa)).toBe("準備中");
    for (const k of Object.keys(MARKS) as MarkKind[]) {
      expect(markLabel(k, tJa).length, `${k} の label は 8 文字以内`).toBeLessThanOrEqual(8);
    }
  });

  it("閉じた は説明で「マージせず」を足す（初めて見た人にも分かる）", () => {
    expect(markDescription("closed", tJa)).toBe("閉じた（マージせず）");
  });

  it("説明が無い印は、label がそのまま説明", () => {
    expect(markDescription("merged", tJa)).toBe("マージ済み");
    expect(markDescription("running", tJa)).toBe("実行中");
  });

  it("説明はどれも label から始まり、説明どうしも重ならない", () => {
    const kinds = Object.keys(MARKS) as MarkKind[];
    for (const k of kinds)
      expect(markDescription(k, tJa).startsWith(markLabel(k, tJa)), k).toBe(true);
    expect(new Set(kinds.map((k) => markDescription(k, tJa))).size).toBe(kinds.length);
  });
});

describe("状態の印の形（記号）。GitHub Actions の見た目に合わせ、意味が同じ状態は同じ形", () => {
  it("種類ごとの形の割り当て: 成功=✓、失敗=✕、実行中=回る輪、レビュー待ち=●、閉じた・キャンセル=–、準備中=点線の輪、入力待ち=！", () => {
    const shapes = Object.fromEntries(Object.entries(MARKS).map(([k, m]) => [k, m.shape]));
    expect(shapes).toEqual({
      preparing: "queued",
      running: "spinner",
      input: "bang",
      verifying: "spinner",
      recovering: "spinner",
      merged: "check",
      review: "dot",
      closed: "dash",
      pr: "dot",
      done: "check",
      failed: "cross",
      budget: "cross",
      cancelled: "dash",
    });
  });

  it("形は 7 種類。形が違っても色に頼らない（形 + 隣の文字 label）", () => {
    expect(new Set(Object.values(MARKS).map((m) => m.shape)).size).toBe(7);
  });

  it("実行中と成功（マージ済み）は、形が違う（濃さの差だけにしない）", () => {
    expect(MARKS.running.shape).not.toBe(MARKS.merged.shape);
    expect(MARKS.running.fill).not.toBe(MARKS.merged.fill);
  });

  it("回る輪（spinner）の状態だけ live（実行中・検証中・復旧中）。準備中は点線の輪で止まっている", () => {
    const live = (Object.keys(MARKS) as MarkKind[]).filter((k) => MARKS[k].live);
    expect(live.sort()).toEqual(["recovering", "running", "verifying"]);
    for (const k of live) expect(MARKS[k].shape).toBe("spinner");
  });
});
