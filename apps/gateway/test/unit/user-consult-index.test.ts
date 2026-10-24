import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ConsultIndexSnapshot } from "../../src/directory/types";
import { ulid } from "../../src/tasks/ulid";
import { newUserId, userStub } from "./helpers";

// consult の索引の outbox（docs/specs/dashboard.md D9 / M3b）。
// UserDO は、settleConsult と同じ同期区間で consult_log の行を dirty にし、alarm で Directory へ配送する。

type UserStub = ReturnType<typeof userStub>;
const MICRO = 1_000_000;
const T0 = Date.UTC(2026, 0, 15, 12);
const MODEL = "anthropic/claude-sonnet-5-5";
const newConsultId = (at = T0) => `consult-${ulid(at)}`;
const OWNER = (id: number) => ({ id, login: "alice" });

type Call = { snapshot: ConsultIndexSnapshot; revision: number };

/** 偽の Directory。呼び出しを記録し、失敗を差し込める。 */
class FakeDirectory {
  calls: Call[] = [];
  mode: "ok" | "throw" | "invalid" = "ok";
  getByName() {
    return {
      upsertConsult: async (snapshot: ConsultIndexSnapshot, revision: number) => {
        this.calls.push({ snapshot, revision });
        if (this.mode === "throw") throw new Error("directory down ghs_leak");
        if (this.mode === "invalid") return { ok: false, code: "invalid_input" };
        return { ok: true, applied: true, revision };
      },
    };
  }
}

async function setup(stub: UserStub, dir?: FakeDirectory) {
  let t = T0;
  await runInDurableObject(stub, (i) => {
    const u = i as unknown as {
      now: () => number;
      monthlyLimitUsd: () => number;
      env: Record<string, unknown>;
      random: () => number;
    };
    u.now = () => t;
    u.monthlyLimitUsd = () => 100;
    u.random = () => 0.5;
    if (dir) u.env = { ...u.env, DIRECTORY_DO: dir };
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
const alarmOf = (stub: UserStub) => runInDurableObject(stub, (_i, s) => s.storage.getAlarm());
const logRows = (stub: UserStub) =>
  sql<Record<string, unknown>>(stub, "SELECT * FROM consult_log ORDER BY consult_id");

describe("UserDO consult_log（reserve / settle）", () => {
  it("reserveConsult がモデル・所有者・時刻つきの行を作る。確定するまで dirty にならず、alarm も無い", async () => {
    const uid = newUserId();
    const stub = userStub(uid);
    await setup(stub);
    const id = newConsultId();
    expect(await stub.reserveConsult(id, MODEL, OWNER(uid))).toEqual({
      ok: true,
      reserved_usd: 0.5,
    });
    const [row] = await logRows(stub);
    expect(row).toMatchObject({
      consult_id: id,
      owner_id: uid,
      owner_login: "alice",
      model: MODEL,
      at: T0,
      settled: 0,
      index_dirty: 0,
      revision: 0,
    });
    expect(await alarmOf(stub)).toBeNull();
  });

  it("settleConsult が費用と見積もりの印を書き、同じ同期区間で dirty にして revision を上げる。alarm が立つ", async () => {
    const uid = newUserId();
    const stub = userStub(uid);
    await setup(stub);
    const id = newConsultId();
    await stub.reserveConsult(id, MODEL, OWNER(uid));
    expect(await stub.settleConsult(id, 0.0123, true)).toEqual({ ok: true, applied: true });
    const [row] = await logRows(stub);
    expect(row).toMatchObject({
      settled: 1,
      cost_micro: Math.round(0.0123 * MICRO),
      estimated: 1,
      revision: 1,
      index_dirty: 1,
    });
    expect(await alarmOf(stub)).not.toBeNull();
    // 本体の予算は従来どおり
    expect((await stub.budgetStatus()).spent_usd).toBeCloseTo(0.0123, 6);
    expect((await stub.budgetStatus()).estimated_usd).toBeCloseTo(0.0123, 6);
  });

  it("実費が分からない（null）consult は予約額・estimated で確定する", async () => {
    const uid = newUserId();
    const stub = userStub(uid);
    await setup(stub);
    const id = newConsultId();
    await stub.reserveConsult(id, MODEL, OWNER(uid));
    await stub.settleConsult(id, null);
    expect((await logRows(stub))[0]).toMatchObject({
      cost_micro: 500_000,
      estimated: 1,
      index_dirty: 1,
    });
  });

  it("再送（閉じた後の settle）と壊れた値では行を変えない", async () => {
    const uid = newUserId();
    const stub = userStub(uid);
    await setup(stub);
    const id = newConsultId();
    await stub.reserveConsult(id, MODEL, OWNER(uid));
    await stub.settleConsult(id, -1);
    expect((await logRows(stub))[0]).toMatchObject({ settled: 0, revision: 0, index_dirty: 0 });
    await stub.settleConsult(id, 0.1);
    await stub.settleConsult(id, 0.4);
    expect((await logRows(stub))[0]).toMatchObject({ cost_micro: 100_000, revision: 1 });
  });

  it("精算されないまま期限を過ぎた consult は、予約額・estimated で閉じる行も dirty になる", async () => {
    const uid = newUserId();
    const stub = userStub(uid);
    const clock = await setup(stub);
    const stale = newConsultId();
    await stub.reserveConsult(stale, MODEL, OWNER(uid));
    clock.advance(31 * 60_000);
    await stub.reserveConsult(newConsultId(T0 + 31 * 60_000), MODEL, OWNER(uid));
    const row = (await logRows(stub)).find((r) => r.consult_id === stale);
    expect(row).toMatchObject({ settled: 1, cost_micro: 500_000, estimated: 1, index_dirty: 1 });
    expect(await alarmOf(stub)).not.toBeNull();
  });

  it("モデルを渡さない呼び出し（旧い呼び出し）と、デプロイ前の予約（consult_log に行が無い）は、索引に入れず従来どおり動く", async () => {
    const uid = newUserId();
    const stub = userStub(uid);
    await setup(stub);
    const a = newConsultId();
    await stub.reserveConsult(a);
    expect(await stub.settleConsult(a, 0.2)).toEqual({ ok: true, applied: true });
    // デプロイ前の予約を再現: task_budget にだけ行がある
    const b = newConsultId(T0 + 1);
    await sql(
      stub,
      "INSERT INTO task_budget (task_id, month, reserved_micro) VALUES (?, '2026-01', 500000)",
      b,
    );
    expect(await stub.settleConsult(b, 0.3)).toEqual({ ok: true, applied: true });
    expect(await logRows(stub)).toEqual([]);
    expect(await alarmOf(stub)).toBeNull();
    expect((await stub.budgetStatus()).spent_usd).toBeCloseTo(0.5, 6);
  });
});

describe("UserDO alarm（consult の配送）", () => {
  async function settled(stub: UserStub, uid: number, n = 1, at = T0) {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const id = newConsultId(at + i);
      await stub.reserveConsult(id, MODEL, OWNER(uid));
      await stub.settleConsult(id, 0.01 * (i + 1));
      ids.push(id);
    }
    return ids;
  }

  it("alarm が dirty な行を Directory へ送り、成功したら dirty を外す。質問・応答の本文は送らない", async () => {
    const uid = newUserId();
    const stub = userStub(uid);
    const dir = new FakeDirectory();
    await setup(stub, dir);
    const [id] = await settled(stub, uid);
    await runDurableObjectAlarm(stub);
    expect(dir.calls).toHaveLength(1);
    expect(dir.calls[0]).toEqual({
      revision: 1,
      snapshot: {
        consult_id: id,
        owner_id: uid,
        owner_login: "alice",
        at: T0,
        model: MODEL,
        cost_micro: 10_000,
        estimated: false,
      },
    });
    expect((await logRows(stub))[0]).toMatchObject({ index_dirty: 0 });
    // 配送が済んだら alarm は残さない
    expect(await alarmOf(stub)).toBeNull();
  });

  it("Directory が止まっていても consult の予約・精算・budget_status は通る。alarm はバックオフで再設定され、復旧したら追いつく", async () => {
    const uid = newUserId();
    const stub = userStub(uid);
    const dir = new FakeDirectory();
    dir.mode = "throw";
    const clock = await setup(stub, dir);
    await settled(stub, uid, 2);
    await runDurableObjectAlarm(stub); // 失敗してもこの呼び出しは例外にならない
    expect(dir.calls.length).toBeGreaterThan(0);
    expect((await logRows(stub)).every((r) => r.index_dirty === 1)).toBe(true);
    expect(await alarmOf(stub)).not.toBeNull();
    // バックオフの間は送らない
    const n = dir.calls.length;
    await runDurableObjectAlarm(stub);
    expect(dir.calls.length).toBe(n);
    // 復旧
    dir.mode = "ok";
    clock.advance(10 * 60_000);
    await runDurableObjectAlarm(stub);
    expect((await logRows(stub)).every((r) => r.index_dirty === 0)).toBe(true);
    expect(await alarmOf(stub)).toBeNull();
  });

  it("恒久的な拒否（invalid_input）は、その行を送信済みとして捨てる（再送し続けない）", async () => {
    const uid = newUserId();
    const stub = userStub(uid);
    const dir = new FakeDirectory();
    dir.mode = "invalid";
    await setup(stub, dir);
    await settled(stub, uid);
    await runDurableObjectAlarm(stub);
    expect((await logRows(stub))[0]).toMatchObject({ index_dirty: 0 });
    expect(await alarmOf(stub)).toBeNull();
  });

  it("モデル名などが長すぎても送る前に切り詰める（Directory のスキーマで恒久的に拒否されない）", async () => {
    const uid = newUserId();
    const stub = userStub(uid);
    const dir = new FakeDirectory();
    await setup(stub, dir);
    const id = newConsultId();
    await stub.reserveConsult(id, "m".repeat(1000), { id: uid, login: "l".repeat(1000) });
    await stub.settleConsult(id, 0.1);
    await runDurableObjectAlarm(stub);
    expect(dir.calls[0]?.snapshot.model.length ?? 0).toBeLessThanOrEqual(200);
    expect(dir.calls[0]?.snapshot.owner_login.length ?? 0).toBeLessThanOrEqual(200);
  });

  it("Directory が束縛されていない環境では何もせず、alarm を回し続けない", async () => {
    const uid = newUserId();
    const stub = userStub(uid);
    await setup(stub);
    await runInDurableObject(stub, (i) => {
      const u = i as unknown as { env: Record<string, unknown> };
      u.env = { ...u.env, DIRECTORY_DO: undefined };
    });
    await settled(stub, uid);
    await runDurableObjectAlarm(stub);
    expect(await alarmOf(stub)).toBeNull();
  });

  it("alarm が既存の機能（同時実行の枠）に触れない", async () => {
    const uid = newUserId();
    const stub = userStub(uid);
    const dir = new FakeDirectory();
    await setup(stub, dir);
    await sql(stub, "INSERT INTO reservation_slot (task_id, reserved_at) VALUES ('01TASK', ?)", T0);
    await settled(stub, uid);
    await runDurableObjectAlarm(stub);
    expect(await sql(stub, "SELECT task_id FROM reservation_slot")).toEqual([
      { task_id: "01TASK" },
    ]);
  });
});
