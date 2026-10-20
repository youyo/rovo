import type { TaskStatus } from "./state";
import type { ResultView } from "./task-do";
import type { MergePolicy } from "./validation";

/**
 * task_result などの応答に添える next_steps（D9）。呼び出し元の AI が次にすべきことを、状態から決めて文にする。
 * 案内であって強制ではない: task_pr_ready / task_pr_merge の条件はサーバー側（TaskDO と GitHub）が必ず検査する。
 */

export type NextStepsInput = {
  task_id: string;
  status: TaskStatus;
  /** task_result の reason（失敗の理由のコード） */
  reason?: string;
  /** "setup" は準備の段階（runSetup）の失敗。reason はそのコード */
  failure_phase?: "setup";
  merge_policy: MergePolicy;
  verification: { verified: boolean };
  pr: Pick<
    NonNullable<ResultView["pr"]>,
    "number" | "url" | "draft" | "merged" | "head_sha" | "head_matches_verified"
  > | null;
};

const REVIEW =
  "task_result の summary・warnings・verification と patch（大きいときは diffstat と PR の差分）を読んで、受け入れ条件を満たしているか、意図しない変更が無いかをレビューする。";

const NO_MERGE_HUMAN = "task_pr_merge は使えない（人がレビューしてマージする）";

function branchOf(taskId: string): string {
  return `agent/task-${taskId}`;
}

/** レビューで問題があったときの続け方（task_steer は実行中専用）。 */
function fixAdvice(input: NextStepsInput): string {
  const sha = input.pr?.head_sha;
  return `問題があれば Ready にせず、修正を新しいタスクで頼む（task_steer は実行中のタスク専用で、COMPLETED には使えない）。この PR のブランチに積むなら、task_start の base_ref に ${branchOf(input.task_id)}${sha ? `、base_sha に ${sha}` : ""} を指定する。`;
}

/** 準備の段階の失敗（FAILED）の案内。理由のコードに合わせる。 */
function setupFailureAdvice(reason: string | undefined): string {
  if (reason === "base_sha_not_found") {
    return "タスクは準備の段階で FAILED になった（reason: base_sha_not_found）。base_sha がそのリポジトリに無い（短縮形や、別のリポジトリ・消えたコミットの SHA）。git ls-remote などで 40 桁の SHA を確かめて、task_start し直す。";
  }
  return `タスクは準備の段階で FAILED になった（reason: ${reason ?? "unknown"}）。エージェントは動いていないので成果は無く、PR も作られていないことがある（task_pr_ready / task_pr_merge は使えない）。reason を確かめ、直せる原因（権限・設定・既存のブランチや PR など）なら直してから task_start し直す。直せない場合は管理者に reason を伝える。`;
}

export function nextSteps(input: NextStepsInput): string {
  const { status, merge_policy: policy, pr } = input;
  if (status === "FAILED" && input.reason === "base_sha_not_found") {
    return setupFailureAdvice(input.reason);
  }
  if (status === "FAILED" && input.failure_phase === "setup") {
    return setupFailureAdvice(input.reason);
  }
  if (status !== "COMPLETED") {
    return `タスクは COMPLETED ではない（status: ${status}）ため、task_pr_ready / task_pr_merge は使えない。summary と warnings で原因を確かめ、作業を続けるなら新しいタスクを task_start で始める${pr ? `（ブランチ ${branchOf(input.task_id)} の続きから行うなら base_ref にそのブランチ名、base_sha に pr.head_sha を指定する）。不要な PR は GitHub 上で閉じる` : ""}。`;
  }
  if (pr === null) {
    return "PR が無い（作成前に失敗した、または Phase 2 のタスク）ため、task_pr_ready / task_pr_merge は使えない。patch を確かめ、必要なら新しいタスクを task_start で始める。";
  }
  if (pr.merged) {
    return "PR はすでにマージ済み。やることは無い。";
  }

  const parts: string[] = [];
  if (!input.verification.verified) {
    parts.push(
      "検証コマンドを通っていない（未指定、またはモデルの申告のみ）ため、差分に加えて必要なテストを自分で確かめる。",
    );
  }

  // head が検証済みの commit と一致しないときは、task_pr_merge を使えない（サーバーも拒否する）
  const headUnknown = pr.head_matches_verified === null;
  const headMismatch = pr.head_matches_verified === false;
  if (headUnknown) {
    parts.push(
      "PR の head をまだ確認できていない（終端の処理の途中）。少し待って task_result を呼び直す。",
    );
  }
  if (headMismatch) {
    parts.push(
      "head_matches_verified が false: PR の head が検証済みの commit と一致しない（検証のあとにブランチが動いた、または push された commit が検証したものと違う）。差分を自分で読み直す。",
    );
  }

  const canMerge = policy === "agent_merge" && pr.head_matches_verified === true;
  const policyText = (afterReady: boolean): string => {
    if (policy === "human_review") {
      return `merge_policy が human_review なので、${afterReady ? "Ready にしたら" : ""}人のレビューを待つ。${NO_MERGE_HUMAN}。`;
    }
    if (headMismatch) {
      return `merge_policy は agent_merge だが、head_matches_verified が false なので ${NO_MERGE_HUMAN}。`;
    }
    if (headUnknown) {
      return "merge_policy は agent_merge。head を確認できたら task_pr_merge を使える。";
    }
    return `merge_policy が agent_merge なので、${afterReady ? "Ready にしたあと" : ""}task_pr_merge でマージできる（merge_method と delete_branch を選べる。ブランチ保護で拒否されたら、その理由がエラーで返る）。`;
  };

  if (pr.draft === false) {
    parts.push("PR はすでに Ready for review。");
    parts.push(REVIEW);
    parts.push(
      canMerge
        ? `差分に問題が無ければ task_pr_merge でマージする。merge_policy が agent_merge。`
        : policyText(false),
    );
    return parts.join(" ");
  }

  parts.push(REVIEW);
  parts.push("問題が無ければ task_pr_ready で Ready にする。");
  parts.push(policyText(true));
  parts.push(fixAdvice(input));
  return parts.join(" ");
}

/** task_pr_ready の成功後の案内。 */
export function nextStepsAfterReady(policy: MergePolicy): string {
  return policy === "agent_merge"
    ? "PR を Ready for review にした。merge_policy が agent_merge なので、差分に問題が無ければ task_pr_merge でマージできる。"
    : "PR を Ready for review にした。merge_policy が human_review なので、人のレビューを待つ。task_pr_merge は使えない（人がレビューしてマージする）。";
}

/** task_pr_merge の成功後の案内。 */
export function nextStepsAfterMerge(args: { branch_deleted: boolean | null }): string {
  const base = "PR をマージした。このタスクでやることは終わり。";
  if (args.branch_deleted === null)
    return `${base}作業ブランチは残っている（不要なら GitHub 上で削除する）。`;
  if (args.branch_deleted === false) {
    return `${base}作業ブランチを削除できなかった（warnings を参照）。不要なら GitHub 上で削除する。`;
  }
  return base;
}
