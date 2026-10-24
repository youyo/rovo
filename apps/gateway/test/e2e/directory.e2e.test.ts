import { beforeEach, describe, expect, it } from "vitest";
import {
  addMember,
  admin,
  bodyOf,
  completedResult,
  directoryRow,
  finishAgent,
  installApp,
  login,
  newUser,
  startArgs,
  waitForResult,
} from "./helpers";

// ダッシュボードの索引（DirectoryDO。docs/specs/dashboard.md M3a）を、実 Worker（wrangler dev）で通しで確かめる。
// TaskDO の outbox は alarm（10 秒間隔）で配送するので、行が出るまで待つ。

beforeEach(async () => {
  await admin.reset();
});

async function waitForRow(
  taskId: string,
  until: (row: Record<string, unknown>) => boolean,
  timeoutMs = 60_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  let last: Record<string, unknown> | null = null;
  while (Date.now() < deadline) {
    last = await directoryRow(taskId);
    if (last && until(last)) return last;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`索引の行が条件を満たしませんでした: ${JSON.stringify(last)}`);
}

async function start(prefix: string, title: string) {
  const user = newUser(prefix);
  await addMember(user);
  await installApp();
  const client = await login(user);
  const { task_id: taskId } = bodyOf(
    await client.callTool({ name: "task_start", arguments: startArgs(title) }),
  ) as { task_id: string };
  // ワーカーが start を受理して RUNNING になるまで待つ
  const deadline = Date.now() + 30_000;
  for (;;) {
    const st = bodyOf(
      await client.callTool({ name: "task_status", arguments: { task_id: taskId } }),
    );
    if (st.status === "RUNNING") break;
    if (Date.now() > deadline) throw new Error(`RUNNING になりませんでした: ${JSON.stringify(st)}`);
    await new Promise((r) => setTimeout(r, 200));
  }
  return { user, client, taskId };
}

describe("索引（DirectoryDO）への配送（実 DO）", () => {
  it("実行中のタスクの行が出る（repository_id と PR を含み、入力は含まない）。キャンセルで終端の行に収束する", async () => {
    const { user, client, taskId } = await start("idx-run", "INDEX-RUNNING");
    try {
      const running = await waitForRow(
        taskId,
        (r) => r.status === "RUNNING" && r.pr_number != null,
      );
      expect(running).toMatchObject({
        task_id: taskId,
        owner_login: user.login,
        repository: "acme/widgets",
        repository_id: 4242,
        title: "INDEX-RUNNING",
        ended_at: null,
        pr_merged: false,
        pr_draft: true,
      });
      expect(String(running.pr_url)).toContain("/pull/");
      expect(running.started_at).not.toBeNull();
      // 索引は入力（instructions など）を持たない
      expect(Object.keys(running)).not.toContain("instructions");

      expect(
        bodyOf(await client.callTool({ name: "task_cancel", arguments: { task_id: taskId } })),
      ).toEqual({ task_id: taskId, status: "CANCELLED" });
      const done = await waitForRow(taskId, (r) => r.status === "CANCELLED");
      expect(done.ended_at).not.toBeNull();
      expect(Number(done.revision)).toBeGreaterThan(Number(running.revision));
    } finally {
      await client.close();
    }
  }, 120_000);

  it("完了したタスクは最終の状態の行になる。task_status / task_result は索引と無関係に通常どおり動く", async () => {
    const { client, taskId } = await start("idx-done", "INDEX-DONE");
    try {
      // 偽のワーカーは、待たせずにすぐ終端にする（長く待つと状態が失われる）
      const head = await admin.app<string | null>("branch", "acme/widgets", `agent/task-${taskId}`);
      if (!head) throw new Error("作業ブランチがありません");
      await finishAgent(taskId, "completed", completedResult(head));
      const result = await waitForResult(client, taskId);
      expect(result.status).toBe("COMPLETED");

      const done = await waitForRow(taskId, (r) => r.status === "COMPLETED");
      expect(done).toMatchObject({ task_id: taskId, repository_id: 4242, pr_merged: false });
      expect(done.ended_at).not.toBeNull();
      expect(done.started_at).not.toBeNull();
      const status = bodyOf(
        await client.callTool({ name: "task_status", arguments: { task_id: taskId } }),
      );
      expect(status.status).toBe("COMPLETED");
    } finally {
      await client.close();
    }
  }, 180_000);
});
