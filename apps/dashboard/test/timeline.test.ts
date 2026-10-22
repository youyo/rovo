import type { OverviewDto } from "@rovo/dashboard-contract";
import { overviewFixture, overviewMeFixture } from "@rovo/dashboard-contract/fixtures";
import { describe, expect, it } from "vitest";
import {
  buildLanes,
  HOUR,
  hourTicks,
  spreadOverlaps,
  stemHeight,
  timelineDomain,
  xFraction,
} from "../src/timeline";

const at = (h: number, m = 0) => new Date(2026, 9, 21, h, m).getTime();
const DAY_START = at(0);
const DAY_END = DAY_START + 24 * HOUR;

describe("timelineDomain（当日のタスクが収まる範囲。見本: 11:44 開始・いま 15:40 → 10:00-16:00）", () => {
  it("最初の開始の 1 時間前（時の頭）から、いまを含む時の終わりまで", () => {
    const d = timelineDomain({
      starts: [at(11, 44), at(13, 7), at(14, 37)],
      nowMs: at(15, 40),
      dayStart: DAY_START,
      dayEnd: DAY_END,
    });
    expect(d).toEqual({ start: at(10), end: at(16) });
  });

  it("日の範囲を出ない", () => {
    const d = timelineDomain({
      starts: [at(0, 10)],
      nowMs: at(23, 50),
      dayStart: DAY_START,
      dayEnd: DAY_END,
    });
    expect(d.start).toBe(DAY_START);
    expect(d.end).toBe(DAY_END);
  });

  it("タスクが無い・短いときも最小 3 時間の幅を持つ", () => {
    const d = timelineDomain({
      starts: [],
      nowMs: at(9, 30),
      dayStart: DAY_START,
      dayEnd: DAY_END,
    });
    expect(d.end - d.start).toBeGreaterThanOrEqual(3 * HOUR);
    expect(d.start).toBeLessThanOrEqual(at(9, 30));
    expect(d.end).toBeGreaterThanOrEqual(at(9, 30));
  });

  it("開始が いま より後（時計のずれ）でも全部収める", () => {
    const d = timelineDomain({
      starts: [at(12, 30)],
      nowMs: at(12, 0),
      dayStart: DAY_START,
      dayEnd: DAY_END,
    });
    expect(d.end).toBeGreaterThanOrEqual(at(12, 30));
  });
});

describe("xFraction / stemHeight / hourTicks", () => {
  const domain = { start: at(10), end: at(16) };
  it("xFraction: 範囲内は線形、範囲外は 0〜1 に丸める", () => {
    expect(xFraction(at(10), domain)).toBe(0);
    expect(xFraction(at(13), domain)).toBeCloseTo(0.5);
    expect(xFraction(at(16), domain)).toBe(1);
    expect(xFraction(at(9), domain)).toBe(0);
    expect(xFraction(at(18), domain)).toBe(1);
  });

  it("stemHeight: 費用に応じて min〜max。0・最大 0 でも壊れない。単調", () => {
    expect(stemHeight(0, 0)).toBe(12);
    expect(stemHeight(0, 5)).toBe(12);
    expect(stemHeight(5, 5)).toBe(92);
    expect(stemHeight(10, 5)).toBe(92);
    expect(stemHeight(2.5, 5)).toBeGreaterThan(stemHeight(1, 5));
    expect(stemHeight(Number.NaN, 5)).toBe(12);
  });

  it("hourTicks: 範囲内の毎時（ローカル）。ラベルは H:00", () => {
    const t = hourTicks(domain);
    expect(t.map((x) => x.label)).toEqual([
      "10:00",
      "11:00",
      "12:00",
      "13:00",
      "14:00",
      "15:00",
      "16:00",
    ]);
    expect(t[0]?.frac).toBe(0);
    expect(t[6]?.frac).toBe(1);
  });
});

describe("spreadOverlaps（同時刻の棒の重なりを横にずらす）", () => {
  it("離れていればずらさない", () => {
    expect(spreadOverlaps([0.1, 0.5, 0.9], 0.02)).toEqual([0, 0, 0]);
  });

  it("近いものは重ならないように中心に対して左右へ。元の順序で返す", () => {
    const dx = spreadOverlaps([0.5, 0.1, 0.5, 0.5], 0.02, 10);
    expect(dx[1]).toBe(0);
    const cluster = [dx[0], dx[2], dx[3]] as number[];
    expect(new Set(cluster).size).toBe(3);
    expect(cluster.reduce((a, b) => a + b, 0)).toBe(0); // 中心に対して対称
    const sorted = [...cluster].sort((a, b) => a - b);
    expect(sorted[1]).toBeGreaterThan((sorted[0] as number) + 9);
  });

  it("空配列", () => {
    expect(spreadOverlaps([], 0.02)).toEqual([]);
  });
});

describe("buildLanes（レーン: 全員は owner_login ごと、自分は自分だけ）", () => {
  const range = { start: DAY_START, end: DAY_END };
  it("全員: 閲覧者が先頭、ほかは login 順。各レーンにそのタスクと consult", () => {
    const lanes = buildLanes(overviewFixture, range);
    expect(lanes.map((l) => l.login)).toEqual(["alice-example", "bob-example", "carol-example"]);
    expect(lanes[0]?.isViewer).toBe(true);
    expect(lanes[0]?.tasks).toHaveLength(2);
    expect(lanes[1]?.tasks).toHaveLength(2);
    expect(lanes[2]?.tasks).toHaveLength(1);
    expect(lanes.map((l) => l.consults.length)).toEqual([1, 1, 1]);
  });

  it("自分: 自分のレーンだけ", () => {
    const lanes = buildLanes(overviewMeFixture, range);
    expect(lanes.map((l) => l.login)).toEqual(["alice-example"]);
    expect(lanes[0]?.tasks).toHaveLength(2);
  });

  it("自分でタスクが 0 件でも閲覧者のレーンは残る（空のレーン）", () => {
    const empty: OverviewDto = { ...overviewMeFixture, tasks: [], consults: [] };
    const lanes = buildLanes(empty, range);
    expect(lanes).toHaveLength(1);
    expect(lanes[0]).toMatchObject({ login: "alice-example", tasks: [], consults: [] });
  });

  it("棒の x は開始時刻（無ければ作成時刻）、高さは費用に比例（全レーン共通の最大で）", () => {
    const utcDay = Date.parse("2026-10-21T00:00:00Z"); // タイムゾーンに依存しない固定の範囲
    const lanes = buildLanes(overviewFixture, { start: utcDay, end: utcDay + 24 * HOUR });
    const all = lanes.flatMap((l) => l.tasks);
    const biggest = all.reduce((a, b) => (a.task.cost.cost_usd >= b.task.cost.cost_usd ? a : b));
    expect(biggest.height).toBe(92);
    const t1 = all.find((t) => t.task.task_id === overviewFixture.tasks[0]?.task_id);
    expect(t1?.frac).toBeCloseTo((Date.parse("2026-10-21T01:06:10Z") - utcDay) / (24 * HOUR), 5);
  });
});
