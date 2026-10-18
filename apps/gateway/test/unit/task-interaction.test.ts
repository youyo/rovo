import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getFakeApp, type UnitGitHubEnv } from "../support/unit-github";
import { fakeAgent, newTaskId, sampleInput, taskStub } from "./helpers";

// Phase 4 M2: 親子間の対話（question / task_answer / task_steer）の TaskDO 側。
const OWNER = 801;
const app = () => getFakeApp(env as unknown as UnitGitHubEnv);

type TaskStub = ReturnType<typeof taskStub>;

function rows<T>(stub: TaskStub, sql: string, ...b: unknown[]): Promise<T[]> {
  return runInDurableObject(
    stub,
    (_i, state) => state.storage.sql.exec(sql, ...b).toArray() as T[],
  );
}
const alarmOf = (stub: TaskStub) =>
  runInDurableObject(stub, (_i, state) => state.storage.getAlarm());

async function createTask() {
  const id = newTaskId();
  const stub = taskStub(id);
  const r = await stub.ensureCreated(sampleInput(id, OWNER));
  if (!r.ok) throw new Error(`ensureCreated failed: ${r.code}`);
  return { id, stub, agent: fakeAgent(id) };
}

/** RUNNING まで進める。 */
async function createRunning() {
  const t = await createTask();
  await t.stub.advance();
  return t;
}

/** 子が質問し、TaskDO が取り込んで INPUT_REQUIRED になるまで進める。 */
async function createAsked(qid = "q1", message = "which db?", options: string[] = ["pg", "mysql"]) {
  const t = await createRunning();
  await t.agent.ask(qid, message, options);
  await t.stub.advance();
  return t;
}

const task = async (stub: TaskStub) => {
  const r = await stub.getStatus(OWNER);
  if (!r.ok) throw new Error("not found");
  return r.task;
};
const statusOf = async (stub: TaskStub) => (await task(stub)).status;
const eventsOf = async (stub: TaskStub, type: string) =>
  (await rows<{ payload: string }>(stub, "SELECT payload FROM events WHERE type = ?", type)).map(
    (e) => JSON.parse(e.payload) as Record<string, unknown>,
  );
const eventTypes = async (stub: TaskStub) =>
  (await rows<{ type: string }>(stub, "SELECT type FROM events ORDER BY seq")).map((e) => e.type);
const questionRow = async (stub: TaskStub, qid = "q1") =>
  (
    await rows<{
      question_id: string;
      message: string;
      options: string;
      answer: string | null;
      delivery_state: string;
    }>(stub, "SELECT * FROM questions WHERE question_id = ?", qid)
  )[0];
const steerRow = async (stub: TaskStub, steerId: string) =>
  (
    await rows<{ message: string; delivery_state: string }>(
      stub,
      "SELECT message, delivery_state FROM steers WHERE steer_id = ?",
      steerId,
    )
  )[0];

/** DO の時計と偽 GitHub の時計を、同じだけ進める。 */
async function warp(stub: TaskStub, ms: number) {
  const clock = () => Date.now() + ms;
  await runInDurableObject(stub, (i) => {
    (i as unknown as { now: () => number }).now = clock;
  });
  app().now = clock;
}

describe("question の取り込み", () => {
  it("question で INPUT_REQUIRED になり、イベントと questions 行を同じ回で保存する", async () => {
    const { stub } = await createAsked("q1", "which db?", ["pg", "mysql"]);
    expect(await statusOf(stub)).toBe("INPUT_REQUIRED");
    expect(await eventsOf(stub, "question")).toEqual([
      { question_id: "q1", message: "which db?", options: JSON.stringify(["pg", "mysql"]) },
    ]);
    expect(await questionRow(stub)).toMatchObject({
      message: "which db?",
      options: JSON.stringify(["pg", "mysql"]),
      answer: null,
      delivery_state: "none",
    });
  });

  it("task_status の pending_question に未回答の質問が入る。回答後は null", async () => {
    const { stub } = await createAsked();
    expect((await task(stub)).pending_question).toEqual({
      question_id: "q1",
      message: "which db?",
      options: ["pg", "mysql"],
    });
    await stub.answer(OWNER, "q1", "pg");
    await stub.advance();
    expect((await task(stub)).pending_question).toBeNull();
  });

  it("質問の前は pending_question が null", async () => {
    const { stub } = await createRunning();
    expect((await task(stub)).pending_question).toBeNull();
  });

  it("4,000 文字の質問と 10 個の options が task_wait に欠けずに届く", async () => {
    const message = "あ".repeat(4_000);
    const options = Array.from({ length: 10 }, (_, i) => `${i}-${"o".repeat(490)}`);
    const { stub } = await createAsked("q1", message, options);
    const w = await stub.wait(OWNER, "0", 0);
    if (!w.ok) throw new Error("wait failed");
    const q = w.events.find((e) => e.type === "question");
    expect(q?.payload.message).toBe(message);
    expect(JSON.parse(String(q?.payload.options))).toEqual(options);
  });

  it("question_id が重複して届いても質問は 1 件", async () => {
    const { stub, agent } = await createAsked();
    await agent.emit("question", { question_id: "q1", message: "dup", options: "[]" });
    await stub.advance();
    const n = await rows<{ c: number }>(stub, "SELECT COUNT(*) AS c FROM questions");
    expect(n[0]?.c).toBe(1);
    expect((await questionRow(stub))?.message).toBe("which db?");
  });

  it("回答待ちの間も同時実行の枠は持ち続ける（終端でないので finished にならない）", async () => {
    const { stub } = await createAsked();
    expect(await stub.inspect()).toMatchObject({ status: "INPUT_REQUIRED", stopped: false });
  });
});

describe("answer（task_answer の TaskDO 側）", () => {
  it("回答を永続化して配送の意図を記録し、advance で AgentDO.answer に届く", async () => {
    const { stub, agent } = await createAsked();
    const r = await stub.answer(OWNER, "q1", "pg");
    expect(r).toMatchObject({ ok: true, status: "INPUT_REQUIRED" });
    expect(await questionRow(stub)).toMatchObject({ answer: "pg", delivery_state: "pending" });
    expect((await agent.calls()).answer).toBe(0);
    await stub.advance();
    expect((await agent.calls()).answers).toEqual([{ questionId: "q1", answer: "pg" }]);
    expect(await questionRow(stub)).toMatchObject({ answer: "pg", delivery_state: "delivered" });
    expect(await statusOf(stub)).toBe("RUNNING");
    expect(await eventsOf(stub, "answered")).toEqual([{ question_id: "q1" }]);
  });

  it("配送が失敗・未完了のあいだは alarm で再送し、ok:true で止まる", async () => {
    const { stub, agent } = await createAsked();
    await agent.setProgram({ answer: ["throw", "not_ok", "lose", "ok"] });
    await stub.answer(OWNER, "q1", "pg");
    for (let i = 0; i < 3; i++) {
      await stub.advance();
      expect((await questionRow(stub))?.delivery_state).toBe("pending");
      expect(await alarmOf(stub)).not.toBeNull();
    }
    // lose は効果が起きているので、次の ok は ignored 相当でも配送完了になる
    await runDurableObjectAlarm(stub);
    expect((await questionRow(stub))?.delivery_state).toBe("delivered");
    expect((await agent.calls()).answer).toBe(4);
    await runDurableObjectAlarm(stub);
    expect((await agent.calls()).answer).toBe(4);
  });

  it("ignored:true も配送完了として再送をやめる", async () => {
    const { stub, agent } = await createAsked();
    await agent.setProgram({ answer: ["ignored"] });
    await stub.answer(OWNER, "q1", "pg");
    await stub.advance();
    expect((await questionRow(stub))?.delivery_state).toBe("delivered");
    await stub.advance();
    expect((await agent.calls()).answer).toBe(1);
  });

  it("同じ回答の再送は、RUNNING に戻った後でも成功する（AgentDO へは再送しない）", async () => {
    const { stub, agent } = await createAsked();
    await stub.answer(OWNER, "q1", "pg");
    await stub.advance();
    expect(await statusOf(stub)).toBe("RUNNING");
    expect(await stub.answer(OWNER, "q1", "pg")).toMatchObject({ ok: true, status: "RUNNING" });
    await stub.advance();
    expect((await agent.calls()).answer).toBe(1);
  });

  it("同じ回答の再送は、配送前でも成功し、意図を二重に作らない", async () => {
    const { stub, agent } = await createAsked();
    await stub.answer(OWNER, "q1", "pg");
    expect(await stub.answer(OWNER, "q1", "pg")).toMatchObject({ ok: true });
    await stub.advance();
    expect((await agent.calls()).answer).toBe(1);
  });

  it("違う回答は conflict（INPUT_REQUIRED のままでも、RUNNING に戻った後でも）", async () => {
    const { stub } = await createAsked();
    await stub.answer(OWNER, "q1", "pg");
    expect(await stub.answer(OWNER, "q1", "mysql")).toEqual({ ok: false, code: "conflict" });
    await stub.advance();
    expect(await statusOf(stub)).toBe("RUNNING");
    expect(await stub.answer(OWNER, "q1", "mysql")).toEqual({ ok: false, code: "conflict" });
    expect((await questionRow(stub))?.answer).toBe("pg");
  });

  it("違う question_id は not_found で、回答は保存されない", async () => {
    const { stub, agent } = await createAsked();
    expect(await stub.answer(OWNER, "q-other", "pg")).toEqual({ ok: false, code: "not_found" });
    await stub.advance();
    expect((await agent.calls()).answer).toBe(0);
    expect((await questionRow(stub))?.answer).toBeNull();
  });

  it("INPUT_REQUIRED でないときの未回答の質問への回答は conflict（終端も同様）", async () => {
    const { stub, agent } = await createAsked();
    // 質問は出たが、状態が INPUT_REQUIRED でなくなった（cancel）
    await stub.cancel(OWNER);
    expect(await stub.answer(OWNER, "q1", "pg")).toEqual({ ok: false, code: "conflict" });
    await stub.advance();
    expect((await agent.calls()).answer).toBe(0);
  });

  it("質問が無いタスクへの回答は not_found。他人のタスクも not_found", async () => {
    const { stub } = await createRunning();
    expect(await stub.answer(OWNER, "q1", "x")).toEqual({ ok: false, code: "not_found" });
    const asked = await createAsked();
    expect(await asked.stub.answer(OWNER + 1, "q1", "x")).toEqual({ ok: false, code: "not_found" });
  });

  it("answer 直後の alarm は 10 秒以内（60 秒の待機から前倒しする）", async () => {
    const { stub } = await createAsked();
    await stub.advance();
    await stub.answer(OWNER, "q1", "pg");
    const at = await alarmOf(stub);
    expect(at).not.toBeNull();
    expect((at ?? 0) - Date.now()).toBeLessThanOrEqual(10_500);
  });
});

describe("cancel と回答・steer の競合", () => {
  it("cancel は pending の回答と steer の配送の意図を同じトランザクションで skipped にする", async () => {
    const { stub, agent } = await createAsked();
    await stub.answer(OWNER, "q1", "pg");
    const s = await stub.steer(OWNER, "also add tests");
    if (!s.ok) throw new Error("steer failed");
    await stub.cancel(OWNER);
    expect(await questionRow(stub)).toMatchObject({ answer: "pg", delivery_state: "skipped" });
    expect((await steerRow(stub, s.steer_id))?.delivery_state).toBe("skipped");
    await stub.advance();
    const c = await agent.calls();
    expect(c.answer).toBe(0);
    expect(c.steer).toBe(0);
    expect(c.cancel).toBeGreaterThanOrEqual(1);
    expect(await stub.inspect()).toMatchObject({ status: "CANCELLED", stopped: true });
  });

  it("cancel の後の回答・steer は conflict で、配送されない", async () => {
    const { stub, agent } = await createAsked();
    await stub.cancel(OWNER);
    expect(await stub.answer(OWNER, "q1", "pg")).toEqual({ ok: false, code: "conflict" });
    expect(await stub.steer(OWNER, "x")).toEqual({ ok: false, code: "conflict" });
    await stub.advance();
    expect((await agent.calls()).answer).toBe(0);
    expect((await agent.calls()).steer).toBe(0);
  });

  it("回答の配送中（応答を待つ間）に cancel が届いても、停止確認まで収束する", async () => {
    const { stub, agent } = await createAsked();
    await stub.answer(OWNER, "q1", "pg");
    await agent.setProgram({ answer: ["lose"] });
    await stub.advance(); // 効果は起きたが応答が失われ、delivery は pending のまま
    await stub.cancel(OWNER);
    expect((await questionRow(stub))?.delivery_state).toBe("skipped");
    await stub.advance();
    expect(await stub.inspect()).toMatchObject({ status: "CANCELLED", stopped: true });
  });

  it("終端（FAILED など）に入ったときも、pending の配送は skipped になる", async () => {
    const { stub, agent } = await createAsked();
    await stub.answer(OWNER, "q1", "pg");
    await agent.setProgram({ answer: ["not_ok"] });
    await agent.setPhase("failed", "deadline");
    await stub.advance();
    expect(await statusOf(stub)).toBe("FAILED");
    expect((await questionRow(stub))?.delivery_state).toBe("skipped");
  });
});

describe("steer（task_steer の TaskDO 側）", () => {
  it.each([["RUNNING"], ["VERIFYING"], ["INPUT_REQUIRED"]])(
    "%s で受け付け、steer_received を永続化して AgentDO.steer に届ける",
    async (state) => {
      const t = await createRunning();
      if (state === "VERIFYING") {
        await t.agent.setPhase("verifying");
        await t.stub.advance();
      } else if (state === "INPUT_REQUIRED") {
        await t.agent.ask("q1", "m");
        await t.stub.advance();
      }
      expect(await statusOf(t.stub)).toBe(state);
      const r = await t.stub.steer(OWNER, "use pnpm");
      if (!r.ok) throw new Error(`steer rejected: ${r.code}`);
      expect(r.status).toBe(state);
      expect(await eventsOf(t.stub, "steer_received")).toEqual([{ steer_id: r.steer_id }]);
      expect(await steerRow(t.stub, r.steer_id)).toMatchObject({
        message: "use pnpm",
        delivery_state: "pending",
      });
      await t.stub.advance();
      expect((await t.agent.calls()).steers).toEqual([
        { steerId: r.steer_id, message: "use pnpm" },
      ]);
      expect((await steerRow(t.stub, r.steer_id))?.delivery_state).toBe("delivered");
      // steer_accepted が取り込まれる
      expect(await eventsOf(t.stub, "steer_accepted")).toEqual([{ steer_id: r.steer_id }]);
    },
  );

  it("CREATING・終端では conflict", async () => {
    const created = await createTask();
    expect(await created.stub.steer(OWNER, "x")).toEqual({ ok: false, code: "conflict" });
    const done = await createRunning();
    await done.agent.setPhase("completed");
    await done.stub.advance();
    expect(await statusOf(done.stub)).toBe("COMPLETED");
    expect(await done.stub.steer(OWNER, "x")).toEqual({ ok: false, code: "conflict" });
  });

  it("他人のタスク・存在しないタスクは not_found", async () => {
    const { stub } = await createRunning();
    expect(await stub.steer(OWNER + 1, "x")).toEqual({ ok: false, code: "not_found" });
    expect(await taskStub(newTaskId()).steer(OWNER, "x")).toEqual({ ok: false, code: "not_found" });
  });

  it("idempotency_key: 同じ key・同じ message は同じ steer_id で 1 回だけ配送。違う message は conflict", async () => {
    const { stub, agent } = await createRunning();
    const a = await stub.steer(OWNER, "do x", "key-1");
    const b = await stub.steer(OWNER, "do x", "key-1");
    if (!a.ok || !b.ok) throw new Error("steer rejected");
    expect(b.steer_id).toBe(a.steer_id);
    expect(await stub.steer(OWNER, "do y", "key-1")).toEqual({ ok: false, code: "conflict" });
    await stub.advance();
    await stub.advance();
    expect((await agent.calls()).steers).toEqual([{ steerId: a.steer_id, message: "do x" }]);
    expect(await eventsOf(stub, "steer_received")).toHaveLength(1);
  });

  it("idempotency_key の再送は、配送済み・状態が変わった後でも成功する", async () => {
    const { stub, agent } = await createRunning();
    const a = await stub.steer(OWNER, "do x", "key-2");
    await stub.advance();
    await agent.setPhase("completed");
    await stub.advance();
    expect(await statusOf(stub)).toBe("COMPLETED");
    const again = await stub.steer(OWNER, "do x", "key-2");
    expect(again).toMatchObject({ ok: true });
    expect(a.ok && again.ok && again.steer_id === a.steer_id).toBe(true);
  });

  it("key が無ければ呼び出しごとに別の steer_id", async () => {
    const { stub } = await createRunning();
    const a = await stub.steer(OWNER, "same");
    const b = await stub.steer(OWNER, "same");
    if (!a.ok || !b.ok) throw new Error("steer rejected");
    expect(a.steer_id).not.toBe(b.steer_id);
  });

  it("配送は成功するまで alarm で再送し、順序を保つ", async () => {
    const { stub, agent } = await createRunning();
    const a = await stub.steer(OWNER, "first");
    const b = await stub.steer(OWNER, "second");
    if (!a.ok || !b.ok) throw new Error("steer rejected");
    await agent.setProgram({ steer: ["throw", "not_ok", "lose"] });
    await stub.advance(); // throw
    await stub.advance(); // not_ok
    expect((await steerRow(stub, a.steer_id))?.delivery_state).toBe("pending");
    expect((await agent.calls()).steers).toEqual([]);
    await runDurableObjectAlarm(stub); // lose（効果は起きたが応答なし）
    expect((await steerRow(stub, a.steer_id))?.delivery_state).toBe("pending");
    await runDurableObjectAlarm(stub); // first を再送 ok、続けて second
    expect((await steerRow(stub, a.steer_id))?.delivery_state).toBe("delivered");
    expect((await steerRow(stub, b.steer_id))?.delivery_state).toBe("delivered");
    const sent = (await agent.calls()).steers.map((s) => s.message);
    expect(sent.at(-2)).toBe("first");
    expect(sent.at(-1)).toBe("second");
    // AgentDO は steer_id で冪等: steer_accepted は 1 つずつ
    expect(await eventsOf(stub, "steer_accepted")).toHaveLength(2);
  });

  it("ignored:true も配送完了", async () => {
    const { stub, agent } = await createRunning();
    const a = await stub.steer(OWNER, "x");
    if (!a.ok) throw new Error("steer rejected");
    await agent.setProgram({ steer: ["ignored"] });
    await stub.advance();
    expect((await steerRow(stub, a.steer_id))?.delivery_state).toBe("delivered");
  });
});

describe("24 時間のバックストップと alarm の間隔", () => {
  it("INPUT_REQUIRED から 24 時間 + 猶予 10 分を過ぎると FAILED(input_timeout) にして cancel を配送する", async () => {
    const { stub, agent } = await createAsked();
    await stub.answer(OWNER, "q1", "pg");
    await agent.setProgram({ answer: Array(10).fill("not_ok") });
    await stub.advance();
    // 24 時間 + 9 分: まだ待つ
    await warp(stub, 24 * 3_600_000 + 9 * 60_000);
    await stub.advance();
    expect(await statusOf(stub)).toBe("INPUT_REQUIRED");
    // 24 時間 + 10 分 + 1 秒: 失敗にする
    await warp(stub, 24 * 3_600_000 + 10 * 60_000 + 1_000);
    await stub.advance();
    expect(await statusOf(stub)).toBe("FAILED");
    const failed = (await eventsOf(stub, "status_changed")).find((e) => e.status === "FAILED");
    expect(failed).toMatchObject({ reason: "input_timeout", from: "INPUT_REQUIRED" });
    expect((await agent.calls()).cancel).toBeGreaterThanOrEqual(1);
    expect(await stub.inspect()).toMatchObject({ status: "FAILED", stopped: true });
    expect((await questionRow(stub))?.delivery_state).toBe("skipped");
  });

  it("回答して RUNNING に戻れば、バックストップは働かない", async () => {
    const { stub } = await createAsked();
    await stub.answer(OWNER, "q1", "pg");
    await stub.advance();
    expect(await statusOf(stub)).toBe("RUNNING");
    await warp(stub, 25 * 3_600_000);
    await stub.advance();
    expect(await statusOf(stub)).toBe("RUNNING");
  });

  it("INPUT_REQUIRED で配送が無いあいだの alarm は 60 秒。配送が pending のときだけ 10 秒", async () => {
    const { stub, agent } = await createAsked();
    await stub.advance();
    const idle = (await alarmOf(stub)) ?? 0;
    expect(idle - Date.now()).toBeGreaterThan(55_000);
    expect(idle - Date.now()).toBeLessThanOrEqual(60_500);

    await agent.setProgram({ answer: ["not_ok"] });
    await stub.answer(OWNER, "q1", "pg");
    await stub.advance(); // not_ok: pending のまま
    const pending = (await alarmOf(stub)) ?? 0;
    expect(pending - Date.now()).toBeLessThanOrEqual(10_500);
    expect(pending).not.toBeNull();
  });

  it("RUNNING の間の alarm は 10 秒のまま", async () => {
    const { stub } = await createRunning();
    await stub.advance();
    expect(((await alarmOf(stub)) ?? 0) - Date.now()).toBeLessThanOrEqual(10_500);
  });

  it("steer の配送が pending のときも 10 秒", async () => {
    const { stub, agent } = await createAsked();
    await agent.setProgram({ steer: ["not_ok"] });
    await stub.steer(OWNER, "x");
    await stub.advance();
    expect(((await alarmOf(stub)) ?? 0) - Date.now()).toBeLessThanOrEqual(10_500);
  });
});

describe("回答待ちの間の Installation Token の更新", () => {
  it("INPUT_REQUIRED の間も、期限の 15 分前になれば新しいトークンを setGitCredential で渡す", async () => {
    const { stub, agent } = await createRunning();
    const first = (await agent.calls()).specs[0]?.gitCredential;
    await agent.ask("q1", "m");
    await stub.advance();
    expect(await statusOf(stub)).toBe("INPUT_REQUIRED");
    await warp(stub, (first?.expiresAt ?? 0) - Date.now() - 14 * 60_000);
    await runDurableObjectAlarm(stub);
    const c = await agent.calls();
    expect(c.setGitCredential).toBe(1);
    expect(c.credentials[0]?.expiresAt).toBeGreaterThan(first?.expiresAt ?? 0);
    expect(await statusOf(stub)).toBe("INPUT_REQUIRED");
  });
});

describe("イベントの並び", () => {
  it("question → answer → answered の順に公開イベントが並ぶ", async () => {
    const { stub } = await createAsked();
    await stub.answer(OWNER, "q1", "pg");
    await stub.advance();
    const types = await eventTypes(stub);
    const q = types.indexOf("question");
    const a = types.indexOf("answered");
    expect(q).toBeGreaterThan(-1);
    expect(a).toBeGreaterThan(q);
  });
});
