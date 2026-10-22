import type { VisibleTaskDto } from "@rovo/dashboard-contract";
import { isPlainLeftClick } from "./click";
import { formatClock, singleLine } from "./format";
import { taskPath } from "./route";
import { markKindOf } from "./status";
import { MarkSymbol } from "./status-mark";
import { taskTime } from "./timeline";

/**
 * タスクのレール（1 行 1 タスク）。行にはリポジトリ・モデル・費用を出さない（選んだタスクのコンソールの見出しに出す）。
 * 状態は印（状態ごとに形が違う SVG の記号。走行中は脈動）で持ち、印の label が読み上げ（aria-label）とマウスオーバー（title）になる。選択中は左にアクセント線（CSS）。
 * 行は /dashboard/tasks/<ID> へのリンク（href は残す）。onSelect があれば、修飾キー無しの左クリックだけページを読み直さず onSelect を呼ぶ
 * （Ctrl・Cmd・Shift・Alt 付きや中クリックはブラウザに任せ、新しいタブで開く）。
 */
export function TaskRail(props: {
  tasks: readonly VisibleTaskDto[];
  selectedId: string | null;
  isToday?: boolean;
  onSelect?: (id: string) => void;
}) {
  const { onSelect } = props;
  const rows = [...props.tasks].sort((a, b) => taskTime(b) - taskTime(a));
  return (
    <nav className="rail" aria-label="タスク">
      {rows.length === 0 ? (
        <p className="rail-empty">
          {props.isToday === false
            ? "この日のタスクはありません。"
            : "今日のタスクはまだありません。"}
        </p>
      ) : null}
      {rows.map((t) => {
        const kind = markKindOf(t);
        const selected = t.task_id === props.selectedId;
        return (
          <a
            key={t.task_id}
            className="rail-row"
            href={taskPath(t.task_id)}
            onClick={(e) => {
              if (onSelect === undefined || !isPlainLeftClick(e)) return;
              e.preventDefault();
              onSelect(t.task_id);
            }}
            data-task-id={t.task_id}
            data-status={t.status}
            data-mark={kind}
            {...(selected ? { "aria-current": "true", "data-selected": "true" } : {})}
          >
            <MarkSymbol kind={kind} />
            <span className="rail-title">
              {t.pr ? <span className="rail-pr">#{t.pr.number}</span> : null}
              {t.pr ? " " : null}
              {singleLine(t.title)}
            </span>
            <span className="rail-time">{formatClock(taskTime(t))}</span>
          </a>
        );
      })}
    </nav>
  );
}
