import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { consultBudgetUsd, DEFAULT_CONSULT_BUDGET_USD } from "../../src/tasks/budget";
import { ulid } from "../../src/tasks/ulid";
import { FP, newUserId, userStub } from "./helpers";

type UserStub = ReturnType<typeof userStub>;

const MICRO = 1_000_000;
const MIN = 60 * 1000;

async function setup(stub: UserStub, { start = Date.UTC(2026, 0, 15, 12), limitUsd = 100 } = {}) {
  let t = start;
  await runInDurableObject(stub, (i) => {
    const u = i as unknown as { now: () => number; monthlyLimitUsd: () => number };
    u.now = () => t;
    u.monthlyLimitUsd = () => limitUsd;
  });
  return {
    advance(ms: number) {
      t += ms;
    },
    set(ms: number) {
      t = ms;
    },
  };
}

function sql<T>(stub: UserStub, q: string, ...b: unknown[]): Promise<T[]> {
  return runInDurableObject(stub, (_i, s) => s.storage.sql.exec(q, ...b).toArray() as T[]);
}

const newConsultId = (at = Date.UTC(2026, 0, 15, 12)) => `consult-${ulid(at)}`;

describe("consultBudgetUsd（env の CONSULT_BUDGET_USD）", () => {
  it("既定 0.5。未設定・数でない・0 以下は既定に戻す", () => {
    expect(DEFAULT_CONSULT_BUDGET_USD).toBe(0.5);
    expect(consultBudgetUsd({})).toBe(0.5);
    expect(consultBudgetUsd({ CONSULT_BUDGET_USD: "" })).toBe(0.5);
    expect(consultBudgetUsd({ CONSULT_BUDGET_USD: "abc" })).toBe(0.5);
    expect(consultBudgetUsd({ CONSULT_BUDGET_USD: "0" })).toBe(0.5);
    expect(consultBudgetUsd({ CONSULT_BUDGET_USD: "-1" })).toBe(0.5);
    expect(consultBudgetUsd({ CONSULT_BUDGET_USD: "2" })).toBe(2);
  });
});

describe("UserDO.budgetStatus（budget_status）", () => {
  it("何も使っていなければ上限がそのまま残り、予約額から同時に始められるタスク数を出す", async () => {
    const stub = userStub(newUserId());
    await setup(stub);
    expect(await stub.budgetStatus()).toEqual({
      monthly_budget_usd: 100,
      spent_usd: 0,
      estimated_usd: 0,
      reserved_usd: 0,
      remaining_usd: 100,
      task_budget_usd: 10,
      consult_budget_usd: 0.5,
      max_concurrent_tasks: 10,
      concurrency_limit: 1, // Unit の vitest.config.ts の MAX_CONCURRENT_TASKS
      period: { start: "2026-01-01T00:00:00.000Z", end: "2026-02-01T00:00:00.000Z" },
    });
  });

  it("実行中のタスクの予約は reserved に、精算済みの実費は spent に出る。remaining は両方を引く", async () => {
    const stub = userStub(newUserId());
    await setup(stub);
    const r = await stub.reserve("k1", FP);
    if (!r.ok) throw new Error("reserve failed");
    expect(await stub.budgetStatus()).toMatchObject({
      spent_usd: 0,
      reserved_usd: 10,
      remaining_usd: 90,
      max_concurrent_tasks: 9,
    });
    await stub.settleUsage(r.task_id, 1, 3.25 * MICRO);
    // 実行中は max(予約, 実費) を数える（予約 10 のうち実費 3.25 が spent、残り 6.75 が reserved）
    expect(await stub.budgetStatus()).toMatchObject({
      spent_usd: 3.25,
      reserved_usd: 6.75,
      remaining_usd: 90,
    });
    await stub.finishTask(r.task_id, 2, 4 * MICRO);
    // 終了後は実費だけが残り、予約の余りは月の枠に戻る
    expect(await stub.budgetStatus()).toMatchObject({
      spent_usd: 4,
      reserved_usd: 0,
      remaining_usd: 96,
      max_concurrent_tasks: 9,
    });
  });

  it("remaining が負にならない（上限を超えた分は 0）。max_concurrent_tasks も 0", async () => {
    const stub = userStub(newUserId());
    await setup(stub, { limitUsd: 12 });
    const r = await stub.reserve("k1", FP);
    if (!r.ok) throw new Error("reserve failed");
    await stub.finishTask(r.task_id, 1, 15 * MICRO);
    expect(await stub.budgetStatus()).toMatchObject({
      monthly_budget_usd: 12,
      spent_usd: 15,
      remaining_usd: 0,
      max_concurrent_tasks: 0,
    });
  });

  it("他の月の使用は数えない", async () => {
    const stub = userStub(newUserId());
    const clock = await setup(stub);
    const r = await stub.reserve("k1", FP);
    if (!r.ok) throw new Error("reserve failed");
    await stub.finishTask(r.task_id, 1, 5 * MICRO);
    clock.set(Date.UTC(2026, 1, 2));
    expect(await stub.budgetStatus()).toMatchObject({
      spent_usd: 0,
      remaining_usd: 100,
      period: { start: "2026-02-01T00:00:00.000Z", end: "2026-03-01T00:00:00.000Z" },
    });
  });
});

describe("UserDO.reserveConsult / settleConsult", () => {
  it("同時実行の枠は使わず、月の枠から CONSULT_BUDGET_USD を予約する（タスクの実行中でも通る）", async () => {
    const stub = userStub(newUserId());
    await setup(stub);
    const task = await stub.reserve("k1", FP);
    if (!task.ok) throw new Error("reserve failed");
    const id = newConsultId();
    expect(await stub.reserveConsult(id)).toEqual({ ok: true, reserved_usd: 0.5 });
    expect(await sql(stub, "SELECT task_id FROM reservation_slot")).toEqual([
      { task_id: task.task_id },
    ]);
    expect(
      await sql(
        stub,
        "SELECT task_id, month, reserved_micro, settled_micro, closed FROM task_budget WHERE task_id = ?",
        id,
      ),
    ).toEqual([
      { task_id: id, month: "2026-01", reserved_micro: 0.5 * MICRO, settled_micro: 0, closed: 0 },
    ]);
    expect(await stub.budgetStatus()).toMatchObject({ reserved_usd: 10.5, remaining_usd: 89.5 });
  });

  it("月の枠が足りなければ budget_exceeded で、行も作らない。ちょうど足りれば通る", async () => {
    const stub = userStub(newUserId());
    await setup(stub, { limitUsd: 0.49 });
    expect(await stub.reserveConsult(newConsultId())).toEqual({
      ok: false,
      code: "budget_exceeded",
    });
    expect(await sql(stub, "SELECT * FROM task_budget")).toEqual([]);
    const exact = userStub(newUserId());
    await setup(exact, { limitUsd: 0.5 });
    expect(await exact.reserveConsult(newConsultId())).toMatchObject({ ok: true });
  });

  it("同じ consult の予約の再送は冪等（二重に予約しない）", async () => {
    const stub = userStub(newUserId());
    await setup(stub);
    const id = newConsultId();
    await stub.reserveConsult(id);
    expect(await stub.reserveConsult(id)).toEqual({ ok: true, reserved_usd: 0.5 });
    expect(await sql(stub, "SELECT * FROM task_budget")).toHaveLength(1);
  });

  it("consult の ID の形でなければ invalid_input（タスクの行を消費・精算できない）", async () => {
    const stub = userStub(newUserId());
    await setup(stub);
    for (const bad of ["", "task", ulid(), "consult-x", `consult-${ulid()}x`]) {
      expect(await stub.reserveConsult(bad), bad).toEqual({ ok: false, code: "invalid_input" });
    }
    const task = await stub.reserve("k1", FP);
    if (!task.ok) throw new Error("reserve failed");
    expect(await stub.settleConsult(task.task_id, 1)).toEqual({ ok: false });
  });

  it("精算: 実費を settled に書いて閉じる。予約の余りは月の枠に戻る", async () => {
    const stub = userStub(newUserId());
    await setup(stub);
    const id = newConsultId();
    await stub.reserveConsult(id);
    expect(await stub.settleConsult(id, 0.0123)).toEqual({ ok: true, applied: true });
    expect(
      await sql(stub, "SELECT settled_micro, closed FROM task_budget WHERE task_id = ?", id),
    ).toEqual([{ settled_micro: 12300, closed: 1 }]);
    expect(await stub.budgetStatus()).toMatchObject({
      spent_usd: 0.0123,
      reserved_usd: 0,
      remaining_usd: 99.9877,
    });
  });

  it("精算は 1 回だけ（再送は無視）。未知の consult は ok:false", async () => {
    const stub = userStub(newUserId());
    await setup(stub);
    const id = newConsultId();
    await stub.reserveConsult(id);
    await stub.settleConsult(id, 0.1);
    expect(await stub.settleConsult(id, 0.4)).toEqual({ ok: true, applied: false });
    expect(await sql(stub, "SELECT settled_micro FROM task_budget WHERE task_id = ?", id)).toEqual([
      { settled_micro: 100000 },
    ]);
    expect(await stub.settleConsult(newConsultId(), 0.1)).toEqual({ ok: false });
  });

  it("実費が分からない（null）ときは、予約額で閉じる（予約より少なく数えない）", async () => {
    const stub = userStub(newUserId());
    await setup(stub);
    const id = newConsultId();
    await stub.reserveConsult(id);
    expect(await stub.settleConsult(id, null)).toEqual({ ok: true, applied: true });
    expect(await stub.budgetStatus()).toMatchObject({ spent_usd: 0.5, reserved_usd: 0 });
  });

  it("壊れた実費（負・NaN）は無視し、予約は開いたまま", async () => {
    const stub = userStub(newUserId());
    await setup(stub);
    const id = newConsultId();
    await stub.reserveConsult(id);
    expect(await stub.settleConsult(id, -1)).toEqual({ ok: true, applied: false });
    expect(await stub.settleConsult(id, Number.NaN)).toEqual({ ok: true, applied: false });
    expect(await sql(stub, "SELECT closed FROM task_budget WHERE task_id = ?", id)).toEqual([
      { closed: 0 },
    ]);
  });

  it("精算されないまま 30 分たった consult の予約は、次の予約のときに予約額で閉じる", async () => {
    const stub = userStub(newUserId());
    const clock = await setup(stub);
    const stale = newConsultId(Date.UTC(2026, 0, 15, 12));
    await stub.reserveConsult(stale);
    clock.advance(29 * MIN);
    await stub.reserveConsult(newConsultId(Date.UTC(2026, 0, 15, 12, 29)));
    expect(await sql(stub, "SELECT closed FROM task_budget WHERE task_id = ?", stale)).toEqual([
      { closed: 0 },
    ]);
    clock.advance(2 * MIN);
    await stub.reserveConsult(newConsultId(Date.UTC(2026, 0, 15, 12, 31)));
    expect(
      await sql(stub, "SELECT settled_micro, closed FROM task_budget WHERE task_id = ?", stale),
    ).toEqual([{ settled_micro: 0.5 * MICRO, closed: 1 }]);
  });

  it("タスクの予約（reserve）のときも、30 分たった consult の予約を閉じてから月の枠を判定する", async () => {
    const stub = userStub(newUserId());
    const clock = await setup(stub, { limitUsd: 10.2 });
    const stale = newConsultId(Date.UTC(2026, 0, 15, 12));
    await stub.reserveConsult(stale);
    clock.advance(31 * MIN);
    // consult の予約 0.5 は閉じて実費（予約額）の 0.5 になる。10.2 − 0.5 = 9.7 < 10 なので、タスク（10）は始められない
    expect(await stub.reserve("k1", FP)).toEqual({ ok: false, code: "budget_exceeded" });
    expect(
      await sql(stub, "SELECT settled_micro, closed FROM task_budget WHERE task_id = ?", stale),
    ).toEqual([{ settled_micro: 0.5 * MICRO, closed: 1 }]);
  });
});

describe("見積もりで確定した分（estimated_usd。spent_usd の内数）", () => {
  const settledEstimated = (stub: UserStub, id: string) =>
    sql(stub, "SELECT settled_estimated FROM task_budget WHERE task_id = ?", id);

  it("実費が分かる精算は estimated_usd に入らない", async () => {
    const stub = userStub(newUserId());
    await setup(stub);
    const id = newConsultId();
    await stub.reserveConsult(id);
    await stub.settleConsult(id, 0.0123);
    expect(await settledEstimated(stub, id)).toEqual([{ settled_estimated: 0 }]);
    expect(await stub.budgetStatus()).toMatchObject({ spent_usd: 0.0123, estimated_usd: 0 });
  });

  it("settleConsult(null)（実費が分からない）は予約額で確定し、estimated_usd と spent_usd の両方に入る", async () => {
    const stub = userStub(newUserId());
    await setup(stub);
    const id = newConsultId();
    await stub.reserveConsult(id);
    await stub.settleConsult(id, null);
    expect(await settledEstimated(stub, id)).toEqual([{ settled_estimated: 1 }]);
    expect(await stub.budgetStatus()).toMatchObject({ spent_usd: 0.5, estimated_usd: 0.5 });
  });

  it("agent が見積もりと申告した精算（estimated=true）は、その額で確定して estimated_usd に入る", async () => {
    const stub = userStub(newUserId());
    await setup(stub);
    const id = newConsultId();
    await stub.reserveConsult(id);
    await stub.settleConsult(id, 0.4, true);
    expect(await stub.budgetStatus()).toMatchObject({ spent_usd: 0.4, estimated_usd: 0.4 });
  });

  it("estimated_usd は見積もりの行だけの合計。実費の行は含めず、spent_usd は両方の合計", async () => {
    const stub = userStub(newUserId());
    await setup(stub);
    const a = newConsultId();
    const b = newConsultId();
    const c = newConsultId();
    for (const id of [a, b, c]) await stub.reserveConsult(id);
    await stub.settleConsult(a, null);
    await stub.settleConsult(b, 0.01);
    await stub.settleConsult(c, 0.2, true);
    const task = await stub.reserve("k1", FP);
    if (!task.ok) throw new Error("reserve failed");
    await stub.settleUsage(task.task_id, 1, 3 * MICRO);
    expect(await stub.budgetStatus()).toMatchObject({
      spent_usd: 0.5 + 0.01 + 0.2 + 3,
      estimated_usd: 0.7,
    });
  });

  it("精算済みの行は再送で見積もりの印が変わらない（実費の精算を後から見積もりにしない）", async () => {
    const stub = userStub(newUserId());
    await setup(stub);
    const id = newConsultId();
    await stub.reserveConsult(id);
    await stub.settleConsult(id, 0.1);
    expect(await stub.settleConsult(id, null)).toEqual({ ok: true, applied: false });
    expect(await settledEstimated(stub, id)).toEqual([{ settled_estimated: 0 }]);
  });

  it("30 分たって予約額で閉じた consult は見積もりになる", async () => {
    const stub = userStub(newUserId());
    const clock = await setup(stub);
    const stale = newConsultId(Date.UTC(2026, 0, 15, 12));
    await stub.reserveConsult(stale);
    clock.advance(31 * MIN);
    await stub.reserveConsult(newConsultId(Date.UTC(2026, 0, 15, 12, 31)));
    expect(await settledEstimated(stub, stale)).toEqual([{ settled_estimated: 1 }]);
    expect(await stub.budgetStatus()).toMatchObject({ spent_usd: 0.5, estimated_usd: 0.5 });
  });

  it("列の追加前の task_budget の行は、見積もりではない扱い（0）になる", async () => {
    const stub = userStub(newUserId());
    await setup(stub);
    await runInDurableObject(stub, (instance, state) => {
      const s = state.storage.sql;
      s.exec("DROP TABLE task_budget");
      // 列の追加前のスキーマ
      s.exec(`CREATE TABLE task_budget (
        task_id TEXT PRIMARY KEY,
        month TEXT NOT NULL,
        reserved_micro INTEGER NOT NULL,
        settled_micro INTEGER NOT NULL DEFAULT 0,
        settled_seq INTEGER NOT NULL DEFAULT 0,
        closed INTEGER NOT NULL DEFAULT 0
      )`);
      s.exec(
        "INSERT INTO task_budget (task_id, month, reserved_micro, settled_micro, closed) VALUES (?, '2026-01', ?, ?, 1)",
        "consult-legacy",
        0.5 * MICRO,
        0.5 * MICRO,
      );
      // コンストラクタを同じストレージでもう一度走らせる（再起動での移行）
      const Ctor = instance.constructor as new (ctx: unknown, env: unknown) => unknown;
      new Ctor(state, (instance as unknown as { env: unknown }).env);
    });
    expect(await sql(stub, "SELECT settled_estimated FROM task_budget")).toEqual([
      { settled_estimated: 0 },
    ]);
    expect(await stub.budgetStatus()).toMatchObject({ spent_usd: 0.5, estimated_usd: 0 });
  });
});
