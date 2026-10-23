import type { BudgetMeDto, CloudflareSummaryDto, OverviewDto } from "@rovo/dashboard-contract";
import { useId, useState } from "react";
import { cloudflareRows } from "./cloudflare";
import { CloudflarePanel } from "./cloudflare-panel";
import { formatClock, formatCount, formatUsd, modelFamily, shortModel } from "./format";
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

/** バーに出す Cloudflare の要約（Workers とクレジット残高）。取れない項目は引き出しと同じ理由の言葉。 */
function cloudflareBar(state: CloudflareState | undefined): { workers: string; credit: string } {
  const data = cloudflareData(state);
  if (data === null) {
    const text = state?.phase === "failed" ? "取得できませんでした" : "読み込み中…";
    return { workers: `Cloudflare ${text}`, credit: "" };
  }
  const rows = cloudflareRows(data);
  const workers = rows.find((r) => r.key === "workers");
  const credit = rows.find((r) => r.key === "credit_balance");
  return {
    workers: workers?.ok
      ? `Workers ${workers.text.replace("、", "  ")}`
      : `Workers ${workers?.text ?? ""}`,
    credit: credit?.ok ? `クレジット ${credit.text}` : `クレジット ${credit?.text ?? ""}`,
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
  if (rows.length === 0) return <>モデル別 まだありません</>;
  return (
    <>
      {rows.map((r, i) => (
        <span key={r.id}>
          {i === 0 ? "" : "  "}
          <span className="sb-item" data-model-part="">
            {r.name} {formatUsd(r.total)}
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
  if (limit === null || !(limit > 0)) return null;
  const ratio = Math.min(1, Math.max(0, spent / limit));
  return (
    <svg
      className="meter"
      width={80}
      height={6}
      role="img"
      aria-label={`今月の使用量 ${formatUsd(spent)} / ${formatUsd(limit)}`}
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
  const [open, setOpen] = useState(props.initialOpen ?? false);
  const drawerId = useId();
  const limit = budgetLimit(data.budget);
  const cf = cloudflareBar(props.cloudflare);
  const kinds = data.tasks.map(markKindOf);

  return (
    <div className="bar-wrap">
      <section
        id={drawerId}
        className="drawer"
        aria-label="内訳"
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
          <p>
            {formatClock(props.nowMs)} に更新。あなたが GitHub
            で見られるリポジトリのタスクだけを表示しています。
          </p>
          {props.showRefreshControls === false ? null : (
            <div className="drawer-controls">
              <label>
                <input
                  type="checkbox"
                  checked={props.autoRefresh}
                  onChange={(e) => props.onAutoRefreshChange(e.currentTarget.checked)}
                />
                自動で更新する
              </label>
              <button type="button" className="link-button" onClick={props.onRefresh}>
                今すぐ更新
              </button>
            </div>
          )}
        </div>
      </section>

      <section className="statusbar" aria-label="費用と枠">
        <Sb k="budget-me" strong>
          今月 {formatUsd(data.budget.spent_usd)}
          {limit === null ? "" : ` / ${formatUsd(limit)}`}
        </Sb>
        <Meter spent={data.budget.spent_usd} limit={limit} />
        <Sb k="budget-left" alt>
          {`残り ${formatUsd(data.budget.remaining_usd)}  あと ${formatCount(data.budget.startable)} 件`}
        </Sb>
        <Sb k="budget-all">全員 {formatUsd(data.month.budget_actual.spent_usd)}</Sb>
        <Sb k="models" alt>
          <ModelLine models={data.models} />
        </Sb>
        <span className="sb-grow" />
        <Sb k="cloudflare">{cf.workers}</Sb>
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
          内訳
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
  const cf = cloudflareBar(props.cloudflare);
  const limit = budget ? budgetLimit(budget) : null;
  return (
    <div className="bar-wrap">
      <section className="statusbar" aria-label="費用と枠">
        <Sb k="budget-me" strong>
          {budget
            ? `今月 ${formatUsd(budget.spent_usd)}${limit === null ? "" : ` / ${formatUsd(limit)}`}`
            : "今月 読み込み中…"}
        </Sb>
        {budget ? <Meter spent={budget.spent_usd} limit={limit} /> : null}
        <Sb k="budget-left" alt>
          {budget
            ? `残り ${formatUsd(budget.remaining_usd)}  あと ${formatCount(budget.startable)} 件`
            : "残り 読み込み中…"}
        </Sb>
        <Sb k="budget-all">全員 読み込み中…</Sb>
        <Sb k="models" alt>
          モデル別 読み込み中…
        </Sb>
        <span className="sb-grow" />
        <Sb k="cloudflare">{cf.workers}</Sb>
        {cf.credit === "" ? null : (
          <Sb k="credit" alt>
            {cf.credit}
          </Sb>
        )}
      </section>
    </div>
  );
}
