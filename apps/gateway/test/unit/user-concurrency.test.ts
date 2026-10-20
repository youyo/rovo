import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { DEFAULT_MAX_CONCURRENT_TASKS, maxConcurrentTasks } from "../../src/tasks/budget";
import { newUserId, sampleInput, taskStub, userStub } from "./helpers";

// vitest.config.ts は既存の Unit が「1 件で埋まる」前提で書かれているので MAX_CONCURRENT_TASKS="1" にしてある。
// ここでは UserDO のインスタンスごとに env を差し替えて、設定なし（既定）・設定あり・不正値の動きを見る。

const MIN = 60 * 1000;
const fp = (i: number) => `${i}`.repeat(64);

type UserStub = ReturnType<typeof userStub>;

/** この UserDO インスタンスだけの env を差し替える（共有の env は触らない）。undefined で未設定にする。 */
async function setLimit(stub: UserStub, value: string | undefined) {
  await runInDurableObject(stub, (i) => {
    const inst = i as unknown as { env: Record<string, unknown> };
    const next = { ...inst.env };
    if (value === undefined) delete next.MAX_CONCURRENT_TASKS;
    else next.MAX_CONCURRENT_TASKS = value;
    inst.env = next;
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

function sql<T>(stub: UserStub, q: string, ...b: unknown[]): Promise<T[]> {
  return runInDurableObject(stub, (_i, s) => s.storage.sql.exec(q, ...b).toArray() as T[]);
}

async function slots(stub: UserStub): Promise<string[]> {
  const rows = await sql<{ task_id: string }>(
    stub,
    "SELECT task_id FROM reservation_slot ORDER BY reserved_at, task_id",
  );
  return rows.map((r) => r.task_id);
}

async function reserveOk(stub: UserStub, key: string, i = 0) {
  const r = await stub.reserve(key, fp(i));
  if (!r.ok) throw new Error(`reserve failed: ${r.code}`);
  return r;
}

describe("maxConcurrentTasks（env の MAX_CONCURRENT_TASKS）", () => {
  it("既定は 2。未設定・空・数でない・0 以下・整数でない値も 2 に戻す", () => {
    expect(DEFAULT_MAX_CONCURRENT_TASKS).toBe(2);
    expect(maxConcurrentTasks({})).toBe(2);
    expect(maxConcurrentTasks({ MAX_CONCURRENT_TASKS: "" })).toBe(2);
    expect(maxConcurrentTasks({ MAX_CONCURRENT_TASKS: "abc" })).toBe(2);
    expect(maxConcurrentTasks({ MAX_CONCURRENT_TASKS: "0" })).toBe(2);
    expect(maxConcurrentTasks({ MAX_CONCURRENT_TASKS: "-3" })).toBe(2);
    expect(maxConcurrentTasks({ MAX_CONCURRENT_TASKS: "1.5" })).toBe(2);
  });

  it("正の整数はそのまま使う", () => {
    expect(maxConcurrentTasks({ MAX_CONCURRENT_TASKS: "1" })).toBe(1);
    expect(maxConcurrentTasks({ MAX_CONCURRENT_TASKS: " 10 " })).toBe(10);
  });
});

describe("UserDO: 同時実行の上限", () => {
  it("設定がなければ 2 件まで同時に予約でき、3 件目は concurrency_limit", async () => {
    const stub = userStub(newUserId());
    await setLimit(stub, undefined);
    const a = await reserveOk(stub, "k1", 1);
    const b = await reserveOk(stub, "k2", 2);
    expect(await stub.reserve("k3", fp(3))).toEqual({ ok: false, code: "concurrency_limit" });
    expect(await slots(stub)).toEqual([a.task_id, b.task_id].sort());
    // 断られた k3 は requests にも task_budget にも残さない
    expect(await sql(stub, "SELECT * FROM requests WHERE request_key = 'k3'")).toEqual([]);
    expect(await sql(stub, "SELECT * FROM task_budget")).toHaveLength(2);
  });

  it("設定値（10）が効く", async () => {
    const stub = userStub(newUserId());
    await setLimit(stub, "10");
    for (let i = 0; i < 10; i++) await reserveOk(stub, `k${i}`, i);
    expect(await stub.reserve("k10", fp(10))).toEqual({ ok: false, code: "concurrency_limit" });
    expect(await slots(stub)).toHaveLength(10);
  });

  it("不正な設定値は既定の 2 に戻る", async () => {
    const stub = userStub(newUserId());
    await setLimit(stub, "many");
    await reserveOk(stub, "k1", 1);
    await reserveOk(stub, "k2", 2);
    expect(await stub.reserve("k3", fp(3))).toMatchObject({ ok: false, code: "concurrency_limit" });
  });

  it("1 件終われば次を予約できる（空いた枠は 1 つだけ）", async () => {
    const stub = userStub(newUserId());
    await setLimit(stub, undefined);
    const a = await reserveOk(stub, "k1", 1);
    await reserveOk(stub, "k2", 2);
    expect(await stub.reserve("k3", fp(3))).toMatchObject({ ok: false });
    expect(await stub.finishTask(a.task_id, 0, 0)).toEqual({ ok: true, released: true });
    const c = await reserveOk(stub, "k3", 3);
    expect(c.task_id).not.toBe(a.task_id);
    expect(await stub.reserve("k4", fp(4))).toMatchObject({ ok: false, code: "concurrency_limit" });
  });

  it("同じ idempotency_key の再試行は同じ task_id を返し、枠を 2 つ使わない（上限に達した後でも）", async () => {
    const stub = userStub(newUserId());
    await setLimit(stub, undefined);
    const a = await reserveOk(stub, "k1", 1);
    const again = await reserveOk(stub, "k1", 1);
    expect(again).toMatchObject({ task_id: a.task_id, reused: true });
    expect(await slots(stub)).toEqual([a.task_id]);
    // 2 件目を入れて上限に達しても、k1 の再試行は断られず同じ task_id が返る
    await reserveOk(stub, "k2", 2);
    expect(await reserveOk(stub, "k1", 1)).toMatchObject({ task_id: a.task_id, reused: true });
    expect(await slots(stub)).toHaveLength(2);
  });

  it("同時の reserve（別キー）は上限の件数だけ成功する", async () => {
    const stub = userStub(newUserId());
    await setLimit(stub, undefined);
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) => stub.reserve(`p-${i}`, fp(i))),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(2);
    expect(results.filter((r) => !r.ok && r.code === "concurrency_limit")).toHaveLength(4);
    expect(await slots(stub)).toHaveLength(2);
  });

  it("作成されないまま 10 分を過ぎた予約は、複数あってもまとめて回収して新規を通す", async () => {
    const stub = userStub(newUserId());
    await setLimit(stub, undefined);
    const clock = await useClock(stub);
    const a = await reserveOk(stub, "k1", 1);
    const b = await reserveOk(stub, "k2", 2);
    clock.advance(10 * MIN);
    const c = await reserveOk(stub, "k3", 3);
    expect(await slots(stub)).toEqual([c.task_id]);
    expect(await taskStub(a.task_id).inspect()).toEqual({ kind: "abandoned" });
    expect(await taskStub(b.task_id).inspect()).toEqual({ kind: "abandoned" });
  });

  it("作成済みで動いているタスクは回収せず、古い未作成の予約だけを回収する", async () => {
    const uid = newUserId();
    const stub = userStub(uid);
    await setLimit(stub, undefined);
    const clock = await useClock(stub);
    const running = await reserveOk(stub, "k1", 1);
    const created = await taskStub(running.task_id).ensureCreated(
      sampleInput(running.task_id, uid),
    );
    expect(created.ok).toBe(true);
    const stale = await reserveOk(stub, "k2", 2);
    clock.advance(10 * MIN);
    const c = await reserveOk(stub, "k3", 3);
    expect(await slots(stub)).toEqual([running.task_id, c.task_id].sort());
    expect(await taskStub(stale.task_id).inspect()).toEqual({ kind: "abandoned" });
  });
});

describe("UserDO: 1 行の予約（reservation）からの移行", () => {
  /** 旧スキーマ（singleton の 1 行）を作って、移行を走らせる。 */
  async function migrateFrom(stub: UserStub, activeTaskId: string | null) {
    await runInDurableObject(stub, (i, state) => {
      const sqlStore = state.storage.sql;
      sqlStore.exec(`CREATE TABLE reservation (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        active_task_id TEXT,
        reserved_at INTEGER NOT NULL,
        version INTEGER NOT NULL
      )`);
      sqlStore.exec(
        "INSERT INTO reservation (singleton, active_task_id, reserved_at, version) VALUES (1, ?, ?, 7)",
        activeTaskId,
        Date.now(),
      );
      (i as unknown as { migrateLegacyReservation: () => void }).migrateLegacyReservation();
    });
  }

  it("既存の 1 件の予約は枠として数えられ、旧テーブルは消える", async () => {
    const stub = userStub(newUserId());
    await setLimit(stub, undefined);
    const legacyId = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    await migrateFrom(stub, legacyId);
    expect(await slots(stub)).toEqual([legacyId]);
    expect(
      await sql(stub, "SELECT name FROM sqlite_master WHERE type='table' AND name='reservation'"),
    ).toEqual([]);
    // 上限 2 のうち 1 件は移行した予約が使っているので、新規はあと 1 件だけ
    await reserveOk(stub, "k1", 1);
    expect(await stub.reserve("k2", fp(2))).toMatchObject({ ok: false, code: "concurrency_limit" });
    // 移行した予約も finishTask で解放できる
    expect(await stub.finishTask(legacyId, 0, 0)).toEqual({ ok: true, released: true });
    expect((await stub.reserve("k2", fp(2))).ok).toBe(true);
  });

  it("予約が空（active_task_id が NULL）なら枠は作らない", async () => {
    const stub = userStub(newUserId());
    await migrateFrom(stub, null);
    expect(await slots(stub)).toEqual([]);
  });

  it("移行は何度走っても枠を増やさない", async () => {
    const stub = userStub(newUserId());
    const legacyId = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
    await migrateFrom(stub, legacyId);
    await runInDurableObject(stub, (i) => {
      (i as unknown as { migrateLegacyReservation: () => void }).migrateLegacyReservation();
    });
    expect(await slots(stub)).toEqual([legacyId]);
  });
});

describe("UserDO.budgetStatus の concurrency_limit", () => {
  it("設定値を返す。設定がなければ 2、不正なら 2", async () => {
    const stub = userStub(newUserId());
    await setLimit(stub, undefined);
    expect((await stub.budgetStatus()).concurrency_limit).toBe(2);
    await setLimit(stub, "10");
    expect((await stub.budgetStatus()).concurrency_limit).toBe(10);
    await setLimit(stub, "0");
    expect((await stub.budgetStatus()).concurrency_limit).toBe(2);
  });

  it("max_concurrent_tasks（残りの予算 ÷ 予約額）とは別の値で、意味を変えない", async () => {
    const stub = userStub(newUserId());
    await setLimit(stub, "3");
    const s = await stub.budgetStatus();
    expect(s.concurrency_limit).toBe(3);
    expect(s.max_concurrent_tasks).toBe(10); // 100 ÷ 10
  });
});
