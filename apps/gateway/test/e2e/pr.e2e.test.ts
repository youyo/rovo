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

// 完了時の自動の Ready 化と、クライアントによるマージ（D9）を、実 Worker（wrangler dev）と偽 GitHub で通しで確かめる。
// 自動の Ready は GitHub App の Installation Token（ghs_）、task_pr_ready とマージは利用者の GitHub トークン（偽 GitHub が OAuth で発行した ghu_）で行われる。

beforeEach(async () => {
  await admin.reset();
});

// childCommit: 子が commit を push した状態にする（既定 true）。変更の無いまま終わると rovo が空の Draft PR を閉じるので、
// Ready・マージの流れを確かめるテストは、作業ブランチに子の commit を積んでから終端にする。
async function setup(childCommit = true, extra: Record<string, unknown> = {}) {
  const user = newUser("pr");
  await addMember(user);
  await installApp();
  const client = await login(user);
  const started = bodyOf(
    await client.callTool({
      name: "task_start",
      arguments: startArgs("pr-task", extra),
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
  const initial = await admin.app<string | null>("branch", "acme/widgets", branch);
  if (!initial) throw new Error("作業ブランチがありません");
  let head = initial;
  if (childCommit) {
    head = await admin.app<string>("addCommit", "acme/widgets", initial, "child commit");
    await admin.app("setBranch", "acme/widgets", branch, head);
  }
  return { user, client, taskId, branch, head, initial };
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
    "client_review（既定）: 完了で rovo が自動で Ready にする（Installation Token）→ task_pr_ready は冪等 → check の失敗・実行中は merge_blocked → ブランチ保護の拒否 → head_moved → 通ればマージ（検証済みの sha。delete_branch で作業ブランチも消える）",
    async () => {
      const t = await setup();
      try {
        const before = await complete(t, t.client);
        expect(before).toMatchObject({
          status: "COMPLETED",
          review_policy: "client_review",
          pr: { draft: false, merged: false, head_sha: t.head, head_matches_verified: true },
        });
        // 新しいフロー: task_pr_ready を呼ばずに Ready。次の一手は手元の全体のテストとレビュー → マージ
        expect((await pullOf(t.branch))?.draft).toBe(false);
        expect(String(before.next_steps)).toContain("全体のテスト");
        expect(String(before.next_steps)).toContain("task_pr_merge でマージ");
        expect(String(before.next_steps)).not.toContain("task_pr_ready で Ready にする");

        // 自動の Ready は Installation Token の GraphQL（利用者のトークンではない）。監査は caller: system
        const gh1 = await admin.app<{ method: string; path: string; auth: string }[]>("requests");
        const graphql = gh1.filter((r) => r.path === "/graphql");
        expect(graphql.map((r) => r.auth)).toEqual(["token"]);
        const auto = (await auditRecords(t.taskId)).filter((r) => r.event === "pr_ready");
        expect(auto).toHaveLength(1);
        expect(auto[0]).toMatchObject({
          taskId: t.taskId,
          caller: "system",
          reason: "auto_ready",
          review_policy: "client_review",
        });

        const call = (name: string, args: Record<string, unknown> = {}) =>
          t.client.callTool({ name, arguments: { task_id: t.taskId, ...args } });

        // task_pr_ready は残してある（冪等）。すでに Ready なので changed: false、監査も増えない
        expect(bodyOf(await call("task_pr_ready"))).toMatchObject({
          draft: false,
          changed: false,
          review_policy: "client_review",
        });
        expect((await auditRecords(t.taskId)).filter((r) => r.event === "pr_ready")).toHaveLength(
          1,
        );

        // PR の head に付いた GitHub の check: 失敗は checks_failing、実行中は checks_pending で拒否する
        await admin.app("setCheckRuns", "acme/widgets", t.head, [
          { name: "ci", status: "completed", conclusion: "failure" },
        ]);
        const failing = await call("task_pr_merge");
        expect(failing.isError).toBe(true);
        expect(bodyOf(failing)).toMatchObject({
          code: "merge_blocked",
          message: expect.stringContaining("checks_failing"),
        });
        await admin.app("setCheckRuns", "acme/widgets", t.head, [
          { name: "ci", status: "in_progress" },
        ]);
        const pending = await call("task_pr_merge");
        expect(bodyOf(pending)).toMatchObject({
          code: "merge_blocked",
          message: expect.stringContaining("checks_pending"),
        });
        await admin.app("setCheckRuns", "acme/widgets", t.head, []);
        await admin.app("setCommitStatuses", "acme/widgets", t.head, [
          { context: "legacy", state: "failure" },
        ]);
        expect(bodyOf(await call("task_pr_merge"))).toMatchObject({
          code: "merge_blocked",
          message: expect.stringContaining("checks_failing"),
        });
        expect((await pullOf(t.branch))?.merged).toBe(false);
        // check が成功すれば進める
        await admin.app("setCommitStatuses", "acme/widgets", t.head, [
          { context: "legacy", state: "success" },
        ]);
        await admin.app("setCheckRuns", "acme/widgets", t.head, [
          { name: "ci", status: "completed", conclusion: "success" },
        ]);

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

        // 検証のあとにブランチが動いた（クライアントが修正を積んだ）: task_pr_merge は使えない。直接マージする
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
          review_policy: "client_review",
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
          review_policy: "client_review",
        });
        expect(records.filter((r) => r.event === "pr_denied").map((r) => r.reason)).toEqual(
          expect.arrayContaining([
            "checks_failing",
            "checks_pending",
            "merge_blocked",
            "head_moved",
          ]),
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
    "自動の Ready が失敗しても COMPLETED のまま Draft: next_steps が task_pr_ready を促す → task_pr_ready は利用者のトークンで Ready にする → task_pr_merge で通る。check が無ければ通る",
    async () => {
      // 完了時の 1 回目の GraphQL（Installation Token の自動の Ready）だけ失敗させる
      await admin.app("setFault", { pattern: "^POST /graphql$", status: 502, count: 1 });
      const t = await setup();
      try {
        const before = await complete(t, t.client);
        expect(before).toMatchObject({ status: "COMPLETED", pr: { draft: true } });
        expect(before.warnings).toEqual([]);
        expect(String(before.next_steps)).toContain("task_pr_ready で Ready にする");
        expect((await pullOf(t.branch))?.draft).toBe(true);
        // Draft のままのマージは、先に task_pr_ready を促されて拒否される
        const early = await t.client.callTool({
          name: "task_pr_merge",
          arguments: { task_id: t.taskId },
        });
        expect(early.isError).toBe(true);
        expect(bodyOf(early)).toMatchObject({
          code: "conflict",
          message: expect.stringContaining("task_pr_ready"),
        });

        const ready = bodyOf(
          await t.client.callTool({ name: "task_pr_ready", arguments: { task_id: t.taskId } }),
        );
        expect(ready).toMatchObject({ draft: false, changed: true });
        expect((await pullOf(t.branch))?.draft).toBe(false);
        // 手動の Ready は利用者のトークン
        const gh = await admin.app<{ method: string; path: string; auth: string }[]>("requests");
        const userCalls = gh.filter((r) => r.auth === "user").map((r) => `${r.method} ${r.path}`);
        expect(userCalls).toContain("POST /graphql");
        const pr = (await auditRecords(t.taskId)).filter((r) => r.event === "pr_ready");
        expect(pr).toHaveLength(1);
        expect(pr[0]).toMatchObject({ caller: "parent", userId: t.user.id });

        // check は 1 つも付いていない: 通る
        const merged = bodyOf(
          await t.client.callTool({ name: "task_pr_merge", arguments: { task_id: t.taskId } }),
        );
        expect(merged).toMatchObject({ merged: true, merge_sha: t.head });
      } finally {
        await t.client.close();
      }
    },
    LONG,
  );

  it(
    "FAILED のタスクは task_pr_ready を拒否する（conflict）。rovo は Ready にしない（PR は Draft のまま）。他の利用者は not_found",
    async () => {
      const t = await setup();
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
        // 自動の Ready も呼ばれていない（FAILED では Draft のまま）
        expect(
          (await admin.app<{ path: string }[]>("requests")).filter((x) => x.path === "/graphql"),
        ).toEqual([]);
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

  it(
    "変更の無いまま COMPLETED: 空の Draft PR が閉じられ、作業ブランチが消え、task_result の pr.closed_empty が true。task_pr_ready / task_pr_merge は conflict",
    async () => {
      const t = await setup(false);
      try {
        // Sandbox を起動せず終わる COMPLETED（子の commit も pushedSha も無い）
        await finishAgent(t.taskId, "completed", {
          ...completedResult(t.head),
          pushedSha: undefined,
        });
        const deadline = Date.now() + 90_000;
        let result: Record<string, unknown> = {};
        for (;;) {
          const r = await t.client.callTool({
            name: "task_result",
            arguments: { task_id: t.taskId },
          });
          if (!r.isError) {
            result = bodyOf(r);
            const pr = result.pr as { closed_empty?: boolean } | null;
            if (pr?.closed_empty === true) break;
          }
          if (Date.now() > deadline)
            throw new Error(`closed_empty になりませんでした: ${JSON.stringify(result)}`);
          await new Promise((r) => setTimeout(r, 500));
        }
        expect(result).toMatchObject({ status: "COMPLETED", pr: { closed_empty: true } });
        expect((await pullOf(t.branch))?.state).toBe("closed");
        expect(await admin.app<string | null>("branch", "acme/widgets", t.branch)).toBeNull();
        for (const name of ["task_pr_ready", "task_pr_merge"]) {
          const r = await t.client.callTool({ name, arguments: { task_id: t.taskId } });
          expect(r.isError).toBe(true);
          expect(bodyOf(r).code).toBe("conflict");
        }
        const denied = (await auditRecords(t.taskId)).filter((x) => x.event === "pr_denied");
        expect(denied.map((x) => x.reason)).toEqual(["pr_closed_empty", "pr_closed_empty"]);
      } finally {
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

  it("task_start: worker_review は未対応（近日）、旧 merge_policy は廃止で、どちらも invalid_input", async () => {
    const user = newUser("rp");
    await addMember(user);
    await installApp();
    const client = await login(user);
    try {
      const worker = await client.callTool({
        name: "task_start",
        arguments: startArgs("rp-worker", { review_policy: "worker_review" }),
      });
      expect(worker.isError).toBe(true);
      expect(bodyOf(worker)).toMatchObject({
        code: "invalid_input",
        message: expect.stringContaining("not supported yet"),
      });
      const old = await client.callTool({
        name: "task_start",
        arguments: startArgs("rp-old", { merge_policy: "agent_merge" }),
      });
      expect(old.isError).toBe(true);
      expect(bodyOf(old)).toMatchObject({
        code: "invalid_input",
        message: expect.stringContaining("review_policy"),
      });
    } finally {
      await client.close();
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
      expect(text).toContain("review_policy");
      expect(text).toContain("自動で Ready for review");
      expect(text).not.toContain("merge_policy");
    } finally {
      await client.close();
    }
  });
});
