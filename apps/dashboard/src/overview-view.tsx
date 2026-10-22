import type { OverviewDto } from "@rovo/dashboard-contract";
import { formatClock, formatDayHeading } from "./format";
import { BudgetPanels, ModelCosts } from "./side-panels";
import { markKindOf } from "./status";
import { TaskTable } from "./task-table";
import { buildLanes, HOUR, taskTime, timelineDomain } from "./timeline";
import { Legend, TimelineView } from "./timeline-view";

/** 一覧の本体（純粋な表示。データ取得は use-overview）。 */
export function OverviewView(props: {
  data: OverviewDto;
  autoRefresh: boolean;
  onAutoRefreshChange: (on: boolean) => void;
  onRefresh: () => void;
  /** 直近の更新に失敗した（前のデータを出している） */
  stale: boolean;
}) {
  const { data } = props;
  const dayStart = Date.parse(data.range.from);
  const nowMs = Date.parse(data.generated_at);
  const domain = timelineDomain({
    starts: [...data.tasks.map(taskTime), ...data.consults.map((c) => Date.parse(c.at))],
    nowMs,
    dayStart,
    dayEnd: dayStart + 24 * HOUR,
  });
  const lanes = buildLanes(data, domain);
  const kinds = data.tasks.map(markKindOf);
  const merged = kinds.filter((k) => k === "merged").length;
  const empty = data.tasks.length === 0 && data.consults.length === 0;

  return (
    <div className="overview">
      {props.stale ? (
        <p className="notice" role="status">
          更新できませんでした。前の内容を表示しています（自動で再試行します）。
        </p>
      ) : null}

      <section className="today" aria-labelledby="today-h">
        <div className="today-head">
          <h1 id="today-h">{formatDayHeading(dayStart)}</h1>
          <p className="summary">
            {data.tasks.length === 0
              ? "今日のタスクはまだありません。"
              : `${data.tasks.length} 件のタスクを実行し、${merged} 件をマージしました。`}
          </p>
        </div>
        {empty ? (
          <p className="empty">タスクを始めると、ここにタイムラインが出ます。</p>
        ) : (
          <>
            <TimelineView lanes={lanes} domain={domain} nowMs={nowMs} />
            <Legend kinds={kinds} />
          </>
        )}
      </section>

      <div className="columns">
        <section className="tasks-section" aria-labelledby="tasks-h">
          <h2 id="tasks-h">タスク</h2>
          {data.tasks.length > 0 ? (
            <TaskTable tasks={data.tasks} />
          ) : (
            <p className="soft">まだありません。</p>
          )}
        </section>
        <aside className="side" aria-label="費用と利用状況">
          <BudgetPanels data={data} />
          <ModelCosts models={data.models} />
        </aside>
      </div>

      <footer className="foot">
        <p>
          {formatClock(nowMs)} に更新。あなたが GitHub
          で見られるリポジトリのタスクだけを表示しています。
        </p>
        <div className="foot-controls">
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
      </footer>
    </div>
  );
}
