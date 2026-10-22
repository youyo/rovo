import type { TaskStatusDto, VisibleTaskDto } from "@rovo/dashboard-contract";

/**
 * 状態の印（色だけで区別しない。色 + 塗り + 縁の形 + 文字）。
 * 契約の全状態を型で網羅する: TaskStatusDto に状態が増えると、`STATUS_TO_KIND` が型エラーになる。
 */
export type MarkKind =
  | "preparing"
  | "running"
  | "input"
  | "verifying"
  | "recovering"
  | "merged"
  | "review"
  | "closed"
  | "pr"
  | "done"
  | "failed"
  | "budget"
  | "cancelled";

export type Mark = {
  label: string;
  /** 色。見本の合図はコバルト（blue）とオレンジ（orange）だけ。ほかは灰とインク */
  tone: "blue" | "orange" | "gray" | "ink";
  fill: "solid" | "hollow";
  /** 縁の形（実線・破線・点線）。色を無視しても分かるように使う */
  edge: "solid" | "dashed" | "dotted";
};

/** 印の定義。MarkKind が増えたらここもコンパイルエラーになる。 */
export const MARKS = {
  preparing: { label: "準備中", tone: "gray", fill: "hollow", edge: "dotted" },
  running: { label: "実行中", tone: "blue", fill: "hollow", edge: "dashed" },
  input: { label: "入力待ち", tone: "orange", fill: "hollow", edge: "dashed" },
  verifying: { label: "検証中", tone: "blue", fill: "hollow", edge: "dotted" },
  recovering: { label: "復旧中", tone: "gray", fill: "hollow", edge: "dashed" },
  merged: { label: "マージ済み", tone: "blue", fill: "solid", edge: "solid" },
  review: { label: "レビュー待ち", tone: "blue", fill: "hollow", edge: "solid" },
  // GitHub 上で閉じられた（マージされていない）PR。灰の中空（実線）で、マージ済みの塗り青・レビュー待ちの中空青と形も色も違う
  closed: { label: "閉じた", tone: "gray", fill: "hollow", edge: "solid" },
  // PR の状態が GitHub から取れなかった（rovo の記録ではマージ済みでもない）。断定しない言葉にする
  pr: { label: "PR あり", tone: "ink", fill: "hollow", edge: "dotted" },
  done: { label: "完了", tone: "ink", fill: "hollow", edge: "solid" },
  failed: { label: "失敗", tone: "orange", fill: "hollow", edge: "solid" },
  budget: { label: "予算超過", tone: "orange", fill: "hollow", edge: "dotted" },
  cancelled: { label: "キャンセル", tone: "gray", fill: "solid", edge: "solid" },
} as const satisfies Record<MarkKind, Mark>;

/**
 * COMPLETED の印を PR で決める。rovo の記録（pr.merged）が先で、GitHub の状態（pr.state）はその次。
 * state が "unknown"（取れなかった）なら、記録だけで判断し、マージ済みでなければ「PR あり」と断定しない。
 */
function completedKind(pr: NonNullable<VisibleTaskDto["pr"]>): MarkKind {
  if (pr.merged) return "merged";
  const byState = {
    merged: "merged",
    open: "review",
    closed: "closed",
    unknown: "pr",
  } as const satisfies Record<typeof pr.state, MarkKind>;
  return byState[pr.state];
}

/** 契約の状態 → 印の種類。漏れるとコンパイルエラー。COMPLETED だけは PR の情報で決める。 */
const STATUS_TO_KIND = {
  CREATING: () => "preparing",
  RUNNING: () => "running",
  INPUT_REQUIRED: () => "input",
  VERIFYING: () => "verifying",
  RECOVERING: () => "recovering",
  COMPLETED: (t) => (t.pr === null ? "done" : completedKind(t.pr)),
  FAILED: () => "failed",
  BUDGET_EXCEEDED: () => "budget",
  CANCELLED: () => "cancelled",
} as const satisfies Record<TaskStatusDto, (task: VisibleTaskDto) => MarkKind>;

export function markKindOf(task: VisibleTaskDto): MarkKind {
  return STATUS_TO_KIND[task.status](task);
}

export function markOf(task: VisibleTaskDto): Mark {
  return MARKS[markKindOf(task)];
}
