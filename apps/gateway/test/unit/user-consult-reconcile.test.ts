import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { RECONCILE_DELAYS_MS } from "../../src/tasks/task-do";
import { ulid } from "../../src/tasks/ulid";
import { newUserId, userStub } from "./helpers";

// consult の費用の確定（docs/specs/consult-pending.md）。精算された consult について、UserDO が
// AI Gateway のログで settled_micro を 1 回だけ上書きする。予定は SQLite に持ち、既存の alarm に相乗りする。

type UserStub = ReturnType<typeof userStub>;
type Result =
  | { state: "confirmed"; micro: number }
  | { state: "pending" }
  | { state: "unconfigured" };
const MICRO = 1_000_000;
const MIN = 60_000;
const T0 = Date.UTC(2026, 0, 15, 12);
const MODEL = "anthropic/claude-sonnet-5-5";
const newConsultId = (at = T0) => `consult-${ulid(at)}`;
const ENV_KEYS = [
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_ACCOUNT_ID",
  "AI_GATEWAY_ID",
  "DIRECTORY_DO",
] as const;

const saved = new Map<string, unknown>();
let restore: (() => void) | undefined;
afterEach(() => {
  restore?.();
  restore = undefined;
  saved.clear();
});

async function setup(configured = true) {
  const uid = newUserId();
  const stub = userStub(uid);
  const calls: [string, number][] = [];
  const results: (Result | "throw")[] = [];
  const clock = { t: T0 };
  await runInDurableObject(stub, (i) => {
    const u = i as unknown as {
      now: () => number;
      monthlyLimitUsd: () => number;
      env: Record<string, unknown>;
      gatewayConsultCost: (id: string, n: number) => Promise<Result>;
    };
    u.now = () => clock.t;
    u.monthlyLimitUsd = () => 100;
    for (const k of ENV_KEYS) saved.set(k, u.env[k]);
    u.env.CLOUDFLARE_API_TOKEN = configured ? "token-example" : undefined;
    u.env.CLOUDFLARE_ACCOUNT_ID = configured ? "acct-example" : undefined;
    u.env.AI_GATEWAY_ID = configured ? "gw-example" : undefined;
    restore = () => {
      for (const [k, v] of saved) u.env[k] = v;
    };
    u.gatewayConsultCost = async (id, n) => {
      calls.push([id, n]);
      const r = results.shift() ?? { state: "pending" as const };
      if (r === "throw") throw new Error("logs api down");
      return r;
    };
  });
  return { uid, stub, calls, results, clock };
}

async function settled(stub: UserStub, uid: number, cost: number | null, estimated = false) {
  const id = newConsultId();
  await stub.reserveConsult(id, MODEL, { id: uid, login: "alice" });
  expect(await stub.settleConsult(id, cost, estimated)).toEqual({ ok: true, applied: true });
  return id;
}

function sql<T>(stub: UserStub, q: string, ...b: unknown[]): Promise<T[]> {
  return runInDurableObject(stub, (_i, s) => s.storage.sql.exec(q, ...b).toArray() as T[]);
}
const budget = async (stub: UserStub, id: string) =>
  (
    await sql<Record<string, unknown>>(
      stub,
      "SELECT settled_micro, settled_estimated, cost_source FROM task_budget WHERE task_id = ?",
      id,
    )
  )[0];
const logRow = async (stub: UserStub, id: string) =>
  (
    await sql<Record<string, unknown>>(
      stub,
      "SELECT cost_micro, estimated, revision, index_dirty FROM consult_log WHERE consult_id = ?",
      id,
    )
  )[0];
const plan = async (stub: UserStub, id: string) =>
  (
    await sql<Record<string, unknown>>(
      stub,
      "SELECT base, attempt, done FROM consult_reconcile WHERE consult_id = ?",
      id,
    )
  )[0];
/** alarm を直接動かす（予定の有無にかかわらず。時刻は this.now() の偽の時計） */
const fire = (stub: UserStub) =>
  runInDurableObject(stub, async (i) => {
    await (i as unknown as { alarm: () => Promise<void> }).alarm();
  });
const alarmOf = (stub: UserStub) => runInDurableObject(stub, (_i, s) => s.storage.getAlarm());

describe("UserDO: consult の費用の確定", () => {
  it("精算すると確定の予定を持つ。2 分たつまでは問い合わせない", async () => {
    const { uid, stub, calls, clock } = await setup();
    const id = await settled(stub, uid, 0.1);
    expect(await plan(stub, id)).toEqual({ base: T0, attempt: 0, done: 0 });
    await fire(stub);
    expect(calls).toHaveLength(0);
    clock.t += 2 * MIN - 1;
    await fire(stub);
    expect(calls).toHaveLength(0);
  });

  it("2 分後に確定できれば settled_micro を gateway の額で上書きし、consult_log に写して dirty にする", async () => {
    const { uid, stub, calls, results, clock } = await setup();
    const id = await settled(stub, uid, 0.1);
    expect(await logRow(stub, id)).toMatchObject({
      cost_micro: 100_000,
      estimated: 0,
      revision: 1,
    });
    await runInDurableObject(stub, (_i, s) => {
      s.storage.sql.exec("UPDATE consult_log SET index_dirty = 0");
    });
    // 配送は別のテストで確かめる。ここでは dirty になるところまで見る
    await runInDurableObject(stub, (i) => {
      (i as unknown as { env: Record<string, unknown> }).env.DIRECTORY_DO = undefined;
    });
    clock.t += 2 * MIN;
    results.push({ state: "confirmed", micro: 70_000 });
    await fire(stub);
    expect(calls).toEqual([[id, 1]]);
    expect(await budget(stub, id)).toEqual({
      settled_micro: 70_000,
      settled_estimated: 0,
      cost_source: "gateway",
    });
    expect(await logRow(stub, id)).toEqual({
      cost_micro: 70_000,
      estimated: 0,
      revision: 2,
      index_dirty: 1,
    });
    expect(await plan(stub, id)).toMatchObject({ done: 1 });
    // もう問い合わせない
    clock.t += 10 * MIN;
    await fire(stub);
    expect(calls).toHaveLength(1);
  });

  it("確定した額が同じ alarm の中で索引（Directory）へ届き、他の用事（配送）を壊さない", async () => {
    const { uid, stub, results, clock } = await setup();
    const sent: { cost_micro?: number; revision: number }[] = [];
    await runInDurableObject(stub, (i) => {
      (i as unknown as { env: Record<string, unknown> }).env.DIRECTORY_DO = {
        getByName: () => ({
          upsertConsult: async (snapshot: { cost_micro?: number }, revision: number) => {
            sent.push({ cost_micro: snapshot.cost_micro, revision });
            return { ok: true, applied: true, revision };
          },
        }),
      };
    });
    const id = await settled(stub, uid, 0.1);
    await fire(stub); // 精算の配送
    expect(sent.map((s) => s.revision)).toEqual([1]);
    clock.t = T0 + 2 * MIN;
    results.push({ state: "confirmed", micro: 70_000 });
    await fire(stub);
    expect(sent.at(-1)).toMatchObject({ revision: 2 });
    expect(await logRow(stub, id)).toMatchObject({ cost_micro: 70_000, index_dirty: 0 });
  });

  it("予約額で精算した（実費不明の）consult も、確定額に置き換わり estimated が外れる", async () => {
    const { uid, stub, results, clock } = await setup();
    const id = await settled(stub, uid, null);
    expect(await budget(stub, id)).toMatchObject({
      settled_micro: 0.5 * MICRO,
      settled_estimated: 1,
    });
    clock.t += 2 * MIN;
    results.push({ state: "confirmed", micro: 12_345 });
    await fire(stub);
    expect(await budget(stub, id)).toEqual({
      settled_micro: 12_345,
      settled_estimated: 0,
      cost_source: "gateway",
    });
    expect(await logRow(stub, id)).toMatchObject({ cost_micro: 12_345, estimated: 0 });
  });

  it("pending は遅延 2 分・10 分・1 時間・6 時間で再試行し、4 回で見積もりのまま打ち切る", async () => {
    const { uid, stub, calls, clock } = await setup();
    const id = await settled(stub, uid, 0.1);
    expect(RECONCILE_DELAYS_MS).toEqual([2 * MIN, 10 * MIN, 60 * MIN, 360 * MIN]);
    for (const [i, delay] of RECONCILE_DELAYS_MS.entries()) {
      clock.t = T0 + delay;
      await fire(stub);
      expect(calls).toHaveLength(i + 1);
      expect(await plan(stub, id)).toMatchObject({ attempt: i + 1, done: i === 3 ? 1 : 0 });
    }
    clock.t += 24 * 60 * MIN;
    await fire(stub);
    expect(calls).toHaveLength(4);
    expect(await budget(stub, id)).toEqual({
      settled_micro: 0.1 * MICRO,
      settled_estimated: 0,
      cost_source: "estimate",
    });
  });

  it("Logs API の例外は pending と同じく回数を進める（無制限に再試行しない）", async () => {
    const { uid, stub, calls, results, clock } = await setup();
    const id = await settled(stub, uid, 0.1);
    clock.t = T0 + 2 * MIN;
    results.push("throw");
    await fire(stub);
    expect(calls).toHaveLength(1);
    expect(await plan(stub, id)).toMatchObject({ attempt: 1, done: 0 });
    // 次の予定は 10 分後
    clock.t = T0 + 5 * MIN;
    await fire(stub);
    expect(calls).toHaveLength(1);
    clock.t = T0 + 10 * MIN;
    results.push({ state: "confirmed", micro: 5_000 });
    await fire(stub);
    expect(await budget(stub, id)).toMatchObject({ settled_micro: 5_000, cost_source: "gateway" });
  });

  it("unconfigured を返されたら何もせず終わる（予定を閉じる）", async () => {
    const { uid, stub, results, clock } = await setup();
    const id = await settled(stub, uid, 0.1);
    clock.t = T0 + 2 * MIN;
    results.push({ state: "unconfigured" });
    await fire(stub);
    expect(await plan(stub, id)).toMatchObject({ done: 1 });
    expect(await budget(stub, id)).toMatchObject({ cost_source: "estimate" });
  });

  it("設定が無い環境では予定を作らない", async () => {
    const { uid, stub, calls, clock } = await setup(false);
    const id = await settled(stub, uid, 0.1);
    expect(await plan(stub, id)).toBeUndefined();
    clock.t += 24 * 60 * MIN;
    await fire(stub);
    expect(calls).toHaveLength(0);
  });

  it("精算すると alarm が確定の時刻（約 2 分後）に立つ", async () => {
    const { uid, stub } = await setup();
    await settled(stub, uid, 0.1);
    // alarm の設定は waitUntil で非同期なので、立つまで待つ
    let at: number | null = null;
    for (let i = 0; i < 20 && at === null; i++) {
      at = await alarmOf(stub);
      if (at === null) await new Promise((r) => setTimeout(r, 10));
    }
    expect(at).not.toBeNull();
    expect(Math.abs((at as number) - (Date.now() + 2 * MIN))).toBeLessThan(10_000);
  });

  it("期限切れで閉じた consult も確定の予定を持つ", async () => {
    const { uid, stub, clock } = await setup();
    const id = newConsultId(T0);
    await stub.reserveConsult(id, MODEL, { id: uid, login: "alice" });
    clock.t = T0 + 11 * MIN;
    await fire(stub);
    expect(await budget(stub, id)).toMatchObject({ settled_estimated: 1, cost_source: "estimate" });
    expect(await plan(stub, id)).toEqual({ base: T0 + 11 * MIN, attempt: 0, done: 0 });
  });

  it("確定前に gateway 確定済みなら書かずに終える（二重に上書きしない）", async () => {
    const { uid, stub, results, clock } = await setup();
    const id = await settled(stub, uid, 0.1);
    await runInDurableObject(stub, (_i, s) => {
      s.storage.sql.exec(
        "UPDATE task_budget SET settled_micro = 1, cost_source = 'gateway' WHERE task_id = ?",
        id,
      );
    });
    clock.t = T0 + 2 * MIN;
    results.push({ state: "confirmed", micro: 99 });
    await fire(stub);
    expect(await budget(stub, id)).toMatchObject({ settled_micro: 1 });
    expect(await plan(stub, id)).toMatchObject({ done: 1 });
  });
});
