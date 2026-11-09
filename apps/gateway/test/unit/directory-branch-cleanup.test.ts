import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { TaskIndexSnapshot } from "../../src/directory/types";

// 作業ブランチの掃除の候補（issue #185「2. 掃除の起点と頻度」）。DirectoryDO の branch_cleanup 表と
// claimBranchCleanup / finishBranchCleanup を確かめる。テストごとに別の Directory を使う（本番はシングルトン）。

let seq = 0;
const dir = () => env.DIRECTORY_DO.getByName(`branch-cleanup-${Date.now()}-${seq++}`);

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const NOW = Date.UTC(2026, 10, 1, 0, 0, 0);

function snap(id: string, over: Partial<TaskIndexSnapshot> = {}): TaskIndexSnapshot {
  return {
    task_id: id,
    owner_id: 1,
    owner_login: "alice",
    repository: "acme/widgets",
    repository_id: 100,
    title: "t",
    status: "COMPLETED",
    model: "anthropic/claude-sonnet-5-5",
    effort: "medium",
    created_at: NOW - 2 * DAY,
    updated_at: NOW - DAY,
    started_at: NOW - 2 * DAY,
    ended_at: NOW - DAY,
    cost_micro: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    pr_number: 7,
    pr_url: "https://github.com/acme/widgets/pull/7",
    pr_draft: false,
    pr_merged: false,
    reason: null,
    failure_phase: null,
    deps_cache: null,
    sandbox_runtime_ms: null,
    ...over,
  };
}

type Dir = ReturnType<typeof dir>;

async function put(d: Dir, s: TaskIndexSnapshot, revision = 1) {
  expect(await d.upsertTask(s, revision)).toMatchObject({ ok: true, applied: true });
}

type CleanupRow = {
  task_id: string;
  ended_at: number;
  last_checked_at: number | null;
  done: number;
};

async function cleanupRows(d: Dir): Promise<CleanupRow[]> {
  return runInDurableObject(d, (_i, state) =>
    state.storage.sql
      .exec<CleanupRow>(
        "SELECT task_id, ended_at, last_checked_at, done FROM branch_cleanup ORDER BY task_id",
      )
      .toArray(),
  );
}

describe("DirectoryDO.claimBranchCleanup（候補の写し）", () => {
  it("終わっていて PR があり review でなく、終わってから 30 日以内のタスクだけを写して返す", async () => {
    const d = dir();
    await put(d, snap("ok"));
    await put(d, snap("failed", { status: "FAILED", ended_at: NOW - 2 * DAY }));
    await put(d, snap("edge", { ended_at: NOW - 30 * DAY }));
    await put(d, snap("running", { status: "RUNNING", ended_at: null }));
    await put(d, snap("no-pr", { pr_number: null, pr_url: null }));
    await put(d, snap("review", { kind: "review" }));
    await put(d, snap("old", { ended_at: NOW - 30 * DAY - 1 }));
    const got = await d.claimBranchCleanup(NOW);
    expect([...got].sort()).toEqual(["edge", "failed", "ok"]);
    const rows = await cleanupRows(d);
    expect(rows.map((r) => r.task_id)).toEqual(["edge", "failed", "ok"]);
    for (const r of rows) {
      expect(r.last_checked_at).toBe(NOW);
      expect(r.done).toBe(0);
    }
    expect(rows.find((r) => r.task_id === "ok")?.ended_at).toBe(NOW - DAY);
  });

  it("索引の更新（新しい revision）で、進み具合（last_checked_at・done）は戻らない", async () => {
    const d = dir();
    await put(d, snap("A"));
    expect(await d.claimBranchCleanup(NOW)).toEqual(["A"]);
    await put(d, snap("A", { pr_merged: true, updated_at: NOW }), 2);
    expect(await d.claimBranchCleanup(NOW + 10 * MIN)).toEqual([]);
    const [row] = await cleanupRows(d);
    expect(row).toMatchObject({ task_id: "A", last_checked_at: NOW, done: 0 });
  });
});

describe("DirectoryDO.claimBranchCleanup（選び方）", () => {
  it("同じタスクは 50 分空ける（49 分後は選ばない、50 分後は選ぶ）", async () => {
    const d = dir();
    await put(d, snap("A"));
    expect(await d.claimBranchCleanup(NOW)).toEqual(["A"]);
    expect(await d.claimBranchCleanup(NOW)).toEqual([]);
    expect(await d.claimBranchCleanup(NOW + 49 * MIN)).toEqual([]);
    expect(await d.claimBranchCleanup(NOW + 50 * MIN)).toEqual(["A"]);
    const [row] = await cleanupRows(d);
    expect(row?.last_checked_at).toBe(NOW + 50 * MIN);
  });

  it("確認が古い順（まだ確認していないものが先）に選ぶ", async () => {
    const d = dir();
    await put(d, snap("A", { ended_at: NOW - 3 * DAY }));
    await put(d, snap("B", { ended_at: NOW - 2 * DAY }));
    await put(d, snap("C", { ended_at: NOW - DAY }));
    const first = await d.claimBranchCleanup(NOW, 1);
    expect(first).toHaveLength(1);
    const second = await d.claimBranchCleanup(NOW + 10 * MIN, 1);
    const third = await d.claimBranchCleanup(NOW + 20 * MIN, 1);
    const order = [...first, ...second, ...third];
    expect([...order].sort()).toEqual(["A", "B", "C"]);
    // 50 分を過ぎたら、確認が古いものから
    expect(await d.claimBranchCleanup(NOW + 80 * MIN, 3)).toEqual(order);
    // まだ確認していない新しい候補は、どれよりも先
    await put(d, snap("D", { ended_at: NOW }));
    expect(await d.claimBranchCleanup(NOW + 200 * MIN, 2)).toEqual(["D", order[0]]);
  });

  it("1 回に選ぶのは上限 20 件（limit を大きくしても 20）。残りは次の回に選ぶ", async () => {
    const d = dir();
    for (let i = 0; i < 25; i++) {
      await put(d, snap(`T${String(i).padStart(2, "0")}`, { ended_at: NOW - DAY + i }));
    }
    const first = await d.claimBranchCleanup(NOW, 100);
    expect(first).toHaveLength(20);
    const second = await d.claimBranchCleanup(NOW + MIN);
    expect(second).toHaveLength(5);
    expect(new Set([...first, ...second]).size).toBe(25);
    expect(await d.claimBranchCleanup(NOW + 2 * MIN)).toEqual([]);
  });

  it("既定の limit は 20", async () => {
    const d = dir();
    for (let i = 0; i < 21; i++) await put(d, snap(`U${String(i).padStart(2, "0")}`));
    expect(await d.claimBranchCleanup(NOW)).toHaveLength(20);
  });

  it("finishBranchCleanup の後は選ばない（done = 1）", async () => {
    const d = dir();
    await put(d, snap("A"));
    await put(d, snap("B"));
    expect([...(await d.claimBranchCleanup(NOW))].sort()).toEqual(["A", "B"]);
    await d.finishBranchCleanup("A");
    expect(await d.claimBranchCleanup(NOW + 60 * MIN)).toEqual(["B"]);
    // 索引が更新されても done は戻らない
    await put(d, snap("A", { updated_at: NOW }), 2);
    expect(await d.claimBranchCleanup(NOW + 120 * MIN)).toEqual(["B"]);
    const rows = await cleanupRows(d);
    expect(rows.find((r) => r.task_id === "A")?.done).toBe(1);
  });

  it("終わってから 30 日を過ぎた行は選ばず、表から消す", async () => {
    const d = dir();
    await put(d, snap("A", { ended_at: NOW - DAY }));
    await put(d, snap("B", { ended_at: NOW - 10 * DAY }));
    expect([...(await d.claimBranchCleanup(NOW))].sort()).toEqual(["A", "B"]);
    // B は 30 日を過ぎた。A はまだ 30 日以内
    const later = NOW + 25 * DAY;
    expect(await d.claimBranchCleanup(later)).toEqual(["A"]);
    expect((await cleanupRows(d)).map((r) => r.task_id)).toEqual(["A"]);
    // 両方とも過ぎた
    expect(await d.claimBranchCleanup(NOW + 40 * DAY)).toEqual([]);
    expect(await cleanupRows(d)).toEqual([]);
  });
});
