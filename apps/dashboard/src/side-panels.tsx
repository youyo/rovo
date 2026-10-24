import type { OverviewDto } from "@rovo/dashboard-contract";
import { formatUsd, shortModel } from "./format";
import { useT } from "./lang";
import { monthPace } from "./pace";

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
  const t = useT();
  const limit = monthlyLimit(budget);
  // 月のペース: 一覧の取得時刻（generated_at）を「いま」にして、画面側だけで計算する
  const pace = monthPace({
    spentUsd: budget.spent_usd,
    limitUsd: limit,
    periodStart: month.period.start,
    periodEnd: month.period.end,
    nowMs: Date.parse(props.data.generated_at),
  });
  const rows = [
    { key: "spent", name: t("budget.spent"), value: formatUsd(budget.spent_usd, t) },
    { key: "remaining", name: t("budget.remaining"), value: formatUsd(budget.remaining_usd, t) },
    {
      key: "limit",
      name: t("budget.limit"),
      value: limit === null ? t("common.unknown") : formatUsd(limit, t),
    },
    { key: "all", name: t("budget.all"), value: formatUsd(month.budget_actual.spent_usd, t) },
  ];
  return (
    <section className="panel" data-budget="month" aria-labelledby="budget-month-h">
      <h2 id="budget-month-h">{t("budget.title")}</h2>
      <p className="caption">{t("budget.utc")}</p>
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
      {pace.kind === "early" ? (
        <p className="soft" data-budget-pace="early">
          {t("budget.paceEarly")}
        </p>
      ) : (
        <p data-budget-pace={pace.over ? "over" : "ok"}>
          {t("budget.pace", {
            day: pace.day,
            spent: formatUsd(pace.spent, t),
            projected: formatUsd(pace.projected, t),
          })}
          {pace.over && pace.limit !== null ? (
            <>
              {" "}
              <strong>{t("budget.paceOver", { limit: formatUsd(pace.limit, t) })}</strong>
            </>
          ) : null}
        </p>
      )}
      <p data-budget-startable="">{t("budget.startable", { n: budget.startable })}</p>
      {month.hidden_tasks.count > 0 ? (
        <p className="soft" data-hidden-tasks={month.hidden_tasks.count}>
          {t("budget.hidden", { n: month.hidden_tasks.count })}
        </p>
      ) : null}
    </section>
  );
}

/** モデル別の費用（今月・UTC・全員分）。タスクと相談を分けて出し、バーは合計に対する比率だけ。 */
export function ModelCosts(props: { models: OverviewDto["models"] }) {
  const t = useT();
  const totals = props.models.map((m) => m.task_cost_usd + m.consult_cost_usd);
  const max = Math.max(0, ...totals);
  return (
    <section className="panel" data-models="" aria-labelledby="models-h">
      <h2 id="models-h">{t("models.title")}</h2>
      <p className="caption">{t("budget.utc")}</p>
      {props.models.length === 0 ? <p className="soft">{t("common.none")}</p> : null}
      <ul className="models">
        {props.models.map((m, i) => (
          <li key={m.model}>
            <span className="model-name" title={shortModel(m.model).full}>
              {shortModel(m.model).name}
            </span>
            <span className="model-cost">
              {t("models.cost", {
                task: formatUsd(m.task_cost_usd, t),
                consult: formatUsd(m.consult_cost_usd, t),
              })}
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
