import type { OverviewDto, VisibleTaskDto } from "@rovo/dashboard-contract";
import { formatDayHeading } from "./format";
import { isTerminal, type MarkKind, markKindOf } from "./status";
import { taskTime } from "./timeline";

/** レール・ヘッダ・ステータスバーの純関数（React に依存しない）。 */

export type GlyphTone = "accent" | "fail" | "mute" | "fg";
export type RailGlyph = { char: string; tone: GlyphTone; pulse: boolean };

/**
 * レールの状態の印。見本の · – ✕ に、走行中（脈動）とマージ済み（●）を足す。
 * 色だけで区別しない: 行には状態の文字（読み上げ用）も付く。
 */
const GLYPH = {
  preparing: { char: "·", tone: "accent", pulse: true },
  running: { char: "·", tone: "accent", pulse: true },
  verifying: { char: "·", tone: "accent", pulse: true },
  recovering: { char: "·", tone: "mute", pulse: true },
  input: { char: "?", tone: "accent", pulse: false },
  merged: { char: "●", tone: "accent", pulse: false },
  review: { char: "·", tone: "fg", pulse: false },
  closed: { char: "·", tone: "mute", pulse: false },
  pr: { char: "·", tone: "fg", pulse: false },
  done: { char: "·", tone: "fg", pulse: false },
  failed: { char: "✕", tone: "fail", pulse: false },
  budget: { char: "✕", tone: "fail", pulse: false },
  cancelled: { char: "–", tone: "mute", pulse: false },
} as const satisfies Record<MarkKind, RailGlyph>;

export function railGlyph(kind: MarkKind): RailGlyph {
  return GLYPH[kind];
}

/**
 * 一覧のコンソールに出すタスク。走行中（終端でない）があれば開始が最新のもの、無ければ開始が最新のタスク。
 */
export function pickConsoleTask(tasks: readonly VisibleTaskDto[]): VisibleTaskDto | null {
  const latest = (list: readonly VisibleTaskDto[]) =>
    list.reduce<VisibleTaskDto | null>(
      (best, t) => (best === null || taskTime(t) > taskTime(best) ? t : best),
      null,
    );
  return latest(tasks.filter((t) => !isTerminal(t.status))) ?? latest(tasks);
}

export type DaySummary = { day: string; total: number; merged: number; running: number };

/** ヘッダの要約。「10月22日  12 件  マージ 0  走行中 0」 */
export function daySummary(data: OverviewDto): DaySummary {
  return {
    day: formatDayHeading(Date.parse(data.range.from)),
    total: data.tasks.length,
    merged: data.tasks.filter((t) => markKindOf(t) === "merged").length,
    running: data.tasks.filter((t) => !isTerminal(t.status)).length,
  };
}

/**
 * 自分の今月の上限（USD）。契約は上限そのものを持たないが、残りは「月の上限から実費と予約を引いた値」なので、
 * 使った額 + 予約 + 残りで上限に戻る。残りが 0 のときは負にしない丸めで上限を求められないので null。
 */
export function budgetLimit(budget: OverviewDto["budget"]): number | null {
  if (!(budget.remaining_usd > 0)) return null;
  return budget.spent_usd + budget.reserved_usd + budget.remaining_usd;
}
