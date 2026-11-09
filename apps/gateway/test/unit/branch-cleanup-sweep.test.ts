import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DIRECTORY_NAME, type TaskIndexSnapshot } from "../../src/directory/types";
import worker from "../../src/index";
import { type BranchCleanupDeps, sweepBranchCleanup } from "../../src/tasks/branch-cleanup";
import type { BranchCleanupOutcome } from "../../src/tasks/task-do";
import { newUserId } from "./helpers";
import { app, clearTaskAlarms, REPO, runToCompleted } from "./pr-helpers";

// issue #185「2. 掃除の起点と頻度」: sweep（Cron の 1 回分）と scheduled ハンドラ。
// 候補は DirectoryDO.claimBranchCleanup が選び、1 件ずつ順に TaskDO.cleanupBranch を呼ぶ。

afterEach(clearTaskAlarms);
afterEach(() => {
  vi.restoreAllMocks();
});

const NOW = Date.UTC(2026, 10, 1, 0, 17, 0);

/** 偽の DirectoryDO（claim / finish の呼び出しを記録する） */
function fakeDirectory(ids: string[]) {
  const calls: string[] = [];
  return {
    calls,
    claimBranchCleanup: vi.fn(async (now: number) => {
      calls.push(`claim:${now}`);
      return ids;
    }),
    finishBranchCleanup: vi.fn(async (id: string) => {
      calls.push(`finish:${id}`);
    }),
  };
}

/** 偽の TaskDO。outcomes[id] が Error なら投げる。並列に呼ばれていないかを数える */
function fakeTasks(outcomes: Record<string, BranchCleanupOutcome | Error>) {
  const order: string[] = [];
  let active = 0;
  let maxActive = 0;
  const task = (id: string) => ({
    cleanupBranch: async (): Promise<BranchCleanupOutcome> => {
      order.push(id);
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      const o = outcomes[id];
      if (o === undefined) throw new Error(`unexpected task ${id}`);
      if (o instanceof Error) throw o;
      return o;
    },
  });
  return { order, task, maxActive: () => maxActive };
}

const deps = (
  dirFake: ReturnType<typeof fakeDirectory>,
  tasks: ReturnType<typeof fakeTasks>,
): BranchCleanupDeps => ({ directory: dirFake, task: tasks.task });

describe("sweepBranchCleanup", () => {
  it("claim した順に 1 件ずつ（並列にせず）cleanupBranch を呼び、done のものだけ finish する。件数を返す", async () => {
    const d = fakeDirectory(["A", "B", "C", "D"]);
    const t = fakeTasks({
      A: { reason: "deleted", done: true },
      B: { reason: "pr_open", done: false },
      C: { reason: "already_gone", done: true },
      D: { reason: "base_of_open_pr", done: false },
    });
    const r = await sweepBranchCleanup(env, NOW, deps(d, t));
    expect(d.claimBranchCleanup).toHaveBeenCalledTimes(1);
    expect(d.claimBranchCleanup.mock.calls[0]?.[0]).toBe(NOW);
    expect(t.order).toEqual(["A", "B", "C", "D"]);
    expect(t.maxActive()).toBe(1);
    expect(d.calls).toEqual([`claim:${NOW}`, "finish:A", "finish:C"]);
    expect(r).toMatchObject({
      claimed: 4,
      checked: 4,
      deleted: 1,
      done: 2,
      errors: 0,
      stopped_by_rate_limit: false,
    });
  });

  it("rate_limited が返ったら、その回の残りは呼ばない", async () => {
    const d = fakeDirectory(["A", "B", "C"]);
    const t = fakeTasks({
      A: { reason: "deleted", done: true },
      B: { reason: "pr_open", done: false, rate_limited: true },
      C: { reason: "deleted", done: true },
    });
    const r = await sweepBranchCleanup(env, NOW, deps(d, t));
    expect(t.order).toEqual(["A", "B"]);
    expect(d.calls).toEqual([`claim:${NOW}`, "finish:A"]);
    expect(r).toMatchObject({
      claimed: 3,
      checked: 2,
      deleted: 1,
      done: 1,
      stopped_by_rate_limit: true,
    });
  });

  it("1 件が例外を投げても止まらず次へ進む（その件は finish しない）", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const d = fakeDirectory(["A", "B", "C"]);
    const t = fakeTasks({
      A: new Error("boom"),
      B: { reason: "deleted", done: true },
      C: { reason: "head_changed", done: true },
    });
    const r = await sweepBranchCleanup(env, NOW, deps(d, t));
    expect(t.order).toEqual(["A", "B", "C"]);
    expect(d.calls).toEqual([`claim:${NOW}`, "finish:B", "finish:C"]);
    expect(r).toMatchObject({ claimed: 3, checked: 3, deleted: 1, done: 2, errors: 1 });
  });

  it("finish が失敗しても次へ進む", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const d = fakeDirectory(["A", "B"]);
    d.finishBranchCleanup.mockImplementationOnce(async () => {
      throw new Error("finish failed");
    });
    const t = fakeTasks({
      A: { reason: "deleted", done: true },
      B: { reason: "deleted", done: true },
    });
    const r = await sweepBranchCleanup(env, NOW, deps(d, t));
    expect(t.order).toEqual(["A", "B"]);
    expect(d.finishBranchCleanup).toHaveBeenCalledTimes(2);
    expect(r).toMatchObject({ claimed: 2, deleted: 2, errors: 1 });
  });

  it("ログには件数と理由コードだけを出す（タスクの id・ブランチ名・PR の URL は出さない）", async () => {
    const logs: unknown[] = [];
    vi.spyOn(console, "log").mockImplementation((...a) => logs.push(a));
    vi.spyOn(console, "info").mockImplementation((...a) => logs.push(a));
    vi.spyOn(console, "error").mockImplementation((...a) => logs.push(a));
    const ids = ["01TASKIDAAAAAAAAAAAAAAAAAA", "01TASKIDBBBBBBBBBBBBBBBBBB"];
    const d = fakeDirectory(ids);
    const t = fakeTasks({
      [ids[0] as string]: { reason: "deleted", done: true },
      [ids[1] as string]: new Error("agent/task-01TASKIDBBBBBBBBBBBBBBBBBB"),
    });
    await sweepBranchCleanup(env, NOW, deps(d, t));
    const text = JSON.stringify(logs);
    expect(logs.length).toBeGreaterThan(0);
    expect(text).toContain("deleted");
    expect(text).not.toContain("01TASKID");
    expect(text).not.toContain("agent/task-");
  });

  it("DIRECTORY_DO が無い環境では何もしない", async () => {
    const t = fakeTasks({});
    const r = await sweepBranchCleanup(
      { ...env, DIRECTORY_DO: undefined } as unknown as Env,
      NOW,
      { task: t.task },
    );
    expect(t.order).toEqual([]);
    expect(r).toMatchObject({ claimed: 0, checked: 0, deleted: 0, done: 0 });
  });

  it("claim が失敗したら何も呼ばずに終わる（例外を投げない）", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const d = fakeDirectory([]);
    d.claimBranchCleanup.mockImplementationOnce(async () => {
      throw new Error("directory down");
    });
    const t = fakeTasks({});
    const r = await sweepBranchCleanup(env, NOW, deps(d, t));
    expect(t.order).toEqual([]);
    expect(r).toMatchObject({ claimed: 0, errors: 1 });
  });

  it("本物の TaskDO: 外でマージされたタスクのブランチを消し、finish する", async () => {
    const owner = newUserId();
    const done = await runToCompleted({}, owner);
    const pr = (await runInDurableObject(
      done.stub,
      (_i, s) => s.storage.sql.exec("SELECT pr_number FROM github_link").one().pr_number,
    )) as number;
    app().markMerged(REPO, pr);
    const d = fakeDirectory([done.id]);
    const r = await sweepBranchCleanup(env, Date.now(), { directory: d });
    expect(r).toMatchObject({ claimed: 1, deleted: 1, done: 1 });
    expect(d.calls.slice(1)).toEqual([`finish:${done.id}`]);
    expect(app().branch(REPO, done.branch)).toBeNull();
  });
});

describe("scheduled ハンドラ", () => {
  it("ctx.waitUntil に sweep を渡す（DirectoryDO の候補が確認済みになる）", async () => {
    const dir = env.DIRECTORY_DO.getByName(DIRECTORY_NAME);
    const id = `sched-${Date.now()}`;
    const now = Date.now();
    const snap: TaskIndexSnapshot = {
      task_id: id,
      owner_id: 1,
      owner_login: "alice",
      repository: "acme/widgets",
      repository_id: 100,
      title: "t",
      status: "COMPLETED",
      model: "anthropic/claude-sonnet-5-5",
      effort: "medium",
      created_at: now - 120_000,
      updated_at: now - 60_000,
      started_at: now - 120_000,
      ended_at: now - 60_000,
      cost_micro: 0,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      pr_number: 3,
      pr_url: "https://github.com/acme/widgets/pull/3",
      pr_draft: false,
      pr_merged: true,
      reason: null,
      failure_phase: null,
      deps_cache: null,
      sandbox_runtime_ms: null,
    };
    expect(await dir.upsertTask(snap, 1)).toMatchObject({ ok: true, applied: true });
    const waits: Promise<unknown>[] = [];
    const ctx = {
      waitUntil: vi.fn((p: Promise<unknown>) => {
        waits.push(p);
      }),
      passThroughOnException: () => {},
      props: {},
    } as unknown as ExecutionContext;
    const controller = {
      scheduledTime: now,
      cron: "17 * * * *",
      noRetry: () => {},
    } as unknown as ScheduledController;
    const handler = worker as unknown as {
      scheduled(c: ScheduledController, e: Env, x: ExecutionContext): Promise<void> | void;
    };
    await handler.scheduled(controller, env, ctx);
    expect(ctx.waitUntil).toHaveBeenCalledTimes(1);
    expect(waits[0]).toBeInstanceOf(Promise);
    const result = await waits[0];
    expect(result).toMatchObject({ claimed: expect.any(Number) });
    const row = await runInDurableObject(dir, (_i, s) =>
      s.storage.sql
        .exec<{ last_checked_at: number | null }>(
          "SELECT last_checked_at FROM branch_cleanup WHERE task_id = ?",
          id,
        )
        .toArray(),
    );
    expect(row).toHaveLength(1);
    expect(row[0]?.last_checked_at).not.toBeNull();
  });
});
