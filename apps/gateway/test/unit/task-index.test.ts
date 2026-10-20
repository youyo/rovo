import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { DIRECTORY_NAME, type TaskIndexSnapshot } from "../../src/directory/types";
import { newTaskId, sampleInput, taskStub } from "./helpers";
import {
  app,
  completedResult,
  createTask,
  REPO,
  runToCompleted,
  type TaskStub,
} from "./pr-helpers";

// ダッシュボードの索引の outbox（docs/specs/dashboard.md D10 / M3a）。
// TaskDO は、行を変える同期区間の中で index_revision を上げ、alarm で最新の snapshot を Directory へ配送する。

const OWNER = 931;

type Call = { snapshot: TaskIndexSnapshot; revision: number };

/** 偽の Directory。呼び出しを記録し、失敗・保留を差し込める。 */
class FakeDirectory {
  calls: Call[] = [];
  mode: "ok" | "throw" | "hang" = "ok";
  getByName() {
    return {
      upsertTask: async (snapshot: TaskIndexSnapshot, revision: number) => {
        this.calls.push({ snapshot, revision });
        if (this.mode === "throw") throw new Error("directory down ghs_leak");
        if (this.mode === "hang") await new Promise(() => {});
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

const link = (stub: TaskStub) =>
  runInDurableObject(
    stub,
    (_i, s) =>
      s.storage.sql
        .exec<{
          index_revision: number;
          index_sent_revision: number;
        }>("SELECT index_revision, index_sent_revision FROM agent_link")
        .one() as { index_revision: number; index_sent_revision: number },
  );
const revision = async (stub: TaskStub) => (await link(stub)).index_revision;
const sent = async (stub: TaskStub) => (await link(stub)).index_sent_revision;
const alarmOf = (stub: TaskStub) => runInDurableObject(stub, (_i, s) => s.storage.getAlarm());

async function setClock(stub: TaskStub, clock: () => number) {
  await runInDurableObject(stub, (i) => {
    (i as unknown as { now: () => number }).now = clock;
  });
  app().now = clock;
}

describe("outbox: 各更新点で revision が上がる", () => {
  it("作成で 1（未配送）。alarm が設定される", async () => {
    const t = await createTask({}, OWNER);
    expect(await link(t.stub)).toEqual({ index_revision: 1, index_sent_revision: 0 });
    expect(await alarmOf(t.stub)).not.toBeNull();
  });

  it("状態の遷移（changeStatus）・PR の作成・usage の更新・キャンセルで上がる。値が変わらない usage では上がらない", async () => {
    const t = await createTask({}, OWNER);
    const r0 = await revision(t.stub);
    await t.stub.advance(); // CREATING -> RUNNING と Draft PR の作成
    const r1 = await revision(t.stub);
    expect(r1).toBeGreaterThan(r0);

    await t.agent.setUsage(0.5);
    await t.stub.advance();
    const r2 = await revision(t.stub);
    expect(r2).toBe(r1 + 1);

    // 何も届かない advance では上がらない（wait のポーリングと alarm で dirty のまま増えない）
    await t.stub.advance();
    await t.stub.advance();
    expect(await revision(t.stub)).toBe(r2);

    expect(await t.stub.cancel(OWNER)).toMatchObject({ ok: true, status: "CANCELLED" });
    expect(await revision(t.stub)).toBe(r2 + 1);
  });

  it("PR の作成の更新点でも上がる（pr_number が初めて入る）", async () => {
    const t = await createTask({}, OWNER);
    const dir = new FakeDirectory();
    await useDirectory(t.stub, dir);
    await t.stub.advance();
    await runDurableObjectAlarm(t.stub);
    const last = dir.calls.at(-1)?.snapshot;
    expect(last?.pr_number).not.toBeNull();
    expect(last?.pr_url).toMatch(/^https?:\/\//);
    expect(last?.pr_draft).toBe(true);
  });

  it("recordPrAction（Ready / マージ）で上がる。終端後で alarm が消えていても、再設定されて配送される", async () => {
    const t = await runToCompleted({ merge_policy: "agent_merge" }, OWNER);
    const dir = new FakeDirectory();
    await useDirectory(t.stub, dir);
    // 束縛していなかった間の更新が未配送で残っている。advance が alarm を戻し、alarm が配送する
    await t.stub.advance();
    // 終端・finalize 後は配送も済んで alarm が消えている
    for (let i = 0; i < 4 && (await alarmOf(t.stub)) !== null; i++) {
      await runDurableObjectAlarm(t.stub);
    }
    expect(await alarmOf(t.stub)).toBeNull();
    const before = await revision(t.stub);
    expect(await sent(t.stub)).toBe(before);

    await t.stub.recordPrAction(OWNER, { kind: "ready", outcome: "done" });
    expect(await revision(t.stub)).toBe(before + 1);
    expect(await alarmOf(t.stub)).not.toBeNull();
    await runDurableObjectAlarm(t.stub);
    expect(dir.calls.at(-1)?.snapshot.pr_draft).toBe(false);
    await t.stub.recordPrAction(OWNER, { kind: "merge", outcome: "done" });
    await runDurableObjectAlarm(t.stub);
    expect(dir.calls.at(-1)?.snapshot.pr_merged).toBe(true);
    expect(dir.calls.at(-1)?.revision).toBe(before + 2);
    expect(await sent(t.stub)).toBe(before + 2);
  });

  it("行の更新と revision の上昇は同じトランザクション（途中で例外なら、どちらも反映されない）", async () => {
    const t = await createTask({}, OWNER);
    await t.stub.advance();
    const before = await revision(t.stub);
    // appendEvent は 1 回だけ失敗させる（UPDATE と revision の上昇の後に呼ばれる）
    // （DO の外へ例外を出すと workerd が未捕捉として報告するので、DO の中で呼んで捕まえる）
    const threw = await runInDurableObject(t.stub, async (i) => {
      const o = i as unknown as {
        appendEvent: (...a: unknown[]) => number;
        cancel: (owner: number) => Promise<unknown>;
      };
      const orig = o.appendEvent.bind(i);
      o.appendEvent = (...a: unknown[]) => {
        o.appendEvent = orig;
        throw new Error("boom");
      };
      try {
        await o.cancel(OWNER);
        return false;
      } catch {
        return true;
      }
    });
    expect(threw).toBe(true);
    const status = await runInDurableObject(
      t.stub,
      (_i, s) => s.storage.sql.exec<{ status: string }>("SELECT status FROM task").one().status,
    );
    expect(status).not.toBe("CANCELLED");
    expect(await revision(t.stub)).toBe(before);
  });
});

describe("outbox: 配送は alarm で行う", () => {
  it("alarm で最新の snapshot を revision つきで送り、成功したら sent が追いつく。advance() では送らない", async () => {
    const t = await createTask({ title: "my title" }, OWNER);
    const dir = new FakeDirectory();
    await useDirectory(t.stub, dir);
    await t.stub.advance();
    await t.agent.setUsage(1.5, { inputTokens: 11, outputTokens: 22 });
    await t.stub.advance();
    // MCP の経路（advance）は Directory を待たない・呼ばない
    expect(dir.calls).toHaveLength(0);

    await runDurableObjectAlarm(t.stub);
    expect(dir.calls).toHaveLength(1);
    const call = dir.calls[0] as Call;
    expect(call.revision).toBe(await revision(t.stub));
    expect(await sent(t.stub)).toBe(call.revision);
    expect(call.snapshot).toMatchObject({
      task_id: t.id,
      owner_id: OWNER,
      owner_login: "alice",
      repository: REPO,
      repository_id: 4242,
      title: "my title",
      status: "RUNNING",
      cost_micro: 1_500_000,
      input_tokens: 11,
      output_tokens: 22,
      ended_at: null,
      reason: null,
      failure_phase: null,
    });
    expect(call.snapshot.started_at).not.toBeNull();
    // 入力（instructions など）は索引に入れない
    expect(JSON.stringify(call.snapshot)).not.toContain("Implement OAuth");
    expect(Object.keys(call.snapshot)).not.toContain("instructions");
    // 追いついたら、同じ revision は再送しない
    await runDurableObjectAlarm(t.stub);
    expect(dir.calls).toHaveLength(1);
  });

  it("repository_id が NULL のタスクは NULL のまま送る", async () => {
    const id = newTaskId();
    const stub = taskStub(id);
    await stub.ensureCreated(sampleInput(id, OWNER, { repository_id: null }));
    const dir = new FakeDirectory();
    await useDirectory(stub, dir);
    await runDurableObjectAlarm(stub);
    expect(dir.calls[0]?.snapshot.repository_id).toBeNull();
  });

  it("Directory が失敗しても、タスクの本体（状態・課金・alarm）は進み、alarm は例外にならない。復旧したら追いつく", async () => {
    const t = await createTask({}, OWNER);
    const dir = new FakeDirectory();
    dir.mode = "throw";
    await useDirectory(t.stub, dir);
    await t.stub.advance();
    await t.agent.setUsage(2);
    await t.agent.setPhase("completed");
    // 失敗は握りつぶす（reject しない）
    await runDurableObjectAlarm(t.stub);
    const status = await t.stub.getStatus(OWNER);
    expect(status.ok && status.task.status).toBe("COMPLETED");
    expect(dir.calls.length).toBeGreaterThan(0);
    expect(await sent(t.stub)).toBe(0);
    // 未配送のあいだ alarm は残る（終端でも）
    expect(await alarmOf(t.stub)).not.toBeNull();

    dir.mode = "ok";
    // 再試行は待ち時間（バックオフ）の後
    await setClock(t.stub, () => Date.now() + 60 * 60_000);
    for (let i = 0; i < 4 && (await sent(t.stub)) < (await revision(t.stub)); i++) {
      await runDurableObjectAlarm(t.stub);
    }
    expect(await sent(t.stub)).toBe(await revision(t.stub));
    expect(dir.calls.at(-1)?.snapshot).toMatchObject({
      status: "COMPLETED",
      cost_micro: 2_000_000,
    });
  });

  it("失敗のエラーの中身（秘密が入りうる）はログに出さない", async () => {
    const t = await createTask({}, OWNER);
    const dir = new FakeDirectory();
    dir.mode = "throw";
    await useDirectory(t.stub, dir);
    const logs: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => {
      logs.push(a.map(String).join(" "));
    };
    try {
      await runDurableObjectAlarm(t.stub);
    } finally {
      console.error = orig;
    }
    expect(logs.some((l) => l.includes("task_index_deliver_error"))).toBe(true);
    expect(logs.join("\n")).not.toContain("ghs_leak");
  });

  it("失敗の後は待ち時間を置く。待つあいだは Directory を呼び直さない", async () => {
    const t = await createTask({}, OWNER);
    const dir = new FakeDirectory();
    dir.mode = "throw";
    await useDirectory(t.stub, dir);
    await runDurableObjectAlarm(t.stub);
    const n = dir.calls.length;
    expect(n).toBe(1);
    await runDurableObjectAlarm(t.stub);
    expect(dir.calls).toHaveLength(n);
  });

  it("Directory が応答しなくても、alarm は上限の時間で戻る（タスクを遅らせない）", async () => {
    const t = await createTask({}, OWNER);
    const dir = new FakeDirectory();
    dir.mode = "hang";
    await useDirectory(t.stub, dir);
    const t0 = Date.now();
    await runDurableObjectAlarm(t.stub);
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(await sent(t.stub)).toBe(0);
    expect(await alarmOf(t.stub)).not.toBeNull();
  });

  it("終端の後（finalize も済んだ後）に usage が遅れて届いても、最後の revision が配送される", async () => {
    const t = await createTask({}, OWNER);
    const dir = new FakeDirectory();
    await useDirectory(t.stub, dir);
    await t.stub.advance();
    await t.agent.setUsage(1);
    const head = app().branch(REPO, t.branch) as string;
    await t.agent.setProgram({ result: completedResult(head) });
    await t.agent.setPhase("completed");
    await t.stub.advance();
    for (let i = 0; i < 4 && (await alarmOf(t.stub)) !== null; i++) {
      await runDurableObjectAlarm(t.stub);
    }
    expect(await alarmOf(t.stub)).toBeNull();
    expect(dir.calls.at(-1)?.snapshot).toMatchObject({
      status: "COMPLETED",
      cost_micro: 1_000_000,
    });
    expect(dir.calls.at(-1)?.snapshot.ended_at).not.toBeNull();

    // 終端の後に、より大きい累計の usage が届く（取り込みは終端後も usage を数える）
    await runInDurableObject(t.stub, (_i, s) => {
      s.storage.sql.exec("UPDATE agent_link SET finished = 0, cancel_state = 'pending'");
    });
    await t.agent.setUsage(3);
    await t.stub.advance();
    for (let i = 0; i < 4 && (await alarmOf(t.stub)) !== null; i++) {
      await runDurableObjectAlarm(t.stub);
    }
    expect(dir.calls.at(-1)?.snapshot.cost_micro).toBe(3_000_000);
    expect(dir.calls.at(-1)?.revision).toBe(await revision(t.stub));
    expect(await sent(t.stub)).toBe(await revision(t.stub));
  });

  it("失敗の snapshot の終端の値: FAILED の reason と failure_phase（準備の失敗）", async () => {
    const t = await createTask({}, OWNER);
    const dir = new FakeDirectory();
    await useDirectory(t.stub, dir);
    // 準備（ブランチの作成）が終わらないまま FAILED にする
    await runInDurableObject(t.stub, (i) => {
      (i as unknown as { failTask: (r: string) => void }).failTask("base_sha_not_found");
    });
    await runDurableObjectAlarm(t.stub);
    expect(dir.calls.at(-1)?.snapshot).toMatchObject({
      status: "FAILED",
      reason: "base_sha_not_found",
      failure_phase: "setup",
    });
  });
});

describe("outbox: 移行と、実 Directory との収束", () => {
  it("revision 0/0 の既存タスク（デプロイ前に作られた）は dirty ではない。終端なら alarm も要らない", async () => {
    const t = await runToCompleted({}, OWNER);
    for (let i = 0; i < 6 && (await alarmOf(t.stub)) !== null; i++) {
      await runDurableObjectAlarm(t.stub);
    }
    await runInDurableObject(t.stub, (_i, s) => {
      s.storage.sql.exec("UPDATE agent_link SET index_revision = 0, index_sent_revision = 0");
    });
    await runInDurableObject(t.stub, async (_i, s) => {
      await s.storage.deleteAlarm();
    });
    const dir = new FakeDirectory();
    await useDirectory(t.stub, dir);
    await t.stub.advance();
    expect(await alarmOf(t.stub)).toBeNull();
    expect(dir.calls).toHaveLength(0);
  });

  it("DIRECTORY_DO が未束縛の環境（migration の前など）でも、索引を止めるだけで、タスクと alarm は従来どおり", async () => {
    const t = await runToCompleted({}, OWNER);
    await runInDurableObject(t.stub, (i) => {
      const o = i as unknown as { env: Record<string, unknown> };
      o.env = { ...o.env, DIRECTORY_DO: undefined };
    });
    for (let i = 0; i < 6 && (await alarmOf(t.stub)) !== null; i++) {
      await runDurableObjectAlarm(t.stub);
    }
    expect(await alarmOf(t.stub)).toBeNull();
  });

  it("実 DirectoryDO へ配送すると、最終の状態・費用・revision に収束する", async () => {
    const t = await createTask({}, OWNER);
    // 本物の DirectoryDO を束縛する（worker-entry.ts の TaskDO は既定では束縛しない）
    await runInDurableObject(t.stub, (i) => {
      const o = i as unknown as { env: Record<string, unknown> };
      o.env = { ...o.env, DIRECTORY_DO: env.DIRECTORY_DO };
    });
    await t.stub.advance();
    await t.agent.setUsage(0.75);
    const head = app().branch(REPO, t.branch) as string;
    await t.agent.setProgram({ result: completedResult(head) });
    await t.agent.setPhase("completed");
    await t.stub.advance();
    for (let i = 0; i < 6 && (await alarmOf(t.stub)) !== null; i++) {
      await runDurableObjectAlarm(t.stub);
    }
    const directory = env.DIRECTORY_DO.getByName(DIRECTORY_NAME);
    const row = await runInDurableObject(
      directory,
      (_i, s) =>
        s.storage.sql.exec("SELECT * FROM task_index WHERE task_id = ?", t.id).toArray()[0],
    );
    expect(row).toMatchObject({
      task_id: t.id,
      status: "COMPLETED",
      cost_micro: 750_000,
      repository_id: 4242,
      revision: await revision(t.stub),
    });
  });
});
