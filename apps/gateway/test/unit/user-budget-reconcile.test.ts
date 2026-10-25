import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { FP, newUserId, userStub } from "./helpers";

const MICRO = 1_000_000;
type UserStub = ReturnType<typeof userStub>;

const row = (stub: UserStub, id: string) =>
  runInDurableObject(
    stub,
    (_i, s) =>
      s.storage.sql
        .exec(
          "SELECT month, settled_micro, settled_estimated, closed, cost_source FROM task_budget WHERE task_id = ?",
          id,
        )
        .toArray()[0],
  );

async function reserved() {
  const stub = userStub(newUserId());
  const r = await stub.reserve("k", FP);
  if (!r.ok) throw new Error("reserve");
  return { stub, id: r.task_id };
}

describe("UserDO.reconcileTaskCost", () => {
  it("既定の cost_source は estimate。閉じた行だけ settled_micro を確定額で上書きし、gateway にする", async () => {
    const { stub, id } = await reserved();
    await stub.finishTask(id, 1, 3 * MICRO);
    expect(await row(stub, id)).toMatchObject({
      cost_source: "estimate",
      settled_micro: 3 * MICRO,
    });
    expect(await stub.reconcileTaskCost(id, 2 * MICRO)).toEqual({ ok: true, applied: true });
    expect(await row(stub, id)).toMatchObject({
      cost_source: "gateway",
      settled_micro: 2 * MICRO,
      closed: 1,
    });
  });

  it("上書きすると settled_estimated は 0 になる（実費で確定したので見積もりではない）", async () => {
    const { stub, id } = await reserved();
    await stub.finishTask(id, 1, 3 * MICRO);
    await runInDurableObject(stub, (_i, st) => {
      st.storage.sql.exec("UPDATE task_budget SET settled_estimated = 1 WHERE task_id = ?", id);
    });
    expect(await row(stub, id)).toMatchObject({ settled_estimated: 1 });
    await stub.reconcileTaskCost(id, 2 * MICRO);
    expect(await row(stub, id)).toMatchObject({ settled_estimated: 0, cost_source: "gateway" });
  });

  it("2 回目以降は無視する（冪等）", async () => {
    const { stub, id } = await reserved();
    await stub.finishTask(id, 1, 3 * MICRO);
    await stub.reconcileTaskCost(id, 2 * MICRO);
    expect(await stub.reconcileTaskCost(id, 9 * MICRO)).toEqual({ ok: true, applied: false });
    expect(await row(stub, id)).toMatchObject({ settled_micro: 2 * MICRO });
  });

  it("閉じていない行・存在しない行・不正な額は無視する", async () => {
    const { stub, id } = await reserved();
    expect(await stub.reconcileTaskCost(id, 2 * MICRO)).toEqual({ ok: true, applied: false });
    expect(await row(stub, id)).toMatchObject({ cost_source: "estimate", settled_micro: 0 });
    await stub.finishTask(id, 1, MICRO);
    expect(await stub.reconcileTaskCost(id, -1)).toEqual({ ok: true, applied: false });
    expect(await stub.reconcileTaskCost("01JNOSUCHTASK00000000000000", MICRO)).toEqual({
      ok: false,
    });
  });

  it("月の集計に確定額が反映され、月は予約した行のまま", async () => {
    const { stub, id } = await reserved();
    const before = await row(stub, id);
    await stub.finishTask(id, 1, 3 * MICRO);
    await stub.reconcileTaskCost(id, 1 * MICRO);
    expect((await row(stub, id))?.month).toBe(before?.month);
    const spent = await runInDurableObject(
      stub,
      (_i, s) =>
        s.storage.sql
          .exec("SELECT COALESCE(SUM(settled_micro),0) AS t FROM task_budget WHERE closed = 1")
          .one().t,
    );
    expect(spent).toBe(1 * MICRO);
  });
});
