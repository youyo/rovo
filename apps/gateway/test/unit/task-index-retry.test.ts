import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { TaskIndexSnapshot } from "../../src/directory/types";
import { app, createTask, runToCompleted, type TaskStub } from "./pr-helpers";

// 索引の配送の再試行（バックオフ・ジッター）、恒久的な拒否の破棄、送る前の切り詰め。

const OWNER = 932;

type Call = { snapshot: TaskIndexSnapshot; revision: number };

class FakeDirectory {
  calls: Call[] = [];
  mode: "ok" | "throw" | "reject" | "unavailable" = "ok";
  getByName() {
    return {
      upsertTask: async (snapshot: TaskIndexSnapshot, revision: number) => {
        this.calls.push({ snapshot, revision });
        if (this.mode === "throw") throw new Error("directory down");
        if (this.mode === "reject") return { ok: false, code: "invalid_input" };
        if (this.mode === "unavailable") return { ok: false, code: "unavailable" };
        return { ok: true, applied: true, revision };
      },
    };
  }
}

async function useDirectory(stub: TaskStub, dir: FakeDirectory) {
  await runInDurableObject(stub, (i) => {
    const o = i as unknown as { env: Record<string, unknown>; indexTimeoutMs: number };
    o.env = { ...o.env, DIRECTORY_DO: dir };
    o.indexTimeoutMs = 100;
  });
}

const state = (stub: TaskStub) =>
  runInDurableObject(
    stub,
    (_i, s) =>
      s.storage.sql
        .exec<{
          index_revision: number;
          index_sent_revision: number;
          index_attempts: number;
          index_retry_at: number;
        }>(
          "SELECT index_revision, index_sent_revision, index_attempts, index_retry_at FROM agent_link",
        )
        .one() as {
        index_revision: number;
        index_sent_revision: number;
        index_attempts: number;
        index_retry_at: number;
      },
  );
const alarmOf = (stub: TaskStub) => runInDurableObject(stub, (_i, s) => s.storage.getAlarm());

async function setClock(stub: TaskStub, clock: () => number) {
  await runInDurableObject(stub, (i) => {
    (i as unknown as { now: () => number }).now = clock;
  });
  app().now = clock;
}

async function setRandom(stub: TaskStub, r: () => number) {
  await runInDurableObject(stub, (i) => {
    (i as unknown as { random: () => number }).random = r;
  });
}

describe("索引の配送: バックオフとジッター", () => {
  it("失敗の回数に応じて間隔が伸び、10 回続いたら 1 時間まで延びる。打ち切らず、復旧したら追いつく", async () => {
    const t = await createTask({}, OWNER);
    const dir = new FakeDirectory();
    dir.mode = "throw";
    await useDirectory(t.stub, dir);
    await setRandom(t.stub, () => 0.5); // ジッター係数 1.0
    const fixed = 1_000_000_000_000;
    await setClock(t.stub, () => fixed);
    await runDurableObjectAlarm(t.stub);
    expect(await state(t.stub)).toMatchObject({
      index_attempts: 1,
      index_retry_at: fixed + 10_000,
    });
    // 9 回失敗した後の 10 回目 = 1 時間
    await runInDurableObject(t.stub, (_i, s) => {
      s.storage.sql.exec("UPDATE agent_link SET index_attempts = 9, index_retry_at = 0");
    });
    await runDurableObjectAlarm(t.stub);
    expect(await state(t.stub)).toMatchObject({
      index_attempts: 10,
      index_retry_at: fixed + 60 * 60_000,
    });
    // 復旧: 時間が経てば送り、追いつく
    dir.mode = "ok";
    await setClock(t.stub, () => fixed + 2 * 60 * 60_000);
    for (let i = 0; i < 4; i++) {
      const s = await state(t.stub);
      if (s.index_sent_revision >= s.index_revision) break;
      await runDurableObjectAlarm(t.stub);
    }
    expect(await state(t.stub)).toMatchObject({
      index_attempts: 0,
      index_retry_at: 0,
    });
    const s = await state(t.stub);
    expect(s.index_sent_revision).toBe(s.index_revision);
  });

  it("ジッターは差し替えた乱数で決まる（±20%）", async () => {
    const t = await createTask({}, OWNER);
    const dir = new FakeDirectory();
    dir.mode = "throw";
    await useDirectory(t.stub, dir);
    const fixed = 1_000_000_000_000;
    await setClock(t.stub, () => fixed);
    await setRandom(t.stub, () => 0);
    await runDurableObjectAlarm(t.stub);
    expect((await state(t.stub)).index_retry_at).toBe(fixed + 8_000);
    await runInDurableObject(t.stub, (_i, s) => {
      s.storage.sql.exec("UPDATE agent_link SET index_attempts = 0, index_retry_at = 0");
    });
    await setRandom(t.stub, () => 1);
    await runDurableObjectAlarm(t.stub);
    expect((await state(t.stub)).index_retry_at).toBe(fixed + 12_000);
  });
});

describe("索引の配送: 恒久的な拒否と一時的な失敗", () => {
  it("invalid_input は、その revision を送信済みとして捨てる。再送せず、ログにはコードだけ。alarm が消える", async () => {
    const t = await runToCompleted({}, OWNER);
    const dir = new FakeDirectory();
    dir.mode = "reject";
    await useDirectory(t.stub, dir);
    const logs: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => {
      logs.push(a.map(String).join(" "));
    };
    try {
      await t.stub.advance();
      for (let i = 0; i < 6 && (await alarmOf(t.stub)) !== null; i++) {
        await runDurableObjectAlarm(t.stub);
      }
    } finally {
      console.error = orig;
    }
    const s = await state(t.stub);
    expect(s.index_sent_revision).toBe(s.index_revision);
    expect(s).toMatchObject({ index_attempts: 0, index_retry_at: 0 });
    expect(await alarmOf(t.stub)).toBeNull();
    expect(dir.calls).toHaveLength(1);
    const line = logs.find((l) => l.includes("task_index_rejected"));
    expect(line).toContain("invalid_input");
  });

  it("一時的な失敗（unavailable の応答）は従来どおり再試行に回す", async () => {
    const t = await createTask({}, OWNER);
    const dir = new FakeDirectory();
    dir.mode = "unavailable";
    await useDirectory(t.stub, dir);
    await runDurableObjectAlarm(t.stub);
    const s = await state(t.stub);
    expect(s.index_sent_revision).toBe(0);
    expect(s.index_attempts).toBe(1);
  });
});

describe("索引の snapshot: 送る前の切り詰め", () => {
  it("長すぎる値は契約の上限（title 300・login 39・repository 140・model 100・reason 100）へ切り詰める", async () => {
    const t = await createTask({}, OWNER);
    const dir = new FakeDirectory();
    await useDirectory(t.stub, dir);
    await runInDurableObject(t.stub, (_i, s) => {
      s.storage.sql.exec(
        "UPDATE task SET title = ?, owner_login = ?, repository = ?, model = ?",
        "あ".repeat(500),
        "l".repeat(100),
        `o/${"r".repeat(400)}`,
        `m${"x".repeat(300)}`,
      );
    });
    await runDurableObjectAlarm(t.stub);
    const s = dir.calls[0]?.snapshot as TaskIndexSnapshot;
    expect(s.title).toBe("あ".repeat(300));
    expect(s.owner_login).toHaveLength(39);
    expect(s.repository).toHaveLength(140);
    expect(s.model).toHaveLength(100);
  });
});
