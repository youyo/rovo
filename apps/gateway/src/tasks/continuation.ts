/**
 * 同じ PR への積み足し（task_start の continue_task_id。docs/specs/continue-task.md）で、UserDO・TaskDO・service が共有する型と小さな関数。
 */

/** 先行タスクから引き継ぐ警告。from は警告を出したタスクの id（task_result では `inherited from <from>: <warning>` と出す） */
export type InheritedWarning = { from: string; warning: string };

/**
 * UserDO.authorizeContinue が確かめて固定した事実。service.start は呼び出し側の入力ではなく、これだけを TaskDO に渡す
 * （task_review の options.pull と同じ形）。
 */
export type ContinuationFacts = {
  /** 元のタスク（continue_task_id） */
  of: string;
  /** チェーンの根のタスク（ブランチを作ったタスク）。branch は agent/task-<root> */
  root: string;
  branch: string;
  repository: string;
  base_ref: string;
  pr_number: number;
  pr_url: string;
  /** 先行タスクの警告（元のタスクの warnings と、元が引き継いでいた分。base_not_from_rovo もここに入る） */
  inherited_warnings: InheritedWarning[];
};

/** TaskDO が作る id（ULID）だけを埋める。ブランチ名・PR 本文の目印に使う */
const ID_RE = /^[A-Za-z0-9_-]+$/;
/** 積み足しの鍵にするブランチ（rovo が作った agent/task-<id> だけ） */
const BRANCH_RE = /^agent\/task-([A-Za-z0-9_-]+)$/;

/** agent/task-<root> の root。形が違えば undefined */
export function rootOfBranch(branch: string): string | undefined {
  return BRANCH_RE.exec(branch)?.[1];
}

/** 根の id から作るブランチ名。id の形が違えば undefined */
export function branchOfRoot(root: string): string | undefined {
  return ID_RE.test(root) ? `agent/task-${root}` : undefined;
}

/** 保存形（JSON）から読む。壊れた要素・形の違う要素は捨てる */
export function parseInheritedWarnings(raw: string | null | undefined): InheritedWarning[] {
  if (typeof raw !== "string" || raw === "") return [];
  try {
    const v: unknown = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v.filter(
      (x): x is InheritedWarning =>
        typeof x === "object" &&
        x !== null &&
        typeof (x as InheritedWarning).from === "string" &&
        typeof (x as InheritedWarning).warning === "string",
    );
  } catch {
    return [];
  }
}
