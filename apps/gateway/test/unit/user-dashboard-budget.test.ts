import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
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
});
