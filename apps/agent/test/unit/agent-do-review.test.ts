import { afterEach, describe, expect, it } from "vitest";
import { clearAgentTestOverrides } from "../../src/agent/deps";
import type { TaskSpec } from "../../src/agent/types";
import { REVIEW_JSON_ONLY_RETRY, REVIEW_SYSTEM_PROMPT } from "../../src/review/input";
import {
  allEvents,
  done,
  type Fixture,
  makeSpec,
  newFixture,
  waitForPhase,
  waitForTerminal,
  waitUntil,
} from "./support/agent-fixture";

afterEach(() => clearAgentTestOverrides());

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const SECRET = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
const DIFF = [
  "diff --git a/src/sum.ts b/src/sum.ts",
  "--- a/src/sum.ts",
  "+++ b/src/sum.ts",
  "@@ -1 +1,2 @@",
  "-export const sum = (a, b) => a - b;",
  "+export const sum = (a, b) => a + b;",
  `+// ${SECRET}`,
  "",
].join("\n");

const VALID = JSON.stringify({
  summary: "One bug.",
  must_fix: [{ path: "src/sum.ts", line: 1, reason: "r", change: "c", severity: "high" }],
  suggestions: [{ path: "src/sum.ts", line: null, reason: "s", change: "", severity: "low" }],
});

function reviewSpec(
  taskId: string,
  over: Partial<TaskSpec> = {},
  commands = [] as { argv: string[] }[],
): TaskSpec {
  return makeSpec(taskId, {
    kind: "review",
    branch: "",
    baseSha: BASE,
    initialSha: HEAD,
    instructions: `Review pull request octo/repo#7 at ${HEAD}.`,
    acceptanceCriteria: [],
    verificationCommands: [],
    constraints: [],
    review: {
      pullNumber: 7,
      headSha: HEAD,
      baseSha: BASE,
      model: "anthropic/claude-sonnet-5-5",
      commands,
      title: "Fix sum",
      body: "cc @octocat",
      diff: DIFF,
      diffTruncated: false,
    },
    ...over,
  });
}

const review = (fx: Fixture) =>
  fx.stub.getResult().then((r) => {
    const d = done(r);
    if (!d.review) throw new Error("no review result");
    return { result: d, review: d.review };
  });

describe("task_review（kind: review）のレビューの段", () => {
  it("コマンドが無ければ Sandbox を起動せず、モデルを 1 回呼んで本文を結果に返す（ワーカーの LLM は動かさない）", async () => {
    const fx = newFixture("rv-diff", [{ text: VALID, usage: { input: 1000, output: 500 } }]);
    const r = await fx.stub.start(reviewSpec("rv-diff"));
    expect(r.status).toBe("accepted");
    expect(await waitForTerminal(fx)).toBe("completed");
    expect(fx.sandbox.readySpecs).toEqual([]);
    expect(fx.modelCalls.count).toBe(1);
    expect(fx.modelCalls.systemTexts[0]).toBe(REVIEW_SYSTEM_PROMPT);
    // 最初の text ブロックは rovo が書いた見出し。差分の秘密はモデルに渡らない
    expect(fx.modelCalls.userTexts[0]?.[0]).toContain(
      `Review pull request octo/repo#7 at ${HEAD}.`,
    );
    expect(fx.modelCalls.userTexts[0]?.join("\n")).not.toContain(SECRET);
    const { result, review: rv } = await review(fx);
    expect(rv).toMatchObject({
      stage: "done",
      model: "anthropic/claude-sonnet-5-5",
      headSha: HEAD,
      mustFixCount: 1,
      suggestionCount: 1,
      commands: [],
      commandsUnavailable: false,
    });
    expect(rv.body).toContain("rovo のレビュー（anthropic/claude-sonnet-5-5、aaaaaaa）");
    // レビューの費用は作業と分けて見え、タスクの usage にも入る（予算の精算に乗る）
    expect(rv.usage).toMatchObject({ inputTokens: 1000, outputTokens: 500, estimated: false });
    expect(rv.usage.costUsd).toBeCloseTo(0.0015, 6);
    expect(result.usage.costUsd).toBeCloseTo(0.0015, 6);
    expect(result.warnings).toContain("review_redacted");
    // push の経路は無い
    expect(fx.pushCalls).toEqual([]);
    const types = (await allEvents(fx)).map((e) => e.type);
    expect(types).toContain("review_started");
  });

  it("review_commands は PR の head で、1 本が失敗しても止めずに全部流す", async () => {
    const fx = newFixture("rv-cmds", [{ text: VALID }]);
    fx.verifyResults.push({ exitCode: 1, stdout: "1 failed" }, { exitCode: 0, stdout: "ok" });
    await fx.stub.start(
      reviewSpec("rv-cmds", {}, [{ argv: ["pnpm", "test"] }, { argv: ["pnpm", "lint"] }]),
    );
    expect(await waitForTerminal(fx)).toBe("completed");
    expect(fx.verifyCalls).toEqual([
      ["pnpm", "test"],
      ["pnpm", "lint"],
    ]);
    // Sandbox は PR の head を取り出す指定で用意する（作業ブランチは持たない）
    expect(fx.sandbox.readySpecs[0]).toMatchObject({
      repository: "octo/repo",
      checkout: { pullNumber: 7, sha: HEAD },
    });
    const origins = fx.sandbox.calls
      .filter((c) => c.argv[0] === "pnpm")
      .map((c) => c.options.origin);
    expect(origins).toEqual(["verification", "verification"]);
    const { review: rv } = await review(fx);
    expect(rv.commands.map((c) => [c.argv.join(" "), c.exitCode])).toEqual([
      ["pnpm test", 1],
      ["pnpm lint", 0],
    ]);
    // コマンドの結果はモデルに渡る（非信頼の囲みの中）
    expect(fx.modelCalls.userTexts[0]?.join("\n")).toContain("1 failed");
    const finished = (await allEvents(fx)).find((e) => e.type === "review_commands_finished");
    expect(finished?.data).toEqual({ passed: 1, failed: 1, timed_out: 0 });
    // コマンドのあとは Sandbox を止める（レビューにはもう要らない）
    expect(fx.sandbox.terminateCount).toBeGreaterThanOrEqual(1);
  });

  it("Sandbox を用意できなければ、テストの結果なしでレビューに進み warnings に review_commands_unavailable", async () => {
    const fx = newFixture("rv-unavail", [{ text: VALID }]);
    fx.sandbox.ensureReady = async () => {
      throw new Error("no container");
    };
    await fx.stub.start(reviewSpec("rv-unavail", {}, [{ argv: ["pnpm", "test"] }]));
    expect(await waitForTerminal(fx)).toBe("completed");
    const { result, review: rv } = await review(fx);
    expect(rv.commandsUnavailable).toBe(true);
    expect(result.warnings).toContain("review_commands_unavailable");
    expect(fx.modelCalls.userTexts[0]?.join("\n")).toMatch(/could not be run/);
  });

  it("答えが JSON でなければ 1 回だけ「JSON だけ」と再要求する", async () => {
    const fx = newFixture("rv-retry", [{ text: "LGTM!" }, { text: VALID }]);
    await fx.stub.start(reviewSpec("rv-retry"));
    expect(await waitForTerminal(fx)).toBe("completed");
    expect(fx.modelCalls.count).toBe(2);
    expect(fx.modelCalls.userTexts[1]).toContain(REVIEW_JSON_ONLY_RETRY);
  });

  it("モデルが失敗し続けたら FAILED（review_failed）。かかった費用は数える", async () => {
    const fx = newFixture("rv-fail", [
      { error: "upstream 500", status: 500, usage: { input: 10 } },
      { error: "upstream 500", status: 500, usage: { input: 10 } },
    ]);
    await fx.stub.start(reviewSpec("rv-fail"));
    expect(await waitForTerminal(fx)).toBe("failed");
    const { result, review: rv } = await review(fx);
    expect(result.reason).toBe("review_failed: model_error");
    expect(rv).toMatchObject({ stage: "skipped", failure: "model_error" });
    expect(rv.body).toBeUndefined();
    expect(result.usage.costUsd).toBeGreaterThan(0);
  });

  it("予算が足りず budget_policy が stop なら、モデルを呼ばずに BUDGET_EXCEEDED（review_skipped_budget）", async () => {
    const fx = newFixture("rv-budget-stop", [{ text: VALID }]);
    await fx.stub.start(reviewSpec("rv-budget-stop", { budgetUsd: 0.001, budgetPolicy: "stop" }));
    expect(await waitForTerminal(fx)).toBe("budget_exceeded");
    expect(fx.modelCalls.count).toBe(0);
    const { result, review: rv } = await review(fx);
    expect(rv).toMatchObject({ stage: "skipped", failure: "budget" });
    expect(result.warnings).toContain("review_skipped_budget");
  });

  it("予算が足りず budget_policy が ask なら、延長を聞き、承認されたらレビューを続ける", async () => {
    const fx = newFixture("rv-budget-ask", [{ text: VALID }]);
    await fx.stub.start(reviewSpec("rv-budget-ask", { budgetUsd: 0.01, budgetPolicy: "ask" }));
    await waitForPhase(fx, "input_required");
    const q = (await allEvents(fx)).find((e) => e.type === "question");
    expect(q?.data).toMatchObject({ question_id: "q-1", kind: "budget_extension" });
    expect(fx.modelCalls.count).toBe(0);
    expect(await fx.stub.answer("q-1", "extend")).toEqual({ ok: true });
    expect(await waitForTerminal(fx)).toBe("completed");
    expect(fx.modelCalls.count).toBe(1);
  });

  it("延長を断られたら BUDGET_EXCEEDED", async () => {
    const fx = newFixture("rv-budget-no", [{ text: VALID }]);
    await fx.stub.start(reviewSpec("rv-budget-no", { budgetUsd: 0.01, budgetPolicy: "ask" }));
    await waitForPhase(fx, "input_required");
    await fx.stub.answer("q-1", "stop");
    expect(await waitForTerminal(fx)).toBe("budget_exceeded");
    expect(fx.modelCalls.count).toBe(0);
  });

  it("コマンドの実行中に取り消されたら、モデルを呼ばずに CANCELLED", async () => {
    const fx = newFixture("rv-cancel", [{ text: VALID }]);
    const gate = { held: true, entered: false };
    fx.sandbox.setHandler(async () => {
      gate.entered = true;
      while (gate.held) await new Promise((r) => setTimeout(r, 10));
      return {};
    });
    await fx.stub.start(
      reviewSpec("rv-cancel", {}, [{ argv: ["pnpm", "test"] }, { argv: ["pnpm", "lint"] }]),
    );
    await waitUntil(() => gate.entered);
    await fx.stub.cancel();
    gate.held = false;
    expect(await waitForTerminal(fx)).toBe("cancelled");
    await new Promise((r) => setTimeout(r, 100));
    expect(fx.modelCalls.count).toBe(0);
  });

  it("段の時間の上限（15 分）を過ぎたら残りのコマンドを飛ばし、warnings に review_timeout", async () => {
    const fx = newFixture("rv-timeout", [{ text: VALID }]);
    fx.verifyAdvanceMs.push(16 * 60_000);
    await fx.stub.start(reviewSpec("rv-timeout", {}, [{ argv: ["slow"] }, { argv: ["next"] }]));
    expect(await waitForTerminal(fx)).toBe("completed");
    expect(fx.verifyCalls).toEqual([["slow"]]);
    const { result, review: rv } = await review(fx);
    expect(rv.commands[1]).toMatchObject({ argv: ["next"], skipped: true });
    expect(result.warnings).toContain("review_timeout");
  });

  it("review の spec の形が違えば受け付けない（作業ブランチを持つ・review が無い・head が違う）", async () => {
    const fx = newFixture("rv-invalid", []);
    const r1 = await fx.stub.start(reviewSpec("rv-invalid", { branch: "agent/task-rv-invalid" }));
    expect(r1).toMatchObject({ status: "rejected" });
    const r2 = await fx.stub.start(reviewSpec("rv-invalid", { review: undefined }));
    expect(r2).toMatchObject({ status: "rejected" });
    const r3 = await fx.stub.start(reviewSpec("rv-invalid", { initialSha: BASE }));
    expect(r3).toMatchObject({ status: "rejected" });
  });

  it("review のタスクに steer は届かない（ワーカーの LLM が無い）", async () => {
    const fx = newFixture("rv-steer", [{ text: VALID, delayMs: 200 }]);
    await fx.stub.start(reviewSpec("rv-steer"));
    expect(await fx.stub.steer("steer-1", "hello")).toEqual({ ok: true, ignored: true });
    expect(await waitForTerminal(fx)).toBe("completed");
  });
});
