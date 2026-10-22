import type { ReactNode } from "react";
import type { Scope } from "./api";
import type { DaySummary } from "./rail";
import type { Route } from "./route";

const SCOPES: { value: Scope; label: string }[] = [
  { value: "all", label: "全員" },
  { value: "me", label: "自分" },
];

/** ヘッダ（一覧と詳細で同じ）: rovo・全員/自分・その日の要約・利用者名・ログアウト。 */
export function Header(props: {
  route: Route;
  /** ログイン済みのときだけ全員/自分を出す */
  scope?: Scope;
  onScopeChange?: (scope: Scope) => void;
  summary: DaySummary | null;
  /** 利用者名とログアウト（ログインの案内） */
  children: ReactNode;
}) {
  const { summary } = props;
  return (
    <header className="top">
      <div className="brand">rovo</div>
      {props.route.kind === "task" ? (
        <a className="back" href="/dashboard/">
          ダッシュボードに戻る
        </a>
      ) : null}
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
      {summary ? (
        <p className="day-summary">
          <span>{summary.day}</span> <span>{summary.total} 件</span>{" "}
          <span>マージ {summary.merged}</span> <span>走行中 {summary.running}</span>
        </p>
      ) : null}
      <div className="grow" />
      <div className="user">{props.children}</div>
    </header>
  );
}
