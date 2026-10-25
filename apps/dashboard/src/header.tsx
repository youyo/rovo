import type { ReactNode } from "react";
import type { Scope } from "./api";
import type { DayKey } from "./day";
import type { Key, Lang } from "./i18n";
import { useLang } from "./lang";
import type { DaySummary } from "./rail";
import { useNarrow } from "./use-narrow";

/** 表示範囲の切り替え。並びは「マイタスク」が先。API の scope の値（me / all）は変えない（表示は辞書で引く） */
const SCOPES: { value: Scope; label: Key }[] = [
  { value: "me", label: "scope.me" },
  { value: "all", label: "scope.all" },
];

/** 言語の切り替えのボタン。名前は言語自身の表記で、訳さない */
const LANG_BUTTONS: { value: Lang; label: string }[] = [
  { value: "en", label: "EN" },
  { value: "ja", label: "日本語" },
];

/** ヘッダ: Rovo・マイタスク/チーム・その日の要約・言語の切り替え・利用者名・ログアウト。 */
export function Header(props: {
  /** ログイン済みのときだけマイタスク/チームを出す */
  scope?: Scope;
  onScopeChange?: (scope: Scope) => void;
  summary: DaySummary | null;
  /** 表示している日（null = 今日）。onDayChange があるときだけ日付の前後送りを出す */
  day?: DayKey;
  /** 前の日・次の日・今日へ。delta は -1 / 1、"today" は今日へ */
  onDayChange?: (move: -1 | 1 | "today") => void;
  /** 利用者名とログアウト（ログインの案内） */
  children?: ReactNode;
}) {
  const { summary } = props;
  const { t, lang, setLang } = useLang();
  const narrow = useNarrow();
  const other = LANG_BUTTONS.find((b) => b.value !== lang) ?? LANG_BUTTONS[0];
  const summaryEl = summary ? (
    <p className="day-summary">
      <span>{summary.day}</span> <span>{t("header.total", { n: summary.total })}</span>{" "}
      <span>{t("header.merged", { n: summary.merged })}</span>{" "}
      <span>{t("header.running", { n: summary.running })}</span>
    </p>
  ) : null;
  return (
    <header className="top">
      <div className="brand">
        <img
          className="brand-mark"
          src="/dashboard/assets/brand/rovo-mark.svg"
          alt=""
          width={24}
          height={24}
        />
        <span className="brand-name">Rovo</span>
      </div>
      {props.scope !== undefined && props.onScopeChange ? (
        <fieldset className="seg" aria-label={t("scope.label")}>
          {SCOPES.map((s) => (
            <button
              key={s.value}
              type="button"
              aria-pressed={props.scope === s.value}
              onClick={() => props.onScopeChange?.(s.value)}
            >
              {t(s.label)}
            </button>
          ))}
        </fieldset>
      ) : null}
      {props.onDayChange ? (
        <div className="day-nav">
          <button
            type="button"
            className="day-btn"
            aria-label={t("day.prevAria")}
            onClick={() => props.onDayChange?.(-1)}
          >
            ◀<span className="day-btn-text"> {t("day.prev")}</span>
          </button>
          {summaryEl}
          <button
            type="button"
            className="day-btn"
            aria-label={t("day.nextAria")}
            disabled={props.day === null || props.day === undefined}
            onClick={() => props.onDayChange?.(1)}
          >
            <span className="day-btn-text">{t("day.next")} </span>▶
          </button>
          {props.day !== null && props.day !== undefined ? (
            <button
              type="button"
              className="day-btn day-today"
              aria-label={t("day.today")}
              onClick={() => props.onDayChange?.("today")}
            >
              {t("day.today")}
            </button>
          ) : null}
        </div>
      ) : (
        summaryEl
      )}
      <div className="grow" />
      {narrow && other ? (
        <button
          type="button"
          className="lang-one"
          lang={other.value}
          onClick={() => setLang(other.value)}
        >
          {other.label}
        </button>
      ) : (
        <fieldset className="seg lang" aria-label={t("lang.label")}>
          {LANG_BUTTONS.map((b) => (
            <button
              key={b.value}
              type="button"
              lang={b.value}
              aria-pressed={lang === b.value}
              onClick={() => setLang(b.value)}
            >
              {b.label}
            </button>
          ))}
        </fieldset>
      )}
      <div className="user">{props.children}</div>
    </header>
  );
}
