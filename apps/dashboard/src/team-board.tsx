import type { OverviewDto, VisibleTaskDto, WaitingDto } from "@rovo/dashboard-contract";
import { isPlainLeftClick } from "./click";
import { formatCount, formatDuration, formatShortDate, formatUsd, singleLine } from "./format";
import type { T } from "./i18n";
import { useT } from "./lang";
import { taskPath } from "./route";
import { markKindOf, markLabel } from "./status";
import { MarkSymbol, ShapeSymbol } from "./status-mark";
import {
  buildFlow,
  buildMonthCosts,
  buildTeamBoard,
  type Flow,
  type MonthCostRow,
  type MonthCosts,
  type TeamPerson,
  type TeamRepo,
} from "./team";
import { useNarrow } from "./use-narrow";

/** 依頼者の頭文字（丸に入れる 1 文字） */
function initialOf(login: string): string {
  return (Array.from(login)[0] ?? "").toUpperCase();
}

/** 数字 + 記号 + 文字。狭い幅では文字を畳み、記号と数字だけにする（文字は読み上げと title に残る） */
function Stat(props: {
  kind: "running" | "asking" | "done" | "failed";
  label: string;
  value: number;
}) {
  const shape = {
    running: { shape: "spinner", tone: "run" },
    asking: { shape: "bang", tone: "run" },
    done: { shape: "check", tone: "ok" },
    failed: { shape: "cross", tone: "bad" },
  } as const satisfies Record<
    string,
    { shape: "spinner" | "bang" | "check" | "cross"; tone: "run" | "ok" | "bad" }
  >;
  const s = shape[props.kind];
  return (
    <span
      className="tb-stat"
      data-stat={props.kind}
      data-zero={props.value === 0 ? "true" : undefined}
      title={`${props.label} ${props.value}`}
    >
      <ShapeSymbol shape={s.shape} tone={s.tone} />
      <span className="tb-stat-label">{props.label}</span>
      <span className="tb-stat-n">{props.value}</span>
    </span>
  );
}

function ActiveTask(props: { task: VisibleTaskDto; at: number; onSelect?: (id: string) => void }) {
  const t = useT();
  const { task, onSelect } = props;
  const kind = markKindOf(task);
  const start = Date.parse(task.started_at ?? task.created_at);
  return (
    <a
      className="tb-task"
      href={taskPath(task.task_id)}
      data-task-id={task.task_id}
      data-mark={kind}
      onClick={(e) => {
        if (onSelect === undefined || !isPlainLeftClick(e)) return;
        e.preventDefault();
        onSelect(task.task_id);
      }}
    >
      <MarkSymbol kind={kind} />
      <span className="tb-task-state">{markLabel(kind, t)}</span>
      <span className="tb-task-title">{singleLine(task.title)}</span>
      <span className="tb-task-repo">{singleLine(task.repository)}</span>
      <span className="tb-task-time">{formatDuration(props.at - start, t)}</span>
    </a>
  );
}

function PersonRow(props: {
  person: TeamPerson;
  isToday: boolean;
  at: number;
  onSelect?: (id: string) => void;
}) {
  const t = useT();
  const narrow = useNarrow();
  const { person: p, isToday } = props;
  const login = singleLine(p.login);
  return (
    <li
      className="tb-person"
      data-login={p.login}
      {...(p.isViewer ? { "data-viewer": "true" } : {})}
    >
      <div className="tb-row">
        <span className="tb-login">
          <span className="rail-avatar" aria-hidden="true">
            {initialOf(login)}
          </span>
          <span className="tb-login-text">{login}</span>
        </span>
        {isToday ? (
          <span className="tb-group" data-group="now">
            <Stat kind="running" label={t("board.running")} value={p.running} />
            <Stat kind="asking" label={t("board.asking")} value={p.asking} />
          </span>
        ) : null}
        <span className="tb-group" data-group="day">
          {/* 狭い幅の過去の日は、箱の見出しが「この日」なので行のラベルは出さない */}
          {narrow && !isToday ? null : (
            <span className="tb-cap">{isToday ? t("board.capToday") : t("board.capDay")}</span>
          )}
          <Stat kind="done" label={t("board.done")} value={p.done} />
          <Stat kind="failed" label={t("board.failed")} value={p.failed} />
          <span className="tb-cost" title={t("board.cost")}>
            <span className="sr-only">{t("board.cost")} </span>
            {formatUsd(p.costUsd, t)}
          </span>
        </span>
      </div>
      {p.active.length > 0 ? (
        <ul className="tb-active">
          {p.active.map((task) => (
            <li key={task.task_id}>
              <ActiveTask task={task} at={props.at} onSelect={props.onSelect} />
            </li>
          ))}
          {p.more > 0 ? (
            <li className="tb-more" data-more="">
              {t("board.more", { n: p.more })}
            </li>
          ) : null}
        </ul>
      ) : null}
    </li>
  );
}

function RepoTable(props: { repos: TeamRepo[]; isToday: boolean }) {
  const t = useT();
  return (
    <table className="tb-repos">
      <thead>
        <tr>
          <th scope="col">{t("board.colRepo")}</th>
          <th scope="col" className="tb-col-n">
            {props.isToday ? t("board.colCountToday") : t("board.colCountDay")}
          </th>
          <th scope="col">{t("board.colPrs")}</th>
        </tr>
      </thead>
      <tbody>
        {props.repos.map((r) => (
          <tr key={r.repository} data-repo={r.repository}>
            <th scope="row" className="tb-repo-name">
              {singleLine(r.repository)}
            </th>
            <td className="tb-col-n">
              <span className="tb-count">{formatCount(r.count, t)}</span>
              {props.isToday && r.running > 0 ? (
                <span className="tb-repo-run" title={`${t("board.running")} ${r.running}`}>
                  <ShapeSymbol shape="spinner" tone="run" />
                  <span className="tb-stat-label">{t("board.running")}</span> {r.running}
                </span>
              ) : null}
            </td>
            <td className="tb-prs">
              {r.prs.length === 0 ? (
                <span className="tb-none">–</span>
              ) : (
                r.prs.map((pr) => (
                  <a
                    key={pr.url}
                    className="tb-pr"
                    href={pr.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={t("board.prTitle", { n: pr.number })}
                  >
                    #{pr.number}
                  </a>
                ))
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function MonthRow(props: { row: MonthCostRow }) {
  const t = useT();
  const r = props.row;
  const login = singleLine(r.login);
  const w = r.ratio === null ? 0 : Math.min(1, Math.max(0, r.ratio)) * 100;
  return (
    <li
      className="tb-month-row"
      data-login={r.login}
      {...(r.isViewer ? { "data-viewer": "true" } : {})}
    >
      <span className="tb-login">
        <span className="rail-avatar" aria-hidden="true">
          {initialOf(login)}
        </span>
        <span className="tb-login-text">{login}</span>
      </span>
      <svg
        className="tb-month-bar"
        viewBox="0 0 100 4"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <rect className="model-bar-bg" x="0" y="0" width="100" height="4" />
        <rect className="model-bar-fill" x="0" y="0" width={w} height="4" />
      </svg>
      <span className="tb-month-amount">
        {formatUsd(r.spentUsd, t)}
        {r.limitUsd === null ? null : ` / ${formatUsd(r.limitUsd, t)}`}
      </span>
      {r.ratio === null ? null : (
        <span className="tb-month-ratio">{`${Math.round(r.ratio * 100)}%`}</span>
      )}
      {r.pace === null ? null : (
        <span className="tb-month-pace" data-pace={r.pace}>
          {r.pace === "fast" ? `▲ ${t("board.paceFast")}` : `▼ ${t("board.paceSlow")}`}
        </span>
      )}
    </li>
  );
}

function MonthSection(props: { month: MonthCosts }) {
  const t = useT();
  const { rows, hidden } = props.month;
  return (
    <section className="tb-section" aria-labelledby="tb-month-h" data-month="">
      <h2 id="tb-month-h">{t("board.titleMonth")}</h2>
      <ul className="tb-month">
        {rows.map((r) => (
          <MonthRow key={r.login} row={r} />
        ))}
      </ul>
      {hidden === null ? null : (
        <p className="soft tb-month-hidden" data-month-hidden="">
          {t("board.monthHidden", { n: hidden.count, cost: formatUsd(hidden.costUsd, t) })}
        </p>
      )}
      {/* 人ごとの額は索引の「見えるタスク + 相談」。予算の欄は台帳（索引より前のタスク・見積もりの確定分も入る）なので一致しないことがある */}
      <p className="soft tb-month-note" data-month-note="">
        {t("board.monthNote")}
      </p>
    </section>
  );
}

const BAR_W = 9;
const BAR_PAIR_GAP = 1;
const GROUP_W = BAR_W * 2 + BAR_PAIR_GAP;
const GROUP_GAP = 7;
const CHART_H = 60;
/** 0 件でない棒が潰れて見えなくならない最小の高さ（件数の比例は保つ） */
const MIN_BAR_H = 2;
const HATCH_ID = "tb-flow-hatch";

const barH = (n: number, max: number) => (n <= 0 ? 0 : Math.max(MIN_BAR_H, (n / max) * CHART_H));

/** 横軸に日付を出す日（古い順の添字）: 14 日前・1 週間前・今日。狭い幅でも重ならない数に間引く */
const AXIS_TICKS = [0, 7, 13];

/** YYYY-MM-DD（UTC の日付）を、ロケールの短い月日（ja は 10/25、en も 10/25）にする */
function shortDate(date: string, t: T): string {
  const ms = Date.parse(date);
  return Number.isFinite(ms) ? formatShortDate(ms, t) : date;
}

function FlowChart(props: { flow: Flow }) {
  const t = useT();
  const { days } = props.flow;
  const max = Math.max(1, ...days.map((d) => Math.max(d.completed, d.failed)));
  // 横は割合（%）で配る: 1 日の幅 = 全体の 1/日数。棒の太さ・間隔は 1 日の幅に対する割合
  const pitch = GROUP_W + GROUP_GAP;
  const n = Math.max(1, days.length);
  const pct = (units: number) => `${Math.round((units / (n * pitch)) * 1e4) / 1e2}%`;
  return (
    <div className="tb-flow-plot">
      {/* biome-ignore lint/a11y/useSemanticElements: SVG の図の集まり。fieldset は使えない */}
      <svg
        className="tb-flow-chart"
        width="100%"
        height={CHART_H + 1}
        role="group"
        aria-label={t("board.flowChart")}
      >
        <defs>
          <pattern id={HATCH_ID} width="4" height="4" patternUnits="userSpaceOnUse">
            <path className="tb-flow-hatch-line" d="M-1 5 L5 -1 M-1 1 L1 -1 M3 5 L5 3" />
          </pattern>
        </defs>
        {days.map((d, i) => {
          const x = i * pitch + GROUP_GAP / 2;
          const hDone = barH(d.completed, max);
          const hFail = barH(d.failed, max);
          const label = t("board.flowDay", { date: d.date, done: d.completed, failed: d.failed });
          return (
            // biome-ignore lint/a11y/noInteractiveElementToNoninteractiveRole: SVG の g は操作の要素ではない。日ごとに読み上げさせる
            <g
              key={d.date}
              data-day={d.date}
              data-completed={d.completed}
              data-failed={d.failed}
              role="img"
              aria-label={label}
            >
              <title>{label}</title>
              <rect
                className="tb-flow-bar"
                x={pct(x)}
                y={CHART_H - hDone}
                width={pct(BAR_W)}
                height={hDone}
              />
              {d.failed > 0 ? (
                <rect
                  className="tb-flow-fail"
                  data-fail-mark=""
                  fill={`url(#${HATCH_ID})`}
                  x={pct(x + BAR_W + BAR_PAIR_GAP + 0.5)}
                  y={CHART_H - hFail}
                  width={pct(BAR_W - 1)}
                  height={hFail}
                />
              ) : null}
            </g>
          );
        })}
        <line className="tb-flow-base" x1="0" y1={CHART_H} x2="100%" y2={CHART_H} />
      </svg>
      <div className="tb-flow-axis" aria-hidden="true">
        {AXIS_TICKS.filter((i) => days[i] !== undefined).map((i) => {
          const last = i === days.length - 1;
          const first = i === 0;
          return (
            <span
              key={i}
              className={`tb-flow-tick${first ? " tb-flow-tick--start" : last ? " tb-flow-tick--end" : ""}`}
              data-axis-label=""
              title={days[i]?.date}
              style={
                first || last ? undefined : { left: pct(i * pitch + GROUP_GAP / 2 + GROUP_W / 2) }
              }
            >
              {shortDate(days[i]?.date ?? "", t)}
            </span>
          );
        })}
      </div>
    </div>
  );
}

function FlowSection(props: { flow: Flow }) {
  const t = useT();
  const f = props.flow;
  const none = "–";
  return (
    <section className="tb-section" aria-labelledby="tb-flow-h" data-flow="">
      <h2 id="tb-flow-h">{t("board.titleFlow")}</h2>
      <div className="tb-flow-body">
        <FlowChart flow={f} />
        <p className="soft tb-flow-legend">
          <svg className="tb-flow-key" viewBox="0 0 9 9" aria-hidden="true">
            <rect className="tb-flow-bar" x="0" y="0" width="9" height="9" />
          </svg>{" "}
          {t("board.flowDone")}{" "}
          <svg className="tb-flow-key" viewBox="0 0 9 9" aria-hidden="true">
            <rect
              className="tb-flow-fail"
              fill={`url(#${HATCH_ID})`}
              x="0.5"
              y="0.5"
              width="8"
              height="8"
            />
          </svg>{" "}
          {t("board.flowFailed")}
        </p>
        <dl className="tb-flow-stats">
          <div data-flow-rate="">
            <dt>{t("board.flowRate")}</dt>
            <dd>
              {f.rate === null
                ? none
                : `${Math.round(f.rate * 100)}% (${f.failed} / ${f.completed + f.failed})`}
            </dd>
          </div>
          <div data-flow-median="">
            <dt>{t("board.flowMedian")}</dt>
            <dd>{f.medianMs === null ? none : formatDuration(f.medianMs, t)}</dd>
          </div>
          <div data-flow-merged="">
            <dt>{t("board.flowMerged")}</dt>
            <dd>{formatCount(f.prMerged, t)}</dd>
          </div>
        </dl>
      </div>
      {f.hidden === null ? null : (
        <p className="soft tb-flow-hidden" data-flow-hidden="">
          {t("board.flowHidden", { n: f.hidden.count, failed: f.hidden.failed })}
        </p>
      )}
      <p className="soft tb-flow-note" data-flow-note="">
        {t("board.flowNote")}
      </p>
    </section>
  );
}

/**
 * チームボード（チームで何も選んでいないときの中央）。読み取り専用。
 * 「いま」: 1 行 1 人（並びは帯と同じ）。走行・質問待ちのタスクを行の下に最大 3 件。タスクを押すとコンソールになる。
 * 「リポジトリ別」: リポジトリごとの今日の件数・走行・待ちの PR。
 * 過去の日は走行中の欄を出さず、その日の完了・失敗・費用だけ。
 * 集計は team.ts（権限の無いタスクの情報は使わない）。
 */
export function TeamBoard(props: {
  data: OverviewDto;
  /** 日をまたいだ待ち（取れていなければ null。今日のときだけ使われる） */
  waiting: WaitingDto | null;
  isToday: boolean;
  onSelectTask?: (id: string) => void;
}) {
  const t = useT();
  const board = buildTeamBoard(props.data, props.waiting, props.isToday);
  const month = buildMonthCosts(props.data);
  const flow = buildFlow(props.data);
  const generated = Date.parse(props.data.generated_at);
  const at = Number.isFinite(generated) ? generated : Date.now();
  return (
    <section className="console teamboard" aria-label={t("board.label")} data-teamboard="">
      <section className="tb-section" aria-labelledby="tb-people-h">
        <h2 id="tb-people-h">{props.isToday ? t("board.titleNow") : t("board.titleDay")}</h2>
        <ul className="tb-people">
          {board.people.map((p) => (
            <PersonRow
              key={p.login}
              person={p}
              isToday={props.isToday}
              at={at}
              onSelect={props.onSelectTask}
            />
          ))}
        </ul>
      </section>
      <section className="tb-section" aria-labelledby="tb-repos-h">
        <h2 id="tb-repos-h">
          {t("board.titleRepos")}
          <span className="tb-period">
            {props.isToday ? t("board.capToday") : t("board.capDay")}
          </span>
        </h2>
        {board.repos.length === 0 ? (
          <p className="soft">{t("board.noRepos")}</p>
        ) : (
          <RepoTable repos={board.repos} isToday={props.isToday} />
        )}
      </section>
      {month === null ? null : <MonthSection month={month} />}
      {flow === null ? null : <FlowSection flow={flow} />}
    </section>
  );
}
