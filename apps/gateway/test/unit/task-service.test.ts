import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  createTaskService as createRealTaskService,
  type Principal,
  type StartOptions,
} from "../../src/tasks/service";
import { fakeAgent, newTaskId, newUserId, taskStub, userStub } from "./helpers";

/** 既定で、認可を通った後の GitHub の ID（Phase 3 では Draft PR の作成に必要）を渡す。 */
function createTaskService(...args: Parameters<typeof createRealTaskService>) {
  const svc = createRealTaskService(...args);
  return {
    ...svc,
    start: (p: Principal, input: unknown, options: StartOptions = {}) =>
      svc.start(p, input, { repositoryId: 4242, installationId: 77, ...options }),
  };
}

const startInput = {
  repository: "acme/widgets",
  base_ref: "main",
  base_sha: "0123456789abcdef",
  title: "Implement authentication",
  instructions: "Implement OAuth authentication.",
  acceptance_criteria: ["tests pass"],
  constraints: ["do not merge"],
};

function principal(): Principal {
  return { githubUserId: newUserId(), login: "alice" };
}

describe("task service: start", () => {
  it("task_id と、AgentDO が start を受理した RUNNING を返し、draft_pr_url は null、note を含む", async () => {
    const svc = createTaskService(env);
    const r = await svc.start(principal(), { ...startInput });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toMatchObject({ status: "RUNNING", draft_pr_url: null });
    expect(r.value.task_id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(r.value.note).toEqual(expect.any(String));
  });

  it("同じ idempotency_key での再試行は同じ task_id", async () => {
    const svc = createTaskService(env);
    const p = principal();
    const a = await svc.start(p, { ...startInput, idempotency_key: "retry-1" });
    const b = await svc.start(p, { ...startInput, idempotency_key: "retry-1" });
    expect(a.ok && b.ok && a.value.task_id === b.value.task_id).toBe(true);
  });

  it("同じキーで入力が違えば conflict", async () => {
    const svc = createTaskService(env);
    const p = principal();
    await svc.start(p, { ...startInput, idempotency_key: "k" });
    const r = await svc.start(p, { ...startInput, title: "other", idempotency_key: "k" });
    expect(r).toMatchObject({ ok: false, error: { code: "conflict" } });
  });

  it("実行中のタスクがあれば concurrency_limit", async () => {
    const svc = createTaskService(env);
    const p = principal();
    await svc.start(p, { ...startInput });
    const r = await svc.start(p, { ...startInput, title: "second" });
    expect(r).toMatchObject({ ok: false, error: { code: "concurrency_limit" } });
  });

  it("idempotency_key 省略の2回の start は別タスク扱い（2回目は concurrency_limit）", async () => {
    const svc = createTaskService(env);
    const p = principal();
    expect((await svc.start(p, { ...startInput })).ok).toBe(true);
    expect(await svc.start(p, { ...startInput })).toMatchObject({
      ok: false,
      error: { code: "concurrency_limit" },
    });
  });

  it.each([
    ["空", ""],
    ["129文字", "a".repeat(129)],
    ["不正な文字", "a b"],
    ["文字列でない", 123],
  ])("idempotency_key が%sなら invalid_input（予約しない）", async (_n, key) => {
    const svc = createTaskService(env);
    const p = principal();
    const r = await svc.start(p, { ...startInput, idempotency_key: key });
    expect(r).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect((await svc.start(p, { ...startInput })).ok).toBe(true);
  });

  it("入力が不正なら invalid_input", async () => {
    const svc = createTaskService(env);
    const r = await svc.start(principal(), { ...startInput, repository: "nope" });
    expect(r).toMatchObject({ ok: false, error: { code: "invalid_input" } });
  });

  it("入力全体が大きすぎれば invalid_input（予約しない）", async () => {
    const svc = createTaskService(env);
    const p = principal();
    const r = await svc.start(p, {
      ...startInput,
      instructions: "x".repeat(100_000),
      acceptance_criteria: Array(50).fill("y".repeat(2_000)),
      constraints: Array(50).fill("z".repeat(2_000)),
    });
    expect(r).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect((await svc.start(p, { ...startInput })).ok).toBe(true);
  });

  it("repository_id / installation_id を TaskDO に渡す", async () => {
    const svc = createTaskService(env);
    const p = principal();
    const r = await svc.start(p, { ...startInput }, { repositoryId: 9, installationId: 3 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const { runInDurableObject } = await import("cloudflare:test");
    const [row] = await runInDurableObject(taskStub(r.value.task_id), (_i, s) =>
      s.storage.sql.exec("SELECT repository_id, installation_id, owner_id FROM task").toArray(),
    );
    expect(row).toEqual({ repository_id: 9, installation_id: 3, owner_id: p.githubUserId });
  });

  it("ensureCreated が失敗しても予約は解放されず、同じキーの再試行で同じ task_id になる", async () => {
    let fail = true;
    const svc = createTaskService(env, {
      tasks: (id) => {
        const real = taskStub(id);
        return new Proxy(real, {
          get(target, prop) {
            if (prop === "ensureCreated") {
              return async (input: never) => {
                if (fail) {
                  fail = false;
                  throw new Error("network lost");
                }
                return target.ensureCreated(input);
              };
            }
            return Reflect.get(target, prop);
          },
        });
      },
    });
    const p = principal();
    await expect(svc.start(p, { ...startInput, idempotency_key: "k1" })).rejects.toThrow(
      "network lost",
    );
    // 予約は残っている: 別キーは concurrency_limit
    expect(await svc.start(p, { ...startInput, idempotency_key: "k2" })).toMatchObject({
      ok: false,
      error: { code: "concurrency_limit" },
    });
    const retry = await svc.start(p, { ...startInput, idempotency_key: "k1" });
    expect(retry).toMatchObject({ ok: true, value: { status: "RUNNING" } });
  });

  it("AgentDO への start が失敗しても task_start は成功し、CREATING のまま（alarm が再送する）", async () => {
    const svc = createTaskService(env, {
      tasks: (id) => {
        const real = taskStub(id);
        return new Proxy(real, {
          get(target, prop) {
            if (prop === "advance") {
              return async () => {
                throw new Error("task do unreachable");
              };
            }
            return Reflect.get(target, prop);
          },
        });
      },
    });
    const r = await svc.start(principal(), { ...startInput });
    expect(r).toMatchObject({ ok: true, value: { status: "CREATING" } });
  });

  it("verification_commands を検証し、taskSpec として AgentDO に渡す", async () => {
    const svc = createTaskService(env);
    const p = principal();
    const bad = await svc.start(p, { ...startInput, verification_commands: [{ argv: [] }] });
    expect(bad).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    const r = await svc.start(p, {
      ...startInput,
      verification_commands: [{ argv: ["npm", "test"], cwd: "pkg", timeout_seconds: 120 }],
    });
    if (!r.ok) throw new Error("start failed");
    const { specs } = await fakeAgent(r.value.task_id).calls();
    expect(specs[0]).toMatchObject({
      taskId: r.value.task_id,
      userId: String(p.githubUserId),
      verificationCommands: [{ argv: ["npm", "test"], cwd: "pkg", timeoutSeconds: 120 }],
      budgetUsd: 10,
    });
  });

  it("verification_commands が違えば同じキーでも conflict", async () => {
    const svc = createTaskService(env);
    const p = principal();
    await svc.start(p, { ...startInput, idempotency_key: "k" });
    const r = await svc.start(p, {
      ...startInput,
      idempotency_key: "k",
      verification_commands: [{ argv: ["npm", "test"] }],
    });
    expect(r).toMatchObject({ ok: false, error: { code: "conflict" } });
  });

  it("月額の枠が足りなければ budget_exceeded（TaskDO も作らない）", async () => {
    const svc = createTaskService(env);
    const p = principal();
    await runInDurableObject(userStub(p.githubUserId), (i) => {
      (i as unknown as { monthlyLimitUsd: () => number }).monthlyLimitUsd = () => 5;
    });
    const r = await svc.start(p, { ...startInput });
    expect(r).toMatchObject({ ok: false, error: { code: "budget_exceeded" } });
  });

  it("回収済み(tombstone)のキーで再試行すると expired", async () => {
    let failFirst = true;
    const svc = createTaskService(env, {
      tasks: (id) => {
        const real = taskStub(id);
        return new Proxy(real, {
          get(target, prop) {
            if (prop === "ensureCreated") {
              return async (input: never) => {
                if (failFirst) {
                  failFirst = false;
                  throw new Error("lost");
                }
                return target.ensureCreated(input);
              };
            }
            return Reflect.get(target, prop);
          },
        });
      },
    });
    const p = principal();
    await expect(svc.start(p, { ...startInput, idempotency_key: "stale" })).rejects.toThrow("lost");
    // 10分経過させ、別キーの start で未作成の予約を回収(tombstone)させる
    const { runInDurableObject } = await import("cloudflare:test");
    const t = Date.now() + 11 * 60 * 1000;
    await runInDurableObject(userStub(p.githubUserId), (i) => {
      (i as unknown as { now: () => number }).now = () => t;
    });
    expect((await svc.start(p, { ...startInput, idempotency_key: "fresh", title: "x" })).ok).toBe(
      true,
    );
    // 古いキーでの再試行は拒否される。新しく始めるには新しいキーが必要
    expect(await svc.start(p, { ...startInput, idempotency_key: "stale" })).toMatchObject({
      ok: false,
      error: { code: "expired" },
    });
  });
});

describe("task service: status / wait / cancel", () => {
  async function started() {
    const svc = createTaskService(env);
    const p = principal();
    const r = await svc.start(p, { ...startInput });
    if (!r.ok) throw new Error("start failed");
    return { svc, p, taskId: r.value.task_id };
  }

  it("status は仕様の項目を返す", async () => {
    const { svc, p, taskId } = await started();
    const r = await svc.status(p, taskId);
    expect(r.ok && r.value).toMatchObject({
      task_id: taskId,
      status: "RUNNING",
      repository: "acme/widgets",
      title: "Implement authentication",
      draft_pr_url: expect.stringMatching(/\/pull\/\d+$/),
      latest_cursor: "3",
    });
    expect(r.ok && Date.parse(r.value.created_at)).not.toBeNaN();
    expect(r.ok && Date.parse(r.value.updated_at)).not.toBeNaN();
  });

  it("別ユーザー・存在しない・形式不正の task_id はすべて not_found", async () => {
    const { svc, taskId } = await started();
    const other = principal();
    for (const id of [taskId, newTaskId(), "task_123", ""]) {
      for (const call of [
        () => svc.status(other, id),
        () => svc.wait(other, { task_id: id }),
        () => svc.cancel(other, id),
      ]) {
        const r = await call();
        expect(r).toMatchObject({ ok: false, error: { code: "not_found" } });
      }
    }
  });

  it("wait は task_id を付けて返し、invalid_cursor / invalid_input を写す", async () => {
    const { svc, p, taskId } = await started();
    const r = await svc.wait(p, { task_id: taskId, cursor: "0", timeout_seconds: 0 });
    expect(r.ok && r.value).toMatchObject({ task_id: taskId, status: "RUNNING", cursor: "3" });
    expect(await svc.wait(p, { task_id: taskId, cursor: "99" })).toMatchObject({
      ok: false,
      error: { code: "invalid_cursor" },
    });
    expect(await svc.wait(p, { task_id: taskId, timeout_seconds: -1 })).toMatchObject({
      ok: false,
      error: { code: "invalid_input" },
    });
  });

  it("wait の retry_after_seconds を error ではなく結果に含める", async () => {
    const { svc, p, taskId } = await started();
    const pendings = Array.from({ length: 16 }, () =>
      svc.wait(p, { task_id: taskId, cursor: "3", timeout_seconds: 30 }),
    );
    const { runInDurableObject } = await import("cloudflare:test");
    for (let i = 0; i < 200; i++) {
      const n = await runInDurableObject(taskStub(taskId), (inst) => {
        return (inst as unknown as { waiters: Set<unknown> }).waiters.size;
      });
      if (n >= 16) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    const over = await svc.wait(p, { task_id: taskId, cursor: "3" });
    expect(over.ok && over.value.retry_after_seconds).toBeGreaterThan(0);
    await svc.cancel(p, taskId);
    await Promise.all(pendings);
  });

  it("cancel: TaskDO を CANCELLED にし、予約を解放する（新しい start が通る）", async () => {
    const { svc, p, taskId } = await started();
    const c = await svc.cancel(p, taskId);
    expect(c).toMatchObject({ ok: true, value: { task_id: taskId, status: "CANCELLED" } });
    const w = await svc.wait(p, { task_id: taskId, cursor: "3", timeout_seconds: 5 });
    expect(w.ok && w.value.events.map((e) => e.type)).toEqual(["cancelled"]);
    const next = await svc.start(p, { ...startInput, title: "next" });
    expect(next.ok).toBe(true);
  });

  it("cancel は冪等（2回目も成功し、イベントは増えない）", async () => {
    const { svc, p, taskId } = await started();
    await svc.cancel(p, taskId);
    expect(await svc.cancel(p, taskId)).toMatchObject({ ok: true, value: { status: "CANCELLED" } });
    const w = await svc.wait(p, { task_id: taskId, timeout_seconds: 0 });
    expect(w.ok && w.value.events).toHaveLength(4);
  });

  it("停止が確認できるまで枠は解放されない。確認できたら次の start が通る", async () => {
    const { svc, p, taskId } = await started();
    await fakeAgent(taskId).setProgram({ cancel: ["not_stopped"] });
    expect(await svc.cancel(p, taskId)).toMatchObject({ ok: true, value: { status: "CANCELLED" } });
    // AgentDO の停止が確認できていない
    expect(await svc.start(p, { ...startInput, title: "next" })).toMatchObject({
      ok: false,
      error: { code: "concurrency_limit" },
    });
    // alarm の代わりに advance で再送する（stopped:true が返る）
    await taskStub(taskId).advance();
    expect((await svc.start(p, { ...startInput, title: "next" })).ok).toBe(true);
  });
});

describe("task service: result", () => {
  async function started() {
    const svc = createTaskService(env);
    const p = principal();
    const r = await svc.start(p, { ...startInput });
    if (!r.ok) throw new Error("start failed");
    return { svc, p, taskId: r.value.task_id };
  }

  it("終端でなければ not_ready", async () => {
    const { svc, p, taskId } = await started();
    expect(await svc.result(p, taskId)).toMatchObject({ ok: false, error: { code: "not_ready" } });
  });

  it("別ユーザー・存在しない・形式不正の task_id は not_found", async () => {
    const { svc, taskId } = await started();
    for (const id of [taskId, newTaskId(), "bad", ""]) {
      expect(await svc.result(principal(), id)).toMatchObject({
        ok: false,
        error: { code: "not_found" },
      });
    }
  });

  it("終端になれば結果を返す", async () => {
    const { svc, p, taskId } = await started();
    const agent = fakeAgent(taskId);
    await agent.setPhase("completed");
    await taskStub(taskId).advance();
    const r = await svc.result(p, taskId);
    expect(r).toMatchObject({
      ok: true,
      value: { task_id: taskId, status: "COMPLETED", summary: "fake summary" },
    });
  });

  it("AgentDO が使えなければ upstream_unavailable", async () => {
    const { svc, p, taskId } = await started();
    await svc.cancel(p, taskId);
    await runInDurableObject(taskStub(taskId), (i) => {
      (i as unknown as { agentStub: () => unknown }).agentStub = () => {
        throw new Error("down");
      };
    });
    expect(await svc.result(p, taskId)).toMatchObject({
      ok: false,
      error: { code: "upstream_unavailable" },
    });
  });
});
