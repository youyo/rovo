import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { FP, newUserId, userStub } from "./helpers";

// タスクの予算の延長（budget_policy: ask）。承認のたびに、タスクの予算（task_budget_usd）と同じ額を月の枠から「その場で」予約する。
// 月の枠はハードリミットのまま: 足りなければ予約できない（budget_exceeded）。同じ延長の再送は冪等。

type UserStub = ReturnType<typeof userStub>;
const MICRO = 1_000_000;

async function setup(stub: UserStub, { limitUsd = 100, taskUsd = "3" } = {}) {
  await runInDurableObject(stub, (i) => {
    const u = i as unknown as {
      now: () => number;
      monthlyLimitUsd: () => number;
      env: Record<string, string | undefined>;
    };
    u.now = () => Date.UTC(2026, 0, 15);
    u.monthlyLimitUsd = () => limitUsd;
    u.env.TASK_BUDGET_USD = taskUsd;
    u.env.MAX_CONCURRENT_TASKS = "5";
  });
}

function sql<T>(stub: UserStub, q: string, ...b: unknown[]): Promise<T[]> {
  return runInDurableObject(stub, (_i, s) => s.storage.sql.exec(q, ...b).toArray() as T[]);
}

async function reserveOk(stub: UserStub, key: string) {
  const r = await stub.reserve(key, FP);
  if (!r.ok) throw new Error(`reserve failed: ${r.code}`);
  return r.task_id;
}

describe("UserDO.extendTaskBudget: 延長の予約", () => {
  it("1 回目の延長で task_budget_usd と同じ額を、そのタスクの予約に足す。budget_status の reserved_usd と remaining_usd に反映される", async () => {
    const stub = userStub(newUserId());
    await setup(stub);
    const id = await reserveOk(stub, "k1");
    expect((await stub.budgetStatus()).reserved_usd).toBe(3);
    const r = await stub.extendTaskBudget(id, 1);
    expect(r).toEqual({ ok: true, applied: true, reserved_usd: 6 });
    const s = await stub.budgetStatus();
    expect(s.reserved_usd).toBe(6);
    expect(s.remaining_usd).toBe(94);
    expect(
      await sql(stub, "SELECT reserved_micro, extensions FROM task_budget WHERE task_id = ?", id),
    ).toEqual([{ reserved_micro: 6 * MICRO, extensions: 1 }]);
  });

  it("同じ延長（n）の再送は冪等で、二重に予約しない", async () => {
    const stub = userStub(newUserId());
    await setup(stub);
    const id = await reserveOk(stub, "k1");
    await stub.extendTaskBudget(id, 1);
    expect(await stub.extendTaskBudget(id, 1)).toEqual({
      ok: true,
      applied: false,
      reserved_usd: 6,
    });
    expect((await stub.budgetStatus()).reserved_usd).toBe(6);
  });

  it("延長は 2 回まで。1 回目より先に 2 回目は取れず、3 回目は invalid_input", async () => {
    const stub = userStub(newUserId());
    await setup(stub);
    const id = await reserveOk(stub, "k1");
    expect(await stub.extendTaskBudget(id, 2)).toEqual({ ok: false, code: "invalid_input" });
    expect(await stub.extendTaskBudget(id, 1)).toMatchObject({ ok: true, reserved_usd: 6 });
    expect(await stub.extendTaskBudget(id, 2)).toMatchObject({ ok: true, reserved_usd: 9 });
    expect(await stub.extendTaskBudget(id, 3)).toEqual({ ok: false, code: "invalid_input" });
    expect(await stub.extendTaskBudget(id, 0)).toEqual({ ok: false, code: "invalid_input" });
    expect((await stub.budgetStatus()).reserved_usd).toBe(9);
  });

  it("月の枠が足りなければ予約しない（budget_exceeded）。月の枠はハードリミット", async () => {
    const stub = userStub(newUserId());
    await setup(stub, { limitUsd: 5 });
    const id = await reserveOk(stub, "k1");
    // 予約 3 + 延長 3 = 6 > 5
    expect(await stub.extendTaskBudget(id, 1)).toEqual({ ok: false, code: "budget_exceeded" });
    expect((await stub.budgetStatus()).reserved_usd).toBe(3);
    expect(
      await sql(stub, "SELECT reserved_micro, extensions FROM task_budget WHERE task_id = ?", id),
    ).toEqual([{ reserved_micro: 3 * MICRO, extensions: 0 }]);
  });

  it("ちょうど枠に収まるなら予約できる。他のタスクの予約・使用済みの実費も数える", async () => {
    const stub = userStub(newUserId());
    await setup(stub, { limitUsd: 9 });
    const a = await reserveOk(stub, "ka"); // 3
    await reserveOk(stub, "kb"); // 3 → 合計 6
    expect(await stub.extendTaskBudget(a, 1)).toMatchObject({ ok: true, reserved_usd: 6 }); // 9
    // これ以上は 9 を超える
    expect(await stub.extendTaskBudget(a, 2)).toEqual({ ok: false, code: "budget_exceeded" });
  });

  it("知らないタスクは not_found、精算済み（closed）のタスクは closed", async () => {
    const stub = userStub(newUserId());
    await setup(stub);
    expect(await stub.extendTaskBudget("01HZZZZZZZZZZZZZZZZZZZZZZZ", 1)).toEqual({
      ok: false,
      code: "not_found",
    });
    const id = await reserveOk(stub, "k1");
    await stub.finishTask(id, 1, 1 * MICRO);
    expect(await stub.extendTaskBudget(id, 1)).toEqual({ ok: false, code: "closed" });
  });

  it("延長した後のタスクを終えると、予約は閉じて実費だけが残る（延長分の未使用は月の枠に戻る）", async () => {
    const stub = userStub(newUserId());
    await setup(stub);
    const id = await reserveOk(stub, "k1");
    await stub.extendTaskBudget(id, 1);
    await stub.finishTask(id, 1, 4 * MICRO);
    const s = await stub.budgetStatus();
    expect(s.reserved_usd).toBe(0);
    expect(s.spent_usd).toBe(4);
  });
});
