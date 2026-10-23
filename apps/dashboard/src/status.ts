import type { TaskStatusDto, VisibleTaskDto } from "@rovo/dashboard-contract";
import type { T } from "./i18n";

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

/**
 * 印の記号（形）。GitHub Actions の見た目に合わせ、意味が同じ状態は同じ形にする:
 * check = 緑の丸に ✓（成功）、cross = 赤の丸に ✕（失敗）、spinner = 黄の回る輪（動いている）、
 * dot = 青の丸に ●（レビュー待ち）、dash = 灰の丸に –（閉じた・キャンセル）、
 * queued = 点線の輪（未着手・準備中）、bang = 黄の丸に ！（入力待ち）。
 * 色だけに頼らず、形と隣の文字（label）で区別する。図形は status-mark.tsx の MarkSymbol が描く。記号が増えたらそちらもコンパイルエラーになる。
 */
export type MarkShape = "check" | "cross" | "spinner" | "dot" | "dash" | "queued" | "bang";

export type Mark = {
  /** 記号（形）。意味が同じ状態は同じ形 */
  shape: MarkShape;
  /** 回る輪の状態か（印を回転させる。reduced-motion では止めて破線にする） */
  live: boolean;
  /** 色。ok = 緑、bad = 赤、run = 黄、wait = 青、skip = 灰 */
  tone: "ok" | "bad" | "run" | "wait" | "skip";
  /** タイムラインの棒の塗りと縁の形。(tone, fill, edge) は全ての印で違い、色を無視しても棒を区別できる */
  fill: "solid" | "hollow";
  edge: "solid" | "dashed" | "dotted";
};

/** 印の定義。MarkKind が増えたらここもコンパイルエラーになる。 */
export const MARKS = {
  preparing: {
    shape: "queued",
    live: false,
    tone: "skip",
    fill: "hollow",
    edge: "dotted",
  },
  running: {
    shape: "spinner",
    live: true,
    tone: "run",
    fill: "hollow",
    edge: "dashed",
  },
  input: {
    shape: "bang",
    live: false,
    tone: "run",
    fill: "hollow",
    edge: "solid",
  },
  verifying: {
    shape: "spinner",
    live: true,
    tone: "run",
    fill: "hollow",
    edge: "dotted",
  },
  recovering: {
    shape: "spinner",
    live: true,
    tone: "skip",
    fill: "hollow",
    edge: "dashed",
  },
  merged: {
    shape: "check",
    live: false,
    tone: "ok",
    fill: "solid",
    edge: "solid",
  },
  review: {
    shape: "dot",
    live: false,
    tone: "wait",
    fill: "hollow",
    edge: "solid",
  },
  // GitHub 上で閉じられた（マージされていない）PR。灰（–）で、マージ済みの緑・レビュー待ちの青と色も形も違う。
  // 「閉じた」だけでは何が閉じたのか分かりにくいので、凡例・点の title では説明をつける（レール・見出し・バッジは短い label のまま）
  closed: {
    shape: "dash",
    live: false,
    tone: "skip",
    fill: "hollow",
    edge: "solid",
  },
  // PR の状態が GitHub から取れなかった（rovo の記録ではマージ済みでもない）。断定しない言葉にする
  pr: {
    shape: "dot",
    live: false,
    tone: "wait",
    fill: "hollow",
    edge: "dotted",
  },
  done: {
    shape: "check",
    live: false,
    tone: "ok",
    fill: "hollow",
    edge: "solid",
  },
  failed: {
    shape: "cross",
    live: false,
    tone: "bad",
    fill: "hollow",
    edge: "solid",
  },
  budget: {
    shape: "cross",
    live: false,
    tone: "bad",
    fill: "hollow",
    edge: "dotted",
  },
  cancelled: {
    shape: "dash",
    live: false,
    tone: "skip",
    fill: "solid",
    edge: "solid",
  },
} as const satisfies Record<MarkKind, Mark>;

/** 短い名前。レール・見出し・バッジなど狭い場所で使う。凡例だけが長い説明（markDescription）を使う */
export function markLabel(kind: MarkKind, t: T): string {
  return t(`mark.${kind}`);
}

/**
 * 長い説明（凡例・タイムラインの点の title）。label だけでは初めて見た人に分かりにくい印（閉じた）だけが持つ。
 * 無ければ label がそのまま説明。label から始まる言葉にする。
 */
export function markDescription(kind: MarkKind, t: T): string {
  return kind === "closed" ? t("mark.closed.description") : markLabel(kind, t);
}

/**
 * COMPLETED の印を PR で決める。rovo の記録（pr.merged）が先で、GitHub の状態（pr.state）はその次。
 * state が "unknown"（取れなかった）なら、記録だけで判断し、マージ済みでなければ「PR あり」と断定しない。
 */
export function completedKind(pr: NonNullable<VisibleTaskDto["pr"]>): MarkKind {
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

const TERMINAL: ReadonlySet<TaskStatusDto> = new Set([
  "COMPLETED",
  "FAILED",
  "BUDGET_EXCEEDED",
  "CANCELLED",
]);

/** 終端の状態か（もう進まない）。 */
export const isTerminal = (s: TaskStatusDto): boolean => TERMINAL.has(s);
