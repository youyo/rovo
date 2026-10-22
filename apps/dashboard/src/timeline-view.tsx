import { formatClock, formatUsd, singleLine } from "./format";
import { MARKS, type MarkKind } from "./status";
import { MarkGlyph, MarkRect } from "./status-mark";
import { type Domain, hourTicks, type Lane, xFraction } from "./timeline";

/** レーンの高さと、棒が立つ線（px）。 */
const LANE_H = 132;
const pct = (f: number) => `${(f * 100).toFixed(3)}%`;

function laneNote(lane: Lane): string {
  if (lane.tasks.length === 0 && lane.consults.length === 0) return "今日のタスクはまだありません";
  return `${lane.tasks.length} 件、相談 ${lane.consults.length} 回`;
}

function taskLabel(l: Lane["tasks"][number]): string {
  const { task } = l;
  const pr = task.pr ? `PR ${task.pr.number}、` : "";
  return `${singleLine(task.title)}（${pr}${MARKS[l.kind].label}、${formatUsd(task.cost.cost_usd)}）`;
}

/** 今日のタイムライン（人ごとのレーン）。位置は SVG の % 指定で、style 属性を使わない。 */
export function TimelineView(props: { lanes: Lane[]; domain: Domain; nowMs: number }) {
  const { lanes, domain, nowMs } = props;
  const ticks = hourTicks(domain);
  const nowFrac = xFraction(nowMs, domain);
  return (
    <div className="tl-scroll">
      <div className="tl">
        {lanes.map((lane) => (
          <div className="lane" key={lane.login} data-lane={lane.login}>
            <div className="lane-name">
              <span className="lane-login">{singleLine(lane.login)}</span>
              <span className="lane-note">{laneNote(lane)}</span>
            </div>
            {/* biome-ignore lint/a11y/useSemanticElements: SVG にはグループを表す要素が無い */}
            <svg
              className="lane-svg"
              height={LANE_H}
              role="group"
              aria-label={`${singleLine(lane.login)} のタスク`}
            >
              {ticks.map((t) => (
                <line
                  key={t.t}
                  className="grid"
                  x1={pct(t.frac)}
                  x2={pct(t.frac)}
                  y1={0}
                  y2={LANE_H}
                />
              ))}
              <line
                className="now"
                data-now=""
                x1={pct(nowFrac)}
                x2={pct(nowFrac)}
                y1={8}
                y2={LANE_H}
              />
              {lane.consults.map((c) => (
                <svg className="pin" key={c.consult.consult_id} x={pct(c.frac)} y={0}>
                  <title>{`相談 ${formatClock(Date.parse(c.consult.at))}`}</title>
                  <circle className="consult" data-consult="" cx={0} cy={LANE_H - 4} r={3.5} />
                </svg>
              ))}
              {lane.labels.map((lb) => (
                <svg
                  className="pin"
                  key={`${lb.frac}-${lb.text}`}
                  x={pct(lb.frac)}
                  y={0}
                  aria-hidden="true"
                >
                  <text
                    className="lbl"
                    data-pr-label=""
                    x={0}
                    y={LANE_H - lb.height - 6}
                    textAnchor="middle"
                  >
                    {lb.text}
                  </text>
                </svg>
              ))}
              {lane.tasks.map((l) => (
                <a
                  key={l.task.task_id}
                  href={`/dashboard/tasks/${l.task.task_id}`}
                  aria-label={taskLabel(l)}
                  data-task={l.task.task_id}
                  data-status={l.task.status}
                  data-mark={l.kind}
                >
                  {/* biome-ignore lint/a11y/noSvgWithoutTitle: 名前は <a> の aria-label と title で付けている */}
                  <svg className="pin" x={pct(l.frac)} y={0}>
                    <rect
                      className="hit"
                      x={l.dx - 12}
                      y={LANE_H - l.height - 22}
                      width={24}
                      height={l.height + 22}
                    />
                    <MarkRect
                      kind={l.kind}
                      x={l.dx - 4}
                      y={LANE_H - l.height}
                      width={8}
                      height={l.height}
                    />
                    <title>{taskLabel(l)}</title>
                  </svg>
                </a>
              ))}
            </svg>
          </div>
        ))}
        <div className="lane lane--axis">
          <span />
          <svg className="axis-svg" height={28} aria-hidden="true">
            {ticks.map((t) => (
              <g key={t.t} data-tick={t.label}>
                {Math.abs(t.frac - nowFrac) > 0.04 ? (
                  <text className="lbl lbl--axis" x={pct(t.frac)} y={18} textAnchor="middle">
                    {t.label}
                  </text>
                ) : null}
              </g>
            ))}
            <text className="lbl lbl--now" x={pct(nowFrac)} y={18} textAnchor="middle">
              いま
            </text>
          </svg>
        </div>
      </div>
    </div>
  );
}

/** 凡例。出ている状態の印だけ + consult の点。 */
export function Legend(props: { kinds: MarkKind[] }) {
  const order = Object.keys(MARKS) as MarkKind[];
  const kinds = order.filter((k) => props.kinds.includes(k));
  return (
    <ul className="legend" aria-label="凡例">
      {kinds.map((k) => (
        <li key={k}>
          <MarkGlyph kind={k} />
          {MARKS[k].label}
          {k === "merged" ? "（高さは費用）" : ""}
        </li>
      ))}
      <li>
        <svg
          className="glyph"
          width={8}
          height={8}
          viewBox="0 0 8 8"
          aria-hidden="true"
          focusable="false"
        >
          <circle className="consult" cx={4} cy={4} r={3.5} />
        </svg>
        相談（consult）
      </li>
    </ul>
  );
}
