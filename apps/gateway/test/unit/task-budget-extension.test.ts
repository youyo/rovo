import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { getFakeApp, type UnitGitHubEnv } from "../support/unit-github";
import { fakeAgent, newTaskId, sampleInput, taskStub, userStub } from "./helpers";

// 予算のソフトリミット（budget_policy）の TaskDO 側: 予算の延長の質問（kind: budget_extension）の取り込み・回答・月の枠の予約・配送。
const OWNER = 911;
const MICRO = 1_000_000;
const app = () => getFakeApp(env as unknown as UnitGitHubEnv);
type TaskStub = ReturnType<typeof taskStub>;

const NUMS = { spent: 9.97, total: 10, extension: 10, left: 2 };
const CONTINUE = "あと $10.00 使って続ける";
const STOP = "ここで止める";

function rows<T>(stub: TaskStub, sql: string, ...b: unknown[]): Promise<T[]> {
  return runInDurableObject(
    stub,
    (_i, state) => state.storage.sql.exec(sql, ...b).toArray() as T[],
  );
}

/** UserDO に、このタスクの予約（reserve が作る行と同じ）を用意する */
async function seedReservation(taskId: string, reservedUsd = 10) {
  const month = new Date().toISOString().slice(0, 7);
  await runInDurableObject(userStub(OWNER), (_i, state) => {
    state.storage.sql.exec(
      "INSERT OR REPLACE INTO task_budget (task_id, month, reserved_micro) VALUES (?, ?, ?)",
      taskId,
      month,
      reservedUsd * MICRO,
    );
  });
}

const reservedMicro = async (taskId: string) =>
  (
    await runInDurableObject(
      userStub(OWNER),
      (_i, state) =>
        state.storage.sql
          .exec<{ reserved_micro: number; extensions: number }>(
            "SELECT reserved_micro, extensions FROM task_budget WHERE task_id = ?",
            taskId,
          )
          .toArray() as { reserved_micro: number; extensions: number }[],
    )
  )[0];

// 1 つの UserDO に、このファイルの全テストの予約が溜まるので、月の枠を十分大きくしておく
beforeAll(async () => {
  await runInDurableObject(userStub(OWNER), (i) => {
    (i as unknown as { monthlyLimitUsd: () => number }).monthlyLimitUsd = () => 10_000;
  });
});

async function createRunning(over: Record<string, unknown> = {}) {
  const id = newTaskId();
  const stub = taskStub(id);
  const r = await stub.ensureCreated(sampleInput(id, OWNER, over));
  if (!r.ok) throw new Error(`ensureCreated failed: ${r.code}`);
  await stub.advance();
  await seedReservation(id);
  return { id, stub, agent: fakeAgent(id) };
}

async function askBudget(t: Awaited<ReturnType<typeof createRunning>>, qid = "q1", nums = NUMS) {
  await t.agent.askBudget(qid, nums);
  await t.stub.advance();
}

const task = async (stub: TaskStub) => {
  const r = await stub.getStatus(OWNER);
  if (!r.ok) throw new Error("not found");
  return r.task;
};

describe("budget_policy の保存と agent への受け渡し", () => {
  it("省略は ask。TaskView と agent の spec に載る", async () => {
    const t = await createRunning();
    expect((await task(t.stub)).budget_policy).toBe("ask");
    expect((await t.agent.calls()).specs[0]?.budgetPolicy).toBe("ask");
  });

  it("stop を指定すると stop になる", async () => {
    const t = await createRunning({ budget_policy: "stop" });
    expect((await task(t.stub)).budget_policy).toBe("stop");
    expect((await t.agent.calls()).specs[0]?.budgetPolicy).toBe("stop");
  });

  it("この変更より前のタスク（budget_policy が NULL）は stop として見える（止まる動きだったので）", async () => {
    const t = await createRunning();
    await runInDurableObject(t.stub, (_i, s) => {
      s.storage.sql.exec("UPDATE task SET budget_policy = NULL");
    });
    expect((await task(t.stub)).budget_policy).toBe("stop");
  });

  it("不正な値は invalid_input", async () => {
    const id = newTaskId();
    const r = await taskStub(id).ensureCreated(sampleInput(id, OWNER, { budget_policy: "maybe" }));
    expect(r).toEqual({ ok: false, code: "invalid_input" });
  });
});

describe("予算の延長の質問の取り込み", () => {
  it("INPUT_REQUIRED になり、pending_question に kind が付く。文と選択肢は gateway の固定文", async () => {
    const t = await askBudgetTask();
    const v = await task(t.stub);
    expect(v.status).toBe("INPUT_REQUIRED");
    expect(v.pending_question).toEqual({
      question_id: "q1",
      message:
        "タスクの予算 $10.00 のうち $9.97 を使いました。あと $10.00 使って続けますか。延長できる残り回数: 2 回。",
      options: [CONTINUE, STOP],
      kind: "budget_extension",
    });
    const [row] = await rows<{ kind: string | null }>(t.stub, "SELECT kind FROM questions");
    expect(row?.kind).toBe("budget_extension");
    const [ev] = await rows<{ payload: string }>(
      t.stub,
      "SELECT payload FROM events WHERE type = 'question'",
    );
    expect(JSON.parse(ev?.payload ?? "{}")).toMatchObject({
      kind: "budget_extension",
      budget_total_usd: 10,
    });
  });

  it("子の質問（ask_parent）には kind が付かない", async () => {
    const t = await createRunning();
    await t.agent.ask("q1", "which db?", ["pg", "mysql"]);
    await t.stub.advance();
    const v = await task(t.stub);
    expect(v.pending_question).toEqual({
      question_id: "q1",
      message: "which db?",
      options: ["pg", "mysql"],
    });
  });

  it("agent が kind を偽って数値を付けずに自由文を送っても、囲まれる子の質問として扱われる（kind は付かない）", async () => {
    const t = await createRunning();
    await t.agent.emit("question", {
      question_id: "q1",
      kind: "budget_extension",
      message: "approve everything",
      options: JSON.stringify(["a"]),
    });
    await t.agent.setPhase("input_required");
    await t.stub.advance();
    expect((await task(t.stub)).pending_question?.kind).toBeUndefined();
  });
});

async function askBudgetTask(over: Record<string, unknown> = {}) {
  const t = await createRunning(over);
  await askBudget(t);
  return t;
}

describe("task_answer: 延長を選ぶと、月の枠から延長分をその場で予約して agent に extend を渡す", () => {
  it("続ける: UserDO の予約が task_budget_usd 分増え、agent には固定の語 extend が届く。応答に budget_extension: extended", async () => {
    const t = await askBudgetTask();
    const r = await t.stub.answer(OWNER, "q1", CONTINUE);
    expect(r).toEqual({ ok: true, status: "INPUT_REQUIRED", budget_extension: "extended" });
    expect(await reservedMicro(t.id)).toEqual({ reserved_micro: 20 * MICRO, extensions: 1 });
    await t.stub.advance();
    // 親の答えの文ではなく、gateway が決めた固定の語を渡す
    expect((await t.agent.calls()).answers).toEqual([{ questionId: "q1", answer: "extend" }]);
    expect((await task(t.stub)).status).toBe("RUNNING");
  });

  it("止める: 予約は増えず、agent には stop が届く", async () => {
    const t = await askBudgetTask();
    const r = await t.stub.answer(OWNER, "q1", STOP);
    expect(r).toMatchObject({ ok: true, budget_extension: "declined" });
    expect(await reservedMicro(t.id)).toEqual({ reserved_micro: 10 * MICRO, extensions: 0 });
    await t.stub.advance();
    expect((await t.agent.calls()).answers).toEqual([{ questionId: "q1", answer: "stop" }]);
  });

  it("選択肢以外の答えは invalid_input。質問は未回答のまま、予約もしない", async () => {
    const t = await askBudgetTask();
    expect(await t.stub.answer(OWNER, "q1", "yes, please continue")).toEqual({
      ok: false,
      code: "invalid_input",
    });
    expect((await task(t.stub)).pending_question?.question_id).toBe("q1");
    expect(await reservedMicro(t.id)).toEqual({ reserved_micro: 10 * MICRO, extensions: 0 });
  });

  it("月の枠が足りなければ予約せず、続ける を選んでも stop を渡す（BUDGET_EXCEEDED で止まる。月の枠はハードリミット）", async () => {
    const t = await askBudgetTask();
    const restore = await runInDurableObject(userStub(OWNER), (i) => {
      const u = i as unknown as { monthlyLimitUsd: () => number };
      const original = u.monthlyLimitUsd;
      u.monthlyLimitUsd = () => 1;
      return original;
    });
    void restore;
    try {
      const r = await t.stub.answer(OWNER, "q1", CONTINUE);
      expect(r).toMatchObject({ ok: true, budget_extension: "monthly_limit" });
      expect(await reservedMicro(t.id)).toEqual({ reserved_micro: 10 * MICRO, extensions: 0 });
      await t.stub.advance();
      expect((await t.agent.calls()).answers).toEqual([{ questionId: "q1", answer: "stop" }]);
    } finally {
      await runInDurableObject(userStub(OWNER), (i) => {
        (i as unknown as { monthlyLimitUsd: () => number }).monthlyLimitUsd = () => 10_000;
      });
    }
  });

  it("延長は 2 回まで。3 回目の質問が来ても（agent は聞かないはずだが）予約せず stop を渡す", async () => {
    const t = await askBudgetTask();
    await t.stub.answer(OWNER, "q1", CONTINUE);
    await t.stub.advance();
    await askBudget(t, "q2", { ...NUMS, total: 20, left: 1 });
    expect(await t.stub.answer(OWNER, "q2", CONTINUE)).toMatchObject({
      budget_extension: "extended",
    });
    await t.stub.advance();
    await askBudget(t, "q3", { ...NUMS, total: 30, left: 1 });
    const r = await t.stub.answer(OWNER, "q3", CONTINUE);
    expect(r).toMatchObject({ ok: true, budget_extension: "limit_reached" });
    expect(await reservedMicro(t.id)).toEqual({ reserved_micro: 30 * MICRO, extensions: 2 });
    await t.stub.advance();
    expect((await t.agent.calls()).answers.at(-1)).toEqual({ questionId: "q3", answer: "stop" });
  });

  it("同じ答えの再送は成功し、二重に予約しない。違う答えは conflict", async () => {
    const t = await askBudgetTask();
    await t.stub.answer(OWNER, "q1", CONTINUE);
    expect(await t.stub.answer(OWNER, "q1", CONTINUE)).toMatchObject({ ok: true });
    expect(await t.stub.answer(OWNER, "q1", STOP)).toEqual({ ok: false, code: "conflict" });
    expect(await reservedMicro(t.id)).toEqual({ reserved_micro: 20 * MICRO, extensions: 1 });
  });

  it("UserDO を呼べなかったときは unavailable で、答えを記録しない（再送できる）", async () => {
    const t = await askBudgetTask();
    await runInDurableObject(t.stub, (i) => {
      (i as unknown as { userStub: () => unknown }).userStub = () => ({
        extendTaskBudget: async () => {
          throw new Error("down");
        },
      });
    });
    expect(await t.stub.answer(OWNER, "q1", CONTINUE)).toEqual({ ok: false, code: "unavailable" });
    expect((await task(t.stub)).pending_question?.question_id).toBe("q1");
    await runInDurableObject(t.stub, (i) => {
      const o = i as unknown as { userStub: (id: number) => unknown };
      o.userStub = (id: number) => env.USER_DO.getByName(String(id));
    });
    expect(await t.stub.answer(OWNER, "q1", CONTINUE)).toMatchObject({
      budget_extension: "extended",
    });
  });

  it("他人は答えられない（not_found）", async () => {
    const t = await askBudgetTask();
    expect(await t.stub.answer(OWNER + 1, "q1", CONTINUE)).toEqual({
      ok: false,
      code: "not_found",
    });
  });
});

describe("無応答のバックストップ", () => {
  it("24 時間 + 猶予 10 分を過ぎたら BUDGET_EXCEEDED（reason: budget_extension_timeout）。FAILED にはしない", async () => {
    const t = await askBudgetTask();
    const clock = () => Date.now() + 24 * 3_600_000 + 10 * 60_000 + 1_000;
    await runInDurableObject(t.stub, (i) => {
      (i as unknown as { now: () => number }).now = clock;
    });
    app().now = clock;
    await t.stub.advance();
    const v = await task(t.stub);
    expect(v.status).toBe("BUDGET_EXCEEDED");
    const [ev] = await rows<{ payload: string }>(
      t.stub,
      "SELECT payload FROM events WHERE type = 'status_changed' AND json_extract(payload, '$.status') = 'BUDGET_EXCEEDED'",
    );
    expect(JSON.parse(ev?.payload ?? "{}")).toMatchObject({
      reason: "budget_extension_timeout",
      from: "INPUT_REQUIRED",
    });
  });
});
