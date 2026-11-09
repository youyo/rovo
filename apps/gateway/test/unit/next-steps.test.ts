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
  it("task_pr_merge の案内: 既定で作業ブランチが消えること・残すなら delete_branch: false", () => {
    const t = nextSteps(input({}, { draft: false }));
    expect(t).toContain("既定で作業ブランチを削除する");
    expect(t).toContain("delete_branch: false");
  });

  it("ready 後: 全体のテストとレビューはクライアントの手元。task_pr_merge か直接マージ", () => {
    const t = nextStepsAfterReady("client_review");
    expect(t).toContain("全体のテスト");
    expect(t).toContain("task_pr_merge");
    expect(t).not.toContain("人のレビューを待つ");
  });

  it("merge 後: マージ済みで終わり。ブランチを残したことと、消せなかったことを伝える", () => {
    expect(nextStepsAfterMerge({ branch_deleted: null })).toContain("マージした");
    expect(nextStepsAfterMerge({ branch_deleted: null })).toContain("作業ブランチは残");
    expect(nextStepsAfterMerge({ branch_deleted: null })).toContain("delete_branch: false");
    expect(nextStepsAfterMerge({ branch_deleted: true })).toContain("作業ブランチを削除した");
    expect(nextStepsAfterMerge({ branch_deleted: true })).not.toContain("作業ブランチは残");
    expect(nextStepsAfterMerge({ branch_deleted: false })).toContain("削除できなかった");
  });
});

describe("nextSteps: 同じ PR への積み足し（continue_task_id）", () => {
  const C = "01HZZZZZZZZZZZZZZZZZZZZZZY";
  const LATEST = "01HZZZZZZZZZZZZZZZZZZZZZZX";

  it("COMPLETED の修正の頼み方: 同じ PR に重ねるなら continue_task_id と base_sha（repository・base_ref は省略可）。別 PR の積み上げは互いに依存する別々の作業のときだけ", () => {
    const t = nextSteps(input({}, { draft: false }));
    expect(t).toContain(`continue_task_id: ${ID}`);
    expect(t).toContain(`base_sha: ${HEAD}`);
    expect(t).toContain("repository と base_ref は省略");
    expect(t).toContain("互いに依存する別々の作業");
    // continue_task_id の案内が、別 PR の積み上げより先
    expect(t.indexOf("continue_task_id")).toBeLessThan(t.indexOf("互いに依存する別々の作業"));
  });

  it("COMPLETED 以外で PR があるとき: continue_task_id を先に案内する（base_sha は pr.head_sha）", () => {
    for (const status of ["FAILED", "CANCELLED", "BUDGET_EXCEEDED"] as const) {
      const t = nextSteps(input({ status }));
      expect(t).toContain(`continue_task_id: ${ID}`);
      expect(t).toContain(HEAD);
      expect(t).not.toContain("git ls-remote");
    }
  });

  it("COMPLETED 以外で pr.head_sha が null: git ls-remote で PR ブランチの先頭を確かめて base_sha に渡す。base_not_from_rovo の注意も添える", () => {
    const t = nextSteps(
      input({ status: "FAILED" }, { head_sha: null, head_matches_verified: null }),
    );
    expect(t).toContain(`continue_task_id: ${ID}`);
    expect(t).toContain("git ls-remote");
    expect(t).toContain(`refs/heads/agent/task-${ID}`);
    expect(t).toContain("base_not_from_rovo");
  });

  it("積み足しのタスクの PR ブランチは根のブランチ（pr.branch）を案内する", () => {
    const t = nextSteps(
      input(
        { task_id: C, status: "FAILED", continuation_of: ID },
        { head_sha: null, head_matches_verified: null, branch: `agent/task-${ID}` },
      ),
    );
    expect(t).toContain(`continue_task_id: ${C}`);
    expect(t).toContain(`refs/heads/agent/task-${ID}`);
    expect(t).not.toContain(`agent/task-${C}`);
  });

  it("superseded_by のある古いタスク: 最新のタスクの結果を確認して、その id で task_pr_merge するよう案内する", () => {
    const t = nextSteps(input({ superseded_by: LATEST }, { draft: false }));
    expect(t).toContain(LATEST);
    expect(t).toContain("task_pr_merge");
    expect(t).toContain("最新のタスク");
    // このタスクの id でマージするよう案内しない
    expect(t).not.toContain("問題が無ければ task_pr_merge でマージする");
    expect(t).not.toContain(`continue_task_id: ${ID}`);
  });

  it("積み足しのタスクの COMPLETED: PR は元のタスクと同じ。全体のテストとレビューは今の PR のブランチで行い、よければこのタスクの id で task_pr_merge。直後の branch_busy は not_ready でなくなってから再試行", () => {
    const t = nextSteps(
      input(
        { task_id: C, continuation_of: ID },
        { draft: false, branch: `agent/task-${ID}`, continuation_of: ID },
      ),
    );
    expect(t).toContain("元のタスク");
    expect(t).toContain(ID);
    expect(t).toContain(`agent/task-${ID}`);
    expect(t).not.toContain(`agent/task-${C}`);
    expect(t).toContain(`このタスクの id（${C}）で task_pr_merge`);
    expect(t).toContain("branch_busy");
    expect(t).toContain("not_ready");
    // 次の修正もこのタスクから積む
    expect(t).toContain(`continue_task_id: ${C}`);
  });

  it("準備の失敗 branch_moved: pr.head_sha か git ls-remote で今の先頭を確かめ直して task_start し直す", () => {
    const t = nextSteps(
      input(
        {
          task_id: C,
          status: "FAILED",
          reason: "branch_moved",
          failure_phase: "setup",
          continuation_of: ID,
        },
        { head_sha: null, head_matches_verified: null, branch: `agent/task-${ID}` },
      ),
    );
    expect(t).toContain("branch_moved");
    expect(t).toContain("git ls-remote");
    expect(t).toContain("base_sha");
    expect(t).toContain("task_start");
    expect(t).toContain(`continue_task_id: ${ID}`);
  });

  it("準備の失敗 pr_not_open: PR が閉じた・マージされたので積み足せない。PR を確かめ、新しいタスクで始める", () => {
    const t = nextSteps(
      input(
        {
          task_id: C,
          status: "FAILED",
          reason: "pr_not_open",
          failure_phase: "setup",
          continuation_of: ID,
        },
        { branch: `agent/task-${ID}` },
      ),
    );
    expect(t).toContain("pr_not_open");
    expect(t).toContain("閉じ");
    expect(t).toContain("マージ");
    expect(t).toContain("task_start");
  });
});
