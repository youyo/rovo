import { beforeEach, describe, expect, it } from "vitest";
import {
  addMember,
  admin,
  archivedObjects,
  auditRecords,
  bodyOf,
  installApp,
  login,
  newUser,
  startArgs,
  tokenState,
  waitForAudit,
} from "./helpers";

// Phase 7 M3: LOGS（R2）のバインディングを外した構成の gateway（vitest.e2e-nologs.config.ts）。
// 本番の wrangler.jsonc は r2_buckets を持たないので、この構成が「LOGS が無い」ときの実際の挙動になる。

beforeEach(async () => {
  await admin.reset();
});

describe("LOGS を外した構成（アーカイブは fail-open）", () => {
  it("タスクは普通に終端まで進み、archive_skipped(no_binding) が出る。archive_completed / archive_failed は出ない。R2 は未バインド", async () => {
    const alice = newUser("alice");
    await addMember(alice);
    await installApp();
    const client = await login(alice);
    try {
      const { task_id: taskId } = bodyOf(
        await client.callTool({ name: "task_start", arguments: startArgs("NOLOGS") }),
      ) as { task_id: string };
      expect(
        bodyOf(await client.callTool({ name: "task_cancel", arguments: { task_id: taskId } })),
      ).toEqual({ task_id: taskId, status: "CANCELLED" });

      const skipped = await waitForAudit((r) => r.event === "archive_skipped", {
        taskId,
        timeoutMs: 30_000,
      });
      expect(skipped).toMatchObject({ taskId, caller: "system", reason: "no_binding" });

      const records = await auditRecords(taskId);
      expect(records.filter((r) => r.event === "archive_skipped")).toHaveLength(1);
      expect(records.some((r) => r.event === "archive_completed")).toBe(false);
      expect(records.some((r) => r.event === "archive_failed")).toBe(false);
      expect((await archivedObjects(taskId)).bound).toBe(false);

      // タスクの結果と GitHub の終了処理（トークンの失効と暗号文の削除）は、アーカイブの有無に影響されない
      const status = bodyOf(
        await client.callTool({ name: "task_status", arguments: { task_id: taskId } }),
      );
      expect(status).toMatchObject({ task_id: taskId, status: "CANCELLED" });
      const result = bodyOf(
        await client.callTool({ name: "task_result", arguments: { task_id: taskId } }),
      );
      expect(result).toMatchObject({ status: "CANCELLED" });
      const state = await tokenState(taskId);
      expect(state.finalizeDone).toBe(true);
      expect(state.encPresent).toBe(0);
      expect(records.filter((r) => r.event === "credential_revoked")).toHaveLength(state.rows);
    } finally {
      await client.close();
    }
  });
});
