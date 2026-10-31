import { overviewFixture } from "@rovo/dashboard-contract/fixtures";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { overviewKeepAlive, type PollerDeps } from "../src/poller";
import { useOverview } from "../src/use-overview";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: { unmount: () => void }[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) act(() => r.unmount());
  overviewKeepAlive.set(null);
  document.body.innerHTML = "";
});

const flush = async () => {
  for (let i = 0; i < 10; i++) await act(async () => await Promise.resolve());
};

describe("useOverview: 工場の PiP が見えている間は、元のタブが hidden でも一覧を取り続ける", () => {
  it("元が hidden のまま始めると最初の 1 回だけ取り、予約しない。PiP の条件（overviewKeepAlive）が立つと即取り、予約を続ける。閉じると予約を消す", async () => {
    let hidden = true;
    const timers = new Map<number, () => void>();
    let id = 0;
    const listeners = new Set<() => void>();
    const deps: PollerDeps = {
      setTimer: (fn) => {
        timers.set(++id, fn);
        return id;
      },
      clearTimer: (h) => void timers.delete(h as number),
      isHidden: () => hidden,
      onVisibilityChange: (cb) => {
        listeners.add(cb);
        return () => listeners.delete(cb);
      },
    };
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify(overviewFixture), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    function Probe() {
      useOverview("all", null, true, { fetchImpl, pollerDeps: deps });
      return null;
    }
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    act(() => root.render(createElement(Probe)));
    await flush();
    // 最初の 1 回（日が決まったときの取り直し）は hidden でも取る。次は予約しない
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(timers.size).toBe(0);

    act(() => overviewKeepAlive.set(() => true));
    await flush();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(timers.size).toBe(1);

    act(() => overviewKeepAlive.set(null));
    expect(timers.size).toBe(0);
    hidden = false;
    for (const l of [...listeners]) l();
    await flush();
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});

describe("useOverview: 最後に更新に成功した時刻（okAt。工場の PiP の古さの表示に使う）", () => {
  it("成功のたびに deps.now の時刻を okAt に持つ。失敗（stale）になっても okAt は前の成功の時刻のまま", async () => {
    let now = Date.parse("2026-10-21T05:00:00Z");
    const timers = new Map<number, () => void>();
    let id = 0;
    const deps: PollerDeps = {
      setTimer: (fn) => {
        timers.set(++id, fn);
        return id;
      },
      clearTimer: (h) => void timers.delete(h as number),
      isHidden: () => false,
      onVisibilityChange: () => () => {},
    };
    let fail = false;
    const fetchImpl = vi.fn(async () =>
      fail
        ? new Response("oops", { status: 500 })
        : new Response(JSON.stringify(overviewFixture), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
    );
    const seen: { current: ReturnType<typeof useOverview> | null } = { current: null };
    function Probe() {
      seen.current = useOverview("all", null, true, {
        fetchImpl,
        pollerDeps: deps,
        now: () => now,
      });
      return null;
    }
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    act(() => root.render(createElement(Probe)));
    await flush();
    const firstOk = now;
    expect(seen.current?.state).toMatchObject({ phase: "ready", stale: false, okAt: firstOk });

    // 次の取得は失敗
    now += 7_000;
    fail = true;
    act(() => seen.current?.refresh());
    await flush();
    expect(seen.current?.state).toMatchObject({ phase: "ready", stale: true, okAt: firstOk });

    // もう一度失敗しても動かない
    now += 20_000;
    act(() => seen.current?.refresh());
    await flush();
    expect(seen.current?.state).toMatchObject({ phase: "ready", stale: true, okAt: firstOk });

    // 成功したら、その時刻
    now += 3_000;
    fail = false;
    act(() => seen.current?.refresh());
    await flush();
    expect(seen.current?.state).toMatchObject({ phase: "ready", stale: false, okAt: now });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });
});
