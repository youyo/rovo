import type { TaskDetailDto, TaskEventDto } from "@rovo/dashboard-contract";
import { taskDetailRunningFixture, taskEventsFixture } from "@rovo/dashboard-contract/fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CACHED_EVENTS_MAX, createDetailCache, DETAIL_CACHE_MAX } from "../src/detail-cache";

afterEach(() => {
  vi.unstubAllGlobals();
});

const detailOf = (n: number): TaskDetailDto => ({
  ...taskDetailRunningFixture,
  task: { ...taskDetailRunningFixture.task, task_id: `01K8ZF${String(n).padStart(20, "0")}` },
});
const entry = (n: number, events: TaskEventDto[] = [], hasOlder = false) => ({
  detail: detailOf(n),
  events,
  hasOlder,
});
const id = (n: number) => detailOf(n).task.task_id;
const evs = (from: number, count: number): TaskEventDto[] =>
  Array.from({ length: count }, (_, i) => ({
    seq: from + i,
    at: "2026-10-21T05:40:00Z",
    type: "agent_event" as const,
    agent_type: `t${from + i}`,
  }));

describe("詳細のキャッシュ（画面のメモリ上だけ。件数に上限）", () => {
  it("最後の詳細・events・hasOlder をそのまま返す。無ければ undefined", () => {
    const cache = createDetailCache();
    expect(cache.get(id(1))).toBeUndefined();
    cache.set(id(1), entry(1, taskEventsFixture.events, true));
    expect(cache.get(id(1))).toEqual({
      detail: detailOf(1),
      events: taskEventsFixture.events,
      hasOlder: true,
    });
  });

  it("同じ ID は上書き（最後の詳細）", () => {
    const cache = createDetailCache();
    cache.set(id(1), entry(1));
    const next = { ...entry(1), hasOlder: true };
    cache.set(id(1), next);
    expect(cache.get(id(1))?.hasOlder).toBe(true);
    expect(cache.size).toBe(1);
  });

  it("件数に小さな上限がある（既定の上限を超えたら、使われていない古いものから捨てる）", () => {
    expect(DETAIL_CACHE_MAX).toBeGreaterThanOrEqual(2);
    expect(DETAIL_CACHE_MAX).toBeLessThanOrEqual(20);
    const cache = createDetailCache();
    for (let n = 1; n <= DETAIL_CACHE_MAX + 5; n++) cache.set(id(n), entry(n));
    expect(cache.size).toBe(DETAIL_CACHE_MAX);
    expect(cache.get(id(1))).toBeUndefined();
    expect(cache.get(id(DETAIL_CACHE_MAX + 5))).toBeDefined();
  });

  it("読んだものは新しい扱いになり、捨てられにくい", () => {
    const cache = createDetailCache(3);
    cache.set(id(1), entry(1));
    cache.set(id(2), entry(2));
    cache.set(id(3), entry(3));
    expect(cache.get(id(1))).toBeDefined();
    cache.set(id(4), entry(4));
    expect(cache.get(id(2))).toBeUndefined();
    expect(cache.get(id(1))).toBeDefined();
    expect(cache.get(id(3))).toBeDefined();
    expect(cache.get(id(4))).toBeDefined();
  });

  it("delete と clear（権限を失った・ログアウトしたときに使う）", () => {
    const cache = createDetailCache();
    cache.set(id(1), entry(1));
    cache.set(id(2), entry(2));
    cache.delete(id(1));
    expect(cache.get(id(1))).toBeUndefined();
    expect(cache.get(id(2))).toBeDefined();
    cache.clear();
    expect(cache.size).toBe(0);
  });

  it("events は新しい側の 1 ページ分だけ残し、切り捨てたら hasOlder にする（メモリを膨らませない）", () => {
    const cache = createDetailCache();
    cache.set(id(1), entry(1, evs(1, CACHED_EVENTS_MAX + 30), false));
    const got = cache.get(id(1));
    expect(got?.events).toHaveLength(CACHED_EVENTS_MAX);
    expect(got?.events[0]?.seq).toBe(31);
    expect(got?.events.at(-1)?.seq).toBe(CACHED_EVENTS_MAX + 30);
    expect(got?.hasOlder).toBe(true);
    // 切り捨てなければ hasOlder はそのまま
    cache.set(id(2), entry(2, evs(1, 5), false));
    expect(cache.get(id(2))?.hasOlder).toBe(false);
  });

  it("localStorage・sessionStorage には触らない（メモリだけ）", () => {
    const boom = () => {
      throw new Error("storage");
    };
    vi.stubGlobal("localStorage", { getItem: boom, setItem: boom, removeItem: boom });
    vi.stubGlobal("sessionStorage", { getItem: boom, setItem: boom, removeItem: boom });
    const cache = createDetailCache();
    expect(() => {
      cache.set(id(1), entry(1));
      cache.get(id(1));
      cache.delete(id(1));
      cache.clear();
    }).not.toThrow();
  });
});
