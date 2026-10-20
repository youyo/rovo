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
