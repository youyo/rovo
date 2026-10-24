/**
 * 月のペース（純粋関数。画面側の計算だけで、契約・API は変えない）。
 * 月（UTC。予算の期間 month.period）の経過日数で、使った額を月末まで日割りで延ばす。
 * 経過が 1 日未満（月の初日）や入力が壊れているときは見込みを出さない（early）。
 */

const DAY_MS = 86_400_000;

export type Pace =
  | { kind: "early" }
  | {
      kind: "ok";
      /** 月の何日目か（1 始まり。期間を過ぎていれば最終日） */
      day: number;
      spent: number;
      /** この速さで月末までに使う見込み（USD） */
      projected: number;
      /** 月の上限（分からなければ null） */
      limit: number | null;
      /** 見込みが上限を超えるか（上限が分からなければ false） */
      over: boolean;
    };

export function monthPace(input: {
  spentUsd: number;
  limitUsd: number | null;
  /** 予算の期間（ISO。start を含み end を含まない） */
  periodStart: string;
  periodEnd: string;
  nowMs: number;
}): Pace {
  const start = Date.parse(input.periodStart);
  const end = Date.parse(input.periodEnd);
  const { spentUsd, limitUsd, nowMs } = input;
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    end <= start ||
    !Number.isFinite(nowMs) ||
    !Number.isFinite(spentUsd) ||
    spentUsd < 0
  ) {
    return { kind: "early" };
  }
  const totalMs = end - start;
  const elapsedMs = Math.min(nowMs - start, totalMs);
  if (elapsedMs < DAY_MS) return { kind: "early" };
  const totalDays = Math.round(totalMs / DAY_MS);
  const day = Math.min(Math.floor(elapsedMs / DAY_MS) + 1, totalDays);
  const projected = (spentUsd / elapsedMs) * totalMs;
  const limit = limitUsd !== null && Number.isFinite(limitUsd) ? limitUsd : null;
  return {
    kind: "ok",
    day,
    spent: spentUsd,
    projected,
    limit,
    over: limit !== null && projected > limit,
  };
}
