import { describe, expect, it } from "vitest";
import { nextSteps, nextStepsAfterMerge, nextStepsAfterReady } from "../../src/tasks/next-steps";
import type { ResultView } from "../../src/tasks/task-do";

// task_result の next_steps（D9）: status・merge_policy・PR の draft 状態・head_matches_verified に応じて、次にすべきことを返す。

const ID = "01HZZZZZZZZZZZZZZZZZZZZZZZ";
const HEAD = "a".repeat(40);

type In = Parameters<typeof nextSteps>[0];
function input(over: Partial<In> = {}, pr: Partial<NonNullable<ResultView["pr"]>> | null = {}): In {
  return {
    task_id: ID,
    status: "COMPLETED",
    merge_policy: "human_review",
    verification: { verified: true },
    pr:
      pr === null
        ? null
        : {
            number: 5,
            url: "https://github.com/acme/widgets/pull/5",
            draft: true,
            merged: false,
            head_sha: HEAD,
            head_matches_verified: true,
            ...pr,
          },
    ...over,
  };
}

describe("nextSteps", () => {
  it("COMPLETED・Draft・human_review: レビュー → task_pr_ready → 人のレビューを待つ。task_pr_merge は使えない", () => {
    const t = nextSteps(input());
    expect(t).toContain("task_result");
    expect(t).toContain("task_pr_ready");
    expect(t).toContain("human_review");
    expect(t).toContain("人のレビューを待つ");
    expect(t).toContain("task_pr_merge は使えない");
    // 問題があるとき: task_steer は実行中専用。新しいタスクで、この PR のブランチに積む
    expect(t).toContain("task_steer");
    expect(t).toContain(`agent/task-${ID}`);
    expect(t).toContain(HEAD);
  });

  it("COMPLETED・Draft・agent_merge: task_pr_ready のあと task_pr_merge でマージできる", () => {
    const t = nextSteps(input({ merge_policy: "agent_merge" }));
    expect(t).toContain("task_pr_ready");
    expect(t).toContain("agent_merge");
    expect(t).toContain("task_pr_merge");
    expect(t).not.toContain("task_pr_merge は使えない");
  });

  it("Ready 済み: human_review は人のレビュー待ち、agent_merge は task_pr_merge", () => {
    const human = nextSteps(input({}, { draft: false }));
    expect(human).toContain("Ready");
    expect(human).toContain("人のレビューを待つ");
    expect(human).not.toContain("task_pr_ready で Ready にする");
    const agent = nextSteps(input({ merge_policy: "agent_merge" }, { draft: false }));
    expect(agent).toContain("task_pr_merge でマージ");
    expect(agent).not.toContain("task_pr_ready で Ready にする");
  });

  it("マージ済みなら、やることは無い", () => {
    const t = nextSteps(input({ merge_policy: "agent_merge" }, { draft: false, merged: true }));
    expect(t).toContain("マージ済み");
    expect(t).not.toContain("task_pr_merge でマージ");
  });

  it("head_matches_verified が false: task_pr_merge は使えない（人がマージ）。Ready にはできる", () => {
    const t = nextSteps(input({ merge_policy: "agent_merge" }, { head_matches_verified: false }));
    expect(t).toContain("head_matches_verified");
    expect(t).toContain("task_pr_merge は使えない");
    expect(t).toContain("task_pr_ready");
  });

  it("head_matches_verified が null（まだ読めていない）: 少し待って task_result を呼び直す", () => {
    const t = nextSteps(input({}, { head_matches_verified: null, head_sha: null }));
    expect(t).toContain("task_result を呼び直す");
  });

  it("verified が false なら、検証を通っていないので自分で確かめるよう添える", () => {
    const t = nextSteps(input({ verification: { verified: false } }));
    expect(t).toContain("検証コマンドを通っていない");
  });

  it("COMPLETED 以外（FAILED / CANCELLED / BUDGET_EXCEEDED）: task_pr_ready / task_pr_merge は使えない。新しいタスクか PR を閉じる", () => {
    for (const status of ["FAILED", "CANCELLED", "BUDGET_EXCEEDED"] as const) {
      const t = nextSteps(input({ status }));
      expect(t).toContain(status);
      expect(t).toContain("task_pr_ready / task_pr_merge は使えない");
      expect(t).toContain("task_start");
      expect(t).not.toContain("task_pr_ready で Ready にする");
    }
  });

  it("PR が無い COMPLETED: PR を使う操作は無い", () => {
    const t = nextSteps(input({}, null));
    expect(t).toContain("PR が無い");
    expect(t).not.toContain("task_pr_ready で Ready にする");
  });

  it("merge_policy を応答の文に含める（どちらの方針かが分かる）", () => {
    expect(nextSteps(input())).toContain("merge_policy が human_review");
    expect(nextSteps(input({ merge_policy: "agent_merge" }))).toContain(
      "merge_policy が agent_merge",
    );
  });
});

describe("task_pr_ready / task_pr_merge の応答の next_steps", () => {
  it("ready 後: human_review は人のレビュー待ち、agent_merge は task_pr_merge", () => {
    expect(nextStepsAfterReady("human_review")).toContain("人のレビューを待つ");
    expect(nextStepsAfterReady("agent_merge")).toContain("task_pr_merge");
  });

  it("merge 後: マージ済みで終わり。ブランチを残したことと、消せなかったことを伝える", () => {
    expect(nextStepsAfterMerge({ branch_deleted: null })).toContain("マージした");
    expect(nextStepsAfterMerge({ branch_deleted: null })).toContain("作業ブランチは残");
    expect(nextStepsAfterMerge({ branch_deleted: true })).not.toContain("作業ブランチは残");
    expect(nextStepsAfterMerge({ branch_deleted: false })).toContain("削除できなかった");
  });
});
