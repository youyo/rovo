import { describe, expect, it } from "vitest";
import { nextStepsForReview } from "../../src/tasks/next-steps";

// task_review の task_result の next_steps: レビューのコメントを読む・must_fix を先に見る・PR の状態は rovo が変えていない、を状態から書く。

const base = {
  status: "COMPLETED" as const,
  comment_url: "https://github.com/acme/widgets/pull/7#pullrequestreview-1",
  must_fix_count: 2,
  failure: undefined,
  comment_failed: false,
  target_pr: "https://github.com/acme/widgets/pull/7",
};

describe("nextStepsForReview", () => {
  it("投稿できたら、コメントの URL を読み、must_fix を先に見るよう書く。rovo は PR を Ready にもマージにもしない", () => {
    const s = nextStepsForReview(base);
    expect(s).toContain(base.comment_url);
    expect(s).toContain("must_fix");
    expect(s).toMatch(/Ready にもマージにもしない|状態は変えていない/);
    // 手元でしか流せないテストは引き続きクライアントが行う
    expect(s).toMatch(/手元/);
  });

  it("投稿に失敗したら、task_result の review.body を読むよう書く", () => {
    const s = nextStepsForReview({ ...base, comment_url: null, comment_failed: true });
    expect(s).toContain("review.body");
  });

  it("FAILED（モデルが答えなかった）・BUDGET_EXCEEDED は、何も投稿していないことと、頼み直し方を書く", () => {
    const failed = nextStepsForReview({
      ...base,
      status: "FAILED",
      comment_url: null,
      failure: "model_error",
    });
    expect(failed).toMatch(/投稿していない/);
    expect(failed).toContain("task_review");
    const budget = nextStepsForReview({ ...base, status: "BUDGET_EXCEEDED", comment_url: null });
    expect(budget).toMatch(/予算/);
  });

  it("CANCELLED は何も投稿していない", () => {
    expect(nextStepsForReview({ ...base, status: "CANCELLED", comment_url: null })).toMatch(
      /投稿していない/,
    );
  });
});
