import type { OverviewDto } from "@rovo/dashboard-contract";
import { formatUsd, singleLine } from "./format";

/**
 * 予算は 2 つの数字を分けて出す（D8。画面で足し合わせない）。
 * (a) あなたの今月の予算（閲覧者本人の spent / remaining / startable）
 * (b) 全員の今月の実績（UTC の月。権限の無いタスクを含む）
 * 分母（上限）や 1 タスクの予約額は契約に無いので出さない。
 */
export function BudgetPanels(props: { data: OverviewDto }) {
  const { budget, month } = props.data;
  return (
    <>
      <section className="panel" data-budget="me" aria-labelledby="budget-me-h">
        <h2 id="budget-me-h">あなたの今月の予算</h2>
        <p className="caption">UTC の月</p>
        <dl className="figures">
          <div>
            <dt>使った額</dt>
            <dd className="big">{formatUsd(budget.spent_usd)}</dd>
          </div>
          <div>
            <dt>残り</dt>
            <dd className="mid">{formatUsd(budget.remaining_usd)}</dd>
          </div>
        </dl>
        <p>あと {budget.startable} 件始められます。</p>
      </section>

      <section className="panel" data-budget="all" aria-labelledby="budget-all-h">
        <h2 id="budget-all-h">全員の今月の実績</h2>
        <p className="caption">UTC の月</p>
        <p className="big">{formatUsd(month.budget_actual.spent_usd)}</p>
        {month.hidden_tasks.count > 0 ? (
          <p className="soft" data-hidden-tasks={month.hidden_tasks.count}>
            権限の無いリポジトリのタスクが {month.hidden_tasks.count} 件、費用の合計に含まれます。
          </p>
        ) : null}
      </section>
    </>
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
            <span className="model-name">{singleLine(m.model)}</span>
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
