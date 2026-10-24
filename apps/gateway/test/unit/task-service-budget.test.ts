import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  createTaskService as createRealTaskService,
  type Principal,
  type StartOptions,
  UNTRUSTED_QUESTION_BEGIN,
  wrapUntrustedQuestion,
} from "../../src/tasks/service";
import { fakeAgent, newUserId, taskStub, userStub } from "./helpers";

// 予算のソフトリミット（budget_policy）の service 層: 質問の囲みの扱い（ワーカーの質問は囲み、予算の延長の質問は囲まない）、
// task_answer の応答、task_console の awaiting。

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
  base_sha: "0123456789abcdef0123456789abcdef01234567",
  title: "Implement authentication",
  instructions: "Implement OAuth authentication.",
};

const NUMS = { spent: 9.97, total: 10, extension: 10, left: 2 };
const FIXED =
  "タスクの予算 $10.00 のうち $9.97 を使いました。あと $10.00 使って続けますか。延長できる残り回数: 2 回。";
const CONTINUE = "あと $10.00 使って続ける";

async function started(over: Record<string, unknown> = {}) {
  const svc = createTaskService(env);
  const p: Principal = { githubUserId: newUserId(), login: "alice" };
  const r = await svc.start(p, { ...startInput, ...over });
  if (!r.ok) throw new Error(`start failed: ${r.error.message}`);
  return { svc, p, taskId: r.value.task_id };
}

describe("task service: budget_policy と予算の延長の質問", () => {
  it("budget_policy を省略すると ask。task_status に返り、agent に渡る。stop も指定できる", async () => {
    const a = await started();
    const s = await a.svc.status(a.p, a.taskId);
    expect(s.ok && s.value.budget_policy).toBe("ask");
    expect((await fakeAgent(a.taskId).calls()).specs[0]?.budgetPolicy).toBe("ask");
    const b = await started({ budget_policy: "stop" });
    const sb = await b.svc.status(b.p, b.taskId);
    expect(sb.ok && sb.value.budget_policy).toBe("stop");
  });

  it("不正な budget_policy は invalid_input", async () => {
    const svc = createTaskService(env);
    const r = await svc.start(
      { githubUserId: newUserId(), login: "a" },
      {
        ...startInput,
        budget_policy: "maybe",
      },
    );
    expect(r).toMatchObject({ ok: false, error: { code: "invalid_input" } });
  });

  it("task_status の pending_question: 予算の延長の質問は囲まず kind が付く。ワーカーの質問は今までどおり囲み、kind は付かない", async () => {
    const a = await started();
    await fakeAgent(a.taskId).askBudget("q1", NUMS);
    await taskStub(a.taskId).advance();
    const s = await a.svc.status(a.p, a.taskId);
    if (!s.ok) throw new Error("status failed");
    expect(s.value.pending_question).toEqual({
      question_id: "q1",
      message: FIXED,
      options: [CONTINUE, "ここで止める"],
      kind: "budget_extension",
    });
    expect(JSON.stringify(s.value.pending_question)).not.toContain("UNTRUSTED");

    const c = await started();
    await fakeAgent(c.taskId).ask("q1", "which db?", ["pg"]);
    await taskStub(c.taskId).advance();
    const cs = await c.svc.status(c.p, c.taskId);
    if (!cs.ok) throw new Error("status failed");
    expect(cs.value.pending_question).toEqual({
      question_id: "q1",
      message: `${UNTRUSTED_QUESTION_BEGIN}\nwhich db?\n${"<<<END_UNTRUSTED_CHILD_QUESTION>>>"}`,
      options: [wrapUntrustedQuestion("pg")],
    });
    expect(cs.value.pending_question).not.toHaveProperty("kind");
  });

  it("task_wait の question イベント: 予算の延長の質問は囲まず kind と数値が付く。ワーカーの質問は囲まれる", async () => {
    const a = await started();
    await fakeAgent(a.taskId).askBudget("q1", NUMS);
    await taskStub(a.taskId).advance();
    const w = await a.svc.wait(a.p, { task_id: a.taskId, cursor: "0", timeout_seconds: 0 });
    if (!w.ok) throw new Error("wait failed");
    const q = w.value.events.find((e) => e.type === "question");
    expect(q?.payload).toMatchObject({
      question_id: "q1",
      kind: "budget_extension",
      message: FIXED,
      budget_total_usd: 10,
    });
    expect(String(q?.payload.message)).not.toContain("UNTRUSTED");
    expect(JSON.parse(String(q?.payload.options))).toEqual([CONTINUE, "ここで止める"]);

    const c = await started();
    await fakeAgent(c.taskId).ask("q1", "which db?", ["pg"]);
    await taskStub(c.taskId).advance();
    const cw = await c.svc.wait(c.p, { task_id: c.taskId, cursor: "0", timeout_seconds: 0 });
    if (!cw.ok) throw new Error("wait failed");
    const cq = cw.value.events.find((e) => e.type === "question");
    expect(String(cq?.payload.message)).toContain("UNTRUSTED_CHILD_QUESTION");
    expect(cq?.payload).not.toHaveProperty("kind");
  });

  it("task_answer: 続ける を選ぶと budget_extension: extended が返り、月の枠の予約が task_budget_usd 分増える。選択肢以外は invalid_input", async () => {
    const a = await started();
    await fakeAgent(a.taskId).askBudget("q1", NUMS);
    await taskStub(a.taskId).advance();
    const before = await userStub(a.p.githubUserId).budgetStatus();
    const bad = await a.svc.answer(a.p, { task_id: a.taskId, question_id: "q1", answer: "yes" });
    expect(bad).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    const r = await a.svc.answer(a.p, { task_id: a.taskId, question_id: "q1", answer: CONTINUE });
    expect(r).toMatchObject({
      ok: true,
      value: { task_id: a.taskId, question_id: "q1", budget_extension: "extended" },
    });
    const after = await userStub(a.p.githubUserId).budgetStatus();
    expect(after.reserved_usd - before.reserved_usd).toBe(before.task_budget_usd);
    expect((await fakeAgent(a.taskId).calls()).answers).toEqual([
      { questionId: "q1", answer: "extend" },
    ]);
  });

  it("task_console: 予算の延長の承認待ちのときだけ awaiting: budget_extension が付く。ワーカーの質問では付かない", async () => {
    const a = await started();
    await fakeAgent(a.taskId).askBudget("q1", NUMS);
    await taskStub(a.taskId).advance();
    const c = await a.svc.console(a.p, a.taskId);
    if (!c.ok) throw new Error(`console failed: ${c.error.message}`);
    expect(c.value).toMatchObject({ status: "INPUT_REQUIRED", awaiting: "budget_extension" });
    expect(c.value.now?.text).toContain("waiting for budget approval");

    const d = await started();
    await fakeAgent(d.taskId).ask("q1", "which db?", ["pg"]);
    await taskStub(d.taskId).advance();
    const dc = await d.svc.console(d.p, d.taskId);
    if (!dc.ok) throw new Error("console failed");
    expect(dc.value.status).toBe("INPUT_REQUIRED");
    expect(dc.value).not.toHaveProperty("awaiting");
  });
});
