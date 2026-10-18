import { beforeEach, describe, expect, it } from "vitest";
import { addMember, admin, bodyOf, installApp, login, newUser, startArgs } from "./helpers";

beforeEach(async () => {
  await admin.reset();
});

async function memberClient(prefix = "user") {
  const user = newUser(prefix);
  await addMember(user);
  await installApp();
  return { user, client: await login(user) };
}

describe("ツール（偽 GitHub 経由の本物のログイン後）", () => {
  it("start -> status -> wait(timeout) -> cancel -> wait(cancelled 即返し)", async () => {
    const { client } = await memberClient();
    try {
      const started = bodyOf(
        await client.callTool({ name: "task_start", arguments: startArgs("t1") }),
      );
      expect(started).toMatchObject({ status: "RUNNING", draft_pr_url: null });
      const taskId = started.task_id as string;

      const status = bodyOf(
        await client.callTool({ name: "task_status", arguments: { task_id: taskId } }),
      );
      expect(status).toMatchObject({
        status: "RUNNING",
        repository: "acme/widgets",
        title: "t1",
        latest_cursor: "2",
      });

      const t0 = Date.now();
      const timedOut = bodyOf(
        await client.callTool({
          name: "task_wait",
          arguments: { task_id: taskId, cursor: "2", timeout_seconds: 1 },
        }),
      );
      expect(Date.now() - t0).toBeGreaterThanOrEqual(900);
      expect(timedOut).toMatchObject({ status: "RUNNING", cursor: "2", events: [] });

      expect(
        bodyOf(await client.callTool({ name: "task_cancel", arguments: { task_id: taskId } })),
      ).toEqual({
        task_id: taskId,
        status: "CANCELLED",
      });

      const t1 = Date.now();
      const cancelled = bodyOf(
        await client.callTool({
          name: "task_wait",
          arguments: { task_id: taskId, cursor: "2", timeout_seconds: 30 },
        }),
      );
      expect(Date.now() - t1).toBeLessThan(5000);
      expect(cancelled).toMatchObject({ status: "CANCELLED", cursor: "3" });
      expect((cancelled.events as { type: string }[]).map((e) => e.type)).toEqual(["cancelled"]);
    } finally {
      await client.close();
    }
  });

  it("task_wait は待機中に cancel されると即座に起きる", async () => {
    const { client } = await memberClient();
    try {
      const { task_id: taskId } = bodyOf(
        await client.callTool({ name: "task_start", arguments: startArgs("t") }),
      ) as { task_id: string };
      const t0 = Date.now();
      const waiting = client.callTool({
        name: "task_wait",
        arguments: { task_id: taskId, cursor: "2", timeout_seconds: 30 },
      });
      await new Promise((r) => setTimeout(r, 500));
      await client.callTool({ name: "task_cancel", arguments: { task_id: taskId } });
      const w = bodyOf(await waiting);
      expect(Date.now() - t0).toBeLessThan(10_000);
      expect(w).toMatchObject({ status: "CANCELLED", cursor: "3" });
    } finally {
      await client.close();
    }
  });

  it("同じ idempotency_key の再試行で同じ task_id が返る", async () => {
    const { client } = await memberClient();
    try {
      const args = startArgs("t", { idempotency_key: "retry-1" });
      const a = bodyOf(await client.callTool({ name: "task_start", arguments: args }));
      const b = bodyOf(await client.callTool({ name: "task_start", arguments: args }));
      expect(b.task_id).toBe(a.task_id);
    } finally {
      await client.close();
    }
  });

  it("同時実行は 1 件まで。キャンセルすると次を始められる", async () => {
    const { client } = await memberClient();
    try {
      const a = bodyOf(await client.callTool({ name: "task_start", arguments: startArgs("a") }));
      const blocked = await client.callTool({ name: "task_start", arguments: startArgs("b") });
      expect(blocked.isError).toBe(true);
      expect(bodyOf(blocked).code).toBe("concurrency_limit");
      await client.callTool({ name: "task_cancel", arguments: { task_id: a.task_id } });
      const next = await client.callTool({ name: "task_start", arguments: startArgs("b") });
      expect(next.isError).toBeFalsy();
    } finally {
      await client.close();
    }
  });

  it("verification_commands を受け付け、task_result は実行中なら not_ready、キャンセル後は結果を返す", async () => {
    const { client } = await memberClient();
    try {
      const started = bodyOf(
        await client.callTool({
          name: "task_start",
          arguments: startArgs("with-verification", {
            verification_commands: [{ argv: ["npm", "test"], cwd: "pkg", timeout_seconds: 60 }],
          }),
        }),
      );
      const taskId = started.task_id as string;
      const notReady = await client.callTool({
        name: "task_result",
        arguments: { task_id: taskId },
      });
      expect(notReady.isError).toBe(true);
      expect(bodyOf(notReady).code).toBe("not_ready");

      await client.callTool({ name: "task_cancel", arguments: { task_id: taskId } });
      const done = await client.callTool({ name: "task_result", arguments: { task_id: taskId } });
      expect(done.isError).toBeFalsy();
      expect(bodyOf(done)).toMatchObject({ task_id: taskId, status: "CANCELLED" });
    } finally {
      await client.close();
    }
  });

  it("不正な verification_commands は invalid_input", async () => {
    const { client } = await memberClient();
    try {
      const r = await client.callTool({
        name: "task_start",
        arguments: startArgs("bad", { verification_commands: [{ argv: ["npm"], cwd: "../x" }] }),
      });
      expect(r.isError).toBe(true);
      expect(bodyOf(r).code).toBe("invalid_input");
    } finally {
      await client.close();
    }
  });

  it("別のユーザーのタスクは status / wait / cancel のどれも not_found", async () => {
    const alice = newUser("alice");
    const bob = newUser("bob");
    await addMember(alice);
    await addMember(bob);
    await installApp();
    const ca = await login(alice);
    const cb = await login(bob);
    try {
      const { task_id: taskId } = bodyOf(
        await ca.callTool({ name: "task_start", arguments: startArgs("secret") }),
      ) as { task_id: string };
      for (const name of ["task_status", "task_wait", "task_cancel", "task_result"]) {
        const r = await cb.callTool({
          name,
          arguments: { task_id: taskId, ...(name === "task_wait" ? { timeout_seconds: 0 } : {}) },
        });
        expect(r.isError).toBe(true);
        expect(bodyOf(r).code).toBe("not_found");
      }
      // 本人にはまだ見える（他人の cancel が効いていない）
      expect(
        bodyOf(await ca.callTool({ name: "task_status", arguments: { task_id: taskId } })).status,
      ).toBe("RUNNING");
    } finally {
      await Promise.all([ca.close(), cb.close()]);
    }
  });

  it("公開リポジトリでも App が未導入なら task_start は forbidden", async () => {
    const { client } = await memberClient();
    try {
      const r = await client.callTool({
        name: "task_start",
        arguments: startArgs("t", { repository: "someone/public-repo" }),
      });
      expect(r.isError).toBe(true);
      expect(bodyOf(r).code).toBe("forbidden");
    } finally {
      await client.close();
    }
  });

  it("push 権限が無いリポジトリは forbidden", async () => {
    const user = newUser();
    await addMember(user);
    await admin.setInstallation(77, [{ id: 9, fullName: "acme/readonly", push: false }]);
    const client = await login(user);
    try {
      const r = await client.callTool({
        name: "task_start",
        arguments: startArgs("t", { repository: "acme/readonly" }),
      });
      expect(bodyOf(r).code).toBe("forbidden");
    } finally {
      await client.close();
    }
  });

  it("アクセストークンが期限切れ(401)でも、自動でリフレッシュしてツール呼び出しが成功する", async () => {
    const { client } = await memberClient();
    try {
      await admin.expireAccessTokens();
      const r = await client.callTool({
        name: "task_start",
        arguments: startArgs("after-refresh"),
      });
      expect(r.isError).toBeFalsy();
      expect(bodyOf(r).status).toBe("RUNNING");
      const grants = (await admin.requests()).filter(
        (q) => q.path === "/login/oauth/access_token" && q.body?.grant_type === "refresh_token",
      );
      expect(grants).toHaveLength(1);
    } finally {
      await client.close();
    }
  });

  it("refresh token も失効していれば reauth_required", async () => {
    const { client } = await memberClient();
    try {
      await admin.expireAccessTokens();
      await admin.revokeRefreshTokens();
      const r = await client.callTool({ name: "task_start", arguments: startArgs("t") });
      expect(r.isError).toBe(true);
      expect(bodyOf(r).code).toBe("reauth_required");
    } finally {
      await client.close();
    }
  });

  it("GitHub が落ちていれば upstream_unavailable（fail-closed）", async () => {
    const { client } = await memberClient();
    try {
      await admin.setFault("api", 503);
      const r = await client.callTool({ name: "task_start", arguments: startArgs("t") });
      expect(r.isError).toBe(true);
      expect(bodyOf(r)).toMatchObject({ code: "upstream_unavailable" });
    } finally {
      await admin.setFault("api", null);
      await client.close();
    }
  });
});
