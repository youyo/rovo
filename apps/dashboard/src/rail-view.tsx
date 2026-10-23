import type { VisibleTaskDto } from "@rovo/dashboard-contract";
import { isPlainLeftClick } from "./click";
import { formatDuration, formatUsd, modelFamily, shortModel, singleLine } from "./format";
import { taskPath } from "./route";
import { isTerminal, MARKS, markKindOf } from "./status";
import { MarkSymbol } from "./status-mark";
import { taskTime } from "./timeline";

/** 行の所要。終わったタスクは終了まで、実行中は at（一覧の更新時刻）までの経過 */
function elapsedMs(t: VisibleTaskDto, at: number): number {
  const start = Date.parse(t.started_at ?? t.created_at);
  const end = t.ended_at === null ? at : Date.parse(t.ended_at);
  return end - start;
}

/** 依頼者の頭文字（丸に入れる 1 文字） */
function initialOf(login: string): string {
  return (Array.from(login)[0] ?? "").toUpperCase();
}

/**
 * タスクのレール（1 行 1 タスク）。GitHub Actions の run の一覧の形:
 * 1 行目は「印・題名・所要」、2 行目は「（チーム表示のときは依頼者）・PR と状態（PR が無ければ、終端は状態・実行中はリポジトリ）・モデル・費用」。
 * 状態は印（状態ごとに形が違う SVG の記号。実行中は回る輪）で持ち、印の label が読み上げ（aria-label）とマウスオーバー（title）になる。選択中は左に青い線（CSS）。
 * 行は /dashboard/tasks/<ID> へのリンク（href は残す）。onSelect があれば、修飾キー無しの左クリックだけページを読み直さず onSelect を呼ぶ
 * （Ctrl・Cmd・Shift・Alt 付きや中クリックはブラウザに任せ、新しいタブで開く）。
 */
export function TaskRail(props: {
  tasks: readonly VisibleTaskDto[];
  selectedId: string | null;
  isToday?: boolean;
  onSelect?: (id: string) => void;
  /** チーム表示のときだけ true。2 行目の先頭に依頼者（頭文字の丸と login）を出す */
  showOwner?: boolean;
  /** 実行中の行の所要の基準にする時刻（ms。一覧の generated_at）。無ければ今 */
  at?: number;
}) {
  const { onSelect } = props;
  const at = props.at ?? Date.now();
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
        const model = shortModel(t.model);
        const login = singleLine(t.owner_login);
        // PR があれば「#番号 状態」。無ければ、終端は状態の文字、実行中などはリポジトリ
        const subject = isTerminal(t.status) ? MARKS[kind].label : singleLine(t.repository);
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
            <span className="rail-title">{singleLine(t.title)}</span>
            <span className="rail-time">{formatDuration(elapsedMs(t, at))}</span>
            <span className="rail-meta">
              {props.showOwner ? (
                <span className="rail-owner">
                  <span className="rail-avatar" aria-hidden="true">
                    {initialOf(login)}
                  </span>
                  <span className="rail-login">{login}</span>
                </span>
              ) : null}
              <span className="rail-subject">
                {t.pr ? <span className="rail-pr">#{t.pr.number}</span> : null}
                {t.pr ? ` ${MARKS[kind].label}` : subject}
              </span>
              <span className="rail-model" title={model.full}>
                {modelFamily(t.model)}
              </span>
              <span className="rail-cost">{formatUsd(t.cost.cost_usd)}</span>
            </span>
          </a>
        );
      })}
    </nav>
  );
}
