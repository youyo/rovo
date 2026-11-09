import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { taskBudgetUsd } from "../../src/tasks/budget";
import { FP, fakeAgent, newTaskId, newUserId, sampleInput, taskStub, userStub } from "./helpers";

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

/** env の TASK_BUDGET_USD を差し替え、元の値を返す（env は他のテストと共有されるので、必ず戻すこと）。 */
async function setTaskBudget(stub: UserStub, v: string | undefined): Promise<string | undefined> {
  return runInDurableObject(stub, (i) => {
    const env = (i as unknown as { env: Record<string, string | undefined> }).env;
    const old = env.TASK_BUDGET_USD;
    env.TASK_BUDGET_USD = v;
    return old;
  });
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
    expect(await sql(stub, "SELECT task_id FROM reservation_slot")).toEqual([]);
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

describe("UserDO: タスクの予約額（TASK_BUDGET_USD）", () => {
  it("既定は 10、環境変数で変えられ、0 以下・数でない値は既定に戻す", async () => {
    const stub = userStub(newUserId());
    const budgets = await runInDurableObject(stub, (i) => {
      const u = i as unknown as { env: Record<string, unknown> };
      const out: number[] = [];
      for (const v of [undefined, "1.5", "abc", "0", "-3", "", " ", "Infinity", "NaN"]) {
        u.env.TASK_BUDGET_USD = v;
        out.push(taskBudgetUsd(u.env as { TASK_BUDGET_USD?: string }));
      }
      u.env.TASK_BUDGET_USD = undefined;
      return out;
    });
    expect(budgets).toEqual([10, 1.5, 10, 10, 10, 10, 10, 10, 10]);
  });

  it("env で 1.5 にすると reserved_micro は 1.5 ドル分になる", async () => {
    const stub = userStub(newUserId());
    await setup(stub);
    const restore = await setTaskBudget(stub, "1.5");
    try {
      await reserveOk(stub, "k1");
      expect(await sql(stub, "SELECT reserved_micro FROM task_budget")).toEqual([
        { reserved_micro: 1.5 * MICRO },
      ]);
    } finally {
      await setTaskBudget(stub, restore);
    }
  });

  it("月額 5・予約 1.5 なら、3 件目まで始められ 4 件目は拒否される", async () => {
    const stub = userStub(newUserId());
    await setup(stub, { limitUsd: 5 });
    const restore = await setTaskBudget(stub, "1.5");
    try {
      // 1 件ずつ実費 1.5 で完了させて月の枠に積む（同時実行は 1 件まで）。
      for (const k of ["k1", "k2", "k3"]) {
        const id = await reserveOk(stub, k); // 積み上がり 0 / 1.5 / 3.0 + 予約 1.5 <= 5
        await stub.finishTask(id, 1, 1.5 * MICRO);
      }
      // 4.5 + 1.5 = 6 > 5
      expect(await reserve(stub, "k4")).toEqual({ ok: false, code: "budget_exceeded" });
    } finally {
      await setTaskBudget(stub, restore);
    }
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
    expect(await sql(stub, "SELECT task_id FROM reservation_slot")).toEqual([]);
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
    expect(await sql(stub, "SELECT task_id FROM reservation_slot")).toEqual([{ task_id: b }]);
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

/** TaskDO → UserDO の呼び出しを止める / 戻す（精算や終了通知が届かない状況の再現）。 */
async function setUserDown(task: ReturnType<typeof taskStub>, down: boolean) {
  await runInDurableObject(task, (i) => {
    const t = i as unknown as { userStub: (n: number) => unknown; __userDown?: boolean };
    if (t.__userDown === undefined) {
      const orig = t.userStub.bind(i);
      t.userStub = (n: number) => {
        if (t.__userDown) throw new Error("user do unreachable");
        return orig(n);
      };
    }
    t.__userDown = down;
  });
}

describe("UserDO: 予算の返却は最終精算(finishTask)だけが行う", () => {
  async function runningTask(uid: number, user: UserStub, key: string) {
    const id = await reserveOk(user, key);
    const task = taskStub(id);
    await task.ensureCreated(sampleInput(id, uid));
    await task.advance(); // RUNNING
    return { id, task, agent: fakeAgent(id) };
  }

  it("反例: 停止確認だけの A を回収して予算を返すと、A の精算後に合計が上限($15)を超える", async () => {
    const uid = newUserId();
    const user = userStub(uid);
    await setup(user, { limitUsd: 15 });
    const a = await runningTask(uid, user, "k1");
    await a.agent.setUsage(9);
    await a.agent.setPhase("completed");
    await setUserDown(a.task, true);
    await a.task.advance(); // 取り込みと停止確認は済むが、精算も終了通知も UserDO に届かない
    expect(await a.task.inspect()).toMatchObject({ status: "COMPLETED", stopped: true });

    // B: 停止が確認できていても、A の予算と枠は戻らない
    expect(await reserve(user, "k2")).toMatchObject({ ok: false, code: "concurrency_limit" });
    expect(await sql(user, "SELECT task_id FROM reservation_slot")).toEqual([{ task_id: a.id }]);
    expect(
      await sql(user, "SELECT reserved_micro, settled_micro, closed FROM task_budget"),
    ).toEqual([{ reserved_micro: 10 * MICRO, settled_micro: 0, closed: 0 }]);

    // TaskDO の alarm が精算と終了通知を再送して収束する
    await setUserDown(a.task, false);
    await runDurableObjectAlarm(a.task);
    expect(await sql(user, "SELECT settled_micro, closed FROM task_budget")).toEqual([
      { settled_micro: 9 * MICRO, closed: 1 },
    ]);
    expect(await sql(user, "SELECT task_id FROM reservation_slot")).toEqual([]);
    // 9 使用済み + 10 > 15: 二重に予算を渡さない
    expect(await reserve(user, "k2")).toMatchObject({ ok: false, code: "budget_exceeded" });
  });

  it("alarm で収束したあとは、枠も予算も戻って次を始められる", async () => {
    const uid = newUserId();
    const user = userStub(uid);
    await setup(user, { limitUsd: 25 });
    const a = await runningTask(uid, user, "k1");
    await a.agent.setUsage(9);
    await a.agent.setPhase("completed");
    await setUserDown(a.task, true);
    await a.task.advance();
    expect(await reserve(user, "k2")).toMatchObject({ ok: false, code: "concurrency_limit" });
    await setUserDown(a.task, false);
    await runDurableObjectAlarm(a.task);
    expect((await reserve(user, "k2")).ok).toBe(true);
  });
});

describe("UserDO: Phase 1 の CREATING(agent_link なし)は照合で回収する", () => {
  it("agent_link が無いタスクは abandoned と同じ扱いで回収される。task_status では表示できる", async () => {
    const uid = newUserId();
    const user = userStub(uid);
    await setup(user, { limitUsd: 10 });
    const id = await reserveOk(user, "k1");
    const task = taskStub(id);
    await task.ensureCreated(sampleInput(id, uid));
    // Phase 1 で作られたタスクを再現する: ワーカーとの配送状態が無い
    await runInDurableObject(task, (_i, s) => {
      s.storage.sql.exec("DELETE FROM agent_link");
    });
    expect(await task.inspect()).toEqual({ kind: "legacy" });
    const st = await task.getStatus(uid);
    expect(st.ok && st.task.status).toBe("CREATING");

    expect((await reserve(user, "k2")).ok).toBe(true);
    expect(await sql(user, "SELECT closed FROM task_budget WHERE task_id = ?", id)).toEqual([
      { closed: 1 },
    ]);
  });
});

describe("UserDO: branch_lock と branch_chain（積み足しの同時実行とチェーンの最新。docs/specs/continue-task.md）", () => {
  const FP2 = "e".repeat(64);
  const FP3 = "d".repeat(64);
  const MIN = 60 * 1000;
  const lockOf = (root: string, continueOf = root) => ({
    branch: `agent/task-${root}`,
    continueOf,
  });

  /** この UserDO インスタンスだけ同時実行の上限を変える（Unit の既定は 1） */
  async function setLimit(stub: UserStub, value: string) {
    await runInDurableObject(stub, (i) => {
      const inst = i as unknown as { env: Record<string, unknown> };
      inst.env = { ...inst.env, MAX_CONCURRENT_TASKS: value };
    });
  }

  async function useClock(stub: UserStub, start = Date.now()) {
    let t = start;
    await runInDurableObject(stub, (i) => {
      (i as unknown as { now: () => number }).now = () => t;
    });
    return {
      advance(ms: number) {
        t += ms;
      },
    };
  }

  async function reserveLocked(
    stub: UserStub,
    key: string,
    fp: string,
    lock: { branch: string; continueOf: string },
  ) {
    const r = await stub.reserve(key, fp, lock);
    if (!r.ok) throw new Error(`reserve failed: ${r.code}`);
    return r.task_id;
  }

  const locks = (stub: UserStub) =>
    sql<{ branch: string; task_id: string; continue_of: string }>(
      stub,
      "SELECT branch, task_id, continue_of FROM branch_lock ORDER BY branch",
    );
  const chain = (stub: UserStub) =>
    sql<{ branch: string; latest_task_id: string; prev_task_id: string }>(
      stub,
      "SELECT branch, latest_task_id, prev_task_id FROM branch_chain ORDER BY branch",
    );

  it("同じ鍵の 2 回目は branch_busy（実行中の積み足しの id が載る）。枠・予算・request_key を消費しない", async () => {
    const stub = userStub(newUserId());
    await setLimit(stub, "4");
    const root = newTaskId();
    const a = await reserveLocked(stub, "k1", FP, lockOf(root));
    expect(await locks(stub)).toEqual([
      { branch: `agent/task-${root}`, task_id: a, continue_of: root },
    ]);
    expect(await stub.reserve("k2", FP2, lockOf(root))).toEqual({
      ok: false,
      code: "branch_busy",
      task_id: a,
    });
    expect(await sql(stub, "SELECT task_id FROM requests")).toEqual([{ task_id: a }]);
    expect(await sql(stub, "SELECT task_id FROM task_budget")).toEqual([{ task_id: a }]);
    expect(await sql(stub, "SELECT task_id FROM reservation_slot")).toEqual([{ task_id: a }]);
  });

  it("別の鍵（別の PR）は通る。鍵を取らない通常の予約も鍵に関係なく通る", async () => {
    const stub = userStub(newUserId());
    await setLimit(stub, "4");
    const r1 = newTaskId();
    const r2 = newTaskId();
    const a = await reserveLocked(stub, "k1", FP, lockOf(r1));
    const b = await reserveLocked(stub, "k2", FP2, lockOf(r2));
    expect(b).not.toBe(a);
    const c = await stub.reserve("k3", FP3);
    expect(c.ok).toBe(true);
    expect((await locks(stub)).map((l) => l.task_id).sort()).toEqual([a, b].sort());
  });

  it("同じ requestKey の再試行は、鍵があっても同じ task_id（冪等の判定が先）", async () => {
    const stub = userStub(newUserId());
    const root = newTaskId();
    const a = await reserveLocked(stub, "k1", FP, lockOf(root));
    expect(await stub.reserve("k1", FP, lockOf(root))).toEqual({
      ok: true,
      task_id: a,
      reused: true,
    });
    expect(await stub.reserve("k1", FP2, lockOf(root))).toEqual({ ok: false, code: "conflict" });
    expect(await locks(stub)).toHaveLength(1);
  });

  it("branch_busy は同時実行の上限（concurrency_limit）より先に判定する", async () => {
    const stub = userStub(newUserId());
    const root = newTaskId();
    const a = await reserveLocked(stub, "k1", FP, lockOf(root));
    // Unit の上限は 1 なので枠も埋まっているが、同じ PR への積み足しは branch_busy で断る
    expect(await stub.reserve("k2", FP2, lockOf(root))).toEqual({
      ok: false,
      code: "branch_busy",
      task_id: a,
    });
  });

  it("branch_chain: 行が無ければ根が最新。予約で latest を新しいタスク、prev をそれまでの最新にする", async () => {
    const stub = userStub(newUserId());
    const root = newTaskId();
    expect(await chain(stub)).toEqual([]);
    const c1 = await reserveLocked(stub, "k1", FP, lockOf(root));
    expect(await chain(stub)).toEqual([
      { branch: `agent/task-${root}`, latest_task_id: c1, prev_task_id: root },
    ]);
    await stub.finishTask(c1, 0, 0);
    const c2 = await reserveLocked(stub, "k2", FP2, lockOf(root, c1));
    expect(await chain(stub)).toEqual([
      { branch: `agent/task-${root}`, latest_task_id: c2, prev_task_id: c1 },
    ]);
  });

  it("reserve の同期区間でも、最新でない元からの積み足しは continue_superseded（最新の id が載る）。何も消費しない", async () => {
    const stub = userStub(newUserId());
    const root = newTaskId();
    const c1 = await reserveLocked(stub, "k1", FP, lockOf(root));
    await stub.finishTask(c1, 0, 0);
    // authorizeContinue の後に別の積み足し（c1）が入った: 根から積み足そうとすると断る
    expect(await stub.reserve("k2", FP2, lockOf(root))).toEqual({
      ok: false,
      code: "continue_superseded",
      latest_task_id: c1,
    });
    expect(await sql(stub, "SELECT request_key FROM requests")).toEqual([{ request_key: "k1" }]);
    expect(await sql(stub, "SELECT task_id FROM reservation_slot")).toEqual([]);
    expect(await locks(stub)).toEqual([]);
  });

  it("完了（finishTask）で鍵が開く。チェーンの最新は戻さない", async () => {
    const stub = userStub(newUserId());
    const root = newTaskId();
    const c1 = await reserveLocked(stub, "k1", FP, lockOf(root));
    expect(await stub.finishTask(c1, 0, 0)).toEqual({ ok: true, released: true });
    expect(await locks(stub)).toEqual([]);
    expect(await chain(stub)).toEqual([
      { branch: `agent/task-${root}`, latest_task_id: c1, prev_task_id: root },
    ]);
  });

  it("キャンセル（CANCELLED）で鍵が開く（finishTask と同じ経路）。チェーンの最新は戻さない", async () => {
    const uid = newUserId();
    const stub = userStub(uid);
    const root = newTaskId();
    const c1 = await reserveLocked(stub, "k1", FP, lockOf(root));
    const created = await taskStub(c1).ensureCreated(sampleInput(c1, uid));
    expect(created.ok).toBe(true);
    await taskStub(c1).advance();
    await taskStub(c1).cancel(uid);
    for (let i = 0; i < 5 && (await locks(stub)).length > 0; i++) await taskStub(c1).advance();
    expect(await locks(stub)).toEqual([]);
    expect(await sql(stub, "SELECT task_id FROM reservation_slot")).toEqual([]);
    expect((await chain(stub))[0]?.latest_task_id).toBe(c1);
    await runInDurableObject(taskStub(c1), (_i, s) => s.storage.deleteAlarm());
  });

  it("失敗（FAILED）で鍵が開く（finishTask と同じ経路）。チェーンの最新は戻さない", async () => {
    const uid = newUserId();
    const stub = userStub(uid);
    const root = newTaskId();
    const c1 = await reserveLocked(stub, "k1", FP, lockOf(root));
    const created = await taskStub(c1).ensureCreated(sampleInput(c1, uid));
    expect(created.ok).toBe(true);
    await taskStub(c1).advance();
    await fakeAgent(c1).setPhase("failed");
    for (let i = 0; i < 5 && (await locks(stub)).length > 0; i++) await taskStub(c1).advance();
    const st = await taskStub(c1).getStatus(uid);
    expect(st.ok && st.task.status).toBe("FAILED");
    expect(await locks(stub)).toEqual([]);
    expect((await chain(stub))[0]?.latest_task_id).toBe(c1);
    await runInDurableObject(taskStub(c1), (_i, s) => s.storage.deleteAlarm());
  });

  it("予約の回収（一度も作られなかった予約）: 照合 → 解放 → 再判定で鍵が開き、チェーンの最新が prev_task_id に戻る", async () => {
    const stub = userStub(newUserId());
    const clock = await useClock(stub);
    const root = newTaskId();
    const c1 = await reserveLocked(stub, "k1", FP, lockOf(root));
    // 10 分未満は回収しない（照合はするが、tombstone は打たない）
    clock.advance(10 * MIN - 1);
    expect(await stub.reserve("k2", FP2, lockOf(root))).toEqual({
      ok: false,
      code: "branch_busy",
      task_id: c1,
    });
    expect(await taskStub(c1).inspect()).toEqual({ kind: "uncreated" });
    // 10 分経過: 回収して、根から積み足せる（チェーンは根に戻っている）
    clock.advance(1);
    const c2 = await reserveLocked(stub, "k2", FP2, lockOf(root));
    expect(c2).not.toBe(c1);
    expect(await taskStub(c1).inspect()).toEqual({ kind: "abandoned" });
    expect(await locks(stub)).toEqual([
      { branch: `agent/task-${root}`, task_id: c2, continue_of: root },
    ]);
    expect(await chain(stub)).toEqual([
      { branch: `agent/task-${root}`, latest_task_id: c2, prev_task_id: root },
    ]);
    expect(await sql(stub, "SELECT task_id FROM reservation_slot")).toEqual([{ task_id: c2 }]);
  });

  it("回収で戻すのは、チェーンの最新がその task_id のときだけ", async () => {
    const stub = userStub(newUserId());
    await setLimit(stub, "4");
    const clock = await useClock(stub);
    const r1 = newTaskId();
    const r2 = newTaskId();
    const c1 = await reserveLocked(stub, "k1", FP, lockOf(r1));
    clock.advance(10 * MIN);
    // 別の PR の積み足しは、c1 の回収とは無関係（c1 の鍵が残るあいだも通る）
    const d1 = await reserveLocked(stub, "k2", FP2, lockOf(r2));
    clock.advance(10 * MIN);
    // r1 への積み足しで c1 を回収する。r2 のチェーンは変わらない
    const c2 = await reserveLocked(stub, "k3", FP3, lockOf(r1));
    expect(await chain(stub)).toEqual(
      [
        { branch: `agent/task-${r1}`, latest_task_id: c2, prev_task_id: r1 },
        { branch: `agent/task-${r2}`, latest_task_id: d1, prev_task_id: r2 },
      ].sort((a, b) => a.branch.localeCompare(b.branch)),
    );
    expect(c1).not.toBe(c2);
  });

  it("照合のあいだに鍵の持ち主が終わった（入れ替わった）ら、判定をやり直す（decide は await しない）", async () => {
    const uid = newUserId();
    const stub = userStub(uid);
    const root = newTaskId();
    const c1 = await reserveLocked(stub, "k1", FP, lockOf(root));
    const created = await taskStub(c1).ensureCreated(sampleInput(c1, uid));
    expect(created.ok).toBe(true);
    let hooked = false;
    await runInDurableObject(stub, (instance) => {
      const target = instance as unknown as {
        taskStub: (id: string) => {
          inspect: () => Promise<unknown>;
          abandonIfUncreated: () => Promise<unknown>;
        };
        finishTask: (id: string, seq: number, micro: number) => Promise<unknown>;
      };
      const original = target.taskStub.bind(instance);
      target.taskStub = (id: string) => {
        const real = original(id);
        return {
          inspect: async () => {
            const result = await real.inspect();
            if (!hooked) {
              hooked = true;
              await target.finishTask(c1, 0, 0);
            }
            return result;
          },
          abandonIfUncreated: () => real.abandonIfUncreated(),
        };
      };
    });
    // c1 は作成済み（回収できない）が、照合中に終わって鍵が開いたので、やり直した判定で通る
    const c2 = await reserveLocked(stub, "k2", FP2, lockOf(root, c1));
    expect(hooked).toBe(true);
    expect(await locks(stub)).toEqual([
      { branch: `agent/task-${root}`, task_id: c2, continue_of: c1 },
    ]);
    await runInDurableObject(taskStub(c1), (_i, s) => s.storage.deleteAlarm());
  });

  it("clearSlot の早期 return: 枠の行が先に消えていても、task_id の鍵の行は消える（戻り値は今のまま false）", async () => {
    const stub = userStub(newUserId());
    const root = newTaskId();
    const c1 = await reserveLocked(stub, "k1", FP, lockOf(root));
    await sql(stub, "DELETE FROM reservation_slot WHERE task_id = ?", c1);
    expect(await stub.finishTask(c1, 0, 0)).toEqual({ ok: true, released: false });
    expect(await locks(stub)).toEqual([]);
    // 鍵が残って branch_busy が続かない
    const c2 = await reserveLocked(stub, "k2", FP2, lockOf(root, c1));
    expect(c2).not.toBe(c1);
  });

  it("finishTask は他のタスクの鍵を消さない", async () => {
    const stub = userStub(newUserId());
    const root = newTaskId();
    const c1 = await reserveLocked(stub, "k1", FP, lockOf(root));
    await stub.finishTask(newTaskId(), 0, 0);
    expect((await locks(stub)).map((l) => l.task_id)).toEqual([c1]);
  });
});
