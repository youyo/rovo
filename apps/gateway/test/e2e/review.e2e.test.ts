import { beforeEach, describe, expect, it } from "vitest";
import {
  addMember,
  admin,
  auditRecords,
  bodyOf,
  finishAgent,
  installApp,
  login,
  newUser,
  waitForResult,
} from "./helpers";

// task_review（クライアントの PR のレビューだけを頼む）を、実 Worker（wrangler dev）と偽 GitHub・偽のワーカーで通しで確かめる。
// 本物のレビューの段（Sandbox で review_commands を流し、モデルを呼ぶ）は、Docker を使う通しの E2E（test/full）が確かめる。

const REPO = "acme/widgets";
const BASE = "0123456789abcdef0123456789abcdef01234567";
const DIFF =
  "diff --git a/src/sum.ts b/src/sum.ts\n--- a/src/sum.ts\n+++ b/src/sum.ts\n@@ -1 +1 @@\n-a - b\n+a + b\n";

beforeEach(async () => {
  await admin.reset();
});

async function clientPull(opts: { fork?: boolean } = {}) {
  const head = await admin.app<string>("addCommit", REPO, BASE, "client work");
  await admin.app("setBranch", REPO, "main", BASE);
  if (!opts.fork) await admin.app("setBranch", REPO, "feature/sum", head);
  const number = await admin.app<number>("seedPull", REPO, {
    head: "feature/sum",
    base: "main",
    title: "Fix sum",
    body: "Please review",
    draft: false,
    ...(opts.fork ? { headRepo: "mallory/widgets", headSha: head } : {}),
  });
  await admin.app("seedDiff", REPO, BASE, head, DIFF);
  return { head, number };
}

const REVIEW_BODY =
  "## rovo のレビュー（anthropic/claude-sonnet-5-5、aaaaaaa）\n\n### 直すべき点（1 件）";

function reviewedResult(head: string) {
  return {
    status: "completed",
    summary: "",
    verification: { commands: [], results: [], verified: false, attempts: 0 },
    warnings: [],
    patchTooLarge: false,
    usage: {
      costUsd: 0.03,
      inputTokens: 900,
      outputTokens: 120,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      web: { search: 0, fetch: 0, browse: 0 },
    },
    review: {
      stage: "done",
      model: "anthropic/claude-sonnet-5-5",
      headSha: head,
      body: REVIEW_BODY,
      mustFixCount: 1,
      suggestionCount: 3,
      commands: [{ argv: ["pnpm", "test"], exitCode: 1, timedOut: false, output: "1 failed" }],
      commandsUnavailable: false,
      usage: {
        costUsd: 0.03,
        inputTokens: 900,
        outputTokens: 120,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        estimated: false,
      },
    },
  };
}

describe("task_review（偽 GitHub 経由の通し）", () => {
  it("PR の head を固定してレビューを頼み、PR に COMMENT のレビューが 1 件だけ付く。PR の状態とブランチは変わらず、rovo のブランチ・PR も作らない", async () => {
    const user = newUser("review");
    await addMember(user);
    await installApp();
    const pr = await clientPull();
    const client = await login(user);
    try {
      const started = bodyOf(
        await client.callTool({
          name: "task_review",
          arguments: {
            repository: REPO,
            pull_number: pr.number,
            review_model: "anthropic/claude-sonnet-5-5",
            review_commands: [{ argv: ["pnpm", "test"] }],
          },
        }),
      );
      expect(started).toMatchObject({
        kind: "review",
        target_pr: { repository: REPO, number: pr.number, head_sha: pr.head },
      });
      const taskId = started.task_id as string;
      const deadline = Date.now() + 30_000;
      for (;;) {
        const st = bodyOf(
          await client.callTool({ name: "task_status", arguments: { task_id: taskId } }),
        );
        if (st.status === "RUNNING") {
          expect(st).toMatchObject({ kind: "review", review: { stage: "waiting" } });
          break;
        }
        if (Date.now() > deadline)
          throw new Error(`RUNNING になりませんでした: ${JSON.stringify(st)}`);
        await new Promise((r) => setTimeout(r, 200));
      }

      await finishAgent(taskId, "completed", reviewedResult(pr.head));
      const deadline2 = Date.now() + 90_000;
      let result: Record<string, unknown>;
      for (;;) {
        result = await waitForResult(client, taskId);
        const rv = result.review as { comment_url: string | null } | undefined;
        if (rv?.comment_url) break;
        if (Date.now() > deadline2)
          throw new Error(`投稿されませんでした: ${JSON.stringify(result)}`);
        await new Promise((r) => setTimeout(r, 500));
      }
      expect(result).toMatchObject({
        status: "COMPLETED",
        kind: "review",
        target_pr: { number: pr.number, head_sha: pr.head },
        review: { stage: "done", must_fix_count: 1, suggestion_count: 3, fix_applied: false },
      });
      for (const k of ["summary", "patch", "pr"]) expect(result).not.toHaveProperty(k);

      // PR に COMMENT のレビューが 1 件（APPROVE / REQUEST_CHANGES は送らない）。commit_id は固定した head
      const reviews = await admin.app<{ event: string; commitId: string; body: string }[]>(
        "reviews",
        REPO,
        pr.number,
      );
      expect(reviews).toEqual([
        expect.objectContaining({ event: "COMMENT", commitId: pr.head, body: REVIEW_BODY }),
      ]);
      // PR の状態・本文・ブランチは変わらない。rovo のブランチ・PR・コミットは作らない
      const pulls = await admin.app<
        { number: number; draft: boolean; state: string; body: string }[]
      >("pulls", REPO);
      expect(pulls).toHaveLength(1);
      expect(pulls[0]).toMatchObject({ draft: false, state: "open", body: "Please review" });
      expect(await admin.app("branch", REPO, "feature/sum")).toBe(pr.head);
      expect(await admin.app("branch", REPO, `agent/task-${taskId}`)).toBeNull();
      const reqs = await admin.app<{ method: string; path: string }[]>("requests");
      const writes = reqs.filter((r) => r.method !== "GET").map((r) => `${r.method} ${r.path}`);
      expect(writes.filter((w) => w.includes("/repos/"))).toEqual([
        `POST /repos/${REPO}/pulls/${pr.number}/reviews`,
      ]);

      // 頼み直しても同じタスク（二重に投稿しない）
      const again = bodyOf(
        await client.callTool({
          name: "task_review",
          arguments: {
            repository: REPO,
            pull_number: pr.number,
            review_model: "anthropic/claude-sonnet-5-5",
            review_commands: [{ argv: ["pnpm", "test"] }],
          },
        }),
      );
      expect(again.task_id).toBe(taskId);
      expect(await admin.app("reviews", REPO, pr.number)).toHaveLength(1);

      // 監査: モデル・件数だけ（本文は出ない）
      const audit = await auditRecords(taskId);
      expect(audit.find((r) => r.event === "review_posted")).toMatchObject({
        model: "anthropic/claude-sonnet-5-5",
        must_fix_count: 1,
        suggestion_count: 3,
      });
      expect(JSON.stringify(audit)).not.toContain("直すべき点");
    } finally {
      await client.close();
    }
  }, 120_000);

  it("fork の PR は invalid_input（fork_not_supported）で、タスクを作らない", async () => {
    const user = newUser("review-fork");
    await addMember(user);
    await installApp();
    const pr = await clientPull({ fork: true });
    const client = await login(user);
    try {
      const r = await client.callTool({
        name: "task_review",
        arguments: {
          repository: REPO,
          pull_number: pr.number,
          review_model: "anthropic/claude-sonnet-5-5",
        },
      });
      expect(r.isError).toBe(true);
      expect(bodyOf(r)).toMatchObject({ code: "invalid_input" });
      expect(String(bodyOf(r).message)).toMatch(/^fork_not_supported/);
      expect(await admin.app("reviews", REPO, pr.number)).toEqual([]);
    } finally {
      await client.close();
    }
  });
});
