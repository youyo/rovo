import type { VisibleTaskDto } from "@rovo/dashboard-contract";
import { formatClock, formatUsd, isAllowedPrUrl, singleLine } from "./format";
import { MARKS, markKindOf } from "./status";
import { MarkGlyph } from "./status-mark";
import { taskTime } from "./timeline";

function PrCell(props: { pr: VisibleTaskDto["pr"] }) {
  const { pr } = props;
  if (!pr) return <span className="muted">なし</span>;
  const label = `#${pr.number}`;
  // 外部リンクは GitHub の PR の URL に厳密に一致するものだけ（D14）
  if (!isAllowedPrUrl(pr.url)) return <span>{label}</span>;
  return (
    <a href={pr.url} target="_blank" rel="noopener noreferrer">
      {label}
    </a>
  );
}

/** タスクの表。新しい開始が上。行はタスク詳細へ、PR 列だけ GitHub へ。 */
export function TaskTable(props: { tasks: VisibleTaskDto[] }) {
  const rows = [...props.tasks].sort((a, b) => taskTime(b) - taskTime(a));
  return (
    <div className="table-scroll">
      <table className="tasks">
        <thead>
          <tr>
            <th scope="col">状態</th>
            <th scope="col">タスク</th>
            <th scope="col">リポジトリ</th>
            <th scope="col">モデル</th>
            <th scope="col" className="num">
              費用
            </th>
            <th scope="col" className="num">
              開始
            </th>
            <th scope="col">PR</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((t) => {
            const kind = markKindOf(t);
            return (
              <tr key={t.task_id} data-task-id={t.task_id}>
                <td className="nowrap">
                  <span className="status">
                    <MarkGlyph kind={kind} />
                    {MARKS[kind].label}
                  </span>
                </td>
                <td className="title">
                  <a href={`/dashboard/tasks/${t.task_id}`}>{singleLine(t.title)}</a>
                </td>
                <td className="nowrap soft">{singleLine(t.repository)}</td>
                <td className="nowrap soft">{singleLine(t.model)}</td>
                <td className="num nowrap">{formatUsd(t.cost.cost_usd)}</td>
                <td className="num soft">{formatClock(taskTime(t))}</td>
                <td>
                  <PrCell pr={t.pr} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
