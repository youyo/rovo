import type { BudgetMeDto, CloudflareSummaryDto, OverviewDto } from "@rovo/dashboard-contract";
import { useId, useState } from "react";
import { cloudflareRows } from "./cloudflare";
import { CloudflarePanel } from "./cloudflare-panel";
import { formatClock, formatCount, formatUsd, modelFamily, shortModel } from "./format";
import type { T } from "./i18n";
import { useT } from "./lang";
import { budgetLimit } from "./rail";
import { BudgetPanel, ModelCosts } from "./side-panels";
import { markKindOf } from "./status";
import { Legend } from "./timeline-view";
import type { CloudflareState } from "./use-cloudflare";

/** tmux 風のステータスバー（今月の自分・全員・モデル別・Cloudflare の要約）と、「内訳」の引き出し。 */

function cloudflareData(state: CloudflareState | undefined): CloudflareSummaryDto | null {
  if (!state) return null;
  if (state.phase === "ready") return state.data;
  return state.phase === "failed" ? state.stale : null;
}

/**
 * バーに出す Cloudflare の要約。Workers の件数は出さず（ダッシュボード自身の自動更新が大半で判断に使えない。内訳の欄に残る）、
 * エラーが 1 件以上のときだけ「Workers のエラー M 件」を出す。0 件・取れない項目は何も出さない（理由は内訳の欄）。
 * 読み込み中・取得失敗のときは、その旨の言葉を出す。クレジット残高は取れていれば出す。
 */
function cloudflareBar(
  state: CloudflareState | undefined,
  t: T,
): { workers: string; credit: string } {
  const data = cloudflareData(state);
  if (data === null) {
    const text = state?.phase === "failed" ? t("bar.cloudflareFailed") : t("common.loading");
    return { workers: t("bar.cloudflare", { text }), credit: "" };
  }
  const workers = data.workers?.ok ? data.workers.value : null;
  const credit = cloudflareRows(data, t).find((r) => r.key === "credit_balance");
  return {
    workers:
      workers !== null && workers.errors > 0
        ? t("bar.workersErrors", { errors: formatCount(workers.errors, t) })
        : "",
    credit: t("bar.credit", { text: credit?.text ?? "" }),
  };
}

function Sb(props: { alt?: boolean; strong?: boolean; children: React.ReactNode; k: string }) {
  const cls = `sb${props.alt ? " sb--alt" : ""}${props.strong ? " sb--strong" : ""}`;
  return (
    <span className={cls} data-sb={props.k}>
      {props.children}
    </span>
  );
}

/** モデル別をバーに収める短い項目（合計の大きい順。多いときは上位だけ）。項目の途中では折り返さない */
function ModelLine(props: { models: OverviewDto["models"] }) {
  const t = useT();
  const all = props.models
    .map((m) => ({
      id: m.model,
      total: m.task_cost_usd + m.consult_cost_usd,
    }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 4);
  const short = all.map((r) => modelFamily(r.id));
  const rows = all.map((r, i) => ({
    ...r,
    // 縮めた名前が重なるときは、重なった側を元の名前に戻す
    name: short.filter((n) => n === short[i]).length > 1 ? shortModel(r.id).name : short[i],
  }));
  if (rows.length === 0) return <>{t("bar.modelsNone")}</>;
  return (
    <>
      {rows.map((r, i) => (
        <span key={r.id}>
          {i === 0 ? "" : "  "}
          <span className="sb-item" data-model-part="">
            {r.name} {formatUsd(r.total, t)}
          </span>
        </span>
      ))}
    </>
  );
}

/**
 * 今月の使用量のメーター（使った額 / 上限）。SVG の属性で幅を持つ（CSP の style-src 'self' で style 属性は使えない）。
 * 上限が分からないとき（古い応答で残りが 0）は出さない。比率は 0〜100% に収める。
 */
function Meter(props: { spent: number; limit: number | null }) {
  const { spent, limit } = props;
  const t = useT();
  if (limit === null || !(limit > 0)) return null;
  const ratio = Math.min(1, Math.max(0, spent / limit));
  return (
    <svg
      className="meter"
      width={80}
      height={6}
      role="img"
      aria-label={t("bar.meter", { spent: formatUsd(spent, t), limit: formatUsd(limit, t) })}
    >
      <rect className="meter-bg" x={0} y={0} width="100%" height={6} rx={3} />
      <rect
        className="meter-fill"
        x={0}
        y={0}
        width={`${(ratio * 100).toFixed(1)}%`}
        height={6}
        rx={3}
      />
    </svg>
  );
}

export function StatusBar(props: {
  data: OverviewDto;
  nowMs: number;
  cloudflare?: CloudflareState;
  autoRefresh: boolean;
  onAutoRefreshChange: (on: boolean) => void;
  onRefresh: () => void;
  /** 自動更新の操作を引き出しに出すか（コンソールが自分の下に持っているときは false。入切は共有する） */
  showRefreshControls?: boolean;
  /** 引き出しの初期状態（テスト用） */
  initialOpen?: boolean;
}) {
  const { data } = props;
  const t = useT();
  const [open, setOpen] = useState(props.initialOpen ?? false);
  const drawerId = useId();
  const limit = budgetLimit(data.budget);
  const cf = cloudflareBar(props.cloudflare, t);
  const kinds = data.tasks.map(markKindOf);

  return (
    <div className="bar-wrap">
      <section
        id={drawerId}
        className="drawer"
        aria-label={t("bar.details")}
        hidden={!open}
        data-open={String(open)}
      >
        <div className="drawer-grid">
          <BudgetPanel data={data} />
          <ModelCosts models={data.models} />
          {props.cloudflare ? <CloudflarePanel state={props.cloudflare} /> : null}
        </div>
        <Legend kinds={kinds} />
        <div className="drawer-foot">
          <p>{t("drawer.updated", { time: formatClock(props.nowMs, t) })}</p>
          {props.showRefreshControls === false ? null : (
            <div className="drawer-controls">
              <label>
                <input
                  type="checkbox"
                  checked={props.autoRefresh}
                  onChange={(e) => props.onAutoRefreshChange(e.currentTarget.checked)}
                />
                {t("common.autoRefresh")}
              </label>
              <button type="button" className="link-button" onClick={props.onRefresh}>
                {t("common.refreshNow")}
              </button>
            </div>
          )}
        </div>
      </section>

      <section className="statusbar" aria-label={t("bar.label")}>
        <Sb k="budget-me" strong>
          {limit === null
            ? t("bar.month", { spent: formatUsd(data.budget.spent_usd, t) })
            : t("bar.monthLimit", {
                spent: formatUsd(data.budget.spent_usd, t),
                limit: formatUsd(limit, t),
              })}
        </Sb>
        <Meter spent={data.budget.spent_usd} limit={limit} />
        <Sb k="budget-left" alt>
          {t("bar.left", {
            remaining: formatUsd(data.budget.remaining_usd, t),
            n: data.budget.startable,
          })}
        </Sb>
        <Sb k="budget-all">
          {t("bar.all", { amount: formatUsd(data.month.budget_actual.spent_usd, t) })}
        </Sb>
        <Sb k="models" alt>
          <ModelLine models={data.models} />
        </Sb>
        <span className="sb-grow" />
        {cf.workers === "" ? null : <Sb k="cloudflare">{cf.workers}</Sb>}
        {cf.credit === "" ? null : (
          <Sb k="credit" alt>
            {cf.credit}
          </Sb>
        )}
        <button
          type="button"
          className="sb-button"
          aria-expanded={open}
          aria-controls={drawerId}
          onClick={() => setOpen((v) => !v)}
        >
          {t("bar.details")}
        </button>
      </section>
    </div>
  );
}

/**
 * 一覧がまだ届かないときのステータスバー。予算（/budget）と Cloudflare の要約だけを出し、
 * 一覧が要る項目（全員・モデル別・内訳）はその場所だけ「読み込み中…」にする。
 */
export function PendingStatusBar(props: {
  budget: BudgetMeDto | null;
  cloudflare?: CloudflareState;
}) {
  const { budget } = props;
  const t = useT();
  const cf = cloudflareBar(props.cloudflare, t);
  const limit = budget ? budgetLimit(budget) : null;
  return (
    <div className="bar-wrap">
      <section className="statusbar" aria-label={t("bar.label")}>
        <Sb k="budget-me" strong>
          {budget
            ? limit === null
              ? t("bar.month", { spent: formatUsd(budget.spent_usd, t) })
              : t("bar.monthLimit", {
                  spent: formatUsd(budget.spent_usd, t),
                  limit: formatUsd(limit, t),
                })
            : t("bar.monthLoading")}
        </Sb>
        {budget ? <Meter spent={budget.spent_usd} limit={limit} /> : null}
        <Sb k="budget-left" alt>
          {budget
            ? t("bar.left", { remaining: formatUsd(budget.remaining_usd, t), n: budget.startable })
            : t("bar.leftLoading")}
        </Sb>
        <Sb k="budget-all">{t("bar.allLoading")}</Sb>
        <Sb k="models" alt>
          {t("bar.modelsLoading")}
        </Sb>
        <span className="sb-grow" />
        {cf.workers === "" ? null : <Sb k="cloudflare">{cf.workers}</Sb>}
        {cf.credit === "" ? null : (
          <Sb k="credit" alt>
            {cf.credit}
          </Sb>
        )}
      </section>
    </div>
  );
}
