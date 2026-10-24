import { describe, expect, it } from "vitest";
import { nextSteps, nextStepsAfterMerge, nextStepsAfterReady } from "../../src/tasks/next-steps";
import type { ResultView } from "../../src/tasks/task-do";

// task_result の next_steps（D9）: status・review_policy・PR の draft 状態・head_matches_verified に応じて、次にすべきことを返す。

const ID = "01HZZZZZZZZZZZZZZZZZZZZZZZ";
const HEAD = "a".repeat(40);

type In = Parameters<typeof nextSteps>[0];
function input(over: Partial<In> = {}, pr: Partial<NonNullable<ResultView["pr"]>> | null = {}): In {
  return {
    task_id: ID,
    status: "COMPLETED",
    review_policy: "client_review",
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

describe("nextSteps: 準備の段階の失敗", () => {
  it("base_sha_not_found: 40 桁の SHA を git ls-remote などで確かめて task_start し直すよう案内する", () => {
    const t = nextSteps(
      input({ status: "FAILED", reason: "base_sha_not_found", failure_phase: "setup" }, null),
    );
    expect(t).toContain("base_sha_not_found");
    expect(t).toContain("40 桁");
    expect(t).toContain("git ls-remote");
    expect(t).toContain("task_start");
    expect(t).not.toContain("summary と warnings で原因を確かめ");
  });

  it("reason だけでも base_sha_not_found なら同じ案内になる", () => {
    const t = nextSteps(input({ status: "FAILED", reason: "base_sha_not_found" }, null));
    expect(t).toContain("git ls-remote");
  });

  it("その他の準備の失敗: reason を示す汎用の案内（git ls-remote は出さない）", () => {
    const t = nextSteps(
      input({ status: "FAILED", reason: "branch_conflict", failure_phase: "setup" }, null),
    );
    expect(t).toContain("branch_conflict");
    expect(t).toContain("task_start");
    expect(t).not.toContain("git ls-remote");
    expect(t).not.toContain("summary と warnings で原因を確かめ");
  });

  it("準備の段階でない FAILED は、従来どおりの案内", () => {
    const t = nextSteps(input({ status: "FAILED", reason: "deadline" }, null));
    expect(t).toContain("summary と warnings で原因を確かめ");
  });
});

describe("nextSteps", () => {
  it("COMPLETED・Ready 済み（client_review。rovo が自動で Ready にした）: レビュー → 手元で全体のテスト → task_pr_merge か直接マージ", () => {
    const t = nextSteps(input({}, { draft: false }));
    expect(t).toContain("task_result");
    expect(t).toContain("client_review");
    expect(t).toContain("rovo が");
    expect(t).toContain("Ready for review");
    expect(t).not.toContain("task_pr_ready で Ready にする");
    // 全体のテストとレビューはクライアントの手元。PR のブランチを取り出す
    expect(t).toContain("手元");
    expect(t).toContain("全体のテスト");
    expect(t).toContain(`agent/task-${ID}`);
    expect(t).toContain("task_pr_merge でマージ");
    // 手元で修正を積んだら head_matches_verified が false になるので、直接マージする
    expect(t).toContain("head_matches_verified");
    expect(t).toContain("gh");
    expect(t).not.toContain("人のレビューを待つ");
    expect(t).not.toContain("human_review");
    expect(t).not.toContain("agent_merge");
  });

  it("Draft のまま（自動の Ready に失敗した・古いタスク）: task_pr_ready で Ready にしてから、同じ流れ", () => {
    const t = nextSteps(input());
    expect(t).toContain("task_pr_ready");
    expect(t).toContain("自動");
    expect(t).toContain("task_pr_merge");
    expect(t).toContain("全体のテスト");
    // 問題があるとき: task_steer は実行中専用。新しいタスクで、この PR のブランチに積む
    expect(t).toContain("task_steer");
    expect(t).toContain(HEAD);
  });

  it("draft が null（まだ読めていない）も Draft と同じ案内（task_pr_ready は冪等）", () => {
    expect(nextSteps(input({}, { draft: null }))).toContain("task_pr_ready");
  });

  it("task_pr_merge の条件（Ready・head_matches_verified・GitHub の check）を書く。check が無ければ通る", () => {
    const t = nextSteps(input({}, { draft: false }));
    expect(t).toContain("check");
    expect(t).toContain("無ければ");
    expect(t).toContain("checks_failing");
  });

  it("マージ済みなら、やることは無い", () => {
    const t = nextSteps(input({}, { draft: false, merged: true }));
    expect(t).toContain("マージ済み");
    expect(t).not.toContain("task_pr_merge でマージ");
  });

  it("head_matches_verified が false: task_pr_merge は使えない（gh などで直接マージする）", () => {
    const t = nextSteps(input({}, { draft: false, head_matches_verified: false }));
    expect(t).toContain("head_matches_verified");
    expect(t).toContain("task_pr_merge は使えない");
    expect(t).toContain("直接マージ");
    expect(t).not.toContain("task_pr_merge でマージする");
  });

  it("head_matches_verified が null（まだ読めていない）: 少し待って task_result を呼び直す", () => {
    const t = nextSteps(input({}, { head_matches_verified: null, head_sha: null }));
    expect(t).toContain("task_result を呼び直す");
  });

  it("verified が false なら、検証を通っていないので自分で確かめるよう添える", () => {
    const t = nextSteps(input({ verification: { verified: false } }));
    expect(t).toContain("検証コマンドを通っていない");
  });

  it("COMPLETED 以外（FAILED / CANCELLED / BUDGET_EXCEEDED）: PR は Draft のまま。task_pr_ready / task_pr_merge は使えない。新しいタスクか PR を閉じる", () => {
    for (const status of ["FAILED", "CANCELLED", "BUDGET_EXCEEDED"] as const) {
      const t = nextSteps(input({ status }));
      expect(t).toContain(status);
      expect(t).toContain("task_pr_ready / task_pr_merge は使えない");
      expect(t).toContain("Draft のまま");
      expect(t).toContain("task_start");
      expect(t).not.toContain("task_pr_ready で Ready にする");
    }
  });

  it("PR が無い COMPLETED: PR を使う操作は無い", () => {
    const t = nextSteps(input({}, null));
    expect(t).toContain("PR が無い");
    expect(t).not.toContain("task_pr_ready で Ready にする");
  });

  it("review_policy を応答の文に含める", () => {
    expect(nextSteps(input())).toContain("review_policy が client_review");
  });
});

describe("task_pr_ready / task_pr_merge の応答の next_steps", () => {
  it("ready 後: 全体のテストとレビューはクライアントの手元。task_pr_merge か直接マージ", () => {
    const t = nextStepsAfterReady("client_review");
    expect(t).toContain("全体のテスト");
    expect(t).toContain("task_pr_merge");
    expect(t).not.toContain("人のレビューを待つ");
  });

  it("merge 後: マージ済みで終わり。ブランチを残したことと、消せなかったことを伝える", () => {
    expect(nextStepsAfterMerge({ branch_deleted: null })).toContain("マージした");
    expect(nextStepsAfterMerge({ branch_deleted: null })).toContain("作業ブランチは残");
    expect(nextStepsAfterMerge({ branch_deleted: true })).not.toContain("作業ブランチは残");
    expect(nextStepsAfterMerge({ branch_deleted: false })).toContain("削除できなかった");
  });
});
