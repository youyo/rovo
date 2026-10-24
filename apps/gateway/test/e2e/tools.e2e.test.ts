import { beforeEach, describe, expect, it } from "vitest";
import {
  addMember,
  admin,
  baseUrl,
  bodyOf,
  emitAgentEvent,
  installApp,
  login,
  newUser,
  startArgs,
  waitForResult,
} from "./helpers";

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
        draft_pr_url: expect.stringMatching(/\/pull\/\d+$/),
        // created -> audit(credential_issued) -> draft_pr_created -> status_changed
        latest_cursor: "4",
      });

      const t0 = Date.now();
      const timedOut = bodyOf(
        await client.callTool({
          name: "task_wait",
          arguments: { task_id: taskId, cursor: "4", timeout_seconds: 1 },
        }),
      );
      expect(Date.now() - t0).toBeGreaterThanOrEqual(900);
      expect(timedOut).toMatchObject({ status: "RUNNING", cursor: "4", events: [] });

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
          arguments: { task_id: taskId, cursor: "4", timeout_seconds: 30 },
        }),
      );
      expect(Date.now() - t1).toBeLessThan(5000);
      expect(cancelled).toMatchObject({ status: "CANCELLED" });
      // cancelled の後に続くのは、終端処理のトークンの失効（audit）だけ
      const types = (cancelled.events as { type: string }[]).map((e) => e.type);
      expect(types[0]).toBe("cancelled");
      expect(types.slice(1).every((t) => t === "audit")).toBe(true);
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
        arguments: { task_id: taskId, cursor: "4", timeout_seconds: 30 },
      });
      await new Promise((r) => setTimeout(r, 500));
      await client.callTool({ name: "task_cancel", arguments: { task_id: taskId } });
      const w = bodyOf(await waiting);
      expect(Date.now() - t0).toBeLessThan(10_000);
      expect(w).toMatchObject({ status: "CANCELLED" });
      expect(Number(w.cursor)).toBeGreaterThanOrEqual(5); // cancelled（と、続く audit）
    } finally {
      await client.close();
    }
  });

  it("task_steer は RUNNING で受け付け、同じ idempotency_key なら同じ steer_id。cancel 後は conflict。質問が無ければ task_answer は not_found", async () => {
    const { client } = await memberClient();
    try {
      const { task_id: taskId } = bodyOf(
        await client.callTool({ name: "task_start", arguments: startArgs("t") }),
      ) as { task_id: string };
      const steerArgs = { task_id: taskId, message: "use pnpm", idempotency_key: "s-1" };
      const a = bodyOf(await client.callTool({ name: "task_steer", arguments: steerArgs }));
      const b = bodyOf(await client.callTool({ name: "task_steer", arguments: steerArgs }));
      expect(a).toMatchObject({ task_id: taskId, status: "RUNNING" });
      expect(b.steer_id).toBe(a.steer_id);
      const noQuestion = await client.callTool({
        name: "task_answer",
        arguments: { task_id: taskId, question_id: "q1", answer: "x" },
      });
      expect(noQuestion.isError).toBe(true);
      expect(bodyOf(noQuestion).code).toBe("not_found");
      await client.callTool({ name: "task_cancel", arguments: { task_id: taskId } });
      const late = await client.callTool({
        name: "task_steer",
        arguments: { task_id: taskId, message: "late" },
      });
      expect(late.isError).toBe(true);
      expect(bodyOf(late).code).toBe("conflict");
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

  it("task_start・task_status・task_result の応答に dashboard_url（<PUBLIC_BASE_URL>/dashboard/tasks/<task_id>）が入り、task_wait・task_cancel には入らない", async () => {
    const { client } = await memberClient();
    try {
      const started = bodyOf(
        await client.callTool({ name: "task_start", arguments: startArgs("dashboard-url") }),
      );
      const taskId = started.task_id as string;
      // PUBLIC_BASE_URL は、この E2E の gateway の公開 URL（global-setup.ts の baseUrl）。末尾の / は付かない
      const expected = `${baseUrl}/dashboard/tasks/${taskId}`;
      expect(started.dashboard_url).toBe(expected);
      expect(String(started.note)).toContain("dashboard_url");

      const status = bodyOf(
        await client.callTool({ name: "task_status", arguments: { task_id: taskId } }),
      );
      expect(status.dashboard_url).toBe(expected);

      const wait = bodyOf(
        await client.callTool({
          name: "task_wait",
          arguments: { task_id: taskId, cursor: "4", timeout_seconds: 0 },
        }),
      );
      expect(wait).not.toHaveProperty("dashboard_url");

      const cancelled = bodyOf(
        await client.callTool({ name: "task_cancel", arguments: { task_id: taskId } }),
      );
      expect(cancelled).toEqual({ task_id: taskId, status: "CANCELLED" });

      const result = await waitForResult(client, taskId, { needHead: false });
      expect(result).toMatchObject({ task_id: taskId, status: "CANCELLED" });
      expect(result.dashboard_url).toBe(expected);

      // 開くと SPA の HTML が返る（ログインの有無は SPA が /dashboard/api/me で判断する）。ログイン後の戻り先は auth の Unit で確かめる
      const page = await fetch(expected, { redirect: "manual" });
      expect(page.status).toBe(200);
      expect(page.headers.get("content-type")).toContain("text/html");
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
      const extra: Record<string, Record<string, unknown>> = {
        task_wait: { timeout_seconds: 0 },
        task_answer: { question_id: "q1", answer: "x" },
        task_steer: { message: "x" },
      };
      for (const name of [
        "task_status",
        "task_wait",
        "task_cancel",
        "task_result",
        "task_answer",
        "task_steer",
      ]) {
        const r = await cb.callTool({
          name,
          arguments: { task_id: taskId, ...(extra[name] ?? {}) },
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

describe("Draft PR（偽 GitHub の App API 経由）", () => {
  type Pull = {
    number: number;
    draft: boolean;
    state: string;
    head: string;
    base: string;
    body: string;
  };
  const pullsOf = () => admin.app<Pull[]>("pulls", "acme/widgets");
  const tokens = () => admin.app<{ token: string; revoked: boolean }[]>("tokenList");

  it("task_start で作業ブランチと Draft PR が作られ、cancel で本文が更新されてトークンが失効する", async () => {
    const { client } = await memberClient();
    try {
      const started = bodyOf(
        await client.callTool({ name: "task_start", arguments: startArgs("draft pr") }),
      );
      const taskId = started.task_id as string;
      const branch = `agent/task-${taskId}`;
      expect(started.draft_pr_url).toBeNull(); // 作成前の応答

      const pr = (await pullsOf()).find((p) => p.head === branch);
      expect(pr).toMatchObject({ draft: true, state: "open", base: "main" });
      expect(await admin.app<string | null>("branch", "acme/widgets", branch)).toMatch(
        /^[0-9a-f]{40}$/,
      );

      const status = bodyOf(
        await client.callTool({ name: "task_status", arguments: { task_id: taskId } }),
      );
      expect(status.draft_pr_url).toBe(`https://github.test/acme/widgets/pull/${pr?.number}`);

      // JWT で認証して、repository_ids と permissions を絞ってトークンを発行している
      const reqs =
        await admin.app<
          { path: string; method: string; auth: string; body: Record<string, unknown> }[]
        >("requests");
      const issued = reqs.filter((r) => r.path.endsWith("/access_tokens"));
      expect(issued.at(-1)).toMatchObject({
        method: "POST",
        auth: "jwt",
        body: {
          repository_ids: [4242],
          permissions: { contents: "write", pull_requests: "write", metadata: "read" },
        },
      });

      await client.callTool({ name: "task_cancel", arguments: { task_id: taskId } });
      // 終端処理（停止確認の後の PR 更新と失効）は alarm 経由なので、少し待つ
      for (let i = 0; i < 50; i++) {
        const t = await tokens();
        if (t.length > 0 && t.every((x) => x.revoked)) break;
        await new Promise((r) => setTimeout(r, 200));
      }
      expect((await tokens()).every((x) => x.revoked)).toBe(true);
      const after = (await pullsOf()).find((p) => p.head === branch);
      // ワーカーの commit が無いままキャンセルされたので、本文を更新したあと空の Draft PR は閉じられる
      expect(after).toMatchObject({ draft: true, state: "closed" });
      expect(after?.body).toContain("CANCELLED");

      const result = bodyOf(
        await client.callTool({ name: "task_result", arguments: { task_id: taskId } }),
      );
      expect(result.pr).toMatchObject({
        number: pr?.number,
        url: status.draft_pr_url,
        // キャンセルでは push しない（pushedSha なし）ので、PR の head は比べず記録もしない
        head_sha: null,
        head_matches_verified: null,
        closed_empty: true,
      });
    } finally {
      await client.close();
    }
  });

  it("Draft PR を作れないリポジトリでは、既定（fail）で FAILED（draft_pr_unsupported）。通常の PR は作られない", async () => {
    await admin.app("setDraftUnsupported", true);
    const { client } = await memberClient();
    try {
      const started = bodyOf(
        await client.callTool({ name: "task_start", arguments: startArgs("no draft") }),
      );
      const taskId = started.task_id as string;
      expect(started.status).toBe("FAILED");
      const w = bodyOf(
        await client.callTool({
          name: "task_wait",
          arguments: { task_id: taskId, cursor: "0", timeout_seconds: 0 },
        }),
      );
      const failed = (w.events as { type: string; payload: Record<string, unknown> }[]).find(
        (e) => e.type === "status_changed" && e.payload.status === "FAILED",
      );
      expect(failed?.payload.reason).toBe("draft_pr_unsupported");
      expect((await pullsOf()).some((p) => p.head === `agent/task-${taskId}`)).toBe(false);
    } finally {
      await admin.app("setDraftUnsupported", false);
      await client.close();
    }
  });
});

describe("task_console（mod 用の読み取り専用ツール。本物のログイン後）", () => {
  const GHP = `ghp_${"a1B2".repeat(9)}`;

  it("実行中は phase=run・output に実行中のコマンド（running）が囲み付きで出て、秘密は伏せられる。終端で phase=done・stopped_phase・output=null", async () => {
    const { client } = await memberClient("console");
    try {
      const started = bodyOf(
        await client.callTool({ name: "task_start", arguments: startArgs("console-1") }),
      );
      const taskId = started.task_id as string;

      const first = bodyOf(
        await client.callTool({ name: "task_console", arguments: { task_id: taskId } }),
      );
      expect(first).toMatchObject({
        task_id: taskId,
        status: "RUNNING",
        phase: "run",
        stopped_phase: null,
        now: null,
        output: null,
        dashboard_url: `${baseUrl}/dashboard/tasks/${taskId}`,
      });
      // pr は task_status の draft_pr_url と同じ値（作成前は null）
      const statusBody = bodyOf(
        await client.callTool({ name: "task_status", arguments: { task_id: taskId } }),
      );
      if (statusBody.draft_pr_url === null) expect(first.pr).toBeNull();
      else expect(first.pr).toMatchObject({ url: statusBody.draft_pr_url });
      expect(new Date(first.generated_at as string).toISOString()).toBe(first.generated_at);

      await emitAgentEvent(taskId, "command_progress", {
        command: "pnpm test",
        startedAt: Date.now() - 5_000,
        outputTail: `running step 1\n${GHP}\nAPI_KEY=plainvalue789\n`,
      });
      let running: Record<string, unknown> = first;
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline) {
        running = bodyOf(
          await client.callTool({ name: "task_console", arguments: { task_id: taskId } }),
        );
        if (running.output !== null) break;
        await new Promise((r) => setTimeout(r, 1_000));
      }
      expect(running).toMatchObject({
        status: "RUNNING",
        phase: "run",
        output: { running: true, redacted: true },
      });
      const output = running.output as { command: string; tail: string; started_at: string };
      expect(output.command).toContain("<<<UNTRUSTED_CHILD_QUESTION");
      expect(output.command).toContain("pnpm test");
      expect(output.command).toContain("<<<END_UNTRUSTED_CHILD_QUESTION>>>");
      expect(output.tail).toContain("running step 1");
      expect(output.tail).toContain("<<<END_UNTRUSTED_CHILD_QUESTION>>>");
      expect(JSON.stringify(running)).not.toContain(GHP);
      expect(JSON.stringify(running)).not.toContain("plainvalue789");

      // task_wait には、実行中の進捗も console の項目も出ない
      const wait = bodyOf(
        await client.callTool({
          name: "task_wait",
          arguments: { task_id: taskId, cursor: "0", timeout_seconds: 0 },
        }),
      );
      expect(JSON.stringify(wait)).not.toContain("running step 1");

      await client.callTool({ name: "task_cancel", arguments: { task_id: taskId } });
      const done = bodyOf(
        await client.callTool({ name: "task_console", arguments: { task_id: taskId } }),
      );
      expect(done).toMatchObject({
        status: "CANCELLED",
        phase: "done",
        stopped_phase: "run",
        now: null,
        output: null,
      });
    } finally {
      await client.close();
    }
  }, 180_000);

  it("log_after: コマンドを 2 本流したタスクで、\"0\" から 2 本とも返り、next_cursor で次を取ると空", async () => {
    const { client } = await memberClient("console-log");
    try {
      const started = bodyOf(
        await client.callTool({ name: "task_start", arguments: startArgs("console-log-1") }),
      );
      const taskId = started.task_id as string;
      await emitAgentEvent(taskId, "command", { command: "echo first", exitCode: 0, outputTail: "first" });
      await emitAgentEvent(taskId, "command", { command: "echo second", exitCode: 0, outputTail: "second" });
      type Log = { entries: { type: string; command?: string }[]; next_cursor: string; truncated: boolean };
      let log: Log = { entries: [], next_cursor: "0", truncated: false };
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline) {
        const res = bodyOf(
          await client.callTool({
            name: "task_console",
            arguments: { task_id: taskId, log_after: "0" },
          }),
        );
        log = res.log as Log;
        if (log.entries.filter((e) => e.type === "command").length >= 2) break;
        await new Promise((r) => setTimeout(r, 1_000));
      }
      const cmds = log.entries.filter((e) => e.type === "command");
      expect(cmds).toHaveLength(2);
      expect(cmds[0]?.command).toContain("echo first");
      expect(cmds[1]?.command).toContain("echo second");
      expect(log.truncated).toBe(false);
      const next = bodyOf(
        await client.callTool({
          name: "task_console",
          arguments: { task_id: taskId, log_after: log.next_cursor },
        }),
      );
      expect((next.log as Log).entries.filter((e) => e.type === "command")).toEqual([]);
    } finally {
      await client.close();
    }
  }, 180_000);

  it("他人のタスクは task_status と同じ not_found で拒否される", async () => {
    const alice = newUser("console-a");
    const bob = newUser("console-b");
    await addMember(alice);
    await addMember(bob);
    await installApp();
    const ca = await login(alice);
    const cb = await login(bob);
    try {
      const { task_id: taskId } = bodyOf(
        await ca.callTool({ name: "task_start", arguments: startArgs("console-secret") }),
      ) as { task_id: string };
      const viaConsole = await cb.callTool({
        name: "task_console",
        arguments: { task_id: taskId },
      });
      const viaStatus = await cb.callTool({ name: "task_status", arguments: { task_id: taskId } });
      expect(viaConsole.isError).toBe(true);
      expect(bodyOf(viaConsole)).toEqual(bodyOf(viaStatus));
      expect(bodyOf(viaConsole).code).toBe("not_found");
      expect(JSON.stringify(bodyOf(viaConsole))).not.toContain("console-secret");
    } finally {
      await Promise.all([ca.close(), cb.close()]);
    }
  });
});
