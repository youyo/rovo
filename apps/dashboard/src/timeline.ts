import type { ConsultPointDto, OverviewDto, VisibleTaskDto } from "@rovo/dashboard-contract";
import { type MarkKind, markKindOf } from "./status";

/** タイムラインの座標・高さ・重なりの純関数（DOM に依存しない）。時刻はエポック ms。 */

export const HOUR = 3_600_000;
export type Domain = { start: number; end: number };

const floorHour = (ms: number) => {
  const d = new Date(ms);
  d.setMinutes(0, 0, 0);
  return d.getTime();
};
const ceilHour = (ms: number) => {
  const f = floorHour(ms);
  return f === ms ? f : f + HOUR;
};

/**
 * 時間の範囲。当日のタスクが収まる範囲（最初の開始の 1 時間前の時の頭から、いまを含む時の終わりまで）。
 * 日の範囲 [dayStart, dayEnd] を出ず、最小 3 時間の幅を持つ。
 */
export function timelineDomain(input: {
  starts: number[];
  nowMs: number;
  dayStart: number;
  dayEnd: number;
  minSpanMs?: number;
}): Domain {
  const { starts, nowMs, dayStart, dayEnd } = input;
  const minSpan = input.minSpanMs ?? 3 * HOUR;
  const anchors = [...starts, nowMs];
  const lo = Math.min(...anchors);
  const hi = Math.max(...anchors);
  let start = Math.max(dayStart, floorHour(lo) - HOUR);
  let end = Math.min(dayEnd, ceilHour(hi));
  if (end - start < minSpan) {
    end = Math.min(dayEnd, start + minSpan);
    if (end - start < minSpan) start = Math.max(dayStart, end - minSpan);
  }
  return { start, end };
}

/** 時刻 → 0〜1 の位置（範囲外は端に丸める）。 */
export function xFraction(t: number, d: Domain): number {
  if (d.end <= d.start) return 0;
  return Math.min(1, Math.max(0, (t - d.start) / (d.end - d.start)));
}

/**
 * 費用 → 棒の高さ（px）。最大の費用で最大の高さ、0・NaN は最小の高さ。
 * 桁の違う費用（$0.001 と $2）でも差が見えるように、対数的な尺度（log1p(cost / FLOOR)）にする。
 */
const COST_FLOOR = 0.001;
export function stemHeight(cost: number, maxCost: number, min = 12, max = 92): number {
  if (!Number.isFinite(cost) || !Number.isFinite(maxCost) || cost <= 0 || maxCost <= 0) return min;
  const ratio = Math.log1p(Math.min(cost, maxCost) / COST_FLOOR) / Math.log1p(maxCost / COST_FLOOR);
  return Math.round(min + ratio * (max - min));
}

export type Tick = { t: number; frac: number; label: string };

/** 範囲内の毎時（ローカル）の目盛り。 */
export function hourTicks(d: Domain): Tick[] {
  const ticks: Tick[] = [];
  for (let t = ceilHour(d.start); t <= d.end; t += HOUR) {
    ticks.push({ t, frac: xFraction(t, d), label: `${new Date(t).getHours()}:00` });
  }
  return ticks;
}

/** 近い位置（minGap 未満）の連なりを 1 群にする。群は位置順で、中身は元の添字。 */
export function clusterGroups(fracs: number[], minGap: number): number[][] {
  const order = fracs.map((_, i) => i).sort((a, b) => (fracs[a] as number) - (fracs[b] as number));
  const groups: number[][] = [];
  let last = Number.NEGATIVE_INFINITY;
  for (const idx of order) {
    const f = fracs[idx] as number;
    if (groups.length === 0 || f - last >= minGap) groups.push([]);
    (groups[groups.length - 1] as number[]).push(idx);
    last = f;
  }
  return groups;
}

/**
 * 近い位置の棒を横にずらす。返すのは入力と同じ順序の横のずれ（px）。
 * 群の中心に対して stepPx 間隔で左右に並べる。
 */
export function spreadOverlaps(fracs: number[], minGap: number, stepPx = 10): number[] {
  const dx = new Array<number>(fracs.length).fill(0);
  for (const group of clusterGroups(fracs, minGap)) {
    group.forEach((idx, k) => {
      dx[idx] = (k - (group.length - 1) / 2) * stepPx;
    });
  }
  return dx;
}

/** 群の PR ラベル。1 件は #n、複数は #最小–#最大（棒の間隔に入らない数字を並べない）。PR が無ければ null。 */
export function clusterLabel(numbers: (number | null)[]): string | null {
  const ns = numbers.filter((n): n is number => n !== null);
  if (ns.length === 0) return null;
  const lo = Math.min(...ns);
  const hi = Math.max(...ns);
  return lo === hi ? `#${lo}` : `#${lo}–#${hi}`;
}

export type LaneTask = {
  task: VisibleTaskDto;
  kind: MarkKind;
  frac: number;
  /** 棒の高さ（px） */
  height: number;
  /** 重なりを避ける横のずれ（px） */
  dx: number;
};
/** 群ごとの PR ラベル（群の中央の位置、群で一番高い棒の高さ） */
export type LaneLabel = { frac: number; height: number; text: string };
export type LaneConsult = { consult: ConsultPointDto; frac: number };
export type Lane = {
  login: string;
  isViewer: boolean;
  tasks: LaneTask[];
  labels: LaneLabel[];
  consults: LaneConsult[];
};

/** タスクの時刻（開始、無ければ作成）。 */
export function taskTime(t: VisibleTaskDto): number {
  return Date.parse(t.started_at ?? t.created_at);
}

/** 重なりとみなす位置の差（範囲に対する割合）。 */
const MIN_GAP = 0.012;

/**
 * 人ごとのレーン。閲覧者が先頭、ほかは login 順。
 * scope=me の応答には自分の分しか入らない（サーバーが絞る）が、念のため閲覧者のレーンは必ず作る。
 */
export function buildLanes(data: OverviewDto, domain: Domain): Lane[] {
  const viewer = data.viewer.login;
  const logins = new Set<string>([viewer]);
  if (data.scope === "all") {
    for (const t of data.tasks) logins.add(t.owner_login);
    for (const c of data.consults) logins.add(c.owner_login);
  }
  const maxCost = Math.max(0, ...data.tasks.map((t) => t.cost.cost_usd));
  const ordered = [viewer, ...[...logins].filter((l) => l !== viewer).sort()];
  return ordered.map((login) => {
    const mine = data.tasks.filter((t) => t.owner_login === login);
    const fracs = mine.map((t) => xFraction(taskTime(t), domain));
    const dx = spreadOverlaps(fracs, MIN_GAP);
    const heights = mine.map((t) => stemHeight(t.cost.cost_usd, maxCost));
    const labels: LaneLabel[] = [];
    for (const g of clusterGroups(fracs, MIN_GAP)) {
      const text = clusterLabel(g.map((i) => (mine[i] as VisibleTaskDto).pr?.number ?? null));
      if (text === null) continue;
      labels.push({
        frac: g.reduce((a, i) => a + (fracs[i] as number), 0) / g.length,
        height: Math.max(...g.map((i) => heights[i] as number)),
        text,
      });
    }
    return {
      login,
      isViewer: login === viewer,
      tasks: mine.map((task, i) => ({
        task,
        kind: markKindOf(task),
        frac: fracs[i] as number,
        height: heights[i] as number,
        dx: dx[i] as number,
      })),
      labels,
      consults: data.consults
        .filter((c) => c.owner_login === login)
        .map((consult) => ({ consult, frac: xFraction(Date.parse(consult.at), domain) })),
    };
  });
}
