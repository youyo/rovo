import type { ReactNode } from "react";
import type { Scope } from "./api";
import type { DayKey } from "./day";
import type { DaySummary } from "./rail";

const SCOPES: { value: Scope; label: string }[] = [
  { value: "all", label: "全員" },
  { value: "me", label: "自分" },
];

/** ヘッダ: rovo・全員/自分・その日の要約・利用者名・ログアウト。 */
export function Header(props: {
  /** ログイン済みのときだけ全員/自分を出す */
  scope?: Scope;
  onScopeChange?: (scope: Scope) => void;
  summary: DaySummary | null;
  /** 表示している日（null = 今日）。onDayChange があるときだけ日付の前後送りを出す */
  day?: DayKey;
  /** 前の日・次の日・今日へ。delta は -1 / 1、"today" は今日へ */
  onDayChange?: (move: -1 | 1 | "today") => void;
  /** 利用者名とログアウト（ログインの案内） */
  children: ReactNode;
}) {
  const { summary } = props;
  const summaryEl = summary ? (
    <p className="day-summary">
      <span>{summary.day}</span> <span>{summary.total} 件</span>{" "}
      <span>マージ {summary.merged}</span> <span>走行中 {summary.running}</span>
    </p>
  ) : null;
  return (
    <header className="top">
      <div className="brand">rovo</div>
      {props.scope !== undefined && props.onScopeChange ? (
        <fieldset className="seg" aria-label="表示するタスク">
          {SCOPES.map((s) => (
            <button
              key={s.value}
              type="button"
              aria-pressed={props.scope === s.value}
              onClick={() => props.onScopeChange?.(s.value)}
            >
              {s.label}
            </button>
          ))}
        </fieldset>
      ) : null}
      {props.onDayChange ? (
        <div className="day-nav">
          <button
            type="button"
            className="day-btn"
            aria-label="前の日"
            onClick={() => props.onDayChange?.(-1)}
          >
            ◀<span className="day-btn-text"> 前の日</span>
          </button>
          {summaryEl}
          <button
            type="button"
            className="day-btn"
            aria-label="次の日"
            disabled={props.day === null || props.day === undefined}
            onClick={() => props.onDayChange?.(1)}
          >
            <span className="day-btn-text">次の日 </span>▶
          </button>
          {props.day !== null && props.day !== undefined ? (
            <button
              type="button"
              className="day-btn day-today"
              aria-label="今日へ"
              onClick={() => props.onDayChange?.("today")}
            >
              今日へ
            </button>
          ) : null}
        </div>
      ) : (
        summaryEl
      )}
      <div className="grow" />
      <div className="user">{props.children}</div>
    </header>
  );
}
