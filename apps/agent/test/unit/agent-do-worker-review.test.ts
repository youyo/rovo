import { afterEach, describe, expect, it } from "vitest";
import { clearAgentTestOverrides } from "../../src/agent/deps";
import type { TaskSpec } from "../../src/agent/types";
import type { ScriptStep } from "../../src/pi/scripted-provider";
import { REVIEW_SYSTEM_PROMPT } from "../../src/review/input";
import {
  allEvents,
  done,
  type Fixture,
  makeSpec,
  newFixture,
  report,
  waitForPhase,
  waitForTerminal,
} from "./support/agent-fixture";

afterEach(() => clearAgentTestOverrides());

// worker_review（review_fix_rounds: 0）: ワーカーの report_completion で verification_commands が通ったあと、完了にする前に、
// 同じ固定 SHA で review_commands を流し、レビューのモデルを（読み取りの道具つきで）呼び、結果に本文を残して COMPLETED にする。
// 部品（runReviewCommands・runReviewModel・本文の組み立て・予算の質問）は task_review と同じものを使う。

const MODEL = "anthropic/claude-sonnet-5-5";
const DIFF = [
  "diff --git a/src/sum.ts b/src/sum.ts",
  "--- a/src/sum.ts",
  "+++ b/src/sum.ts",
  "@@ -1 +1 @@",
  "-export const sum = (a, b) => a - b;",
  "+export const sum = (a, b) => a + b;",
  "",
].join("\n");
const WORKER_CLAIM = "I verified everything and the change is perfect (worker summary)";

const verdict = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ summary: "ok", must_fix: [], suggestions: [], ...over });
const MUST_FIX = {
  path: "src/sum.ts",
  line: 1,
  reason: "r",
  change: "c",
  severity: "high",
};
const SUGGESTION = { path: "src/sum.ts", line: null, reason: "s", change: "", severity: "low" };
/** ワーカーの report_completion。予算（$0.03）のうち $0.02 を使う（残りではレビューの最大額が収まらない） */
const piSpend = (): ScriptStep => ({ ...report(), usage: { input: 20_000 } });
const readFile = (path: string): ScriptStep => ({
  toolCall: { name: "read_file", arguments: { path } },
});

function workerSpec(
  taskId: string,
  over: Partial<TaskSpec> = {},
  commands: { argv: string[]; cwd?: string }[] = [],
): TaskSpec {
  return makeSpec(taskId, {
    workerReview: { model: MODEL, commands, fixRounds: 0 },
    ...over,
  });
}

async function resultOf(fx: Fixture) {
  const d = done(await fx.stub.getResult());
  return { result: d, review: d.review };
}

/**
 * 台本は最初の user メッセージの本文をキーに引く。ワーカー（Pi）の台本はその指示文（makeSpec の instructions）をキーにして保存し、
 * 既定の台本はレビューのモデルが使う（レビューの会話は、ワーカーの会話とは別の台本の先頭から始まる）。
 */
async function fixture(
  name: string,
  review: ScriptStep[],
  worker: ScriptStep[] = [report()],
  sha = "c".repeat(40),
): Promise<Fixture> {
  const fx = newFixture(name, review);
  await fx.stub.setScript(`taskId=${name} を実装して`, worker);
  fx.reviewDiff.value = DIFF;
  // git rev-parse HEAD の応答（検証の前後と固定の確認で何度も読む）。尽きたあとの既定値だと固定の確認が合わない
  fx.revParse.push(...Array.from({ length: 12 }, () => sha));
  return fx;
}

describe("worker_review: レビューの段（verification のあと、完了にする前）", () => {
  it("verification_commands が通ったあと、同じ SHA で review_commands を流し、モデルを呼び、本文を結果に残して completed にする", async () => {
    const fx = await fixture(
      "wr-flow",
      [{ text: verdict({ must_fix: [MUST_FIX] }), usage: { input: 1000, output: 500 } }],
      [report(WORKER_CLAIM)],
    );
    const r = await fx.stub.start(
      workerSpec("wr-flow", {}, [{ argv: ["pnpm", "test"] }, { argv: ["pnpm", "lint"] }]),
    );
    expect(r.status).toBe("accepted");
    expect(await waitForTerminal(fx)).toBe("completed");

    // verification_commands（npm test）→ review_commands（pnpm test・pnpm lint）の順。どちらも origin: verification
    expect(fx.verifyCalls).toEqual([
      ["npm", "test"],
      ["pnpm", "test"],
      ["pnpm", "lint"],
    ]);
    const origins = fx.sandbox.calls
      .filter((c) => c.argv[0] === "pnpm" || c.argv[0] === "npm")
      .map((c) => c.options.origin);
    expect(origins).toEqual(["verification", "verification", "verification"]);

    // 差分は Sandbox の固定した SHA から読む（base_sha..固定 SHA）
    expect(fx.reviewDiffCalls).toHaveLength(1);
    expect(fx.reviewDiffCalls[0]).toContain("base000..cccccccccccccccccccccccccccccccccccccccc");

    expect(fx.modelCalls.count).toBe(2);
    const { result, review } = await resultOf(fx);
    expect(review).toMatchObject({
      stage: "done",
      model: MODEL,
      headSha: "c".repeat(40),
      mustFixCount: 1,
      suggestionCount: 0,
      commandsUnavailable: false,
    });
    expect(review?.body).toContain("rovo のレビュー（anthropic/claude-sonnet-5-5、ccccccc）");
    expect(review?.commands.map((c) => [c.argv.join(" "), c.exitCode])).toEqual([
      ["pnpm test", 0],
      ["pnpm lint", 0],
    ]);
    expect(review?.usage).toMatchObject({ inputTokens: 1000, outputTokens: 500, estimated: false });
    expect(result.usage.costUsd).toBeGreaterThanOrEqual(review?.usage.costUsd ?? 1);
    // 検証の結果は今までどおり
    expect(result.verification).toMatchObject({ verified: true, commitSha: "c".repeat(40) });
    const types = (await allEvents(fx)).map((e) => e.type);
    expect(types).toContain("verification");
    expect(types).toContain("review_started");
    expect(types).toContain("review_commands_finished");
    expect(types.indexOf("verification")).toBeLessThan(types.indexOf("review_started"));
  });

  it("レビューのモデルへの入力: 差分・目的・受け入れ条件・review_commands の結果を渡し、ワーカーの summary は渡さない。道具は読み取りの 3 つだけ", async () => {
    const fx = await fixture("wr-input", [{ text: verdict() }], [report(WORKER_CLAIM)]);
    fx.verifyResults.push({}, { exitCode: 1, stdout: "1 failed: sum.test.ts" });
    await fx.stub.start(workerSpec("wr-input", {}, [{ argv: ["pnpm", "test"] }]));
    expect(await waitForTerminal(fx)).toBe("completed");
    const reviewCall = fx.modelCalls.systemTexts.indexOf(REVIEW_SYSTEM_PROMPT);
    expect(reviewCall).toBeGreaterThan(0);
    const seen = fx.modelCalls.userTexts[reviewCall]?.join("\n") ?? "";
    expect(seen).toContain("taskId=wr-input を実装して");
    expect(seen).toContain("テストが通る");
    expect(seen).toContain("a + b");
    expect(seen).toContain("1 failed: sum.test.ts");
    expect(seen).not.toContain(WORKER_CLAIM);
    expect(fx.modelCalls.toolNames[reviewCall]).toEqual(["read_file", "list_files", "search"]);
    // ワーカー自身のモデルの呼び出しには、ワーカーの道具（書き込み・bash など）が付く
    expect(fx.modelCalls.toolNames[0]).toContain("report_completion");
    // review_commands の失敗はタスクを止めない（レビューの入力になる）
    const { review } = await resultOf(fx);
    expect(review?.commands[0]).toMatchObject({ exitCode: 1 });
  });

  it("読み取りの道具の往復: read_file の結果がモデルに渡り、本文に反映される。Sandbox はレビューが終わるまで止めない", async () => {
    const fx = await fixture("wr-tools", [
      readFile("src/index.ts"),
      {
        text: verdict({
          suggestions: [
            { path: "src/index.ts", line: 3, reason: "see src/index.ts:3", change: "" },
          ],
        }),
      },
    ]);
    fx.sandbox.files.set("/workspace/src/index.ts", "export { sum } from './sum';\n");
    const terminatedAtCall: number[] = [];
    const terminate = fx.sandbox.terminate.bind(fx.sandbox);
    fx.sandbox.terminate = async () => {
      terminatedAtCall.push(fx.modelCalls.count);
      return terminate();
    };
    await fx.stub.start(workerSpec("wr-tools"));
    expect(await waitForTerminal(fx)).toBe("completed");
    expect(fx.modelCalls.toolResults[2]?.join("\n")).toContain("export { sum } from './sum';");
    expect(Math.min(...terminatedAtCall)).toBe(3);
    const { review } = await resultOf(fx);
    expect(review?.body).toContain("src/index.ts:3");
  });

  it("verification_commands が通らないあいだはレビューしない。通った回の SHA でだけレビューする", async () => {
    const fx = await fixture(
      "wr-retry",
      [{ text: verdict() }],
      [report("first"), report("second")],
    );
    fx.verifyResults.push({ exitCode: 1, stdout: "fail" });
    fx.revParse.length = 0;
    fx.revParse.push(...Array.from({ length: 3 }, () => "a".repeat(40)));
    fx.revParse.push(...Array.from({ length: 12 }, () => "b".repeat(40)));
    await fx.stub.start(workerSpec("wr-retry", {}, [{ argv: ["pnpm", "test"] }]));
    expect(await waitForTerminal(fx)).toBe("completed");
    // 1 回目の検証の失敗では review_commands もモデルも呼ばない
    expect(fx.verifyCalls).toEqual([
      ["npm", "test"],
      ["npm", "test"],
      ["pnpm", "test"],
    ]);
    // ワーカーの 2 回 + レビューの 1 回
    expect(fx.modelCalls.count).toBe(3);
    const { review } = await resultOf(fx);
    expect(review?.headSha).toBe("b".repeat(40));
  });

  it("検証を使い切って failed になったときは、レビューしない（review は skipped）", async () => {
    const fx = await fixture(
      "wr-verify-fail",
      [{ text: verdict() }],
      [report("1"), report("2"), report("3"), report("4")],
    );
    for (let i = 0; i < 4; i++) fx.verifyResults.push({ exitCode: 1, stdout: "fail" });
    await fx.stub.start(workerSpec("wr-verify-fail", {}, [{ argv: ["pnpm", "test"] }]));
    expect(await waitForTerminal(fx)).toBe("failed");
    expect(fx.reviewDiffCalls).toEqual([]);
    expect(fx.verifyCalls.filter((c) => c[0] === "pnpm")).toEqual([]);
    expect(fx.modelCalls.count).toBe(4);
    const { review } = await resultOf(fx);
    expect(review).toMatchObject({ stage: "skipped", model: MODEL });
  });

  it("verification_commands が無く Sandbox も使っていなくても、レビューのために Sandbox を用意して流す", async () => {
    const fx = await fixture("wr-no-verify", [{ text: verdict() }]);
    await fx.stub.start(workerSpec("wr-no-verify", { verificationCommands: [] }));
    expect(await waitForTerminal(fx)).toBe("completed");
    expect(fx.sandbox.readySpecs).toHaveLength(1);
    expect(fx.modelCalls.count).toBe(2);
    const { review } = await resultOf(fx);
    expect(review?.stage).toBe("done");
  });
});

describe("worker_review: 結果の分類（review_fix_rounds: 0）", () => {
  it("must_fix が 0 件・suggestions なし: warnings に review_* は無い", async () => {
    const fx = await fixture("wr-clean", [{ text: verdict() }]);
    await fx.stub.start(workerSpec("wr-clean"));
    expect(await waitForTerminal(fx)).toBe("completed");
    const { result, review } = await resultOf(fx);
    expect(result.warnings.filter((w) => w.startsWith("review_"))).toEqual([]);
    expect(review).toMatchObject({ stage: "done", mustFixCount: 0, suggestionCount: 0 });
  });

  it("must_fix が 0 件で suggestions がある: review_suggestions: <件数>", async () => {
    const fx = await fixture("wr-suggest", [
      { text: verdict({ suggestions: [SUGGESTION, SUGGESTION] }) },
    ]);
    await fx.stub.start(workerSpec("wr-suggest"));
    expect(await waitForTerminal(fx)).toBe("completed");
    const { result } = await resultOf(fx);
    expect(result.warnings).toContain("review_suggestions: 2");
    expect(result.warnings.some((w) => w.startsWith("review_must_fix"))).toBe(false);
  });

  it("must_fix がある: review_must_fix_unaddressed: <件数>。completed のまま（直さない）", async () => {
    const fx = await fixture("wr-mustfix", [
      {
        text: verdict({
          must_fix: [MUST_FIX, { ...MUST_FIX, line: 2 }],
          suggestions: [SUGGESTION],
        }),
      },
    ]);
    await fx.stub.start(workerSpec("wr-mustfix"));
    expect(await waitForTerminal(fx)).toBe("completed");
    const { result, review } = await resultOf(fx);
    expect(result.warnings).toContain("review_must_fix_unaddressed: 2");
    expect(result.warnings.some((w) => w.startsWith("review_suggestions"))).toBe(false);
    expect(review).toMatchObject({ stage: "done", mustFixCount: 2, suggestionCount: 1 });
    // 修正の回は無い: ワーカーのモデルは再び呼ばれない（report の 1 回 + レビューの 1 回）
    expect(fx.modelCalls.count).toBe(2);
  });

  it("レビューのモデルが失敗: completed のまま、review は skipped、warnings に review_failed: <理由>。かかった費用は数える", async () => {
    const fx = await fixture("wr-model-fail", [
      { error: "upstream 500", status: 500, usage: { input: 10 } },
      { error: "upstream 500", status: 500, usage: { input: 10 } },
    ]);
    await fx.stub.start(workerSpec("wr-model-fail"));
    expect(await waitForTerminal(fx)).toBe("completed");
    const { result, review } = await resultOf(fx);
    expect(result.warnings).toContain("review_failed: model_error");
    expect(review).toMatchObject({ stage: "skipped", failure: "model_error" });
    expect(review?.body).toBeUndefined();
    expect(review?.usage.costUsd).toBeGreaterThan(0);
    expect(result.verification.verified).toBe(true);
  });

  it("差分を Sandbox の git から読めなければ、モデルを呼ばずにレビューを飛ばし、completed のまま review_failed: diff_unavailable", async () => {
    const fx = await fixture("wr-no-diff", [{ text: verdict() }]);
    const exec = fx.sandbox.exec.bind(fx.sandbox);
    fx.sandbox.exec = async (argv, options) =>
      argv.includes("--no-ext-diff")
        ? {
            exitCode: 128,
            stdout: "",
            stderr: "fatal: bad revision",
            timedOut: false,
            truncated: false,
          }
        : exec(argv, options);
    await fx.stub.start(workerSpec("wr-no-diff"));
    expect(await waitForTerminal(fx)).toBe("completed");
    expect(fx.modelCalls.count).toBe(1);
    const { result, review } = await resultOf(fx);
    expect(review).toMatchObject({ stage: "skipped", failure: "diff_unavailable" });
    expect(result.warnings).toContain("review_failed: diff_unavailable");
    expect(result.verification.verified).toBe(true);
  });

  it("JSON でない答えは「JSON だけ」と 1 回だけ再要求し、それでもだめなら review_failed: invalid_response", async () => {
    const fx = await fixture("wr-invalid", [{ text: "LGTM" }, { text: "still not json" }]);
    await fx.stub.start(workerSpec("wr-invalid"));
    expect(await waitForTerminal(fx)).toBe("completed");
    expect(fx.modelCalls.count).toBe(3);
    const { result } = await resultOf(fx);
    expect(result.warnings).toContain("review_failed: invalid_response");
  });

  it("差分の秘密は伏せ字にしてモデルに渡し、warnings に review_redacted", async () => {
    const fx = await fixture("wr-redact", [{ text: verdict() }]);
    fx.reviewDiff.value = `${DIFF}+const token = "ghp_${"a1B2c3D4e5".repeat(4)}";\n`;
    await fx.stub.start(workerSpec("wr-redact"));
    expect(await waitForTerminal(fx)).toBe("completed");
    expect(fx.modelCalls.userTexts[1]?.join("\n")).toContain("const token");
    expect(fx.modelCalls.userTexts[1]?.join("\n")).not.toContain("ghp_a1B2c3D4e5");
    const { result } = await resultOf(fx);
    expect(result.warnings).toContain("review_redacted");
  });
});

describe("worker_review: 予算（同じタスクの枠の中）", () => {
  it("budget_policy が stop で足りなければ、モデルを呼ばずにレビューを飛ばし、completed のまま review_skipped_budget", async () => {
    const fx = await fixture("wr-budget-stop", [{ text: verdict() }], [piSpend()]);
    await fx.stub.start(workerSpec("wr-budget-stop", { budgetUsd: 0.03, budgetPolicy: "stop" }));
    expect(await waitForTerminal(fx)).toBe("completed");
    // ワーカーの 1 回だけ。レビューのモデルは呼ばない
    expect(fx.modelCalls.count).toBe(1);
    const { result, review } = await resultOf(fx);
    expect(review).toMatchObject({ stage: "skipped", failure: "budget" });
    expect(result.warnings).toContain("review_skipped_budget");
    expect(result.warnings.some((w) => w.startsWith("review_failed"))).toBe(false);
  });

  it("budget_policy が ask で足りなければ、budget_extension の質問を出し、Sandbox を中断して待つ。承認されたらレビューを続けて completed にする", async () => {
    const fx = await fixture(
      "wr-budget-ask",
      [{ text: verdict({ must_fix: [MUST_FIX] }) }],
      [piSpend()],
    );
    await fx.stub.start(workerSpec("wr-budget-ask", { budgetUsd: 0.03, budgetPolicy: "ask" }));
    await waitForPhase(fx, "input_required");
    const q = (await allEvents(fx)).find((e) => e.type === "question");
    expect(q?.data).toMatchObject({ question_id: "q-1", kind: "budget_extension" });
    expect(fx.modelCalls.count).toBe(1);
    expect(fx.sandbox.suspendCalls).toEqual([{ allowReclone: true }]);
    expect(fx.sandbox.terminateCount).toBe(0);
    expect(await fx.stub.answer("q-1", "extend")).toEqual({ ok: true });
    expect(await waitForTerminal(fx)).toBe("completed");
    expect(fx.modelCalls.count).toBe(2);
    const { result, review } = await resultOf(fx);
    expect(review).toMatchObject({ stage: "done", mustFixCount: 1 });
    expect(result.warnings).toContain("review_must_fix_unaddressed: 1");
    expect(result.verification.verified).toBe(true);
    // 終端になったので Sandbox は止める
    expect(fx.sandbox.terminateCount).toBeGreaterThanOrEqual(1);
  });

  it("延長を断られたら BUDGET_EXCEEDED（従来どおり）", async () => {
    const fx = await fixture("wr-budget-no", [{ text: verdict() }], [piSpend()]);
    await fx.stub.start(workerSpec("wr-budget-no", { budgetUsd: 0.03, budgetPolicy: "ask" }));
    await waitForPhase(fx, "input_required");
    await fx.stub.answer("q-1", "stop");
    expect(await waitForTerminal(fx)).toBe("budget_exceeded");
    expect(fx.modelCalls.count).toBe(1);
  });

  it("往復の途中で足りなくなり stop なら、そこで打ち切って completed（review_skipped_budget）", async () => {
    const fx = await fixture("wr-budget-mid", [
      {
        toolCall: { name: "read_file", arguments: { path: "src/a.ts" } },
        usage: { input: 20_000 },
      },
      { text: verdict() },
    ]);
    fx.sandbox.files.set("/workspace/src/a.ts", "export const a = 1;\n");
    await fx.stub.start(workerSpec("wr-budget-mid", { budgetUsd: 0.03, budgetPolicy: "stop" }));
    expect(await waitForTerminal(fx)).toBe("completed");
    const { result, review } = await resultOf(fx);
    expect(review).toMatchObject({ stage: "skipped", failure: "budget" });
    expect(result.warnings).toContain("review_skipped_budget");
  });
});

describe("worker_review: 取消し・spec の検査・client_review との違い", () => {
  it("レビューのコマンドの実行中に取り消されたら CANCELLED。レビューのモデルは呼ばない", async () => {
    const fx = await fixture("wr-cancel", [{ text: verdict() }]);
    const gate = { held: false, entered: false };
    const exec = fx.sandbox.exec.bind(fx.sandbox);
    fx.sandbox.exec = async (argv, options) => {
      if (argv[0] === "pnpm") {
        gate.entered = true;
        while (gate.held) await new Promise((r) => setTimeout(r, 10));
      }
      return exec(argv, options);
    };
    // Sandbox を止めると実行中のコマンドは終わる（本物の Sandbox と同じ）
    const terminate = fx.sandbox.terminate.bind(fx.sandbox);
    fx.sandbox.terminate = async () => {
      gate.held = false;
      return terminate();
    };
    gate.held = true;
    await fx.stub.start(workerSpec("wr-cancel", {}, [{ argv: ["pnpm", "test"] }]));
    while (!gate.entered) await new Promise((r) => setTimeout(r, 10));
    await fx.stub.cancel();
    gate.held = false;
    expect(await waitForTerminal(fx)).toBe("cancelled");
    await new Promise((r) => setTimeout(r, 100));
    expect(fx.modelCalls.count).toBe(1);
  });

  it("workerReview の形が違えば受け付けない（未知のモデル・修正の回 1・コマンドの形・task_review の spec との併用）", async () => {
    const fx = newFixture("wr-badspec", []);
    const bad = (workerReview: unknown, over: Partial<TaskSpec> = {}) =>
      fx.stub.start(
        makeSpec("wr-badspec", { workerReview: workerReview as TaskSpec["workerReview"], ...over }),
      );
    expect(await bad({ model: "nope/none", commands: [], fixRounds: 0 })).toMatchObject({
      status: "rejected",
    });
    expect(await bad({ model: MODEL, commands: [], fixRounds: 1 })).toMatchObject({
      status: "rejected",
    });
    expect(await bad({ model: MODEL, commands: [{ argv: [] }], fixRounds: 0 })).toMatchObject({
      status: "rejected",
    });
    expect(await bad({ model: MODEL, commands: "x", fixRounds: 0 })).toMatchObject({
      status: "rejected",
    });
    expect(await bad({ model: MODEL, commands: [] })).toMatchObject({ status: "rejected" });
    // task_review（kind: review）の spec とは併用しない
    const both = await bad(
      { model: MODEL, commands: [], fixRounds: 0 },
      {
        kind: "review",
        branch: "",
        initialSha: "a".repeat(40),
        review: {
          pullNumber: 7,
          headSha: "a".repeat(40),
          baseSha: "b".repeat(40),
          model: MODEL,
          commands: [],
          title: "t",
          body: "",
          diff: "",
          diffTruncated: false,
        },
      },
    );
    expect(both).toMatchObject({ status: "rejected", reason: "invalid_spec: workerReview" });
  });

  it("workerReview が無ければ今までどおり（レビューの段は動かず、review は付かない）", async () => {
    const fx = newFixture("wr-none", [report()]);
    fx.reviewDiff.value = DIFF;
    await fx.stub.start(makeSpec("wr-none"));
    expect(await waitForTerminal(fx)).toBe("completed");
    expect(fx.reviewDiffCalls).toEqual([]);
    expect(fx.modelCalls.count).toBe(1);
    const d = done(await fx.stub.getResult());
    expect(d).not.toHaveProperty("review");
    const types = (await allEvents(fx)).map((e) => e.type);
    expect(types).not.toContain("review_started");
  });

  it("model_calls: 作業とレビューの呼び出しを数え、usage イベントに累計で載せる", async () => {
    const fx = await fixture(
      "wr-calls",
      [{ text: verdict({ must_fix: [MUST_FIX] }), usage: { input: 1000, output: 500 } }],
      [report(WORKER_CLAIM)],
    );
    await fx.stub.start(workerSpec("wr-calls", {}, [{ argv: ["pnpm", "test"] }]));
    expect(await waitForTerminal(fx)).toBe("completed");
    expect(fx.modelCalls.count).toBe(2);
    const usage = (await allEvents(fx)).filter((e) => e.type === "usage");
    const last = usage.at(-1)?.data as { modelCalls?: number };
    expect(last.modelCalls).toBe(2);
  });
});
