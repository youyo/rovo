import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { newTaskId, sampleInput, taskStub } from "./helpers";

const OWNER = 501;

async function createTask(overrides: Record<string, unknown> = {}) {
  const id = newTaskId();
  const stub = taskStub(id);
  const r = await stub.ensureCreated(sampleInput(id, OWNER, overrides));
  if (!r.ok) throw new Error(`ensureCreated failed: ${r.code}`);
  return { id, stub };
}

function rows<T>(stub: ReturnType<typeof taskStub>, sql: string): Promise<T[]> {
  return runInDurableObject(stub, (_i, state) => state.storage.sql.exec(sql).toArray() as T[]);
}

describe("TaskDO.ensureCreated", () => {
  it("未作成なら CREATING で作り、created イベント(seq=1)を1件追加する", async () => {
    const id = newTaskId();
    const stub = taskStub(id);
    const r = await stub.ensureCreated(sampleInput(id, OWNER));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.created).toBe(true);
    expect(r.task).toMatchObject({
      task_id: id,
      status: "CREATING",
      repository: "acme/widgets",
      title: "Implement authentication",
      draft_pr_url: null,
      latest_cursor: "1",
    });
    const events = await rows<{ seq: number; type: string }>(stub, "SELECT seq, type FROM events");
    expect(events).toEqual([{ seq: 1, type: "created" }]);
  });

  it("repository_id / installation_id / owner 情報を保存する", async () => {
    const { stub } = await createTask();
    const [row] = await rows<Record<string, unknown>>(stub, "SELECT * FROM task");
    expect(row).toMatchObject({
      owner_id: OWNER,
      owner_login: "alice",
      repository_id: 4242,
      installation_id: 77,
      base_ref: "main",
      base_sha: "0123456789abcdef",
    });
    expect(JSON.parse(row?.acceptance_criteria as string)).toEqual(["tests pass"]);
    expect(JSON.parse(row?.constraints as string)).toEqual(["do not merge"]);
  });

  it("repository_id / installation_id は省略できる（null で保存）", async () => {
    const id = newTaskId();
    const stub = taskStub(id);
    const input = sampleInput(id, OWNER, { repository_id: undefined, installation_id: undefined });
    expect((await stub.ensureCreated(input)).ok).toBe(true);
    const [row] = await rows<Record<string, unknown>>(stub, "SELECT * FROM task");
    expect(row?.repository_id).toBeNull();
    expect(row?.installation_id).toBeNull();
  });

  it("同じ入力で再実行すると既存の内容を返し、イベントを増やさない", async () => {
    const { id, stub } = await createTask();
    const again = await stub.ensureCreated(sampleInput(id, OWNER));
    expect(again.ok && again.created).toBe(false);
    if (again.ok) expect(again.task.latest_cursor).toBe("1");
    expect(await rows(stub, "SELECT * FROM events")).toHaveLength(1);
  });

  it("入力が異なれば conflict", async () => {
    const { id, stub } = await createTask();
    expect(await stub.ensureCreated(sampleInput(id, OWNER, { title: "other" }))).toEqual({
      ok: false,
      code: "conflict",
    });
    expect(await stub.ensureCreated(sampleInput(id, 999))).toEqual({
      ok: false,
      code: "conflict",
    });
  });

  it("tombstone 済みなら expired（作成されない）", async () => {
    const id = newTaskId();
    const stub = taskStub(id);
    expect(await stub.abandonIfUncreated()).toEqual({ result: "abandoned" });
    expect(await stub.ensureCreated(sampleInput(id, OWNER))).toEqual({
      ok: false,
      code: "expired",
    });
    expect(await rows(stub, "SELECT * FROM task")).toHaveLength(0);
    expect(await rows(stub, "SELECT * FROM events")).toHaveLength(0);
  });

  it("入力が不正（base_sha など）なら invalid_input", async () => {
    const id = newTaskId();
    const r = await taskStub(id).ensureCreated(sampleInput(id, OWNER, { base_sha: "zz" }));
    expect(r).toEqual({ ok: false, code: "invalid_input" });
  });
});

describe("TaskDO.abandonIfUncreated", () => {
  it("作成済みなら何もせず現在の状態を返す", async () => {
    const { stub } = await createTask();
    expect(await stub.abandonIfUncreated()).toEqual({ result: "created", status: "CREATING" });
    expect(await stub.inspect()).toEqual({ kind: "created", status: "CREATING" });
  });

  it("冪等: 2回目も abandoned。inspect は abandoned", async () => {
    const stub = taskStub(newTaskId());
    expect(await stub.inspect()).toEqual({ kind: "uncreated" });
    await stub.abandonIfUncreated();
    expect(await stub.abandonIfUncreated()).toEqual({ result: "abandoned" });
    expect(await stub.inspect()).toEqual({ kind: "abandoned" });
  });
});

describe("TaskDO.getStatus / cancel", () => {
  it("getStatus は owner 一致で返し、不一致・未作成は not_found", async () => {
    const { id, stub } = await createTask();
    const ok = await stub.getStatus(OWNER);
    expect(ok.ok && ok.task.task_id).toBe(id);
    expect(await stub.getStatus(OWNER + 1)).toEqual({ ok: false, code: "not_found" });
    expect(await taskStub(newTaskId()).getStatus(OWNER)).toEqual({ ok: false, code: "not_found" });
  });

  it("cancel は CANCELLED にし、cancelled イベントを同時に追加する", async () => {
    const { stub } = await createTask();
    const r = await stub.cancel(OWNER);
    expect(r).toMatchObject({ ok: true, status: "CANCELLED", changed: true });
    const events = await rows<{ seq: number; type: string }>(
      stub,
      "SELECT seq, type FROM events ORDER BY seq",
    );
    expect(events).toEqual([
      { seq: 1, type: "created" },
      { seq: 2, type: "cancelled" },
    ]);
    const s = await stub.getStatus(OWNER);
    expect(s.ok && s.task.status).toBe("CANCELLED");
    expect(s.ok && s.task.latest_cursor).toBe("2");
  });

  it("終端状態への cancel は冪等に成功し、イベントを追加しない", async () => {
    const { stub } = await createTask();
    await stub.cancel(OWNER);
    const again = await stub.cancel(OWNER);
    expect(again).toMatchObject({ ok: true, status: "CANCELLED", changed: false });
    expect(await rows(stub, "SELECT * FROM events")).toHaveLength(2);
  });

  it.each(["COMPLETED", "FAILED", "BUDGET_EXCEEDED"])(
    "%s への cancel も変更せず現在の状態を返す",
    async (status) => {
      const { stub } = await createTask();
      await runInDurableObject(stub, (_i, state) =>
        state.storage.sql.exec("UPDATE task SET status = ?", status),
      );
      expect(await stub.cancel(OWNER)).toMatchObject({ ok: true, status, changed: false });
      expect(await rows(stub, "SELECT * FROM events")).toHaveLength(1);
    },
  );

  it("owner 不一致の cancel は not_found で何も変えない", async () => {
    const { stub } = await createTask();
    expect(await stub.cancel(OWNER + 1)).toEqual({ ok: false, code: "not_found" });
    const s = await stub.getStatus(OWNER);
    expect(s.ok && s.task.status).toBe("CREATING");
  });

  it("状態変更とイベント挿入は原子的（イベント挿入が失敗したら状態も変わらない）", async () => {
    const { stub } = await createTask();
    await runInDurableObject(stub, async (instance) => {
      // 状態更新の後でイベント挿入が失敗する状況を作る
      const target = instance as unknown as { appendEvent: (...a: unknown[]) => unknown };
      const original = target.appendEvent;
      target.appendEvent = () => {
        throw new Error("boom");
      };
      await expect(instance.cancel(OWNER)).rejects.toThrow("boom");
      target.appendEvent = original;
    });
    const s = await stub.getStatus(OWNER);
    expect(s.ok && s.task.status).toBe("CREATING");
    expect(await rows(stub, "SELECT * FROM events")).toHaveLength(1);
    expect(await stub.cancel(OWNER)).toMatchObject({
      ok: true,
      status: "CANCELLED",
      changed: true,
    });
    const events = await rows<{ seq: number }>(stub, "SELECT seq FROM events ORDER BY seq");
    expect(events.map((e) => e.seq)).toEqual([1, 2]);
  });
});

describe("TaskDO.wait", () => {
  it("cursor 省略なら先頭から、イベントがあれば即座に返す", async () => {
    const { id, stub } = await createTask();
    const t0 = Date.now();
    const r = await stub.wait(OWNER, undefined, 30);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(r).toMatchObject({ ok: true, status: "CREATING", cursor: "1" });
    if (!r.ok) return;
    expect(r.events).toHaveLength(1);
    expect(r.events[0]).toMatchObject({ seq: 1, type: "created" });
    expect(r.retry_after_seconds).toBeUndefined();
    void id;
  });

  it("seq > cursor のイベントだけを返し、cursor は最後の seq", async () => {
    const { stub } = await createTask();
    await stub.cancel(OWNER);
    const r = await stub.wait(OWNER, "1", 30);
    expect(r.ok && r.events.map((e) => e.type)).toEqual(["cancelled"]);
    expect(r.ok && r.cursor).toBe("2");
  });

  it("最大100件に切り詰め、残りは続きの cursor で取れる", async () => {
    const { stub } = await createTask();
    await runInDurableObject(stub, (_i, state) => {
      for (let seq = 2; seq <= 150; seq++) {
        state.storage.sql.exec(
          "INSERT INTO events (seq, type, payload, created_at) VALUES (?, 'x', '{}', 0)",
          seq,
        );
      }
    });
    const first = await stub.wait(OWNER, undefined, 0);
    expect(first.ok && first.events).toHaveLength(100);
    expect(first.ok && first.cursor).toBe("100");
    const second = await stub.wait(OWNER, "100", 0);
    expect(second.ok && second.events).toHaveLength(50);
    expect(second.ok && second.cursor).toBe("150");
  });

  it("終端状態で新しいイベントが無ければ、待たずに空で返す（cursor はそのまま）", async () => {
    const { stub } = await createTask();
    await stub.cancel(OWNER);
    const t0 = Date.now();
    const r = await stub.wait(OWNER, "2", 30);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(r).toMatchObject({ ok: true, status: "CANCELLED", cursor: "2", events: [] });
  });

  it("timeout_seconds=0 は待たずに空で返す", async () => {
    const { stub } = await createTask();
    const r = await stub.wait(OWNER, "1", 0);
    expect(r).toMatchObject({ ok: true, status: "CREATING", cursor: "1", events: [] });
  });

  it("イベントが無ければ timeout まで待って空で返し、待機者を片付ける", async () => {
    const { stub } = await createTask();
    const t0 = Date.now();
    const r = await stub.wait(OWNER, "1", 1);
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(900);
    expect(elapsed).toBeLessThan(5000);
    expect(r).toMatchObject({ ok: true, cursor: "1", events: [] });
    expect(await waiterCount(stub)).toBe(0);
  });

  it("待機中にイベントが追加されたら起きて返す（cancel を妨げない）", async () => {
    const { stub } = await createTask();
    const pending = stub.wait(OWNER, "1", 30);
    await waitForWaiters(stub, 1);
    const t0 = Date.now();
    await stub.cancel(OWNER); // wait 中でも cancel が通る = blockConcurrencyWhile で包んでいない
    const r = await pending;
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(r).toMatchObject({ ok: true, status: "CANCELLED", cursor: "2" });
    expect(r.ok && r.events.map((e) => e.type)).toEqual(["cancelled"]);
    expect(await waiterCount(stub)).toBe(0);
  });

  it("複数の待機者がそれぞれの cursor で独立に起きる", async () => {
    const { stub } = await createTask();
    await runInDurableObject(stub, (_i, state) => {
      state.storage.sql.exec(
        "INSERT INTO events (seq, type, payload, created_at) VALUES (2, 'x', '{}', 0)",
      );
    });
    const a = stub.wait(OWNER, "2", 30); // 最新から待つ
    const b = stub.wait(OWNER, "2", 30);
    const c = stub.wait(OWNER, "2", 30);
    await waitForWaiters(stub, 3);
    await stub.cancel(OWNER);
    for (const r of await Promise.all([a, b, c])) {
      expect(r.ok && r.events.map((e) => e.seq)).toEqual([3]);
      expect(r.ok && r.cursor).toBe("3");
    }
    expect(await waiterCount(stub)).toBe(0);
  });

  it("同時待機数の上限(16)を超えたら即座に空で返し retry_after_seconds を含む", async () => {
    const { stub } = await createTask();
    const pendings = Array.from({ length: 16 }, () => stub.wait(OWNER, "1", 30));
    await waitForWaiters(stub, 16);
    const t0 = Date.now();
    const over = await stub.wait(OWNER, "1", 30);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(over).toMatchObject({ ok: true, cursor: "1", events: [] });
    expect(over.ok && over.retry_after_seconds).toBeGreaterThan(0);
    expect(await waiterCount(stub)).toBe(16);
    await stub.cancel(OWNER);
    const results = await Promise.all(pendings);
    expect(results.every((r) => r.ok && r.events.length === 1)).toBe(true);
    expect(await waiterCount(stub)).toBe(0);
  });

  it("呼び出し側が切断（結果を捨てる）しても、待機者は timeout で必ず片付き枠が戻る", async () => {
    const { stub } = await createTask();
    // 切断を模す: 16 件の wait を投げっぱなしにし、結果を誰も待たない
    for (let i = 0; i < 16; i++) void stub.wait(OWNER, "1", 1).catch(() => {});
    await waitForWaiters(stub, 16);
    const full = await stub.wait(OWNER, "1", 1);
    expect(full.ok && full.retry_after_seconds).toBeGreaterThan(0);
    // timeout_seconds 経過後（上限 60 秒でクランプされる）には全員片付く
    await new Promise((r) => setTimeout(r, 1500));
    expect(await waiterCount(stub)).toBe(0);
    const again = stub.wait(OWNER, "1", 1);
    await waitForWaiters(stub, 1); // 新しい wait が枠を使える
    expect((await again).ok).toBe(true);
  });

  it("上限に達していても、イベントがあれば即座に返す（待機枠を使わない）", async () => {
    const { stub } = await createTask();
    const pendings = Array.from({ length: 16 }, () => stub.wait(OWNER, "1", 30));
    await waitForWaiters(stub, 16);
    const r = await stub.wait(OWNER, undefined, 30);
    expect(r.ok && r.events).toHaveLength(1);
    expect(r.ok && r.retry_after_seconds).toBeUndefined();
    await stub.cancel(OWNER);
    await Promise.all(pendings);
  });

  it("不正な cursor は invalid_cursor", async () => {
    const { stub } = await createTask();
    for (const bad of ["-1", "1.5", "abc", "", String(Number.MAX_SAFE_INTEGER + 1)]) {
      expect(await stub.wait(OWNER, bad, 0), bad).toEqual({ ok: false, code: "invalid_cursor" });
    }
  });

  it("未来の cursor（最新 seq より大きい）は invalid_cursor。最新と同じは有効", async () => {
    const { stub } = await createTask();
    expect(await stub.wait(OWNER, "2", 0)).toEqual({ ok: false, code: "invalid_cursor" });
    expect((await stub.wait(OWNER, "1", 0)).ok).toBe(true);
  });

  it("不正な timeout（負数・小数）は invalid_input", async () => {
    const { stub } = await createTask();
    expect(await stub.wait(OWNER, undefined, -1)).toEqual({ ok: false, code: "invalid_input" });
    expect(await stub.wait(OWNER, undefined, 1.5)).toEqual({ ok: false, code: "invalid_input" });
  });

  it("owner 不一致・未作成は not_found（検証より先に判定する）", async () => {
    const { stub } = await createTask();
    expect(await stub.wait(OWNER + 1, "-1", -1)).toEqual({ ok: false, code: "not_found" });
    expect(await taskStub(newTaskId()).wait(OWNER, undefined, 0)).toEqual({
      ok: false,
      code: "not_found",
    });
  });

  it("上限を超える timeout は 60 秒にクランプされる（検証だけ。待たずに起こす）", async () => {
    const { stub } = await createTask();
    const pending = stub.wait(OWNER, "1", 100000);
    await waitForWaiters(stub, 1);
    await stub.cancel(OWNER);
    expect((await pending).ok).toBe(true);
  });
});

describe("TaskDO 永続化", () => {
  it("再起動（evict）後もイベントと状態を再読できる", async () => {
    const { id, stub } = await createTask();
    await stub.cancel(OWNER);
    await evictDurableObject(stub);
    const fresh = taskStub(id);
    const s = await fresh.getStatus(OWNER);
    expect(s.ok && s.task.status).toBe("CANCELLED");
    const r = await fresh.wait(OWNER, undefined, 0);
    expect(r.ok && r.events.map((e) => [e.seq, e.type])).toEqual([
      [1, "created"],
      [2, "cancelled"],
    ]);
    // 再起動後も seq 採番が続く（衝突しない）
    expect(await fresh.cancel(OWNER)).toMatchObject({ changed: false });
  });

  it("tombstone も再起動後に残る", async () => {
    const id = newTaskId();
    const stub = taskStub(id);
    await stub.abandonIfUncreated();
    await evictDurableObject(stub);
    expect(await taskStub(id).ensureCreated(sampleInput(id, OWNER))).toEqual({
      ok: false,
      code: "expired",
    });
  });
});

function waiterCount(stub: ReturnType<typeof taskStub>): Promise<number> {
  return runInDurableObject(stub, (instance) => {
    return (instance as unknown as { waiters: Set<unknown> }).waiters.size;
  });
}

async function waitForWaiters(stub: ReturnType<typeof taskStub>, n: number) {
  for (let i = 0; i < 200; i++) {
    if ((await waiterCount(stub)) >= n) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`waiters did not reach ${n}`);
}
