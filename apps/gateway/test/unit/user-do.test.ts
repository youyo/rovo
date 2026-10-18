import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { newUserId, sampleInput, taskStub, userStub } from "./helpers";

const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;
const FP = "f".repeat(64);
const FP2 = "e".repeat(64);

type UserStub = ReturnType<typeof userStub>;

/** UserDO の時刻を差し替える（テスト用）。戻り値で時刻を進められる。 */
async function useClock(stub: UserStub, start = Date.now()) {
  let t = start;
  await runInDurableObject(stub, (instance) => {
    (instance as unknown as { now: () => number }).now = () => t;
  });
  return {
    advance(ms: number) {
      t += ms;
    },
    now: () => t,
  };
}

function sql<T>(stub: UserStub, query: string, ...bindings: unknown[]): Promise<T[]> {
  return runInDurableObject(
    stub,
    (_i, state) => state.storage.sql.exec(query, ...bindings).toArray() as T[],
  );
}

type Reservation = { active_task_id: string | null; reserved_at: number; version: number };
async function reservation(stub: UserStub): Promise<Reservation> {
  const [r] = await sql<Reservation>(stub, "SELECT * FROM reservation");
  if (!r) throw new Error("no reservation row");
  return r;
}

async function reserveOk(stub: UserStub, key: string, fp = FP) {
  const r = await stub.reserve(key, fp);
  if (!r.ok) throw new Error(`reserve failed: ${r.code}`);
  return r;
}

async function create(userId: number, taskId: string) {
  const r = await taskStub(taskId).ensureCreated(sampleInput(taskId, userId));
  if (!r.ok) throw new Error(`ensureCreated failed: ${r.code}`);
}

describe("UserDO.reserve", () => {
  it("新規: task_id(ULID)を発行し、requests と reservation に記録する", async () => {
    const uid = newUserId();
    const stub = userStub(uid);
    const r = await reserveOk(stub, "key-1");
    expect(r.task_id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(r.reused).toBe(false);
    const res = await reservation(stub);
    expect(res.active_task_id).toBe(r.task_id);
    expect(res.version).toBeGreaterThan(0);
    expect(await sql(stub, "SELECT request_key, task_id, fingerprint FROM requests")).toEqual([
      { request_key: "key-1", task_id: r.task_id, fingerprint: FP },
    ]);
  });

  it("再試行: 同じキー・同じ fingerprint なら同じ task_id を返し、状態を変えない", async () => {
    const stub = userStub(newUserId());
    const a = await reserveOk(stub, "key-1");
    const before = await reservation(stub);
    const b = await reserveOk(stub, "key-1");
    expect(b).toMatchObject({ task_id: a.task_id, reused: true });
    expect(await reservation(stub)).toEqual(before);
    expect(await sql(stub, "SELECT * FROM requests")).toHaveLength(1);
  });

  it("再試行: 予約が解放された後でも同じ task_id を返す", async () => {
    const stub = userStub(newUserId());
    const a = await reserveOk(stub, "key-1");
    await stub.release(a.task_id);
    const b = await reserveOk(stub, "key-1");
    expect(b).toMatchObject({ task_id: a.task_id, reused: true });
    expect((await reservation(stub)).active_task_id).toBeNull();
  });

  it("同じキーで fingerprint が違えば conflict", async () => {
    const stub = userStub(newUserId());
    await reserveOk(stub, "key-1", FP);
    expect(await stub.reserve("key-1", FP2)).toEqual({ ok: false, code: "conflict" });
  });

  it("別のキーで実行中の予約があれば concurrency_limit（作成直後の未作成予約も）", async () => {
    const stub = userStub(newUserId());
    const a = await reserveOk(stub, "key-1");
    expect(await stub.reserve("key-2", FP2)).toEqual({ ok: false, code: "concurrency_limit" });
    expect((await reservation(stub)).active_task_id).toBe(a.task_id);
    expect(await sql(stub, "SELECT * FROM requests")).toHaveLength(1);
  });

  it("作成済みで実行中のタスクがあれば concurrency_limit", async () => {
    const uid = newUserId();
    const stub = userStub(uid);
    const a = await reserveOk(stub, "key-1");
    await create(uid, a.task_id);
    expect(await stub.reserve("key-2", FP2)).toEqual({ ok: false, code: "concurrency_limit" });
  });

  it("同時の reserve（別キー）は1件だけ成功し、残りは concurrency_limit", async () => {
    const stub = userStub(newUserId());
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) => stub.reserve(`k-${i}`, `${i}`.repeat(64))),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok && r.code === "concurrency_limit")).toHaveLength(4);
    expect(await sql(stub, "SELECT * FROM requests")).toHaveLength(1);
  });

  it("同時の reserve（同じキー）は同じ task_id になる", async () => {
    const stub = userStub(newUserId());
    const results = await Promise.all(Array.from({ length: 5 }, () => stub.reserve("same", FP)));
    const ids = new Set(results.map((r) => (r.ok ? r.task_id : "ng")));
    expect(ids.size).toBe(1);
    expect(ids.has("ng")).toBe(false);
    expect(await sql(stub, "SELECT * FROM requests")).toHaveLength(1);
  });

  it("requests は 7 日で削除され、そのキーは新規扱いになる", async () => {
    const stub = userStub(newUserId());
    const clock = await useClock(stub);
    const a = await reserveOk(stub, "old");
    await stub.release(a.task_id);
    clock.advance(7 * DAY - MIN);
    expect(await sql(stub, "SELECT * FROM requests")).toHaveLength(1);
    expect(((await reserveOk(stub, "old")) as { reused: boolean }).reused).toBe(true);
    await stub.release(a.task_id);
    clock.advance(2 * MIN); // 7 日を超える
    const b = await reserveOk(stub, "old");
    expect(b.reused).toBe(false);
    expect(b.task_id).not.toBe(a.task_id);
  });
});

describe("UserDO.release", () => {
  it("予約先が同じ task_id のときだけ解放する（compare-and-clear）", async () => {
    const stub = userStub(newUserId());
    const a = await reserveOk(stub, "key-1");
    const v = (await reservation(stub)).version;
    expect(await stub.release("01ARZ3NDEKTSV4RRFFQ69G5FAV")).toEqual({ released: false });
    expect(await reservation(stub)).toMatchObject({ active_task_id: a.task_id, version: v });
    expect(await stub.release(a.task_id)).toEqual({ released: true });
    const after = await reservation(stub);
    expect(after.active_task_id).toBeNull();
    expect(after.version).toBeGreaterThan(v);
  });

  it("冪等: 2回目は released=false で状態を変えない", async () => {
    const stub = userStub(newUserId());
    const a = await reserveOk(stub, "key-1");
    await stub.release(a.task_id);
    const before = await reservation(stub);
    expect(await stub.release(a.task_id)).toEqual({ released: false });
    expect(await reservation(stub)).toEqual(before);
  });

  it("解放後は新しいキーで reserve できる", async () => {
    const stub = userStub(newUserId());
    const a = await reserveOk(stub, "key-1");
    await stub.release(a.task_id);
    const b = await reserveOk(stub, "key-2", FP2);
    expect(b.task_id).not.toBe(a.task_id);
  });
});

describe("UserDO.reserve の照合による回収", () => {
  it("終端状態(CANCELLED)のタスクは、予約を解放して新規 reserve が通る", async () => {
    const uid = newUserId();
    const stub = userStub(uid);
    const a = await reserveOk(stub, "key-1");
    await create(uid, a.task_id);
    await taskStub(a.task_id).cancel(uid);
    await taskStub(a.task_id).advance(); // AgentDO の停止を確認する（これが済むまで枠は解放されない）
    const b = await reserveOk(stub, "key-2", FP2);
    expect(b.task_id).not.toBe(a.task_id);
    expect((await reservation(stub)).active_task_id).toBe(b.task_id);
  });

  it("未作成で10分未満なら回収せず concurrency_limit（tombstone も作らない）", async () => {
    const stub = userStub(newUserId());
    const clock = await useClock(stub);
    const a = await reserveOk(stub, "key-1");
    clock.advance(10 * MIN - 1);
    expect(await stub.reserve("key-2", FP2)).toEqual({ ok: false, code: "concurrency_limit" });
    expect(await taskStub(a.task_id).inspect()).toEqual({ kind: "uncreated" });
  });

  it("未作成で10分経過: abandonIfUncreated が abandoned なら解放して新規 reserve が通る", async () => {
    const stub = userStub(newUserId());
    const clock = await useClock(stub);
    const a = await reserveOk(stub, "key-1");
    clock.advance(10 * MIN);
    const b = await reserveOk(stub, "key-2", FP2);
    expect(b.task_id).not.toBe(a.task_id);
    expect(await taskStub(a.task_id).inspect()).toEqual({ kind: "abandoned" });
  });

  it("10分経過でも作成済み(created)が返れば解放しない", async () => {
    const uid = newUserId();
    const stub = userStub(uid);
    const clock = await useClock(stub);
    const a = await reserveOk(stub, "key-1");
    await create(uid, a.task_id);
    clock.advance(30 * MIN);
    expect(await stub.reserve("key-2", FP2)).toEqual({ ok: false, code: "concurrency_limit" });
    expect((await reservation(stub)).active_task_id).toBe(a.task_id);
  });

  it("回収後に古いキーで再試行すると同じ task_id が返り、その ensureCreated は expired", async () => {
    const uid = newUserId();
    const stub = userStub(uid);
    const clock = await useClock(stub);
    const a = await reserveOk(stub, "key-1");
    clock.advance(10 * MIN);
    await reserveOk(stub, "key-2", FP2); // key-1 の予約を回収
    const retry = await reserveOk(stub, "key-1");
    expect(retry).toMatchObject({ task_id: a.task_id, reused: true });
    expect(await taskStub(a.task_id).ensureCreated(sampleInput(a.task_id, uid))).toEqual({
      ok: false,
      code: "expired",
    });
  });

  it("遅れて届いた ensureCreated は、回収済みのタスクでは expired", async () => {
    const uid = newUserId();
    const stub = userStub(uid);
    const clock = await useClock(stub);
    const a = await reserveOk(stub, "key-1");
    clock.advance(11 * MIN);
    await reserveOk(stub, "key-2", FP2);
    const late = await taskStub(a.task_id).ensureCreated(sampleInput(a.task_id, uid));
    expect(late).toEqual({ ok: false, code: "expired" });
  });

  it("照合中に release が進んだ場合: 古い version で上書きせず、状態が整合する", async () => {
    const uid = newUserId();
    const stub = userStub(uid);
    const a = await reserveOk(stub, "key-1");
    await create(uid, a.task_id);
    await taskStub(a.task_id).cancel(uid);
    // 照合(inspect)の最中に、別経路の release が先に走り、さらに別の予約が入る状況を作る
    let hooked = false;
    await hookTaskInspect(stub, async (instance) => {
      if (hooked) return;
      hooked = true;
      await instance.release(a.task_id);
      await instance.reserve("key-other", FP2);
    });
    const r = await stub.reserve("key-new", "9".repeat(64));
    // key-other が予約を持っているので、key-new は解放された他人の予約を消してはいけない
    expect(r).toEqual({ ok: false, code: "concurrency_limit" });
    const other = await sql<{ task_id: string }>(
      stub,
      "SELECT task_id FROM requests WHERE request_key = 'key-other'",
    );
    expect(other).toHaveLength(1);
    expect((await reservation(stub)).active_task_id).toBe(other[0]?.task_id);
    expect(await sql(stub, "SELECT * FROM requests WHERE request_key = 'key-new'")).toHaveLength(0);
  });

  it("照合中に同じキーの reserve が割り込んでも、task_id が二重発行されない", async () => {
    const uid = newUserId();
    const stub = userStub(uid);
    const a = await reserveOk(stub, "key-1");
    await create(uid, a.task_id);
    await taskStub(a.task_id).cancel(uid);
    let hooked = false;
    let inner: string | undefined;
    await hookTaskInspect(stub, async (instance) => {
      if (hooked) return;
      hooked = true;
      await instance.release(a.task_id);
      const r = await instance.reserve("key-new", "9".repeat(64));
      inner = r.ok ? r.task_id : undefined;
    });
    const outer = await stub.reserve("key-new", "9".repeat(64));
    expect(outer.ok && outer.task_id).toBe(inner);
    expect(await sql(stub, "SELECT * FROM requests WHERE request_key = 'key-new'")).toHaveLength(1);
  });

  it("RPC は成功したが応答が失われた場合: 同じキーで再試行すれば同じ task_id で ensureCreated まで進める", async () => {
    const uid = newUserId();
    const stub = userStub(uid);
    const first = await reserveOk(stub, "key-lost"); // 応答を受け取れなかったとみなす
    const retry = await reserveOk(stub, "key-lost");
    expect(retry.task_id).toBe(first.task_id);
    await create(uid, retry.task_id);
    await create(uid, retry.task_id); // ensureCreated の再試行も冪等
    expect(await taskStub(retry.task_id).inspect()).toEqual({
      kind: "created",
      status: "CREATING",
      stopped: false,
    });
  });

  it("停止確認の後に UserDO への終了通知が届かないあいだは、reserve の照合で回収されない（finishTask の再送で収束する）", async () => {
    const uid = newUserId();
    const stub = userStub(uid);
    const a = await reserveOk(stub, "key-1");
    await create(uid, a.task_id);
    await runInDurableObject(taskStub(a.task_id), (i) => {
      const t = i as unknown as { userStub: (n: number) => unknown; __down?: boolean };
      const orig = t.userStub.bind(i);
      t.__down = true;
      t.userStub = (n: number) => {
        if (t.__down) throw new Error("user do unreachable");
        return orig(n);
      };
    });
    await taskStub(a.task_id).cancel(uid);
    await taskStub(a.task_id).advance(); // 停止は確認できたが、finishTask は届かない
    expect(await taskStub(a.task_id).inspect()).toMatchObject({ stopped: true });
    expect((await reservation(stub)).active_task_id).toBe(a.task_id);
    expect(await stub.reserve("key-2", FP2)).toMatchObject({
      ok: false,
      code: "concurrency_limit",
    });
    expect((await reservation(stub)).active_task_id).toBe(a.task_id);
    await runInDurableObject(taskStub(a.task_id), (i) => {
      (i as unknown as { __down: boolean }).__down = false;
    });
    await runDurableObjectAlarm(taskStub(a.task_id));
    expect((await stub.reserve("key-2", FP2)).ok).toBe(true);
  });
});

/** UserDO の TaskDO 照合(inspect)の直前に副作用を差し込む。 */
async function hookTaskInspect(
  stub: UserStub,
  hook: (instance: UserStubInstance) => Promise<void>,
) {
  await runInDurableObject(stub, (instance) => {
    const target = instance as unknown as {
      taskStub: (id: string) => {
        inspect: () => Promise<unknown>;
        abandonIfUncreated: () => Promise<unknown>;
      };
    };
    const original = target.taskStub.bind(instance);
    target.taskStub = (id: string) => {
      const real = original(id);
      return {
        inspect: async () => {
          const result = await real.inspect();
          await hook(instance as unknown as UserStubInstance);
          return result;
        },
        abandonIfUncreated: () => real.abandonIfUncreated(),
      };
    };
  });
}
type UserStubInstance = {
  release: (id: string) => Promise<unknown>;
  reserve: (key: string, fp: string) => Promise<{ ok: boolean; task_id?: string; code?: string }>;
};
