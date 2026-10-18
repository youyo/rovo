import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { fakeAgent, newTaskId, newUserId, sampleInput, taskStub, userStub } from "./helpers";

const OWNER = 601;

type TaskStub = ReturnType<typeof taskStub>;

function rows<T>(stub: TaskStub, sql: string, ...b: unknown[]): Promise<T[]> {
  return runInDurableObject(
    stub,
    (_i, state) => state.storage.sql.exec(sql, ...b).toArray() as T[],
  );
}
const alarmOf = (stub: TaskStub) =>
  runInDurableObject(stub, (_i, state) => state.storage.getAlarm());

async function createTask(overrides: Record<string, unknown> = {}, owner = OWNER) {
  const id = newTaskId();
  const stub = taskStub(id);
  const r = await stub.ensureCreated(sampleInput(id, owner, overrides));
  if (!r.ok) throw new Error(`ensureCreated failed: ${r.code}`);
  return { id, stub, agent: fakeAgent(id) };
}

const statusOf = async (stub: TaskStub, owner = OWNER) => {
  const r = await stub.getStatus(owner);
  if (!r.ok) throw new Error("not found");
  return r.task.status;
};
const eventTypes = async (stub: TaskStub) =>
  (await rows<{ type: string }>(stub, "SELECT type FROM events ORDER BY seq")).map((e) => e.type);

describe("TaskDO: start の配送", () => {
  it("作成時に start の意図と taskSpec を記録し、alarm を設定する（CREATING も alarm の対象）", async () => {
    const { stub } = await createTask({
      verification_commands: [{ argv: ["npm", "test"], cwd: "pkg", timeout_seconds: 60 }],
    });
    const [link] = await rows<{ spec: string; start_state: string; cancel_state: string }>(
      stub,
      "SELECT spec, start_state, cancel_state FROM agent_link",
    );
    expect(link).toMatchObject({ start_state: "pending", cancel_state: "none" });
    const spec = JSON.parse(link?.spec ?? "{}");
    expect(spec).toMatchObject({
      userId: String(OWNER),
      repository: "acme/widgets",
      baseSha: "0123456789abcdef",
      instructions: "Implement OAuth authentication.",
      acceptanceCriteria: ["tests pass"],
      constraints: ["do not merge"],
      verificationCommands: [{ argv: ["npm", "test"], cwd: "pkg", timeoutSeconds: 60 }],
      budgetUsd: 10,
    });
    expect(spec.deadlineAt).toBeGreaterThan(Date.now() + 119 * 60_000);
    expect(spec.deadlineAt).toBeLessThanOrEqual(Date.now() + 120 * 60_000);
    expect(await alarmOf(stub)).not.toBeNull();
    expect(await statusOf(stub)).toBe("CREATING");
  });

  it("advance: AgentDO.start を呼び、accepted なら RUNNING へ（status_changed イベント）", async () => {
    const { id, stub, agent } = await createTask();
    await stub.advance();
    expect(await statusOf(stub)).toBe("RUNNING");
    expect(await eventTypes(stub)).toEqual([
      "created",
      "audit",
      "draft_pr_created",
      "status_changed",
    ]);
    const calls = await agent.calls();
    expect(calls.start).toBe(1);
    expect(calls.specs[0]).toMatchObject({ taskId: id, userId: String(OWNER) });
  });

  it("start が失敗しても CREATING のまま alarm が残り、alarm で再送されて RUNNING になる", async () => {
    const { stub, agent } = await createTask();
    await agent.setProgram({ start: ["throw", "throw"] });
    await stub.advance();
    expect(await statusOf(stub)).toBe("CREATING");
    expect(await alarmOf(stub)).not.toBeNull();
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await statusOf(stub)).toBe("CREATING");
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await statusOf(stub)).toBe("RUNNING");
    expect((await agent.calls()).start).toBe(3);
  });

  it("start の応答が失われても、同じ spec を再送して収束する", async () => {
    const { stub, agent } = await createTask();
    await agent.setProgram({ start: ["lose"] });
    await stub.advance();
    expect(await statusOf(stub)).toBe("CREATING");
    await runDurableObjectAlarm(stub);
    expect(await statusOf(stub)).toBe("RUNNING");
    const { specs, start } = await agent.calls();
    expect(start).toBe(2);
    expect(specs[1]).toEqual(specs[0]);
    expect(JSON.stringify(specs[1])).toBe(JSON.stringify(specs[0]));
  });

  it("応答喪失のあいだに AgentDO が先へ進んでいても、イベントを順に適用して状態に追いつく", async () => {
    const { stub, agent } = await createTask();
    await agent.setProgram({ start: ["lose"] });
    await stub.advance(); // 効果は起きたが CREATING のまま
    await agent.setPhase("verifying");
    await runDurableObjectAlarm(stub);
    expect(await statusOf(stub)).toBe("VERIFYING");
    expect(await eventTypes(stub)).toEqual([
      "created",
      "audit",
      "draft_pr_created",
      "status_changed",
      "status_changed",
    ]);
  });

  it("rejected は FAILED（理由つき）。再送せず、alarm は止まる", async () => {
    const { stub, agent } = await createTask();
    await agent.setProgram({ start: ["reject"], rejectReason: "unknown_model: x" });
    await stub.advance();
    expect(await statusOf(stub)).toBe("FAILED");
    const ev = await rows<{ type: string; payload: string }>(
      stub,
      "SELECT type, payload FROM events WHERE type = 'status_changed'",
    );
    expect(JSON.parse(ev[0]?.payload ?? "{}")).toMatchObject({
      status: "FAILED",
      reason: "unknown_model: x",
    });
    expect(await alarmOf(stub)).toBeNull();
    expect((await agent.calls()).start).toBe(1);
    expect(await stub.inspect()).toMatchObject({
      kind: "created",
      status: "FAILED",
      stopped: true,
    });
  });

  it("start が終端のあとに届いて cancelled が返っても、状態は変えない", async () => {
    const { stub, agent } = await createTask();
    await agent.cancel(); // AgentDO に tombstone だけがある
    await stub.cancel(OWNER);
    await stub.advance();
    expect(await statusOf(stub)).toBe("CANCELLED");
    expect((await agent.calls()).start).toBe(0); // 終端のタスクの start は送らない
  });
});

describe("TaskDO: キャンセルと停止確認", () => {
  it("cancel は CANCELLED 確定と同じトランザクションで cancel の意図を記録し、alarm を設定する", async () => {
    const { stub } = await createTask();
    await stub.cancel(OWNER);
    const [link] = await rows<{ cancel_state: string }>(
      stub,
      "SELECT cancel_state FROM agent_link",
    );
    expect(link?.cancel_state).toBe("pending");
    expect(await statusOf(stub)).toBe("CANCELLED");
    expect(await alarmOf(stub)).not.toBeNull();
    expect(await stub.inspect()).toMatchObject({
      kind: "created",
      status: "CANCELLED",
      stopped: false,
    });
  });

  it("cancel が start より先: start を送らず cancel だけを配送し、停止確認で完了する", async () => {
    const { stub, agent } = await createTask();
    await stub.cancel(OWNER);
    await stub.advance();
    const calls = await agent.calls();
    expect(calls.start).toBe(0);
    expect(calls.cancel).toBe(1);
    expect(await stub.inspect()).toMatchObject({ stopped: true });
    expect(await alarmOf(stub)).toBeNull();
  });

  it("cancel の配送失敗・未停止のあいだは再送し続け、stopped:true で止まる（終端後も）", async () => {
    const { stub, agent } = await createTask();
    await stub.advance(); // RUNNING
    await agent.setProgram({ cancel: ["throw", "not_stopped", "lose", "stopped"] });
    await stub.cancel(OWNER);
    for (let i = 0; i < 3; i++) {
      await stub.advance();
      expect(await stub.inspect()).toMatchObject({ status: "CANCELLED", stopped: false });
      expect(await alarmOf(stub)).not.toBeNull();
    }
    await runDurableObjectAlarm(stub);
    expect(await stub.inspect()).toMatchObject({ stopped: true });
    expect(await alarmOf(stub)).toBeNull();
    expect((await agent.calls()).cancel).toBe(4);
  });

  it("エージェント側の終端（completed）でも、cancel で停止を確認してから停止確認済みになる", async () => {
    const { stub, agent } = await createTask();
    await stub.advance();
    await agent.setPhase("completed");
    await agent.setProgram({ cancel: ["not_stopped", "stopped"] });
    await stub.advance();
    expect(await statusOf(stub)).toBe("COMPLETED");
    expect(await stub.inspect()).toMatchObject({ status: "COMPLETED", stopped: false });
    expect(await alarmOf(stub)).not.toBeNull();
    await runDurableObjectAlarm(stub);
    expect(await stub.inspect()).toMatchObject({ stopped: true });
    expect((await agent.calls()).cancel).toBe(2);
  });

  it("終端状態への cancel は何も変えない（停止確認の状態も触らない）", async () => {
    const { stub, agent } = await createTask();
    await stub.advance();
    await agent.setPhase("failed", "deadline");
    await stub.advance();
    const before = await eventTypes(stub);
    expect(await stub.cancel(OWNER)).toMatchObject({ ok: true, status: "FAILED", changed: false });
    expect(await eventTypes(stub)).toEqual(before);
  });
});

describe("TaskDO: イベントの取り込み", () => {
  it("AgentDO のイベントを要約・整形して取り込む（data をそのまま流さない）", async () => {
    const { stub, agent } = await createTask();
    await stub.advance();
    await agent.emit("tool_start", { callId: "c1", name: "bash", summary: "ls", secret: "x" });
    await agent.emit("tool_end", { callId: "c1", name: "bash", isError: false, summary: "ok" });
    await agent.emit("completion_report", { summary: "done" });
    await agent.emit("unknown_kind", { anything: "goes" });
    await stub.advance();
    const ev = await rows<{ type: string; payload: string }>(
      stub,
      "SELECT type, payload FROM events WHERE seq > 4 ORDER BY seq",
    );
    expect(ev.map((e) => e.type)).toEqual([
      "tool_start",
      "tool_end",
      "completion_report",
      "agent_event",
    ]);
    expect(JSON.parse(ev[0]?.payload ?? "{}")).toEqual({
      call_id: "c1",
      name: "bash",
      summary: "ls",
    });
    expect(ev[0]?.payload).not.toContain("secret");
    expect(JSON.parse(ev[3]?.payload ?? "{}")).toEqual({ agent_type: "unknown_kind" });
  });

  it("文字列は上限で切り詰める", async () => {
    const { stub, agent } = await createTask();
    await stub.advance();
    await agent.emit("tool_end", {
      callId: "c",
      name: "n",
      isError: true,
      summary: "x".repeat(10_000),
    });
    await stub.advance();
    const [e] = await rows<{ payload: string }>(
      stub,
      "SELECT payload FROM events WHERE type = 'tool_end'",
    );
    expect(e?.payload.length).toBeLessThan(1_000);
    expect(JSON.parse(e?.payload ?? "{}")).toMatchObject({ is_error: true });
  });

  it("(operation_id, agent_seq) は一意で、AgentDO の seq を記録する", async () => {
    const { stub, agent } = await createTask();
    await stub.advance();
    await agent.emit("tool_start", { callId: "c1", name: "bash", summary: "ls" });
    await stub.advance();
    const r = await rows<{ operation_id: string; agent_seq: number; type: string }>(
      stub,
      "SELECT operation_id, agent_seq, type FROM events WHERE agent_seq IS NOT NULL ORDER BY seq",
    );
    expect(r.map((x) => x.agent_seq)).toEqual([...new Set(r.map((x) => x.agent_seq))]);
    expect(r.at(-1)).toMatchObject({ type: "tool_start", agent_seq: 3 });
    expect(r[0]?.operation_id).toMatch(/^run:/);
    await expect(
      runInDurableObject(stub, (_i, state) =>
        state.storage.sql.exec(
          "INSERT INTO events (seq, type, payload, created_at, operation_id, agent_seq) VALUES (999, 't', '{}', 0, ?, 3)",
          r[0]?.operation_id,
        ),
      ),
    ).rejects.toThrow();
  });

  it("hasMore の間は取り込み続ける（ページ終端まで）", async () => {
    const { stub, agent } = await createTask();
    await stub.advance();
    for (let i = 0; i < 7; i++)
      await agent.emit("tool_start", { callId: `c${i}`, name: "n", summary: "s" });
    await agent.setProgram({ pageCap: 2 });
    await stub.advance();
    const n = await rows<{ c: number }>(
      stub,
      "SELECT COUNT(*) AS c FROM events WHERE type = 'tool_start'",
    );
    expect(n[0]?.c).toBe(7);
    expect((await agent.calls()).getEvents).toBeGreaterThanOrEqual(4);
  });

  it("終端 phase のイベントを取り込むまで終端に確定しない", async () => {
    const { stub, agent } = await createTask();
    await stub.advance();
    await agent.emit("tool_start", { callId: "c1", name: "n", summary: "s" });
    await agent.emit("tool_start", { callId: "c2", name: "n", summary: "s" });
    await agent.setPhase("completed");
    // 2 ページ目（終端 phase を含む）の取得が失敗する
    await agent.setProgram({ pageCap: 2, getEventsFailAfter: 1 + (await agent.calls()).getEvents });
    await stub.advance();
    expect(await statusOf(stub)).toBe("RUNNING");
    await agent.setProgram({ pageCap: 2 });
    await stub.advance();
    expect(await statusOf(stub)).toBe("COMPLETED");
    const types = await eventTypes(stub);
    // 終端の status_changed の後に続くのは、終端処理の audit（トークンの失効）だけ
    expect(types.slice(types.lastIndexOf("status_changed") + 1).every((t) => t === "audit")).toBe(
      true,
    );
  });

  it("古いページが再配送されても重複しない（カーソルと一意制約）", async () => {
    const { stub, agent } = await createTask();
    await stub.advance();
    await agent.emit("tool_start", { callId: "c", name: "n", summary: "s" });
    await stub.advance();
    const before = await eventTypes(stub);
    await agent.setProgram({ staleOnce: true });
    await stub.advance();
    expect(await eventTypes(stub)).toEqual(before);
  });

  it("task_wait と alarm が同時に同じ範囲を取りに行っても重複しない", async () => {
    const { stub, agent } = await createTask();
    await stub.advance();
    for (let i = 0; i < 3; i++)
      await agent.emit("tool_start", { callId: `c${i}`, name: "n", summary: "s" });
    await agent.setProgram({ getEventsDelayMs: 50 });
    await Promise.all([
      stub.advance(),
      stub.wait(OWNER, "0", 0),
      stub.wait(OWNER, "0", 0),
      runDurableObjectAlarm(stub),
    ]);
    const r = await rows<{ c: number; d: number }>(
      stub,
      "SELECT COUNT(*) AS c, COUNT(DISTINCT agent_seq) AS d FROM events WHERE agent_seq IS NOT NULL",
    );
    expect(r[0]?.c).toBe(r[0]?.d);
    expect(
      (
        await rows<{ c: number }>(
          stub,
          "SELECT COUNT(*) AS c FROM events WHERE type = 'tool_start'",
        )
      )[0]?.c,
    ).toBe(3);
  });

  it("task_wait は返す前に AgentDO から取り込む", async () => {
    const { stub, agent } = await createTask();
    await stub.advance();
    const w0 = await stub.wait(OWNER, undefined, 0);
    const cursor = w0.ok ? w0.cursor : "";
    await agent.emit("tool_start", { callId: "c", name: "n", summary: "s" });
    const w = await stub.wait(OWNER, cursor, 0);
    expect(w.ok && w.events.map((e) => e.type)).toEqual(["tool_start"]);
  });

  it("task_wait の待機中に AgentDO で起きたイベントを、定期的な取り込みで拾って返す", async () => {
    const { stub, agent } = await createTask();
    await stub.advance();
    await runInDurableObject(stub, (i) => {
      (i as unknown as { pollIntervalMs: number }).pollIntervalMs = 30;
    });
    const cursor = (await stub.getStatus(OWNER)).ok ? "4" : "";
    const waiting = stub.wait(OWNER, cursor, 5);
    await new Promise((r) => setTimeout(r, 100));
    await agent.emit("tool_start", { callId: "c", name: "n", summary: "s" });
    const t0 = Date.now();
    const w = await waiting;
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(w.ok && w.events.map((e) => e.type)).toEqual(["tool_start"]);
  });

  it("利用者の cancel の後は、公開イベントを増やさない（取り込みは続ける）", async () => {
    const { stub, agent } = await createTask();
    await stub.advance();
    await stub.cancel(OWNER);
    // 終端処理（トークンの失効の audit など）を済ませてから、子の遅れて届くイベントが公開されないことを確かめる
    await stub.advance();
    const before = await eventTypes(stub);
    await agent.emit("tool_end", { callId: "c", name: "n", isError: false, summary: "late" });
    await stub.advance();
    expect(await eventTypes(stub)).toEqual(before);
    expect(await statusOf(stub)).toBe("CANCELLED");
  });
});

describe("TaskDO: usage の精算と終了時の返却", () => {
  async function reserved() {
    const uid = newUserId();
    const user = userStub(uid);
    const r = await user.reserve("k", FP);
    if (!r.ok) throw new Error("reserve");
    const stub = taskStub(r.task_id);
    const c = await stub.ensureCreated(sampleInput(r.task_id, uid));
    if (!c.ok) throw new Error("create");
    return { uid, user, id: r.task_id, stub, agent: fakeAgent(r.task_id) };
  }
  const budgetRow = (user: ReturnType<typeof userStub>, id: string) =>
    runInDurableObject(
      user,
      (_i, state) =>
        state.storage.sql
          .exec(
            "SELECT reserved_micro, settled_micro, settled_seq, closed FROM task_budget WHERE task_id = ?",
            id,
          )
          .toArray()[0],
    );
  const FP = "f".repeat(64);

  it("usage イベントを取り込むたびに UserDO へ精算する（累計・seq で冪等）", async () => {
    const { user, id, stub, agent } = await reserved();
    await stub.advance();
    const s1 = await agent.setUsage(0.5);
    await stub.advance();
    expect(await budgetRow(user, id)).toMatchObject({
      reserved_micro: 10_000_000,
      settled_micro: 500_000,
      settled_seq: s1,
      closed: 0,
    });
    const s2 = await agent.setUsage(1.25);
    await stub.advance();
    await stub.advance();
    expect(await budgetRow(user, id)).toMatchObject({ settled_micro: 1_250_000, settled_seq: s2 });
  });

  it("UserDO への精算が失敗しても取り込みは進み、次の alarm で精算される", async () => {
    const { user, id, stub, agent } = await reserved();
    await stub.advance();
    await runInDurableObject(stub, (i) => {
      const t = i as unknown as { userStub: (n: number) => unknown };
      const orig = t.userStub.bind(i);
      let fail = true;
      t.userStub = (n: number) => {
        if (fail) {
          fail = false;
          throw new Error("user do down");
        }
        return orig(n);
      };
    });
    await agent.setUsage(2);
    await stub.advance();
    expect(await budgetRow(user, id)).toMatchObject({ settled_micro: 0 });
    expect(await alarmOf(stub)).not.toBeNull();
    await runDurableObjectAlarm(stub);
    expect(await budgetRow(user, id)).toMatchObject({ settled_micro: 2_000_000 });
  });

  it("終端かつ停止確認済みで、実費との差額を返し、同時実行枠を解放する", async () => {
    const { user, id, stub, agent } = await reserved();
    await stub.advance();
    await agent.setUsage(3.5);
    await agent.setPhase("completed");
    await stub.advance();
    expect(await budgetRow(user, id)).toMatchObject({ settled_micro: 3_500_000, closed: 1 });
    const res = await runInDurableObject(user, (_i, s) =>
      s.storage.sql.exec("SELECT active_task_id FROM reservation").one(),
    );
    expect(res.active_task_id).toBeNull();
    expect(await alarmOf(stub)).toBeNull();
  });

  it("停止が確認できないあいだは枠を解放しない（古いタスクが動いたまま次が始まらない）", async () => {
    const { uid, user, id, stub, agent } = await reserved();
    await stub.advance();
    await agent.setProgram({ cancel: ["not_stopped", "not_stopped"] });
    expect(await stub.cancel(uid)).toMatchObject({ ok: true, status: "CANCELLED" });
    await stub.advance();
    const res = await runInDurableObject(user, (_i, s) =>
      s.storage.sql.exec("SELECT active_task_id FROM reservation").one(),
    );
    expect(res.active_task_id).toBe(id);
    expect(await budgetRow(user, id)).toMatchObject({ closed: 0 });
  });

  it("キャンセル後に届いた最後の usage まで精算してから枠を閉じる", async () => {
    const { uid, user, id, stub, agent } = await reserved();
    await stub.advance();
    await agent.setUsage(1);
    await stub.advance();
    await agent.setProgram({ cancel: ["not_stopped", "stopped"] });
    // 停止の確認が取れるまでの間に最後の usage が積まれる
    expect(await stub.cancel(uid)).toMatchObject({ ok: true, status: "CANCELLED" });
    await stub.advance();
    await agent.setUsage(4);
    await stub.advance();
    expect(await budgetRow(user, id)).toMatchObject({ settled_micro: 4_000_000, closed: 1 });
  });
});

describe("TaskDO: 最終取り込みは finalSeq まで", () => {
  async function reservedTask() {
    const uid = newUserId();
    const user = userStub(uid);
    const r = await user.reserve("k", "f".repeat(64));
    if (!r.ok) throw new Error("reserve");
    const stub = taskStub(r.task_id);
    await stub.ensureCreated(sampleInput(r.task_id, uid));
    return { uid, user, id: r.task_id, stub, agent: fakeAgent(r.task_id) };
  }
  const budget = (user: ReturnType<typeof userStub>, id: string) =>
    runInDurableObject(
      user,
      (_i, s) =>
        s.storage.sql
          .exec("SELECT settled_micro, closed FROM task_budget WHERE task_id = ?", id)
          .toArray() as { settled_micro: number; closed: number }[],
    );

  it("cancel の stopped:true と finalSeq を記録し、取り込みカーソルは finalSeq に達する", async () => {
    const { uid, stub, agent } = await reservedTask();
    await stub.advance();
    await agent.setUsage(1);
    await stub.cancel(uid);
    await stub.advance();
    const [link] = await rows<{ final_seq: number | null; ingest_cursor: number }>(
      stub,
      "SELECT final_seq, ingest_cursor FROM agent_link",
    );
    expect(link?.final_seq).toBeGreaterThan(0);
    expect(link?.ingest_cursor).toBe(link?.final_seq);
  });

  it("停止確認の前後に usage があっても、finalSeq までの usage をすべて精算してから finish する", async () => {
    const { uid, user, id, stub, agent } = await reservedTask();
    await stub.advance();
    await agent.setUsage(1);
    await stub.advance();
    await agent.setProgram({ cancel: ["not_stopped", "stopped"] });
    await stub.cancel(uid);
    await stub.advance(); // 未停止
    await agent.setUsage(4); // 停止処理の途中で積まれた最後の usage
    await stub.advance(); // 停止確認 + finalSeq まで取り込み
    expect(await budget(user, id)).toEqual([{ settled_micro: 4_000_000, closed: 1 }]);
  });

  it("読み取りが遅れて finalSeq に届かないページ(hasMore:false)では finish しない。届いてから finish する", async () => {
    const { uid, user, id, stub, agent } = await reservedTask();
    await stub.advance();
    const first = await agent.setUsage(1);
    await agent.setUsage(4);
    // 最後の usage がまだ読めない
    await agent.setProgram({ visibleThrough: first });
    await stub.cancel(uid);
    await stub.advance();
    expect(await budget(user, id)).toEqual([{ settled_micro: 1_000_000, closed: 0 }]);
    const res = await runInDurableObject(user, (_i, s) =>
      s.storage.sql.exec("SELECT active_task_id FROM reservation").one(),
    );
    expect(res.active_task_id).toBe(id);
    expect(await alarmOf(stub)).not.toBeNull();

    await agent.setProgram({});
    await runDurableObjectAlarm(stub);
    expect(await budget(user, id)).toEqual([{ settled_micro: 4_000_000, closed: 1 }]);
    expect(await alarmOf(stub)).toBeNull();
  });
});

describe("TaskDO: task_wait は期限内に返る", () => {
  /** AgentDO / UserDO への RPC を、5 秒後に失敗するまで応答しないものに差し替える。 */
  async function hangRpc(stub: TaskStub, targets: { agent?: boolean; user?: boolean }) {
    await runInDurableObject(stub, (i) => {
      const t = i as unknown as {
        agentStub: () => unknown;
        userStub: (n: number) => unknown;
        __hung: { getEvents: number };
      };
      const hang = () =>
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error("hung rpc")), 5_000));
      t.__hung = { getEvents: 0 };
      const origAgent = t.agentStub.bind(i);
      const origUser = t.userStub.bind(i);
      if (targets.agent) {
        t.agentStub = () => ({
          ...(origAgent() as object),
          getEvents: () => {
            t.__hung.getEvents++;
            return hang();
          },
        });
      }
      if (targets.user) {
        t.userStub = (n: number) => ({
          settleUsage: hang,
          finishTask: hang,
          ...(origUser(n) as object),
        });
      }
    });
  }
  const hungCalls = (stub: TaskStub) =>
    runInDurableObject(stub, (i) => (i as unknown as { __hung: { getEvents: number } }).__hung);

  async function timed(p: PromiseLike<unknown>) {
    const t0 = Date.now();
    const v = await Promise.race([
      Promise.resolve(p),
      new Promise<"never">((r) => setTimeout(() => r("never"), 4_000)),
    ]);
    return { v, ms: Date.now() - t0 };
  }

  it("timeout_seconds=0: getEvents が応答しなくても、すぐ保存済みのイベントで返る", async () => {
    const { stub } = await createTask();
    await stub.advance();
    await hangRpc(stub, { agent: true });
    const { v, ms } = await timed(stub.wait(OWNER, "0", 0));
    expect(v).not.toBe("never");
    expect(ms).toBeLessThan(2_000);
    expect(v).toMatchObject({ ok: true, status: "RUNNING" });
    expect((v as { events: unknown[] }).events.length).toBeGreaterThan(0);
  });

  it("短い timeout(1 秒): 待機の全体が期限(約 1 秒)で終わる", async () => {
    const { stub } = await createTask();
    await stub.advance();
    await hangRpc(stub, { agent: true });
    const latest = await stub.getStatus(OWNER);
    const cursor = latest.ok ? latest.task.latest_cursor : "0";
    const { v, ms } = await timed(stub.wait(OWNER, cursor, 1));
    expect(v).toMatchObject({ ok: true, events: [] });
    expect(ms).toBeGreaterThanOrEqual(900);
    expect(ms).toBeLessThan(2_500);
  });

  it("進行中の取り込みは単一のまま: 続けて wait しても getEvents を重ねて呼ばない", async () => {
    const { stub } = await createTask();
    await stub.advance();
    await hangRpc(stub, { agent: true });
    await timed(stub.wait(OWNER, "0", 0));
    await timed(stub.wait(OWNER, "0", 0));
    expect((await hungCalls(stub)).getEvents).toBe(1);
  });

  it("終端のタスク: 精算 / 終了通知が応答しなくても待たずに返る", async () => {
    const { uid, stub } = await (async () => {
      const uid = newUserId();
      const id = newTaskId();
      const stub = taskStub(id);
      await stub.ensureCreated(sampleInput(id, uid));
      return { uid, stub };
    })();
    await stub.advance();
    await stub.cancel(uid);
    await stub.advance(); // 停止確認まで済ませる
    // 終了通知が未達の状態に戻す（次の取り込みで finishTask を呼ぼうとする）
    await rows(stub, "UPDATE agent_link SET finished = 0");
    await hangRpc(stub, { user: true });
    const { v, ms } = await timed(stub.wait(uid, "0", 30));
    expect(v).toMatchObject({ ok: true, status: "CANCELLED" });
    expect(ms).toBeLessThan(2_500);
  });
});

describe("TaskDO.result", () => {
  it("owner が違えば not_found", async () => {
    const { stub } = await createTask();
    expect(await stub.result(999)).toEqual({ ok: false, code: "not_found" });
  });

  it("終端でなければ not_ready", async () => {
    const { stub } = await createTask();
    await stub.advance();
    expect(await stub.result(OWNER)).toEqual({ ok: false, code: "not_ready" });
  });

  it("終端でも停止が確認できるまでは not_ready", async () => {
    const { stub, agent } = await createTask();
    await stub.advance();
    await agent.setProgram({ cancel: ["not_stopped"] });
    await stub.cancel(OWNER);
    await stub.advance();
    expect(await stub.result(OWNER)).toEqual({ ok: false, code: "not_ready" });
  });

  it("終端なら AgentDO の結果を整形して返す", async () => {
    const { stub, agent } = await createTask();
    await stub.advance();
    await agent.setProgram({
      result: {
        status: "completed",
        summary: "done",
        verification: {
          commands: [{ argv: ["npm", "test"], timeoutSeconds: 60 }],
          results: [{ argv: ["npm", "test"], exitCode: 0, timedOut: false, output: "ok" }],
          verified: true,
          attempts: 1,
          commitSha: "a".repeat(40),
        },
        warnings: ["w"],
        pushedSha: "a".repeat(40),
        patch: "diff --git",
        patchTooLarge: false,
        usage: {
          costUsd: 1.5,
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 1,
          cacheWriteTokens: 2,
          web: { search: 3, fetch: 4, browse: 0 },
        },
      },
    });
    await agent.setPhase("completed");
    await stub.advance();
    const r = await stub.result(OWNER);
    expect(r).toEqual({
      ok: true,
      result: {
        status: "COMPLETED",
        summary: "done",
        verification: {
          commands: [{ argv: ["npm", "test"], timeout_seconds: 60 }],
          results: [{ argv: ["npm", "test"], exit_code: 0, timed_out: false, output: "ok" }],
          verified: true,
          attempts: 1,
          commit_sha: "a".repeat(40),
        },
        warnings: ["w", expect.stringMatching(/^head_moved_after_verification/)],
        pr: {
          number: expect.any(Number),
          url: expect.stringMatching(/\/pull\/\d+$/),
          // 終端の PR 更新（head の読み取り）が済んでいる。commit_sha（pushedSha と同じ）は PR の head と一致しない。
          head_sha: expect.stringMatching(/^[0-9a-f]{40}$/),
          head_matches_verified: false,
        },
        patch: "diff --git",
        patch_too_large: false,
        usage: {
          cost_usd: 1.5,
          input_tokens: 10,
          output_tokens: 5,
          cache_read_tokens: 1,
          cache_write_tokens: 2,
          web: { search: 3, fetch: 4, browse: 0 },
        },
      },
    });
  });

  it("verification の output は UTF-8 のバイト数で 16KiB に切り詰める（末尾を残し、文字を壊さない）", async () => {
    const { stub, agent } = await createTask();
    await stub.advance();
    const output = `HEAD${"あ".repeat(10_000)}TAIL`; // 約 30KB。UTF-16 の長さでは 10,008 しかない
    await agent.setProgram({
      result: {
        status: "completed",
        summary: "s",
        verification: {
          commands: [],
          results: [{ argv: ["t"], exitCode: 0, timedOut: false, output }],
          verified: true,
          attempts: 1,
        },
        warnings: [],
        patchTooLarge: false,
        usage: {
          costUsd: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          web: { search: 0, fetch: 0, browse: 0 },
        },
      },
    });
    await agent.setPhase("completed");
    await stub.advance();
    const r = await stub.result(OWNER);
    if (!r.ok) throw new Error("result");
    const out = r.result.verification.results[0]?.output ?? "";
    expect(new TextEncoder().encode(out).length).toBeLessThanOrEqual(16 * 1024);
    expect(out.endsWith("TAIL")).toBe(true);
    expect(out).not.toContain("\uFFFD");
    expect(out).not.toContain("HEAD");
  });

  it("短い output はそのまま返す", async () => {
    const { stub, agent } = await createTask();
    await stub.advance();
    await agent.setProgram({
      result: {
        status: "completed",
        summary: "s",
        verification: {
          commands: [],
          results: [{ argv: ["t"], exitCode: 0, timedOut: false, output: "日本語ok" }],
          verified: true,
          attempts: 1,
        },
        warnings: [],
        patchTooLarge: false,
        usage: {
          costUsd: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          web: { search: 0, fetch: 0, browse: 0 },
        },
      },
    });
    await agent.setPhase("completed");
    await stub.advance();
    const r = await stub.result(OWNER);
    expect(r.ok && r.result.verification.results[0]?.output).toBe("日本語ok");
  });

  it("start より先に cancel して AgentDO に結果が無いときは、TaskDO の状態から合成して返す", async () => {
    const { stub } = await createTask();
    await stub.cancel(OWNER);
    await stub.advance();
    const r = await stub.result(OWNER);
    expect(r).toMatchObject({
      ok: true,
      result: { status: "CANCELLED", summary: "", patch_too_large: false },
    });
  });

  it("AgentDO の呼び出しが失敗したら upstream_unavailable", async () => {
    const { stub } = await createTask();
    await stub.cancel(OWNER);
    await stub.advance();
    await runInDurableObject(stub, (i) => {
      (i as unknown as { agentStub: () => unknown }).agentStub = () => {
        throw new Error("down");
      };
    });
    expect(await stub.result(OWNER)).toEqual({ ok: false, code: "upstream_unavailable" });
  });

  it("AgentDO の getResult が返らなくても、期限が来たら upstream_unavailable", async () => {
    const { stub } = await createTask();
    await stub.cancel(OWNER);
    await stub.advance();
    await runInDurableObject(stub, (i) => {
      const t = i as unknown as { agentStub: () => unknown; resultTimeoutMs: number };
      t.resultTimeoutMs = 200;
      t.agentStub = () => ({ getResult: () => new Promise<never>(() => {}) });
    });
    const started = Date.now();
    expect(await stub.result(OWNER)).toEqual({ ok: false, code: "upstream_unavailable" });
    expect(Date.now() - started).toBeLessThan(3_000);
  });
});
