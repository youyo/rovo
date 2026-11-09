import { DIRECTORY_NAME } from "../directory/types";
import type { BranchCleanupOutcome } from "./task-do";

/**
 * 作業ブランチの掃除（issue #185「2. 掃除の起点と頻度」）。Cron Trigger（毎時 17 分）の 1 回分。
 *
 * 1. DirectoryDO.claimBranchCleanup が候補を選ぶ（1 回 20 件まで・同じタスクは 50 分空ける・終わってから 30 日以内・確認が古い順）。
 * 2. 1 件ずつ順に（並列にしない）TaskDO.cleanupBranch を呼ぶ。消すかどうかの判断はすべて TaskDO が行う。
 * 3. done（もう試さない）なら DirectoryDO.finishBranchCleanup。rate_limited ならその回の残りを止める。
 *    1 件の例外は握って次へ進む（その件は 50 分後にまた選ばれる）。
 *
 * ログに出すのは件数と理由コードだけ（タスクの id・ブランチ名・PR の URL は出さない）。
 */

export type BranchCleanupSweepResult = {
  /** claim で選ばれた件数 */
  claimed: number;
  /** cleanupBranch を呼んだ件数 */
  checked: number;
  /** ブランチを消した件数（reason: deleted） */
  deleted: number;
  /** done（もう試さない）になった件数 */
  done: number;
  /** 例外（claim / cleanupBranch / finish の失敗）の件数 */
  errors: number;
  /** GitHub のレート制限で、その回の残りを止めた */
  stopped_by_rate_limit: boolean;
  /** 理由コードごとの件数 */
  reasons: Record<string, number>;
};

type CleanupDirectory = {
  claimBranchCleanup(now: number, limit?: number): Promise<string[]>;
  finishBranchCleanup(taskId: string): Promise<void>;
};

type CleanupTask = { cleanupBranch(): Promise<BranchCleanupOutcome> };

/** テストで差し替える部品。省略時は env の DIRECTORY_DO（シングルトン）と TASK_DO を使う */
export type BranchCleanupDeps = {
  directory?: CleanupDirectory;
  task?: (taskId: string) => CleanupTask;
};

const errorName = (e: unknown) => (e instanceof Error ? e.name : typeof e);

export async function sweepBranchCleanup(
  env: Env,
  now: number,
  deps: BranchCleanupDeps = {},
): Promise<BranchCleanupSweepResult> {
  const result: BranchCleanupSweepResult = {
    claimed: 0,
    checked: 0,
    deleted: 0,
    done: 0,
    errors: 0,
    stopped_by_rate_limit: false,
    reasons: {},
  };
  const binding = (env as { DIRECTORY_DO?: Env["DIRECTORY_DO"] }).DIRECTORY_DO;
  const directory: CleanupDirectory | undefined =
    deps.directory ??
    (binding ? (binding.getByName(DIRECTORY_NAME) as unknown as CleanupDirectory) : undefined);
  // 索引の無い環境では候補を選べない。何もしない
  if (!directory) return result;
  const task = deps.task ?? ((id: string) => env.TASK_DO.getByName(id) as unknown as CleanupTask);

  let ids: string[];
  try {
    ids = await directory.claimBranchCleanup(now);
  } catch (e) {
    result.errors++;
    console.error("branch_cleanup_claim_error", errorName(e));
    return result;
  }
  result.claimed = ids.length;

  for (const id of ids) {
    let outcome: BranchCleanupOutcome;
    result.checked++;
    try {
      outcome = await task(id).cleanupBranch();
    } catch (e) {
      // その件は 50 分後にまた選ばれる。他の件は続ける
      result.errors++;
      console.error("branch_cleanup_task_error", errorName(e));
      continue;
    }
    result.reasons[outcome.reason] = (result.reasons[outcome.reason] ?? 0) + 1;
    if (outcome.reason === "deleted") result.deleted++;
    if (outcome.done) {
      result.done++;
      try {
        await directory.finishBranchCleanup(id);
      } catch (e) {
        // 記録できなくても、次の回に TaskDO の記録から done が返る
        result.errors++;
        console.error("branch_cleanup_finish_error", errorName(e));
      }
    }
    if (outcome.rate_limited === true) {
      result.stopped_by_rate_limit = true;
      break;
    }
  }

  console.log("branch_cleanup_sweep", JSON.stringify(result));
  return result;
}
