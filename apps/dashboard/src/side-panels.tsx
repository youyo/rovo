import type { OverviewDto } from "@rovo/dashboard-contract";
import { formatUsd, shortModel } from "./format";

/**
 * 月の上限（USD）。契約の monthly_budget_usd が先。無い古い応答だけ、今の逆算（使った額 + 予約 + 残り）に戻す。
 * 残りが 0 の逆算は「上限 = 使った額 + 予約」と区別できないので、作った値を出さず null（画面は「不明」）。
 */
function monthlyLimit(budget: OverviewDto["budget"]): number | null {
  if (budget.monthly_budget_usd !== undefined) return budget.monthly_budget_usd;
  if (budget.remaining_usd <= 0) return null;
  return budget.spent_usd + budget.reserved_usd + budget.remaining_usd;
}

/**
 * 今月の予算と実績（1 つの欄）。自分の使った額・残り・上限と、全員の実績を並べて比べられるようにする。
 * 自分と全員は別の数字のまま（D8。足し合わせない）。1 タスクの予約額は出さない。月は UTC。
 * 行は dl の項目で、名前（dt）は折り返せ、値（dd）は折り返さない（幅 360px でも重ならない。CSS の .budget-row）。
 */
export function BudgetPanel(props: { data: OverviewDto }) {
  const { budget, month } = props.data;
  const limit = monthlyLimit(budget);
  const rows = [
    { key: "spent", name: "あなたの使った額", value: formatUsd(budget.spent_usd) },
    { key: "remaining", name: "あなたの残り", value: formatUsd(budget.remaining_usd) },
    { key: "limit", name: "あなたの上限", value: limit === null ? "不明" : formatUsd(limit) },
    { key: "all", name: "全員の実績", value: formatUsd(month.budget_actual.spent_usd) },
  ];
  return (
    <section className="panel" data-budget="month" aria-labelledby="budget-month-h">
      <h2 id="budget-month-h">今月の予算と実績</h2>
      <p className="caption">UTC の月</p>
      <dl className="budget-rows">
        {rows.map((r) => (
          <div
            key={r.key}
            className={r.key === "all" ? "budget-row budget-row--all" : "budget-row"}
            data-budget-row={r.key}
          >
            <dt>{r.name}</dt>
            <dd className="budget-value">{r.value}</dd>
          </div>
        ))}
      </dl>
      <p data-budget-startable="">あと {budget.startable} 件始められます。</p>
      {month.hidden_tasks.count > 0 ? (
        <p className="soft" data-hidden-tasks={month.hidden_tasks.count}>
          権限の無いリポジトリのタスクが {month.hidden_tasks.count} 件、費用の合計に含まれます。
        </p>
      ) : null}
    </section>
  );
}

/** モデル別の費用（今月・UTC・全員分）。タスクと相談を分けて出し、バーは合計に対する比率だけ。 */
export function ModelCosts(props: { models: OverviewDto["models"] }) {
  const totals = props.models.map((m) => m.task_cost_usd + m.consult_cost_usd);
  const max = Math.max(0, ...totals);
  return (
    <section className="panel" data-models="" aria-labelledby="models-h">
      <h2 id="models-h">モデル別の費用</h2>
      <p className="caption">UTC の月</p>
      {props.models.length === 0 ? <p className="soft">まだありません。</p> : null}
      <ul className="models">
        {props.models.map((m, i) => (
          <li key={m.model}>
            <span className="model-name" title={shortModel(m.model).full}>
              {shortModel(m.model).name}
            </span>
            <span className="model-cost">
              タスク {formatUsd(m.task_cost_usd)}、相談 {formatUsd(m.consult_cost_usd)}
            </span>
            <svg className="model-bar" height={4} aria-hidden="true" focusable="false">
              <rect className="model-bar-bg" x={0} y={0} width="100%" height={4} />
              <rect
                className="model-bar-fill"
                x={0}
                y={0}
                width={
                  max > 0 ? `${Math.max(2, ((totals[i] as number) / max) * 100).toFixed(1)}%` : "0%"
                }
                height={4}
              />
            </svg>
          </li>
        ))}
      </ul>
    </section>
  );
}
