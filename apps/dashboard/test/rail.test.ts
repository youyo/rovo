import type { OverviewDto, VisibleTaskDto } from "@rovo/dashboard-contract";
import { overviewFixture } from "@rovo/dashboard-contract/fixtures";
import { describe, expect, it } from "vitest";
import { budgetLimit, daySummary, pickConsoleTask, railGlyph } from "../src/rail";
import { MARKS, type MarkKind } from "../src/status";

const task = (over: Partial<VisibleTaskDto>): VisibleTaskDto => ({
  ...(overviewFixture.tasks[0] as VisibleTaskDto),
  ...over,
});

describe("railGlyph（レールの状態の印。見本の · – ✕ と走行中）", () => {
  it("失敗・予算超過は ✕、キャンセルは –、PR 済みの終了は ·、走行中は脈動", () => {
    expect(railGlyph("failed")).toMatchObject({ char: "✕", tone: "fail", pulse: false });
    expect(railGlyph("budget")).toMatchObject({ char: "✕", tone: "fail" });
    expect(railGlyph("cancelled")).toMatchObject({ char: "–", tone: "mute", pulse: false });
    expect(railGlyph("closed")).toMatchObject({ char: "·", pulse: false });
    expect(railGlyph("review")).toMatchObject({ char: "·" });
    expect(railGlyph("merged")).toMatchObject({ tone: "accent", pulse: false });
    for (const k of ["preparing", "running", "verifying", "recovering"] as const) {
      expect(railGlyph(k).pulse, k).toBe(true);
    }
  });

  it("全ての印に対して定義がある（状態が増えたら気づく）", () => {
    for (const k of Object.keys(MARKS) as MarkKind[]) {
      expect(railGlyph(k).char.length, k).toBeGreaterThan(0);
    }
  });
});

describe("pickConsoleTask（一覧のコンソールに出すタスク）", () => {
  const old = task({
    task_id: "01JZ00000000000000000000A0",
    status: "COMPLETED",
    started_at: "2026-10-21T01:00:00Z",
  });
  const newer = task({
    task_id: "01JZ00000000000000000000A1",
    status: "FAILED",
    started_at: "2026-10-21T05:00:00Z",
  });
  const runOld = task({
    task_id: "01JZ00000000000000000000A2",
    status: "RUNNING",
    started_at: "2026-10-21T02:00:00Z",
  });
  const runNew = task({
    task_id: "01JZ00000000000000000000A3",
    status: "VERIFYING",
    started_at: "2026-10-21T03:00:00Z",
  });

  it("走行中があれば最新の走行中（より新しい終了済みがあっても）", () => {
    expect(pickConsoleTask([old, newer, runOld, runNew])?.task_id).toBe(runNew.task_id);
  });

  it("走行中が無ければ最新のタスク", () => {
    expect(pickConsoleTask([old, newer])?.task_id).toBe(newer.task_id);
  });

  it("タスクが無ければ null", () => {
    expect(pickConsoleTask([])).toBeNull();
  });
});

describe("daySummary（ヘッダの要約「10月22日 12 件 マージ 0 走行中 0」）", () => {
  it("件数・マージ・走行中を数える", () => {
    const s = daySummary(overviewFixture);
    expect(s.total).toBe(5);
    expect(s.merged).toBe(2);
    expect(s.running).toBe(1);
    expect(s.day).toMatch(/^\d+月\d+日$/);
  });

  it("PR の状態: 閉じた PR はマージに入れない。GitHub 上でマージ済み(state=merged)は数える。取れなかった(unknown)は断定しない", () => {
    const withState = (state: "open" | "merged" | "closed" | "unknown"): OverviewDto => ({
      ...overviewFixture,
      tasks: overviewFixture.tasks.map((t) =>
        t.status === "COMPLETED" && t.pr && !t.pr.merged ? { ...t, pr: { ...t.pr, state } } : t,
      ),
    });
    expect(daySummary(withState("closed")).merged).toBe(2);
    expect(daySummary(withState("open")).merged).toBe(2);
    expect(daySummary(withState("unknown")).merged).toBe(2);
    expect(daySummary(withState("merged")).merged).toBe(3);
  });

  it("タスクが無ければ 0 件", () => {
    const empty: OverviewDto = { ...overviewFixture, tasks: [] };
    expect(daySummary(empty)).toMatchObject({ total: 0, merged: 0, running: 0 });
  });
});

describe("budgetLimit（月の上限。契約の monthly_budget_usd を使い、無ければ使った額 + 予約 + 残りから求める）", () => {
  it("monthly_budget_usd があればそれをそのまま使う。残りが 0 でも出る", () => {
    expect(budgetLimit({ ...overviewFixture.budget, monthly_budget_usd: 50 })).toBe(50);
    expect(
      budgetLimit({ ...overviewFixture.budget, monthly_budget_usd: 50, remaining_usd: 0 }),
    ).toBe(50);
  });

  it("monthly_budget_usd が無い古い応答では spent + reserved + remaining", () => {
    const { monthly_budget_usd: _omit, ...legacy } = overviewFixture.budget;
    expect(
      budgetLimit({
        ...legacy,
        spent_usd: 7.97,
        reserved_usd: 0,
        remaining_usd: 42.03,
      }),
    ).toBeCloseTo(50, 6);
  });

  it("残りが 0（上限を超えて切り上げられている）なら求められないので null", () => {
    const { monthly_budget_usd: _omit, ...legacy } = overviewFixture.budget;
    expect(budgetLimit({ ...legacy, remaining_usd: 0 })).toBeNull();
  });
});
