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

beforeEach(async () => {
  await admin.reset();
});

describe("R2 アーカイブ（wrangler dev のローカル R2 = LOGS）", () => {
  it("終端（cancel）の後に 3 オブジェクトが出て、summary.json が最後。中身にトークンも入力も無い", async () => {
    const alice = newUser("alice");
    await addMember(alice);
    await installApp();
    const client = await login(alice);
    try {
      const { task_id: taskId } = bodyOf(
        await client.callTool({
          name: "task_start",
          arguments: startArgs("ARCHIVE-TITLE-secret", {
            instructions: "ARCHIVE-INSTRUCTIONS-secret",
            constraints: ["ARCHIVE-CONSTRAINT-secret"],
          }),
        }),
      ) as { task_id: string };
      expect(
        bodyOf(await client.callTool({ name: "task_cancel", arguments: { task_id: taskId } })),
      ).toEqual({ task_id: taskId, status: "CANCELLED" });

      const done = await waitForAudit((r) => r.event === "archive_completed", {
        taskId,
        timeoutMs: 30_000,
      });
      expect(done).toMatchObject({ taskId, caller: "system" });
      const prefix = (done as unknown as { prefix: string }).prefix;
      expect(prefix).toMatch(new RegExp(`^tasks/\\d{4}/\\d{2}/${taskId}/$`));

      const { bound, objects } = await archivedObjects(taskId);
      expect(bound).toBe(true);
      const byName = new Map(objects.map((o) => [o.key.slice(prefix.length), o]));
      expect([...byName.keys()].sort()).toEqual(["events.jsonl", "result.json", "summary.json"]);
      expect(objects.every((o) => o.key.startsWith(prefix))).toBe(true);
      expect((done as unknown as { bytes: number }).bytes).toBe(
        objects.reduce((n, o) => n + o.size, 0),
      );

      // summary.json が完了の印: 最後に書かれている
      const summaryAt = byName.get("summary.json")?.uploaded ?? 0;
      expect(summaryAt).toBeGreaterThanOrEqual(byName.get("events.jsonl")?.uploaded ?? Infinity);
      expect(summaryAt).toBeGreaterThanOrEqual(byName.get("result.json")?.uploaded ?? Infinity);

      const events = (byName.get("events.jsonl")?.text ?? "")
        .trimEnd()
        .split("\n")
        .map((l) => JSON.parse(l) as { seq: number; type: string; payload: { code?: string } });
      expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
      // 二重化した監査イベント（トークンの発行と失効）が R2 にも残る
      expect(events.filter((e) => e.type === "audit").map((e) => e.payload.code)).toEqual(
        expect.arrayContaining(["credential_issued", "credential_revoked"]),
      );
      const summary = JSON.parse(byName.get("summary.json")?.text ?? "{}");
      expect(summary).toMatchObject({ task_id: taskId, user_id: alice.id, status: "CANCELLED" });
      expect(JSON.parse(byName.get("result.json")?.text ?? "{}")).toMatchObject({
        status: "CANCELLED",
      });

      // acceptance 15: トークン形式の grep、保存しないものの grep
      const all = objects.map((o) => o.text).join("\n");
      expect(all).not.toMatch(
        /ghs_|ghu_|ghp_|github_pat_|sk-ant-|Authorization: Bearer|-----BEGIN/,
      );
      for (const secret of ["ARCHIVE-TITLE", "ARCHIVE-INSTRUCTIONS", "ARCHIVE-CONSTRAINT"]) {
        expect(all).not.toContain(secret);
      }
      // 監査ログ側の archive_completed に、キー全体や本文は出ない
      const line = JSON.stringify(
        (await auditRecords(taskId)).filter((r) => r.event.startsWith("archive_")),
      );
      expect(line).not.toContain("events.jsonl");
      expect(line).not.toContain("archive_failed");
    } finally {
      await client.close();
    }
  });

  it("終端の後（finalize_done = 1）、TaskDO の git_token の暗号文は空になり、行は残る", async () => {
    const alice = newUser("alice");
    await addMember(alice);
    await installApp();
    const client = await login(alice);
    try {
      const { task_id: taskId } = bodyOf(
        await client.callTool({ name: "task_start", arguments: startArgs("SCRUB") }),
      ) as { task_id: string };
      bodyOf(await client.callTool({ name: "task_cancel", arguments: { task_id: taskId } }));
      // アーカイブは finalize_done = 1 が成立してから書かれる
      await waitForAudit((r) => r.event === "archive_completed", { taskId, timeoutMs: 30_000 });
      const state = await tokenState(taskId);
      expect(state.finalizeDone).toBe(true);
      expect(state.rows).toBeGreaterThan(0);
      expect(state).toEqual({
        finalizeDone: true,
        rows: state.rows,
        encEmpty: state.rows,
        encPresent: 0,
      });
      // 件数の突き合わせは壊れていない
      const records = await auditRecords(taskId);
      expect(records.filter((r) => r.event === "credential_issued")).toHaveLength(state.rows);
      expect(records.filter((r) => r.event === "credential_revoked")).toHaveLength(state.rows);
    } finally {
      await client.close();
    }
  });
});
