import { beforeEach, describe, expect, it } from "vitest";
import {
  addMember,
  admin,
  auditRecords,
  baseUrl,
  bodyOf,
  completedResult,
  directoryRow,
  finishAgent,
  installApp,
  login,
  newUser,
  pullOf,
  startArgs,
  waitForResult,
} from "./helpers";

// 作業ブランチの掃除（issue #185）を、実 Worker（wrangler dev）と偽 GitHub で通しで確かめる。
// Cron（scheduled）は E2E から起動できないので、同じ sweep を呼ぶテスト専用のルート /__test/branch-cleanup/sweep を使う。

beforeEach(async () => {
  await admin.reset();
});

const LONG = 120_000;

/** COMPLETED のタスク（ワーカーの commit を積んだ PR つき）を作り、索引に終端と PR が載るまで待つ */
async function completedTask() {
  const user = newUser("cleanup");
  await addMember(user);
  await installApp();
  const client = await login(user);
  const started = bodyOf(
    await client.callTool({ name: "task_start", arguments: startArgs("cleanup-task") }),
  );
  const taskId = started.task_id as string;
  const deadline = Date.now() + 30_000;
  for (;;) {
    const st = bodyOf(
      await client.callTool({ name: "task_status", arguments: { task_id: taskId } }),
    );
    if (st.status === "RUNNING") break;
    if (Date.now() > deadline) throw new Error(`RUNNING になりませんでした: ${JSON.stringify(st)}`);
    await new Promise((r) => setTimeout(r, 200));
  }
  const branch = `agent/task-${taskId}`;
  const initial = await admin.app<string | null>("branch", "acme/widgets", branch);
  if (!initial) throw new Error("作業ブランチがありません");
  const head = await admin.app<string>("addCommit", "acme/widgets", initial, "child commit");
  await admin.app("setBranch", "acme/widgets", branch, head);
  await finishAgent(taskId, "completed", completedResult(head));
  const result = await waitForResult(client, taskId);
  expect(result).toMatchObject({
    status: "COMPLETED",
    pr: { merged: false, head_sha: head, head_matches_verified: true },
  });
  // 索引（DirectoryDO）に終端（ended_at）と PR が載るまで待つ（候補は索引から選ぶ）
  const indexDeadline = Date.now() + 60_000;
  for (;;) {
    const row = await directoryRow(taskId);
    if (row && row.ended_at !== null && row.pr_number !== null) break;
    if (Date.now() > indexDeadline)
      throw new Error(`索引に載りませんでした: ${JSON.stringify(row)}`);
    await new Promise((r) => setTimeout(r, 300));
  }
  const pull = await pullOf(branch);
  if (!pull) throw new Error("PR がありません");
  return { user, client, taskId, branch, head, pr: pull.number };
}

type SweepResult = {
  claimed: number;
  checked: number;
  deleted: number;
  done: number;
  errors: number;
  stopped_by_rate_limit: boolean;
};

/**
 * 掃除の 1 回分（Cron と同じ sweep）を、候補が尽きるまで繰り返す。前のテストのタスクも索引に残っているので、
 * 1 回の上限（20 件）で今回のタスクが漏れないようにする（同じタスクは 50 分空くので、繰り返しても 2 度は選ばれない）。
 */
async function sweepAll(): Promise<SweepResult[]> {
  const results: SweepResult[] = [];
  for (let i = 0; i < 50; i++) {
    const res = await fetch(`${baseUrl}/__test/branch-cleanup/sweep`, { method: "POST" });
    if (!res.ok) throw new Error(`/__test/branch-cleanup/sweep failed: ${res.status}`);
    const r = (await res.json()) as SweepResult;
    results.push(r);
    if (r.claimed === 0) return results;
  }
  throw new Error("候補が尽きませんでした");
}

const cleanupAudits = async (taskId: string) =>
  (await auditRecords(taskId)).filter((r) => r.event === "branch_cleanup");

describe("作業ブランチの掃除（Cron の sweep。偽 GitHub 経由の通し）", () => {
  it(
    "rovo の外でマージされた PR: sweep でブランチが消え、task_result の pr.branch_deleted が true、監査に branch_cleanup（deleted）",
    async () => {
      const t = await completedTask();
      try {
        // GitHub の UI などでマージされた（rovo の task_pr_merge を通らない）
        await admin.app("markMerged", "acme/widgets", t.pr);
        expect(await admin.app<string | null>("branch", "acme/widgets", t.branch)).toBe(t.head);

        await sweepAll();
        expect(await admin.app<string | null>("branch", "acme/widgets", t.branch)).toBeNull();
        // 消したのは Installation Token（利用者のトークンではない）。消す前の先頭を確かめている
        const deletes = (
          await admin.app<{ method: string; path: string; auth: string }[]>("requests")
        ).filter((r) => r.method === "DELETE" && r.path.endsWith(`/git/refs/heads/${t.branch}`));
        expect(deletes.map((r) => r.auth)).toEqual(["token"]);

        const result = bodyOf(
          await t.client.callTool({ name: "task_result", arguments: { task_id: t.taskId } }),
        );
        expect(result).toMatchObject({ pr: { branch_deleted: true } });
        const status = bodyOf(
          await t.client.callTool({ name: "task_status", arguments: { task_id: t.taskId } }),
        );
        expect(status).toMatchObject({ pr: { branch_deleted: true } });

        const audits = await cleanupAudits(t.taskId);
        expect(audits).toHaveLength(1);
        expect(audits[0]).toMatchObject({ taskId: t.taskId, reason: "deleted", done: true });
        // 監査にブランチ名・PR の URL は出さない
        expect(JSON.stringify(audits)).not.toContain(t.branch);

        // done のタスクは次の回に選ばれない（監査も増えない）
        await sweepAll();
        expect(await cleanupAudits(t.taskId)).toHaveLength(1);
      } finally {
        await t.client.close();
      }
    },
    LONG,
  );

  it(
    "そのブランチを base にした open な PR がある: sweep してもブランチは残る（branch_cleanup の reason は base_of_open_pr）",
    async () => {
      const t = await completedTask();
      try {
        await admin.app("markMerged", "acme/widgets", t.pr);
        // 誰かが作業ブランチの上に積んだ PR（消すと GitHub がこの PR を閉じてしまう）
        const stacked = await admin.app<string>("addCommit", "acme/widgets", t.head, "stacked");
        await admin.app("setBranch", "acme/widgets", "feature/stacked", stacked);
        await admin.app("seedPull", "acme/widgets", {
          head: "feature/stacked",
          base: t.branch,
          draft: false,
        });

        await sweepAll();
        expect(await admin.app<string | null>("branch", "acme/widgets", t.branch)).toBe(t.head);
        const audits = await cleanupAudits(t.taskId);
        expect(audits).toHaveLength(1);
        expect(audits[0]).toMatchObject({ reason: "base_of_open_pr", done: false });
        const result = bodyOf(
          await t.client.callTool({ name: "task_result", arguments: { task_id: t.taskId } }),
        );
        expect((result.pr as Record<string, unknown>).branch_deleted).not.toBe(true);
      } finally {
        await t.client.close();
      }
    },
    LONG,
  );
});
