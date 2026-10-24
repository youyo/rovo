import { describe, expect, it } from "vitest";
import { type NextStepsInput, nextSteps } from "../../src/tasks/next-steps";

// worker_review の task_result の next_steps: レビューのコメントを読む・must_fix が残っていれば先に対応する・
// docker の e2e など手元でしか流せないテストは引き続きクライアントが行う。

const pr = {
  number: 5,
  url: "https://github.com/acme/widgets/pull/5",
  draft: false,
  merged: false,
  head_sha: "a".repeat(40),
  head_matches_verified: true,
};
const input = (over: Partial<NextStepsInput> = {}): NextStepsInput => ({
  task_id: "t1",
  status: "COMPLETED",
  review_policy: "worker_review",
  verification: { verified: true },
  pr,
  review: {
    comment_url: "https://github.com/acme/widgets/pull/5#pullrequestreview-1",
    must_fix_count: 0,
    comment_failed: false,
  },
  ...over,
});

describe("nextSteps（worker_review）", () => {
  it("投稿できたら、コメントの URL を読むよう書き、手元でしか流せないテスト（docker の e2e など）はクライアントが行うと書く", () => {
    const s = nextSteps(input());
    expect(s).toContain("pullrequestreview-1");
    expect(s).toContain("コメントを読む");
    expect(s).toContain("docker を使う e2e");
    expect(s).toContain("手元");
    expect(s).toContain("must_fix（直すべき点）は無い");
  });

  it("must_fix が残っていれば、先に対応するかを判断するよう書く（review_must_fix_unaddressed）", () => {
    const s = nextSteps(
      input({
        review: {
          comment_url: "https://github.com/acme/widgets/pull/5#pullrequestreview-1",
          must_fix_count: 2,
          comment_failed: false,
        },
      }),
    );
    expect(s).toContain("must_fix（直すべき点）が 2 件残っている");
    expect(s).toContain("review_must_fix_unaddressed");
    expect(s).toContain("先に対応");
  });

  it("投稿に失敗したら review.body を、レビューを飛ばしたら自分でレビューするよう書く", () => {
    const failedPost = nextSteps(
      input({ review: { comment_url: null, must_fix_count: 1, comment_failed: true } }),
    );
    expect(failedPost).toContain("review.body");
    const skipped = nextSteps(
      input({
        review: { comment_url: null, must_fix_count: 0, failure: "budget", comment_failed: false },
      }),
    );
    expect(skipped).toContain("review_skipped_budget");
    expect(skipped).toContain("自分で読んでレビュー");
    const failed = nextSteps(
      input({
        review: {
          comment_url: null,
          must_fix_count: 0,
          failure: "model_error",
          comment_failed: false,
        },
      }),
    );
    expect(failed).toContain("review_failed");
    expect(failed).toContain("model_error");
  });

  it("client_review の案内は変わらない（review を渡さない・policy が client_review）", () => {
    const client = nextSteps(input({ review_policy: "client_review", review: undefined }));
    expect(client).toContain(
      "全体のテスト（docker を使う e2e など、Sandbox では動かないものを含む）とレビューは、クライアントの手元で行う",
    );
    expect(client).not.toContain("コメントを読む");
  });
});
