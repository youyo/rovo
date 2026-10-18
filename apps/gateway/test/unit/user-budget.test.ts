import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { FP, newUserId, sampleInput, taskStub, userStub } from "./helpers";

type UserStub = ReturnType<typeof userStub>;

const MICRO = 1_000_000;

/** UserDO の時刻と月額上限(USD)を差し替える。 */
async function setup(stub: UserStub, { start = Date.UTC(2026, 0, 15), limitUsd = 100 } = {}) {
  let t = start;
  await runInDurableObject(stub, (i) => {
    const u = i as unknown as { now: () => number; monthlyLimitUsd: () => number };
    u.now = () => t;
    u.monthlyLimitUsd = () => limitUsd;
  });
  return {
    set(ms: number) {
      t = ms;
    },
  };
}

function sql<T>(stub: UserStub, q: string, ...b: unknown[]): Promise<T[]> {
  return runInDurableObject(stub, (_i, s) => s.storage.sql.exec(q, ...b).toArray() as T[]);
}

async function reserve(stub: UserStub, key: string) {
  return stub.reserve(key, FP);
}

async function reserveOk(stub: UserStub, key: string) {
  const r = await reserve(stub, key);
  if (!r.ok) throw new Error(`reserve failed: ${r.code}`);
  return r.task_id;
}

describe("UserDO: 月額枠の予約", () => {
  it("reserve は同時実行枠と同じトランザクションでタスク予算($10)を月に予約する", async () => {
    const stub = userStub(newUserId());
    await setup(stub);
    const id = await reserveOk(stub, "k1");
    expect(
      await sql(
        stub,
        "SELECT task_id, month, reserved_micro, settled_micro, closed FROM task_budget",
      ),
    ).toEqual([
      { task_id: id, month: "2026-01", reserved_micro: 10 * MICRO, settled_micro: 0, closed: 0 },
    ]);
  });

  it("月額の上限に足りなければ budget_exceeded（request_key も予約も消費しない）", async () => {
    const stub = userStub(newUserId());
    await setup(stub, { limitUsd: 9.99 });
    expect(await reserve(stub, "k1")).toEqual({ ok: false, code: "budget_exceeded" });
    expect(await sql(stub, "SELECT * FROM requests")).toEqual([]);
    expect(await sql(stub, "SELECT * FROM task_budget")).toEqual([]);
    expect(await sql(stub, "SELECT active_task_id FROM reservation")).toEqual([
      { active_task_id: null },
    ]);
  });

  it("ちょうど足りるなら通る", async () => {
    const stub = userStub(newUserId());
    await setup(stub, { limitUsd: 10 });
    expect((await reserve(stub, "k1")).ok).toBe(true);
  });

  it("budget_exceeded の後、上限が上がれば同じキーで予約できる", async () => {
    const stub = userStub(newUserId());
    await setup(stub, { limitUsd: 5 });
    expect(await reserve(stub, "k1")).toMatchObject({ ok: false, code: "budget_exceeded" });
    await setup(stub, { limitUsd: 50 });
    expect((await reserve(stub, "k1")).ok).toBe(true);
  });

  it("同じキーの再試行は予算を再判定しない（既存を返す）", async () => {
    const stub = userStub(newUserId());
    await setup(stub, { limitUsd: 10 });
    const id = await reserveOk(stub, "k1");
    await setup(stub, { limitUsd: 1 });
    expect(await reserve(stub, "k1")).toEqual({ ok: true, task_id: id, reused: true });
    expect(await sql(stub, "SELECT * FROM task_budget")).toHaveLength(1);
  });

  it("同時実行の上限は予算より先に判定する", async () => {
    const stub = userStub(newUserId());
    await setup(stub, { limitUsd: 10 });
    await reserveOk(stub, "k1");
    expect(await reserve(stub, "k2")).toMatchObject({ ok: false, code: "concurrency_limit" });
  });

  it("MONTHLY_BUDGET_USD の既定は 100、環境変数で変えられ、不正な値は既定に戻す", async () => {
    const stub = userStub(newUserId());
    const limits = await runInDurableObject(stub, (i) => {
      const u = i as unknown as { env: Record<string, unknown>; monthlyLimitUsd: () => number };
      const out: number[] = [];
      for (const v of [undefined, "250", "abc", "-5", ""]) {
        u.env.MONTHLY_BUDGET_USD = v;
        out.push(u.monthlyLimitUsd());
      }
      u.env.MONTHLY_BUDGET_USD = undefined;
      return out;
    });
    expect(limits).toEqual([100, 250, 100, 100, 100]);
  });
});

describe("UserDO: usage の精算", () => {
  it("settleUsage は累計を記録し、seq が古い・同じものは無視する（冪等）", async () => {
    const stub = userStub(newUserId());
    await setup(stub);
    const id = await reserveOk(stub, "k1");
    expect(await stub.settleUsage(id, 5, 2 * MICRO)).toEqual({ ok: true, applied: true });
    expect(await stub.settleUsage(id, 5, 2 * MICRO)).toEqual({ ok: true, applied: false });
    expect(await stub.settleUsage(id, 3, 9 * MICRO)).toEqual({ ok: true, applied: false });
    expect(await stub.settleUsage(id, 8, 3 * MICRO)).toEqual({ ok: true, applied: true });
    expect(await sql(stub, "SELECT settled_micro, settled_seq FROM task_budget")).toEqual([
      { settled_micro: 3 * MICRO, settled_seq: 8 },
    ]);
  });

  it("予約の無いタスクの精算は ok:false", async () => {
    const stub = userStub(newUserId());
    expect(await stub.settleUsage("NOSUCH", 1, 1)).toEqual({ ok: false });
  });

  it("実費は月の枠を使い、予約($10)を超えた分も数える", async () => {
    const stub = userStub(newUserId());
    await setup(stub, { limitUsd: 25 });
    const a = await reserveOk(stub, "k1");
    await stub.settleUsage(a, 1, 12 * MICRO);
    await stub.finishTask(a, 1, 12 * MICRO);
    // 12 使用済み + 10 予約 = 22 <= 25
    const b = await reserveOk(stub, "k2");
    await stub.settleUsage(b, 1, 9 * MICRO);
    await stub.finishTask(b, 1, 9 * MICRO);
    // 21 使用済み + 10 > 25
    expect(await reserve(stub, "k3")).toMatchObject({ ok: false, code: "budget_exceeded" });
  });

  it("月またぎのタスクの費用は開始した月に計上する", async () => {
    const stub = userStub(newUserId());
    const clock = await setup(stub, { start: Date.UTC(2026, 0, 31, 23, 59), limitUsd: 15 });
    const a = await reserveOk(stub, "k1");
    clock.set(Date.UTC(2026, 1, 1, 0, 5));
    await stub.settleUsage(a, 1, 9 * MICRO);
    await stub.finishTask(a, 1, 9 * MICRO);
    expect(await sql(stub, "SELECT month, settled_micro FROM task_budget")).toEqual([
      { month: "2026-01", settled_micro: 9 * MICRO },
    ]);
    // 2 月の枠は使っていない
    expect((await reserve(stub, "k2")).ok).toBe(true);
  });

  it("同じ月で上限を使い切ると、翌月までは拒否される", async () => {
    const stub = userStub(newUserId());
    const clock = await setup(stub, { start: Date.UTC(2026, 0, 10), limitUsd: 15 });
    const a = await reserveOk(stub, "k1");
    await stub.finishTask(a, 1, 9 * MICRO);
    expect(await reserve(stub, "k2")).toMatchObject({ ok: false, code: "budget_exceeded" });
    clock.set(Date.UTC(2026, 1, 2));
    expect((await reserve(stub, "k2")).ok).toBe(true);
  });
});

describe("UserDO.finishTask", () => {
  it("最終の実費を記録して予約を閉じ、同時実行枠を解放する。差額($10 - 実費)は枠に戻る", async () => {
    const stub = userStub(newUserId());
    await setup(stub, { limitUsd: 15 });
    const id = await reserveOk(stub, "k1");
    expect(await stub.finishTask(id, 4, 3 * MICRO)).toEqual({ ok: true, released: true });
    expect(await sql(stub, "SELECT settled_micro, closed FROM task_budget")).toEqual([
      { settled_micro: 3 * MICRO, closed: 1 },
    ]);
    expect(await sql(stub, "SELECT active_task_id FROM reservation")).toEqual([
      { active_task_id: null },
    ]);
    // 3 使用済み + 10 予約 <= 15 なので次を始められる
    expect((await reserve(stub, "k2")).ok).toBe(true);
  });

  it("冪等: 2 回目は何も変えない。古い seq の費用で巻き戻さない", async () => {
    const stub = userStub(newUserId());
    await setup(stub);
    const id = await reserveOk(stub, "k1");
    await stub.finishTask(id, 4, 3 * MICRO);
    expect(await stub.finishTask(id, 4, 3 * MICRO)).toEqual({ ok: true, released: false });
    expect(await stub.finishTask(id, 2, 1 * MICRO)).toEqual({ ok: true, released: false });
    expect(await sql(stub, "SELECT settled_micro FROM task_budget")).toEqual([
      { settled_micro: 3 * MICRO },
    ]);
  });

  it("予約先が別のタスクなら枠は解放しない（compare-and-clear）", async () => {
    const stub = userStub(newUserId());
    await setup(stub);
    const a = await reserveOk(stub, "k1");
    await stub.finishTask(a, 0, 0);
    const b = await reserveOk(stub, "k2");
    expect(await stub.finishTask(a, 0, 0)).toEqual({ ok: true, released: false });
    expect(await sql(stub, "SELECT active_task_id FROM reservation")).toEqual([
      { active_task_id: b },
    ]);
  });
});

describe("UserDO: 照合は TaskDO の停止確認済みを条件にする", () => {
  async function started(uid: number, key: string) {
    const user = userStub(uid);
    const id = await reserveOk(user, key);
    await taskStub(id).ensureCreated(sampleInput(id, uid));
    return { user, id, task: taskStub(id) };
  }

  it("CANCELLED でも停止が確認できなければ concurrency_limit のまま", async () => {
    const { fakeAgent } = await import("./helpers");
    const uid = newUserId();
    const { user, id, task } = await started(uid, "k1");
    await fakeAgent(id).setProgram({ cancel: ["not_stopped"] });
    await task.cancel(uid);
    await task.advance();
    expect(await reserve(user, "k2")).toMatchObject({ ok: false, code: "concurrency_limit" });
  });

  it("停止が確認できたら回収され、次のタスクを始められる", async () => {
    const uid = newUserId();
    const { user, task } = await started(uid, "k1");
    await task.cancel(uid);
    await task.advance();
    expect((await reserve(user, "k2")).ok).toBe(true);
  });

  it("abandoned で回収した予約は、予算も返す", async () => {
    const uid = newUserId();
    const user = userStub(uid);
    const clock = await setup(user, { limitUsd: 10 });
    const id = await reserveOk(user, "k1");
    clock.set(Date.UTC(2026, 0, 15) + 11 * 60_000);
    expect((await reserve(user, "k2")).ok).toBe(true);
    expect(await sql(user, "SELECT closed FROM task_budget WHERE task_id = ?", id)).toEqual([
      { closed: 1 },
    ]);
  });
});
