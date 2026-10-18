import { beforeEach, describe, expect, it } from "vitest";
import {
  addMember,
  admin,
  auditRecords,
  baseUrl,
  bodyOf,
  installApp,
  login,
  newUser,
  startArgs,
  waitForAudit,
} from "./helpers";
import { approveAtGitHub, beginLogin, callCallback } from "./oauth-client";

beforeEach(async () => {
  await admin.reset();
});

describe("監査イベント（/__test/audit。stdout は走査しない）", () => {
  it("不正なトークンの /mcp は auth_failed(token_rejected)。トークンの値は監査に出ない", async () => {
    const secret = "garbage-token-should-never-be-logged";
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(401);
    const hit = await waitForAudit(
      (r) => r.event === "auth_failed" && r.reason === "token_rejected",
    );
    expect(hit).toMatchObject({ audit: true, caller: "parent" });
    expect(JSON.stringify(await auditRecords())).not.toContain(secret);
  });

  it("team に所属しないユーザーのログインは authz_denied(not_team_member)。userId だけが出て、login は出ない", async () => {
    const user = newUser("outsider");
    await admin.addUser(user);
    const flow = await beginLogin(baseUrl);
    const callbackUrl = await approveAtGitHub(flow.githubAuthorizeUrl);
    const res = await callCallback(callbackUrl, flow.cookie);
    expect(new URL(res.headers.get("location") ?? "").searchParams.get("error")).toBe(
      "access_denied",
    );
    const hit = await waitForAudit(
      (r) => r.event === "authz_denied" && r.reason === "not_team_member" && r.userId === user.id,
    );
    expect(hit.caller).toBe("parent");
    expect(JSON.stringify(await auditRecords())).not.toContain(user.login);
  });

  it("state が一致しない /callback は auth_failed(invalid_state)", async () => {
    const user = newUser();
    await addMember(user);
    const flow = await beginLogin(baseUrl);
    const callbackUrl = new URL(await approveAtGitHub(flow.githubAuthorizeUrl));
    callbackUrl.searchParams.set("state", "forged-state");
    const res = await callCallback(callbackUrl.toString(), flow.cookie);
    expect(res.status).toBe(400);
    await waitForAudit((r) => r.event === "auth_failed" && r.reason === "invalid_state");
  });

  it("App が未導入のリポジトリへの task_start は authz_denied(forbidden)", async () => {
    const user = newUser();
    await addMember(user);
    const client = await login(user);
    try {
      const r = await client.callTool({ name: "task_start", arguments: startArgs("t") });
      expect(bodyOf(r).code).toBe("forbidden");
    } finally {
      await client.close();
    }
    const hit = await waitForAudit((r) => r.event === "authz_denied" && r.userId === user.id);
    expect(hit).toMatchObject({ reason: "forbidden", caller: "parent" });
  });

  it("cancel: task_cancelled と、トークンの発行・失効が監査ログと events の両方に残る。他人の操作は authz_denied(not_owner)", async () => {
    const alice = newUser("alice");
    const bob = newUser("bob");
    await addMember(alice);
    await addMember(bob);
    await installApp();
    const ca = await login(alice);
    const cb = await login(bob);
    try {
      const { task_id: taskId } = bodyOf(
        await ca.callTool({ name: "task_start", arguments: startArgs("audited") }),
      ) as { task_id: string };

      // 他人の cancel は not_found のまま。拒否は監査に出る
      const denied = await cb.callTool({ name: "task_cancel", arguments: { task_id: taskId } });
      expect(bodyOf(denied).code).toBe("not_found");
      await waitForAudit((r) => r.event === "authz_denied" && r.reason === "not_owner", {
        taskId,
      });

      expect(
        bodyOf(await ca.callTool({ name: "task_cancel", arguments: { task_id: taskId } })),
      ).toEqual({ task_id: taskId, status: "CANCELLED" });
      const cancelled = await waitForAudit((r) => r.event === "task_cancelled", { taskId });
      expect(cancelled).toMatchObject({
        taskId,
        userId: alice.id,
        caller: "parent",
        reason: "parent_requested",
      });
      await waitForAudit((r) => r.event === "credential_revoked", { taskId });

      // events（task_wait で親にも見える）の audit は、固定コードだけ
      const waited = bodyOf(
        await ca.callTool({
          name: "task_wait",
          arguments: { task_id: taskId, cursor: "0", timeout_seconds: 0 },
        }),
      );
      const events = (waited.events as { type: string; payload: Record<string, string> }[]).filter(
        (e) => e.type === "audit",
      );
      expect(events.map((e) => e.payload.code)).toEqual(
        expect.arrayContaining(["credential_issued", "credential_revoked"]),
      );
      for (const e of events) {
        expect(Object.keys(e.payload).every((k) => k === "code" || k === "kind")).toBe(true);
      }
      // 二重化した監査ログの件数と、events の audit の件数が合う（acceptance 16）
      const dual = (await auditRecords(taskId)).filter(
        (r) =>
          r.taskId === taskId &&
          (["credential_issued", "credential_revoked", "delivery_given_up"].includes(r.event) ||
            // 他の失効の諦め（attempts_exhausted / not_retryable）は既存の warning が events 側
            (r.event === "credential_revoke_given_up" && r.reason === "setup_failure")),
      );
      expect(dual.length).toBe(events.length);

      // 終端の要約（task_summary）: 精算と GitHub の終了処理が済んだ後に 1 回、数値と固定コードだけで出る
      const summary = (await waitForAudit((r) => r.event === "task_summary", { taskId })) as {
        kind?: string;
        userId?: number;
        metrics?: Record<string, number>;
      };
      expect(summary).toMatchObject({
        taskId,
        userId: alice.id,
        caller: "system",
        kind: "cancelled",
      });
      expect(summary.metrics).toMatchObject({ duration_ms: expect.any(Number), transitions: 2 });
      const summaries = (await auditRecords(taskId)).filter((r) => r.event === "task_summary");
      expect(summaries).toHaveLength(1);
      expect(JSON.stringify(summaries)).not.toContain("audited");
    } finally {
      await Promise.all([ca.close(), cb.close()]);
    }
  });
});
