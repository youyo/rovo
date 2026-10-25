import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ulid } from "../../src/tasks/ulid";
import { CONSULT_STALE_AFTER_MS } from "../../src/tasks/user-do";
import { FP, newUserId, userStub } from "./helpers";

// UserDO.dashboardBudget(): ダッシュボードの予算の表示用（M5b）。budgetStatus に、いま同時実行の枠を持つタスクの数を足す。
// BudgetStatus の型は MCP の budget_status と共用なので、running_slots は budget_status の応答には現れない。

describe("UserDO.dashboardBudget", () => {
  it("budgetStatus と同じ値に running_slots を足す。予約すると枠が 1 増える", async () => {
    const stub = userStub(newUserId());
    await runInDurableObject(stub, (i) => {
      const u = i as unknown as { now: () => number; concurrencyLimit: () => number };
      u.now = () => Date.UTC(2026, 9, 15);
      u.concurrencyLimit = () => 3;
    });
    const before = await stub.dashboardBudget();
    expect(before).toEqual({ ...(await stub.budgetStatus()), running_slots: 0 });
    expect(before.concurrency_limit).toBe(3);

    const r = await stub.reserve("req-1", FP);
    expect(r.ok).toBe(true);
    const after = await stub.dashboardBudget();
    expect(after.running_slots).toBe(1);
    expect(after.reserved_usd).toBeGreaterThan(0);
    // MCP の budget_status には running_slots は出ない
    expect(await stub.budgetStatus()).not.toHaveProperty("running_slots");
  });
});

describe("UserDO.dashboardMonthSpent", () => {
  it("今月の台帳の spent / estimated をマイクロドルで返す（budget_status の spent_usd と同じ定義。予約中の分は含めない）", async () => {
    const stub = userStub(newUserId());
    await runInDurableObject(stub, (i) => {
      const u = i as unknown as { now: () => number };
      u.now = () => Date.UTC(2026, 9, 15);
    });
    expect(await stub.dashboardMonthSpent()).toEqual({ spent_micro: 0, estimated_micro: 0 });

    const r = await stub.reserve("req-spent", FP);
    if (!r.ok) throw new Error("reserve failed");
    await stub.settleUsage(r.task_id, 1, 2_500_000);
    const status = await stub.budgetStatus();
    const spent = await stub.dashboardMonthSpent();
    expect(spent.spent_micro).toBe(2_500_000);
    expect(spent.spent_micro / 1_000_000).toBe(status.spent_usd);
    expect(spent.estimated_micro).toBe(0);
  });

  it("読み取りだけ: 期限切れで閉じていない consult の予約を閉じず、alarm も立てず、spent に入れない", async () => {
    const stub = userStub(newUserId());
    const t0 = Date.UTC(2026, 9, 15, 12);
    let now = t0;
    await runInDurableObject(stub, (i) => {
      (i as unknown as { now: () => number }).now = () => now;
    });
    const id = `consult-${ulid(t0)}`;
    expect(await stub.reserveConsult(id)).toMatchObject({ ok: true });
    const probe = () =>
      runInDurableObject(stub, async (_i, state) => ({
        alarm: await state.storage.getAlarm(),
        rows: state.storage.sql
          .exec("SELECT closed, settled_micro FROM task_budget WHERE task_id = ?", id)
          .toArray(),
      }));
    // 期限を過ぎ、alarm を消した状態で呼ぶ
    now = t0 + CONSULT_STALE_AFTER_MS + 1000;
    await runInDurableObject(stub, async (_i, state) => state.storage.deleteAlarm());
    const spent = await stub.dashboardMonthSpent();
    expect(spent).toEqual({ spent_micro: 0, estimated_micro: 0 });
    const after = await probe();
    expect(after.alarm).toBeNull();
    expect(after.rows).toEqual([{ closed: 0, settled_micro: 0 }]);
    // 本人が budgetStatus を呼べば、そこで閉じる（予約額が spent になる）
    const status = await stub.budgetStatus();
    expect(status.spent_usd).toBeGreaterThan(0);
    expect((await stub.dashboardMonthSpent()).spent_micro).toBe(Math.round(status.spent_usd * 1e6));
  });
});
