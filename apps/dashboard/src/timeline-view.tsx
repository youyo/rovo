import { formatClock, formatUsd, singleLine } from "./format";
import { MARKS, type MarkKind } from "./status";
import { MarkGlyph, MarkRect } from "./status-mark";
import { type Domain, hourTicks, type Lane, xFraction } from "./timeline";

/**
 * 今日のタイムライン（人ごとのレーン）を、ヘッダの下の細い帯にする。
 * 帯全体（レーン + 時刻の軸）の高さは TL_BAND_H で、レーンの数で割る。レーンが多くて割り切れないときは帯の中を縦にスクロールする。
 */
export const TL_BAND_H = 48;
export const TL_AXIS_H = 12;
/** 1 レーンの最小の高さ（これ未満になるほどレーンが多いときは、帯を縦にスクロールする） */
export const TL_MIN_LANE_H = 12;
/** 1 レーンの最大の高さ */
const TL_MAX_LANE_H = 36;

const pct = (f: number) => `${(f * 100).toFixed(3)}%`;

/** レーンの高さ。帯から軸を引いた残りをレーン数で割り、最小〜最大に丸める */
export function laneHeight(laneCount: number): number {
  if (laneCount <= 0) return TL_MAX_LANE_H;
  return Math.max(
    TL_MIN_LANE_H,
    Math.min(TL_MAX_LANE_H, Math.floor((TL_BAND_H - TL_AXIS_H) / laneCount)),
  );
}

function laneNote(lane: Lane): string {
  if (lane.tasks.length === 0 && lane.consults.length === 0) return "今日のタスクはまだありません";
  return `${lane.tasks.length} 件、相談 ${lane.consults.length} 回`;
}

function taskLabel(l: Lane["tasks"][number]): string {
  const { task } = l;
  const pr = task.pr ? `PR ${task.pr.number}、` : "";
  return `${singleLine(task.title)}（${pr}${MARKS[l.kind].label}、${formatUsd(task.cost.cost_usd)}）`;
}

/** buildLanes の棒の高さ（12〜92）を、レーンの高さに収まる範囲に写す */
function markHeight(stem: number, laneH: number): number {
  const room = laneH - 4;
  const ratio = Math.min(1, Math.max(0, (stem - 12) / (92 - 12)));
  return Math.max(6, Math.round(6 + ratio * (room - 6)));
}

export function TimelineView(props: { lanes: Lane[]; domain: Domain; nowMs: number }) {
  const { lanes, domain, nowMs } = props;
  const ticks = hourTicks(domain);
  const nowFrac = xFraction(nowMs, domain);
  const laneH = laneHeight(lanes.length);
  return (
    <div className="tl-scroll">
      <div className="tl">
        {lanes.map((lane) => (
          <div className="lane" key={lane.login} data-lane={lane.login}>
            <div className="lane-name">
              <span className="lane-login">{singleLine(lane.login)}</span>
              <span className="sr-only">{laneNote(lane)}</span>
            </div>
            {/* biome-ignore lint/a11y/useSemanticElements: SVG にはグループを表す要素が無い */}
            <svg
              className="lane-svg"
              height={laneH}
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
                  y2={laneH}
                />
              ))}
              <line
                className="now"
                data-now=""
                x1={pct(nowFrac)}
                x2={pct(nowFrac)}
                y1={0}
                y2={laneH}
              />
              {lane.consults.map((c) => (
                <svg className="pin" key={c.consult.consult_id} x={pct(c.frac)} y={0}>
                  <title>{`相談 ${formatClock(Date.parse(c.consult.at))}`}</title>
                  <circle className="consult" data-consult="" cx={0} cy={laneH - 4} r={2.5} />
                </svg>
              ))}
              {lane.tasks.map((l) => {
                const h = markHeight(l.height, laneH);
                // 近い棒の重なりの横のずれ（buildLanes は 10px 間隔）は、細い帯では半分にする
                const dx = l.dx / 2;
                return (
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
                      <rect className="hit" x={dx - 6} y={0} width={12} height={laneH} />
                      <MarkRect kind={l.kind} x={dx - 3} y={laneH - h - 1} width={6} height={h} />
                      <title>{taskLabel(l)}</title>
                    </svg>
                  </a>
                );
              })}
            </svg>
          </div>
        ))}
        <div className="lane lane--axis">
          <span />
          <svg className="axis-svg" height={TL_AXIS_H} aria-hidden="true">
            {ticks.map((t) => (
              <g key={t.t} data-tick={t.label}>
                {Math.abs(t.frac - nowFrac) > 0.04 ? (
                  <text className="lbl lbl--axis" x={pct(t.frac)} y={10} textAnchor="middle">
                    {t.label}
                  </text>
                ) : null}
              </g>
            ))}
            <text className="lbl lbl--now" x={pct(nowFrac)} y={10} textAnchor="middle">
              いま
            </text>
          </svg>
        </div>
      </div>
    </div>
  );
}

/** 凡例。出ている状態の印 + consult の点。 */
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
