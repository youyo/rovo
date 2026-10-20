import { beforeEach, describe, expect, it } from "vitest";
import {
  addMember,
  admin,
  auditRecords,
  bodyOf,
  completedResult,
  finishAgent,
  installApp,
  login,
  newUser,
  pullOf,
  startArgs,
  waitForAudit,
  waitForResult,
} from "./helpers";

// PR のレビュー後の Ready 化とマージ（D9）を、実 Worker（wrangler dev）と偽 GitHub で通しで確かめる。
// Ready 化とマージは利用者の GitHub トークン（偽 GitHub が OAuth で発行した ghu_）で行われる。

beforeEach(async () => {
  await admin.reset();
});

async function setup(mergePolicy?: "agent_merge" | "human_review") {
  const user = newUser("pr");
  await addMember(user);
  await installApp();
  const client = await login(user);
  const started = bodyOf(
    await client.callTool({
      name: "task_start",
      arguments: startArgs("pr-task", mergePolicy ? { merge_policy: mergePolicy } : {}),
    }),
  );
  const taskId = started.task_id as string;
  // 子エージェントが start を受理して RUNNING になってから終端にする（受理前に終端にすると順序が変わる）
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
  const head = await admin.app<string | null>("branch", "acme/widgets", branch);
  if (!head) throw new Error("作業ブランチがありません");
  return { user, client, taskId, branch, head };
}

async function complete(
  t: { taskId: string; head: string },
  client: Awaited<ReturnType<typeof setup>>["client"],
) {
  await finishAgent(t.taskId, "completed", completedResult(t.head));
  return waitForResult(client, t.taskId);
}

// 終端の処理（停止確認・PR 本文の更新）は TaskDO の alarm（10 秒間隔）で進むので、COMPLETED を作る 1 回に 10〜20 秒かかる。
// タスクを作る回数を減らすため、1 つのタスクで続きのシナリオをまとめて確かめる。
const LONG = 120_000;

describe("task_pr_ready / task_pr_merge（偽 GitHub 経由の通し）", () => {
  it(
    "human_review: task_pr_ready で Ready になり（冪等）、task_result の next_steps と pr.draft が変わる。task_pr_merge は forbidden",
    async () => {
      const t = await setup("human_review");
      try {
        const before = await complete(t, t.client);
        expect(before).toMatchObject({
          status: "COMPLETED",
          merge_policy: "human_review",
          pr: { draft: true, merged: false, head_sha: t.head, head_matches_verified: true },
        });
        expect(String(before.next_steps)).toContain("task_pr_ready");
        expect((await pullOf(t.branch))?.draft).toBe(true);

        const ready = bodyOf(
          await t.client.callTool({ name: "task_pr_ready", arguments: { task_id: t.taskId } }),
        );
        expect(ready).toMatchObject({
          task_id: t.taskId,
          draft: false,
          changed: true,
          merge_policy: "human_review",
        });
        expect((await pullOf(t.branch))?.draft).toBe(false);
        const again = bodyOf(
          await t.client.callTool({ name: "task_pr_ready", arguments: { task_id: t.taskId } }),
        );
        expect(again).toMatchObject({ draft: false, changed: false });

        const after = bodyOf(
          await t.client.callTool({ name: "task_result", arguments: { task_id: t.taskId } }),
        );
        expect(after).toMatchObject({ pr: { draft: false } });
        expect(String(after.next_steps)).toContain("人のレビューを待つ");

        // human_review のタスクでは task_pr_merge を拒否する。GitHub は変わらない
        const merge = await t.client.callTool({
          name: "task_pr_merge",
          arguments: { task_id: t.taskId },
        });
        expect(merge.isError).toBe(true);
        expect(bodyOf(merge).code).toBe("forbidden");
        expect(await pullOf(t.branch)).toMatchObject({ draft: false, merged: false });

        // 監査: pr_ready は 1 回だけ（冪等な 2 回目は出さない）。拒否は pr_denied
        const records = await auditRecords(t.taskId);
        const ev = records.filter((r) => r.event === "pr_ready");
        expect(ev).toHaveLength(1);
        expect(ev[0]).toMatchObject({
          taskId: t.taskId,
          userId: t.user.id,
          merge_policy: "human_review",
        });
        expect(records.filter((r) => r.event === "pr_denied").at(-1)).toMatchObject({
          kind: "merge",
          reason: "policy_human_review",
          merge_policy: "human_review",
          userId: t.user.id,
        });

        // 利用者のトークンで呼ばれている（偽 GitHub の User API 経由。Installation Token ではない）
        const gh = await admin.app<{ method: string; path: string; auth: string }[]>("requests");
        const userCalls = gh.filter((r) => r.auth === "user").map((r) => `${r.method} ${r.path}`);
        expect(userCalls).toContain("POST /graphql");
        expect(userCalls.some((c) => c.startsWith("PUT "))).toBe(false);
      } finally {
        await t.client.close();
      }
    },
    LONG,
  );

  it(
    "agent_merge: Draft のマージは拒否 → ready → ブランチ保護の拒否（merge_blocked）→ 解除 → ブランチが動いたら head_moved → 戻すとマージできる（検証済みの sha を渡す。delete_branch で作業ブランチも消える）",
    async () => {
      const t = await setup("agent_merge");
      try {
        await complete(t, t.client);
        const call = (name: string, args: Record<string, unknown> = {}) =>
          t.client.callTool({ name, arguments: { task_id: t.taskId, ...args } });

        // Draft のままのマージは、先に task_pr_ready を促されて拒否される
        const early = await call("task_pr_merge");
        expect(early.isError).toBe(true);
        expect(bodyOf(early)).toMatchObject({
          code: "conflict",
          message: expect.stringContaining("task_pr_ready"),
        });
        expect((await pullOf(t.branch))?.merged).toBe(false);

        await call("task_pr_ready");
        const readyResult = bodyOf(await call("task_result"));
        expect(String(readyResult.next_steps)).toContain("task_pr_merge でマージ");

        // ブランチ保護（必須レビュー）の拒否: GitHub の理由がコード付きで返る
        await admin.app(
          "setMergeBlock",
          "acme/widgets",
          "At least 1 approving review is required by reviewers with write access.",
        );
        const blocked = await call("task_pr_merge");
        expect(blocked.isError).toBe(true);
        expect(bodyOf(blocked)).toMatchObject({
          code: "merge_blocked",
          message: expect.stringContaining("At least 1 approving review is required"),
        });
        expect((await pullOf(t.branch))?.merged).toBe(false);
        await waitForAudit((x) => x.event === "pr_denied" && x.reason === "merge_blocked", {
          taskId: t.taskId,
        });
        await admin.app("setMergeBlock", "acme/widgets", null);

        // 検証のあとにブランチが動いた: マージしない
        const moved = await admin.app<string>(
          "addCommit",
          "acme/widgets",
          t.head,
          "pushed by someone",
        );
        await admin.app("setBranch", "acme/widgets", t.branch, moved);
        const headMoved = await call("task_pr_merge");
        expect(headMoved.isError).toBe(true);
        expect(bodyOf(headMoved).code).toBe("head_moved");
        expect((await pullOf(t.branch))?.merged).toBe(false);
        await admin.app("setBranch", "acme/widgets", t.branch, t.head);

        // 通る
        const merged = bodyOf(
          await call("task_pr_merge", { merge_method: "squash", delete_branch: true }),
        );
        expect(merged).toMatchObject({
          merged: true,
          already_merged: false,
          merge_method: "squash",
          merge_sha: t.head,
          branch_deleted: true,
          merge_policy: "agent_merge",
        });
        expect(await pullOf(t.branch)).toMatchObject({
          merged: true,
          state: "closed",
          mergeMethod: "squash",
          mergeSha: t.head,
        });
        expect(await admin.app<string | null>("branch", "acme/widgets", t.branch)).toBeNull();

        const result = bodyOf(await call("task_result"));
        expect(result).toMatchObject({ pr: { merged: true, draft: false } });
        expect(String(result.next_steps)).toContain("マージ済み");
        // 冪等
        expect(bodyOf(await call("task_pr_merge"))).toMatchObject({ already_merged: true });

        const records = await auditRecords(t.taskId);
        const merges = records.filter((r) => r.event === "pr_merged");
        expect(merges).toHaveLength(1);
        expect(merges[0]).toMatchObject({
          taskId: t.taskId,
          userId: t.user.id,
          merge_policy: "agent_merge",
        });
        expect(records.filter((r) => r.event === "pr_denied").map((r) => r.reason)).toEqual(
          expect.arrayContaining(["pr_draft", "merge_blocked", "head_moved"]),
        );
        // マージの PUT は 1 回だけ、検証済みの sha 付き
        const puts = (
          await admin.app<{ method: string; path: string; body: { sha?: string } }[]>("requests")
        ).filter((r) => r.method === "PUT");
        expect(puts.filter((p) => p.path.endsWith("/merge")).at(-1)?.body.sha).toBe(t.head);
      } finally {
        await t.client.close();
      }
    },
    LONG,
  );

  it(
    "FAILED のタスクは task_pr_ready を拒否する（conflict）。PR は Draft のまま。他の利用者は not_found",
    async () => {
      const t = await setup("agent_merge");
      const other = newUser("other");
      await addMember(other);
      const otherClient = await login(other);
      try {
        await finishAgent(t.taskId, "failed");
        await waitForResult(t.client, t.taskId, { needHead: false });
        const r = await t.client.callTool({
          name: "task_pr_ready",
          arguments: { task_id: t.taskId },
        });
        expect(r.isError).toBe(true);
        expect(bodyOf(r).code).toBe("conflict");
        expect((await pullOf(t.branch))?.draft).toBe(true);
        const denied = (await auditRecords(t.taskId)).filter((x) => x.event === "pr_denied");
        expect(denied[0]).toMatchObject({ reason: "not_completed", kind: "ready" });
        const result = bodyOf(
          await t.client.callTool({ name: "task_result", arguments: { task_id: t.taskId } }),
        );
        expect(String(result.next_steps)).toContain("task_pr_ready / task_pr_merge は使えない");

        for (const name of ["task_pr_ready", "task_pr_merge"]) {
          const o = await otherClient.callTool({ name, arguments: { task_id: t.taskId } });
          expect(o.isError).toBe(true);
          expect(bodyOf(o).code).toBe("not_found");
        }
        expect((await pullOf(t.branch))?.merged).toBe(false);
      } finally {
        await otherClient.close();
        await t.client.close();
      }
    },
    LONG,
  );

  it("実行中のタスクは not_ready", async () => {
    const t = await setup();
    try {
      const r = await t.client.callTool({
        name: "task_pr_ready",
        arguments: { task_id: t.taskId },
      });
      expect(r.isError).toBe(true);
      expect(bodyOf(r).code).toBe("not_ready");
    } finally {
      await t.client.close();
    }
  });

  it("MCP の initialize の応答に instructions がある", async () => {
    const user = newUser("ins");
    await addMember(user);
    await installApp();
    const client = await login(user);
    try {
      const text = client.getInstructions() ?? "";
      expect(text).toContain("task_pr_ready");
      expect(text).toContain("merge_policy");
    } finally {
      await client.close();
    }
  });
});
