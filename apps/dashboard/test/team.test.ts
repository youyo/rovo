import type { OverviewDto, VisibleTaskDto, WaitingDto } from "@rovo/dashboard-contract";
import { overviewFixture, waitingFixture } from "@rovo/dashboard-contract/fixtures";
import { describe, expect, it } from "vitest";
import { BOARD_ACTIVE_MAX, buildFlow, buildMonthCosts, buildTeamBoard } from "../src/team";

const base = overviewFixture.tasks[0] as VisibleTaskDto;
let seq = 0;
const task = (over: Partial<VisibleTaskDto>): VisibleTaskDto => ({
  ...base,
  task_id: `01K8ZFT${String(++seq).padStart(19, "0")}`,
  pr: null,
  ...over,
});
const data = (tasks: VisibleTaskDto[], over: Partial<OverviewDto> = {}): OverviewDto => ({
  ...overviewFixture,
  tasks,
  ...over,
});
const waiting = (tasks: VisibleTaskDto[]): WaitingDto => ({ ...waitingFixture, tasks });
const person = (b: ReturnType<typeof buildTeamBoard>, login: string) => {
  const p = b.people.find((x) => x.login === login);
  if (!p) throw new Error(`${login} の行が無い`);
  return p;
};
const prOf = (n: number, repo: string) => ({
  number: n,
  url: `https://github.com/example-org/${repo}/pull/${n}`,
  draft: false,
  merged: false,
  state: "open" as const,
});

describe("buildTeamBoard の人ごとの並び", () => {
  it("閲覧者が先頭、ほかは login 順（帯と同じ）", () => {
    const b = buildTeamBoard(
      data([
        task({ owner_login: "zed-example" }),
        task({ owner_login: "bob-example" }),
        task({ owner_login: "alice-example" }),
      ]),
      null,
      true,
    );
    expect(b.people.map((p) => p.login)).toEqual(["alice-example", "bob-example", "zed-example"]);
    expect(b.people[0]?.isViewer).toBe(true);
  });

  it("タスクが無くても閲覧者の行は出る", () => {
    const b = buildTeamBoard(data([]), null, true);
    expect(b.people.map((p) => p.login)).toEqual(["alice-example"]);
  });
});

describe("buildTeamBoard の今日の数", () => {
  it("走行・質問待ち・完了・失敗・費用を数える。前日から走り続けているタスクも走行に入る", () => {
    const b = buildTeamBoard(
      data([
        task({
          owner_login: "bob-example",
          status: "RUNNING",
          started_at: "2026-10-20T22:00:00Z",
          created_at: "2026-10-20T21:59:00Z",
          ended_at: null,
          cost: { ...base.cost, cost_usd: 1 },
        }),
        task({ owner_login: "bob-example", status: "VERIFYING", ended_at: null }),
        task({ owner_login: "bob-example", status: "INPUT_REQUIRED", ended_at: null }),
        task({
          owner_login: "bob-example",
          status: "COMPLETED",
          ended_at: "2026-10-21T03:00:00Z",
          cost: { ...base.cost, cost_usd: 0.5 },
        }),
        task({ owner_login: "bob-example", status: "FAILED", ended_at: "2026-10-21T04:00:00Z" }),
        task({
          owner_login: "bob-example",
          status: "BUDGET_EXCEEDED",
          ended_at: "2026-10-21T04:30:00Z",
        }),
        task({ owner_login: "bob-example", status: "CANCELLED", ended_at: "2026-10-21T05:00:00Z" }),
      ]),
      null,
      true,
    );
    const p = person(b, "bob-example");
    expect(p.running).toBe(2);
    expect(p.asking).toBe(1);
    expect(p.done).toBe(1);
    expect(p.failed).toBe(2);
    expect(p.costUsd).toBeGreaterThan(1.5);
  });

  it("review は件数・走行・リポジトリの数から除く（費用は実費なので含める）", () => {
    const real = task({ owner_login: "bob-example", status: "RUNNING", ended_at: null });
    const review = task({
      owner_login: "bob-example",
      status: "RUNNING",
      ended_at: null,
      kind: "review",
      cost: { ...base.cost, cost_usd: 3 },
    });
    const doneReview = task({
      owner_login: "bob-example",
      status: "COMPLETED",
      kind: "review",
      cost: { ...base.cost, cost_usd: 2 },
    });
    const b = buildTeamBoard(data([real, review, doneReview]), null, true);
    const p = person(b, "bob-example");
    expect(p.running).toBe(1);
    expect(p.done).toBe(0);
    expect(p.active.map((t) => t.task_id)).toEqual([real.task_id]);
    expect(p.costUsd).toBeCloseTo(real.cost.cost_usd + 5);
    expect(b.repos.reduce((n, r) => n + r.count, 0)).toBe(1);
  });

  it("kind が無い古い応答は task として数える", () => {
    const b = buildTeamBoard(data([task({ status: "RUNNING", ended_at: null })]), null, true);
    expect(person(b, "alice-example").running).toBe(1);
  });
});

describe("buildTeamBoard の質問待ち（/waiting の合算）", () => {
  it("日をまたいだ質問待ちも人ごとに数える。同じタスクが両方にあっても二重に数えない", () => {
    const both = task({ owner_login: "bob-example", status: "INPUT_REQUIRED", ended_at: null });
    const old = task({
      owner_login: "bob-example",
      status: "INPUT_REQUIRED",
      ended_at: null,
      created_at: "2026-10-18T00:00:00Z",
      started_at: "2026-10-18T00:01:00Z",
    });
    const b = buildTeamBoard(data([both]), waiting([both, old]), true);
    const p = person(b, "bob-example");
    expect(p.asking).toBe(2);
    expect(p.active.map((t) => t.task_id).sort()).toEqual([both.task_id, old.task_id].sort());
  });

  it("overview に行の無い人も、質問待ちがあれば行が出る", () => {
    const old = task({ owner_login: "carol-example", status: "INPUT_REQUIRED", ended_at: null });
    const b = buildTeamBoard(data([]), waiting([old]), true);
    expect(person(b, "carol-example").asking).toBe(1);
  });

  it("review の質問待ちは数えない。レビュー待ちの PR（COMPLETED）は質問待ちではない", () => {
    const rv = task({
      owner_login: "bob-example",
      status: "INPUT_REQUIRED",
      ended_at: null,
      kind: "review",
    });
    const pr = task({ owner_login: "bob-example", status: "COMPLETED", pr: prOf(5, "x") });
    const b = buildTeamBoard(data([]), waiting([rv, pr]), true);
    expect(b.people.find((p) => p.login === "bob-example")?.asking ?? 0).toBe(0);
  });

  it("待ちの scope が違う応答は使わない", () => {
    const old = task({ owner_login: "bob-example", status: "INPUT_REQUIRED", ended_at: null });
    const b = buildTeamBoard(data([]), { ...waiting([old]), scope: "me" }, true);
    expect(b.people.map((p) => p.login)).toEqual(["alice-example"]);
  });
});

describe("buildTeamBoard の走行中の一覧", () => {
  it("質問待ちが先、次に走行中。それぞれ新しい順。最大 3 件で、残りは more", () => {
    const mk = (n: number, status: VisibleTaskDto["status"]) =>
      task({
        owner_login: "bob-example",
        status,
        ended_at: null,
        started_at: `2026-10-21T0${n}:00:00Z`,
      });
    const r1 = mk(1, "RUNNING");
    const r2 = mk(2, "RUNNING");
    const r3 = mk(3, "VERIFYING");
    const q1 = mk(0, "INPUT_REQUIRED");
    const q2 = mk(4, "INPUT_REQUIRED");
    const b = buildTeamBoard(data([r1, r2, r3, q1, q2]), null, true);
    const p = person(b, "bob-example");
    expect(BOARD_ACTIVE_MAX).toBe(3);
    expect(p.active.map((t) => t.task_id)).toEqual([q2.task_id, q1.task_id, r3.task_id]);
    expect(p.more).toBe(2);
  });
});

describe("buildTeamBoard のリポジトリ別", () => {
  it("件数（多い順）・走行・待ちの PR（レビュー待ちの印のもの）を数える", () => {
    const b = buildTeamBoard(
      data([
        task({ repository: "example-org/a", status: "RUNNING", ended_at: null }),
        task({ repository: "example-org/a", status: "COMPLETED", pr: prOf(7, "a") }),
        task({
          repository: "example-org/a",
          status: "COMPLETED",
          pr: { ...prOf(8, "a"), state: "merged", merged: true },
        }),
        task({ repository: "example-org/b", status: "FAILED" }),
      ]),
      null,
      true,
    );
    expect(b.repos.map((r) => r.repository)).toEqual(["example-org/a", "example-org/b"]);
    const a = b.repos[0];
    expect(a?.count).toBe(3);
    expect(a?.running).toBe(1);
    expect(a?.prs.map((p) => p.number)).toEqual([7]);
    expect(b.repos[1]?.prs).toEqual([]);
  });

  it("日をまたいだ待ちの PR も入れる。同じ PR は 1 つ", () => {
    const t1 = task({ repository: "example-org/a", status: "COMPLETED", pr: prOf(7, "a") });
    const old = task({ repository: "example-org/c", status: "COMPLETED", pr: prOf(3, "c") });
    const b = buildTeamBoard(data([t1]), waiting([t1, old]), true);
    expect(b.repos.find((r) => r.repository === "example-org/a")?.prs).toHaveLength(1);
    expect(b.repos.find((r) => r.repository === "example-org/c")?.prs.map((p) => p.number)).toEqual(
      [3],
    );
    // 日をまたいだ待ちだけのリポジトリの今日の件数は 0
    expect(b.repos.find((r) => r.repository === "example-org/c")?.count).toBe(0);
  });

  it("日をまたいだ待ちの PR は、GitHub の状態が取れていなくても待ちとして入れる（要対応のタブと同じ）。マージ済み・閉じたものは入れない", () => {
    const unknown = task({
      repository: "example-org/c",
      status: "COMPLETED",
      pr: { ...prOf(3, "c"), state: "unknown" },
    });
    const merged = task({
      repository: "example-org/c",
      status: "COMPLETED",
      pr: { ...prOf(4, "c"), state: "merged", merged: true },
    });
    const b = buildTeamBoard(data([]), waiting([unknown, merged]), true);
    expect(b.repos.find((r) => r.repository === "example-org/c")?.prs.map((p) => p.number)).toEqual(
      [3],
    );
    // 一覧のタスクの PR は、状態の印がレビュー待ちのものだけ（取れていない PR は入れない）
    const own = buildTeamBoard(data([unknown]), null, true);
    expect(own.repos[0]?.prs).toEqual([]);
  });

  it("GitHub の PR の URL でないものは PR に入れない", () => {
    const bad = task({
      status: "COMPLETED",
      pr: { ...prOf(9, "a"), url: "https://evil.example/x/y/pull/9" },
    });
    const b = buildTeamBoard(data([bad]), null, true);
    expect(b.repos[0]?.prs).toEqual([]);
  });
});

describe("buildTeamBoard の過去の日", () => {
  it("走行・質問待ちを出さず、その日の完了・失敗・費用だけ。その日に終わったものだけ数える", () => {
    const d = data([
      task({ owner_login: "bob-example", status: "COMPLETED", ended_at: "2026-10-21T03:00:00Z" }),
      // 翌日に終わった（その日の完了ではない）
      task({ owner_login: "bob-example", status: "COMPLETED", ended_at: "2026-10-22T01:00:00Z" }),
      task({ owner_login: "bob-example", status: "INPUT_REQUIRED", ended_at: null }),
    ]);
    const other = task({ owner_login: "carol-example", status: "INPUT_REQUIRED", ended_at: null });
    const b = buildTeamBoard(d, waiting([other]), false);
    expect(b.isToday).toBe(false);
    const p = person(b, "bob-example");
    expect(p.done).toBe(1);
    expect(p.running).toBe(0);
    expect(p.asking).toBe(0);
    expect(p.active).toEqual([]);
    expect(b.people.map((x) => x.login)).not.toContain("carol-example");
  });
});

describe("権限の無いタスクの情報を使わない", () => {
  it("overview.tasks と waiting.tasks 以外の値を使わない（hidden の件数は人に結び付けない）", () => {
    const b = buildTeamBoard(overviewFixture, waitingFixture, true);
    const text = JSON.stringify(b);
    expect(text).not.toContain("dave-hidden-example");
    expect(text).not.toContain("hidden-repo");
  });
});

describe("buildMonthCosts（人ごとの今月の費用）", () => {
  const month = (over: Partial<OverviewDto["month"]>): OverviewDto => ({
    ...overviewFixture,
    generated_at: "2026-10-16T00:00:00.000Z",
    budget: { ...overviewFixture.budget, monthly_budget_usd: 100 },
    month: { ...overviewFixture.month, ...over },
  });

  it("by_owner が無い（古い gateway）なら null", () => {
    const m = { ...overviewFixture.month } as OverviewDto["month"];
    delete m.by_owner;
    expect(buildMonthCosts({ ...overviewFixture, month: m })).toBeNull();
  });

  it("閲覧者が先頭・ほかは login 順。額はタスク + 相談、割合は共通の上限に対して。ペースは月の経過に対して速い・遅い", () => {
    const r = buildMonthCosts(
      month({
        by_owner: [
          { login: "zed-example", task_cost_usd: 10, consult_cost_usd: 5 },
          { login: "bob-example", task_cost_usd: 60, consult_cost_usd: 0 },
        ],
        hidden: { count: 2, cost_usd: 3 },
      }),
    );
    expect(r?.rows.map((x) => x.login)).toEqual(["alice-example", "bob-example", "zed-example"]);
    expect(r?.rows[0]).toMatchObject({ isViewer: true, spentUsd: 0, ratio: 0 });
    expect(r?.rows[1]).toMatchObject({ spentUsd: 60, limitUsd: 100, ratio: 0.6, pace: "fast" });
    expect(r?.rows[2]).toMatchObject({ spentUsd: 15, ratio: 0.15, pace: "slow" });
    expect(r?.hidden).toEqual({ count: 2, costUsd: 3 });
  });

  it("上限が無ければ割合とペースは null。hidden が 0 件なら null", () => {
    const d = month({
      by_owner: [{ login: "bob-example", task_cost_usd: 1, consult_cost_usd: 1 }],
      hidden: { count: 0, cost_usd: 0 },
    });
    const noLimit = { ...d, budget: { ...d.budget } };
    delete noLimit.budget.monthly_budget_usd;
    const r = buildMonthCosts(noLimit);
    expect(r?.rows[1]).toMatchObject({ spentUsd: 2, limitUsd: null, ratio: null, pace: null });
    expect(r?.hidden).toBeNull();
  });
});

describe("buildFlow（成果の推移の整形）", () => {
  const flowOf = (flow: Partial<NonNullable<OverviewDto["flow"]>>): OverviewDto => ({
    ...overviewFixture,
    flow: {
      period: { start: "2026-10-08T00:00:00.000Z", end: "2026-10-22T00:00:00.000Z" },
      days: [],
      median_duration_ms: null,
      pr_merged: 0,
      hidden: { count: 0, failed: 0 },
      ...flow,
    },
  });

  it("flow が無い古い応答は null", () => {
    expect(buildFlow(overviewFixture)).toBeNull();
  });

  it("14 日ぶんを古い順に並べ、欠けた日を 0 で埋める", () => {
    const f = buildFlow(
      flowOf({
        days: [
          { date: "2026-10-21", completed: 3, failed: 1, budget_exceeded: 2, cancelled: 4 },
          { date: "2026-10-08", completed: 1, failed: 0, budget_exceeded: 0, cancelled: 0 },
        ],
      }),
    );
    expect(f?.days).toHaveLength(14);
    expect(f?.days[0]).toMatchObject({ date: "2026-10-08", completed: 1, failed: 0 });
    expect(f?.days[13]).toMatchObject({ date: "2026-10-21", completed: 3, failed: 1 });
    expect(f?.days[5]).toMatchObject({ date: "2026-10-13", completed: 0, failed: 0 });
  });

  it("失敗率は 失敗 /（完了 + 失敗）。BUDGET_EXCEEDED・CANCELLED は入れず、件数を併記できる", () => {
    const f = buildFlow(
      flowOf({
        days: [
          { date: "2026-10-20", completed: 10, failed: 1, budget_exceeded: 9, cancelled: 9 },
          { date: "2026-10-21", completed: 6, failed: 1, budget_exceeded: 0, cancelled: 0 },
        ],
      }),
    );
    expect(f).toMatchObject({ completed: 16, failed: 2, rate: 2 / 18 });
  });

  it("完了も失敗も 0 件なら失敗率は null、少数でも件数をそのまま持つ", () => {
    expect(buildFlow(flowOf({}))).toMatchObject({ completed: 0, failed: 0, rate: null });
    expect(
      buildFlow(
        flowOf({
          days: [{ date: "2026-10-21", completed: 0, failed: 1, budget_exceeded: 0, cancelled: 0 }],
        }),
      ),
    ).toMatchObject({ completed: 0, failed: 1, rate: 1 });
  });

  it("中央値・マージ数・hidden を渡す（中央値が無ければ null、hidden が 0 件なら null）", () => {
    expect(buildFlow(flowOf({}))).toMatchObject({ medianMs: null, prMerged: 0, hidden: null });
    expect(
      buildFlow(
        flowOf({ median_duration_ms: 90_000, pr_merged: 4, hidden: { count: 5, failed: 2 } }),
      ),
    ).toMatchObject({ medianMs: 90_000, prMerged: 4, hidden: { count: 5, failed: 2 } });
  });

  it("UTC の日付の境界: 期間の終わり（明日 0 時 UTC）の前日 = 今日までの 14 日", () => {
    // 2026-10-25 23:59:59 UTC に集計した応答（end は 10-26 00:00 UTC）。今日（10-25）が最後の日
    const f = buildFlow(
      flowOf({
        period: { start: "2026-10-12T00:00:00.000Z", end: "2026-10-26T00:00:00.000Z" },
        days: [
          { date: "2026-10-25", completed: 2, failed: 0, budget_exceeded: 0, cancelled: 0 },
          { date: "2026-10-11", completed: 9, failed: 9, budget_exceeded: 0, cancelled: 0 },
        ],
      }),
    );
    expect(f?.days[0]?.date).toBe("2026-10-12");
    expect(f?.days[13]).toMatchObject({ date: "2026-10-25", completed: 2 });
    // 期間より前の日は入らない
    expect(f).toMatchObject({ completed: 2, failed: 0 });
  });

  it("月またぎ・年またぎでも日付が連続する", () => {
    const f = buildFlow(
      flowOf({ period: { start: "2025-12-24T00:00:00.000Z", end: "2026-01-07T00:00:00.000Z" } }),
    );
    expect(f?.days.map((d) => d.date)).toEqual([
      "2025-12-24",
      "2025-12-25",
      "2025-12-26",
      "2025-12-27",
      "2025-12-28",
      "2025-12-29",
      "2025-12-30",
      "2025-12-31",
      "2026-01-01",
      "2026-01-02",
      "2026-01-03",
      "2026-01-04",
      "2026-01-05",
      "2026-01-06",
    ]);
  });
});
