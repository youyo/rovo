import { describe, expect, it } from "vitest";
import { createPoller, type PollOutcome } from "../src/poller";

/** 時刻・タイマー・可視状態を差し替えた環境（実時間を待たない） */
function makeEnv() {
  let now = 0;
  let hidden = false;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const listeners = new Set<() => void>();
  const deps = {
    setTimer: (fn: () => void, ms: number) => {
      const id = nextId++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimer: (h: unknown) => {
      timers.delete(h as number);
    },
    isHidden: () => hidden,
    onVisibilityChange: (cb: () => void) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
  return {
    deps,
    pending: () => [...timers.values()].map((t) => t.at - now),
    /** 次のタイマーまで時間を進めて実行する */
    async fire() {
      const [id, t] = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0] ?? [];
      if (id === undefined || !t) throw new Error("タイマーが無い");
      timers.delete(id);
      now = t.at;
      t.fn();
      await flush();
    },
    setHidden(h: boolean) {
      hidden = h;
      for (const l of [...listeners]) l();
    },
    listenerCount: () => listeners.size,
  };
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

/** 外から解決できる run */
function controllable() {
  const calls: ((o: PollOutcome) => void)[] = [];
  let inflight = 0;
  let maxInflight = 0;
  return {
    run: () =>
      new Promise<PollOutcome>((resolve) => {
        inflight++;
        maxInflight = Math.max(maxInflight, inflight);
        calls.push((o) => {
          inflight--;
          resolve(o);
        });
      }),
    count: () => calls.length,
    async resolve(i: number, o: PollOutcome) {
      calls[i]?.(o);
      await flush();
    },
    maxInflight: () => maxInflight,
  };
}

describe("createPoller（D15）", () => {
  it("開始で即 1 回取り、成功したら 5 秒後にまた取る", async () => {
    const env = makeEnv();
    const c = controllable();
    const p = createPoller({ run: c.run, deps: env.deps });
    p.start();
    expect(c.count()).toBe(1);
    await c.resolve(0, "ok");
    expect(env.pending()).toEqual([5000]);
    await env.fire();
    expect(c.count()).toBe(2);
  });

  it("同時に 2 本走らせない（取得中に refresh しても重ねない。終わってからもう 1 回）", async () => {
    const env = makeEnv();
    const c = controllable();
    const p = createPoller({ run: c.run, deps: env.deps });
    p.start();
    p.refresh();
    p.refresh();
    expect(c.count()).toBe(1);
    await c.resolve(0, "ok");
    expect(c.count()).toBe(2);
    await c.resolve(1, "ok");
    expect(c.maxInflight()).toBe(1);
  });

  it("失敗は 5→10→20→40→最大 60 秒の backoff（失敗 n 回目の次は 5×2^n 秒を 60 秒で頭打ち）、成功で 5 秒に戻る", async () => {
    const env = makeEnv();
    const c = controllable();
    const p = createPoller({ run: c.run, deps: env.deps });
    p.start();
    const waits: number[] = [];
    for (let i = 0; i < 6; i++) {
      await c.resolve(i, "error");
      waits.push(env.pending()[0] as number);
      await env.fire();
    }
    expect(waits).toEqual([10_000, 20_000, 40_000, 60_000, 60_000, 60_000]);
    await c.resolve(6, "ok");
    expect(env.pending()).toEqual([5000]);
  });

  it("hidden の間は取らない。hidden になったらタイマーを止め、戻ったら即 1 回", async () => {
    const env = makeEnv();
    const c = controllable();
    const p = createPoller({ run: c.run, deps: env.deps });
    p.start();
    await c.resolve(0, "ok");
    expect(env.pending()).toHaveLength(1);
    env.setHidden(true);
    expect(env.pending()).toHaveLength(0);
    expect(c.count()).toBe(1);
    env.setHidden(false);
    expect(c.count()).toBe(2);
  });

  it("取得中に hidden になったら、終わっても次を予約しない。戻ったときに即取る", async () => {
    const env = makeEnv();
    const c = controllable();
    const p = createPoller({ run: c.run, deps: env.deps });
    p.start();
    env.setHidden(true);
    await c.resolve(0, "ok");
    expect(env.pending()).toHaveLength(0);
    env.setHidden(false);
    expect(c.count()).toBe(2);
  });

  it("hidden のまま開始したら、戻るまで取らない", async () => {
    const env = makeEnv();
    env.setHidden(true);
    const c = controllable();
    const p = createPoller({ run: c.run, deps: env.deps });
    p.start();
    expect(c.count()).toBe(0);
    env.setHidden(false);
    expect(c.count()).toBe(1);
  });

  it("401 は止まる（再取得しない）。通知は run の結果として呼び出し側が受け取る", async () => {
    const env = makeEnv();
    const c = controllable();
    const p = createPoller({ run: c.run, deps: env.deps });
    p.start();
    await c.resolve(0, "unauthorized");
    expect(env.pending()).toHaveLength(0);
    env.setHidden(true);
    env.setHidden(false);
    expect(c.count()).toBe(1);
  });

  it("finished（終端になって追う期間が過ぎた）で止まる。可視状態が戻っても取らず、refresh で 1 回だけ取れる", async () => {
    const env = makeEnv();
    const c = controllable();
    const p = createPoller({ run: c.run, deps: env.deps });
    p.start();
    await c.resolve(0, "ok");
    await env.fire();
    await c.resolve(1, "finished");
    expect(env.pending()).toHaveLength(0);
    env.setHidden(true);
    env.setHidden(false);
    expect(c.count()).toBe(2);
    p.refresh();
    expect(c.count()).toBe(3);
  });

  it("404 も止まる", async () => {
    const env = makeEnv();
    const c = controllable();
    const p = createPoller({ run: c.run, deps: env.deps });
    p.start();
    await c.resolve(0, "not_found");
    expect(env.pending()).toHaveLength(0);
  });

  it("自動更新を切ると予約を消し、戻ってきても取らない。refresh（手動）は取れる。入れ直すと再開", async () => {
    const env = makeEnv();
    const c = controllable();
    const p = createPoller({ run: c.run, deps: env.deps });
    p.start();
    await c.resolve(0, "ok");
    p.setAutoRefresh(false);
    expect(env.pending()).toHaveLength(0);
    env.setHidden(true);
    env.setHidden(false);
    expect(c.count()).toBe(1);
    p.refresh();
    expect(c.count()).toBe(2);
    await c.resolve(1, "ok");
    expect(env.pending()).toHaveLength(0);
    p.setAutoRefresh(true);
    expect(env.pending()).toEqual([5000]);
  });

  it("自動更新が最初から切れていても、最初の 1 回は取る", async () => {
    const env = makeEnv();
    const c = controllable();
    const p = createPoller({ run: c.run, autoRefresh: false, deps: env.deps });
    p.start();
    expect(c.count()).toBe(1);
    await c.resolve(0, "ok");
    expect(env.pending()).toHaveLength(0);
  });

  it("stop で予約・購読を消し、取得中の結果が来ても何も予約しない", async () => {
    const env = makeEnv();
    const c = controllable();
    const p = createPoller({ run: c.run, deps: env.deps });
    p.start();
    expect(env.listenerCount()).toBe(1);
    p.stop();
    expect(env.listenerCount()).toBe(0);
    await c.resolve(0, "ok");
    expect(env.pending()).toHaveLength(0);
  });

  it("run が例外を投げても error として扱い、止まらない", async () => {
    const env = makeEnv();
    let n = 0;
    const p = createPoller({
      run: async () => {
        n++;
        throw new Error("boom");
      },
      deps: env.deps,
    });
    p.start();
    await flush();
    expect(n).toBe(1);
    expect(env.pending()).toEqual([10_000]);
  });
});

describe("createPoller: 間隔を関数で渡す（PR の CI。実行中は短く、終わったら長く）", () => {
  it("次の予約のたびに関数を呼び直し、その値で待つ", async () => {
    const env = makeEnv();
    const c = controllable();
    let ms = 10_000;
    const p = createPoller({ run: c.run, deps: env.deps, intervalMs: () => ms });
    p.start();
    await c.resolve(0, "ok");
    expect(env.pending()).toEqual([10_000]);
    ms = 60_000;
    await env.fire();
    await c.resolve(1, "ok");
    expect(env.pending()).toEqual([60_000]);
  });

  it("失敗の backoff は関数の値を基準にする（最大 60 秒）", async () => {
    const env = makeEnv();
    const c = controllable();
    const p = createPoller({ run: c.run, deps: env.deps, intervalMs: () => 10_000 });
    p.start();
    await c.resolve(0, "error");
    expect(env.pending()).toEqual([20_000]);
    await env.fire();
    await c.resolve(1, "error");
    expect(env.pending()).toEqual([40_000]);
    await env.fire();
    await c.resolve(2, "error");
    expect(env.pending()).toEqual([60_000]);
    p.stop();
  });
});
