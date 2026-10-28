import type { ReactNode, Ref } from "react";
import {
  type Check,
  type CheckClass,
  checkClass,
  checkDurationMs,
  shortSha,
  sortChecks,
  summarizeChecks,
} from "./checks";
import { formatDuration, isAllowedCheckUrl } from "./format";
import type { T } from "./i18n";
import { useT } from "./lang";
import type { MarkShape } from "./status";
import { ShapeSymbol } from "./status-mark";
import type { ChecksState } from "./use-task-checks";

/**
 * PR の CI（check run と commit status）の表示。名前と URL は外部が書ける非信頼データなので、
 * 名前は React のテキストとしてだけ描き（HTML として解釈しない）、リンクは https://github.com/ のものだけにする。
 */

const SYMBOL: Record<CheckClass, { shape: MarkShape; tone: "ok" | "bad" | "run" | "skip" }> = {
  fail: { shape: "cross", tone: "bad" },
  run: { shape: "spinner", tone: "run" },
  queued: { shape: "queued", tone: "skip" },
  ok: { shape: "check", tone: "ok" },
  skip: { shape: "dash", tone: "skip" },
};

function CheckSymbol(props: { cls: CheckClass }) {
  const s = SYMBOL[props.cls];
  return <ShapeSymbol shape={s.shape} tone={s.tone} live={props.cls === "run"} />;
}

/** 見出しのチップの aria-label に入れる要約（0 は入れない）。状態のないときはその言葉 */
export function ciSummaryText(state: ChecksState, t: T): string {
  if (state.phase === "loading") return t("ci.stateLoading");
  if (state.phase === "error") return t("ci.stateError");
  const { data } = state;
  if (data.state === "unreadable") return t("ci.stateUnreadable");
  if (data.checks.length === 0) return t("ci.stateNone");
  const n = summarizeChecks(data.checks);
  const parts: string[] = [];
  if (n.ok > 0) parts.push(t("ci.sumOk", { n: n.ok }));
  if (n.fail > 0) parts.push(t("ci.sumFail", { n: n.fail }));
  if (n.pending > 0) parts.push(t("ci.sumPending", { n: n.pending }));
  return parts.join(t("common.sep"));
}

/** 失敗の数（CI のタブの見出しに出す）。取れていない・読めないときは 0 */
export function ciFailedCount(state: ChecksState | null): number {
  if (state === null || state.phase !== "ready" || state.data.state === "unreadable") return 0;
  return summarizeChecks(state.data.checks).fail;
}

/** 見出しの要約チップ（✓ 成功 ✗ 失敗 ◌ 実行中・待ち）。色だけに頼らず、記号と数と aria-label で伝える */
export function CiChip(props: { state: ChecksState; onClick: () => void }) {
  const t = useT();
  const { state } = props;
  let body: ReactNode;
  if (
    state.phase === "ready" &&
    state.data.state !== "unreadable" &&
    state.data.checks.length > 0
  ) {
    const n = summarizeChecks(state.data.checks);
    const item = (kind: "ok" | "fail" | "pending", count: number, cls: CheckClass) =>
      count === 0 ? null : (
        <span className="ci-n" data-n="" data-kind={kind}>
          <CheckSymbol cls={cls} />
          {count}
        </span>
      );
    body = (
      <>
        {item("ok", n.ok, "ok")}
        {item("fail", n.fail, "fail")}
        {item("pending", n.pending, "queued")}
      </>
    );
  } else {
    // 数が無い状態: 読み込み中 …、読めない・取得失敗 ?、まだ無い –
    const glyph =
      state.phase === "loading"
        ? "…"
        : state.phase === "error" || state.data.state === "unreadable"
          ? "?"
          : "–";
    body = (
      <span className="ci-n ci-n--none" aria-hidden="true">
        {glyph}
      </span>
    );
  }
  return (
    <button
      type="button"
      className="ci-chip"
      data-ci-chip=""
      aria-label={t("ci.chipAria", { list: ciSummaryText(state, t) })}
      onClick={props.onClick}
    >
      <span className="ci-chip-label">CI</span>
      {body}
    </button>
  );
}

function CheckRow(props: { check: Check; now: number }) {
  const t = useT();
  const { check } = props;
  const cls = checkClass(check);
  const ms = checkDurationMs(check, props.now);
  const url = isAllowedCheckUrl(check.url) ? check.url : null;
  return (
    <li className="ci-row" data-class={cls} data-kind={check.kind}>
      <CheckSymbol cls={cls} />
      <span className="sr-only">{t(`ci.status.${cls}`)}</span>
      <span className="ci-name" title={check.name}>
        {check.name}
      </span>
      <span className="ci-dur">
        {ms === null ? "" : `${formatDuration(ms, t)}${cls === "run" ? "…" : ""}`}
      </span>
      {url === null ? (
        <span className="ci-link" aria-hidden="true" />
      ) : (
        <a
          className="ci-link"
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={t("ci.openNamed", { name: check.name })}
        >
          {t("ci.open")}
        </a>
      )}
    </li>
  );
}

/**
 * CI のペイン。見出し「CI」と head の短い SHA → 細い区切りの帯（check 1 つが 1 区画。唯一の目を引く要素）→ 一覧。
 * 並びは 失敗 → 実行中 → 待ち → 成功 → skipped / neutral。
 */
export function CiPane(props: {
  state: ChecksState;
  /** 実行中の経過の基準（ms） */
  now: number;
  id?: string;
  hidden?: boolean;
  /** 見出し（h2）の id。タブから参照する */
  headingId?: string;
  paneRef?: Ref<HTMLElement>;
  role?: "tabpanel";
  labelledBy?: string;
}) {
  const t = useT();
  const { state } = props;
  const data = state.phase === "ready" ? state.data : null;
  const checks = data === null || data.state === "unreadable" ? [] : sortChecks(data.checks);
  let message: string | null = null;
  if (state.phase === "loading") message = t("common.loading");
  else if (state.phase === "error") message = t("ci.error");
  else if (data?.state === "unreadable") message = t("ci.unreadable");
  else if (checks.length === 0) message = t("ci.none");
  return (
    <section
      className="ci-pane"
      id={props.id}
      ref={props.paneRef}
      hidden={props.hidden}
      role={props.role}
      aria-labelledby={props.labelledBy ?? props.headingId}
      tabIndex={-1}
    >
      <div className="ci-head">
        <h2 id={props.headingId}>{t("ci.heading")}</h2>
        {data?.head_sha ? (
          <code className="ci-sha" data-ci-sha="" title={t("ci.headSha", { sha: data.head_sha })}>
            {shortSha(data.head_sha)}
          </code>
        ) : null}
      </div>
      {checks.length > 0 ? (
        <ol className="ci-strip" aria-hidden="true">
          {checks.map((c, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: check の名前は重複しうる。並びが全てで並べ替えない
            <li key={i} className="ci-seg" data-class={checkClass(c)} />
          ))}
        </ol>
      ) : null}
      {message === null ? null : (
        <p className="ci-note" role={state.phase === "loading" ? "status" : undefined}>
          {message}
        </p>
      )}
      {state.phase === "ready" && state.stale ? <p className="ci-note">{t("ci.stale")}</p> : null}
      {data?.partial ? <p className="ci-note">{t("ci.partial")}</p> : null}
      {checks.length > 0 ? (
        <ul className="ci-list" aria-label={t("ci.listLabel")}>
          {checks.map((c, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: check の名前は重複しうる。並びが全てで並べ替えない
            <CheckRow key={i} check={c} now={props.now} />
          ))}
        </ul>
      ) : null}
      {data?.truncated ? (
        <p className="ci-note">{t("ci.truncated", { n: data.checks.length })}</p>
      ) : null}
    </section>
  );
}
