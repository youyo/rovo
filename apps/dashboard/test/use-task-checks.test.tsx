import type { ChecksDto } from "@rovo/dashboard-contract";
import {
  checksFailingFixture,
  checksFixture,
  checksUnreadableFixture,
} from "@rovo/dashboard-contract/fixtures";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PollerDeps } from "../src/poller";
import { type ChecksState, useTaskChecks } from "../src/use-task-checks";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ID = "01K8ZF00000000000000000004";
const ID2 = "01K8ZF00000000000000000005";
const done: ChecksDto = {
  ...checksFixture,
  state: "passing",
  checks: checksFixture.checks.slice(0, 2),
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

/** 時刻・タイマー・可視状態を差し替えた環境（実時間を待たない） */
function makeEnv() {
  let now = 0;
  let hidden = false;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const listeners = new Set<() => void>();
  const deps: PollerDeps = {
    setTimer: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimer: (h) => {
      timers.delete(h as number);
    },
    isHidden: () => hidden,
    onVisibilityChange: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
  return {
    deps,
    pending: () => [...timers.values()].map((t) => t.at - now),
    async fire() {
      const [id, t] = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0] ?? [];
      if (id === undefined || !t) throw new Error("タイマーが無い");
      timers.delete(id);
      now = t.at;
      await act(async () => {
        t.fn();
        await flush();
      });
    },
    setHidden(h: boolean) {
      hidden = h;
      for (const l of [...listeners]) l();
    },
  };
}

const roots: { unmount: () => void }[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) act(() => r.unmount());
  document.body.innerHTML = "";
});

type Props = { id: string; enabled: boolean; autoRefresh: boolean };

async function mount(
  responses: (() => Response)[] | (() => Response),
  initial: Partial<Props> = {},
) {
  const env = makeEnv();
  const queue = Array.isArray(responses) ? [...responses] : null;
  const fetchImpl = vi.fn(async () => {
    if (!queue) return (responses as () => Response)();
    const next = queue.shift() ?? queue[0];
    return next ? next() : json(500, {});
  });
  const latest: { state: ChecksState | null; refresh: () => void } = {
    state: null,
    refresh: () => {},
  };
  function Probe(p: Props) {
    const r = useTaskChecks(p.id, p.enabled, p.autoRefresh, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      pollerDeps: env.deps,
    });
    latest.state = r.state;
    latest.refresh = r.refresh;
    return null;
  }
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const render = async (p: Partial<Props>) => {
    props = { ...props, ...p };
    await act(async () => {
      root.render(createElement(Probe, props));
      await flush();
    });
  };
  let props: Props = { id: ID, enabled: true, autoRefresh: true, ...initial };
  await render({});
  return { env, fetchImpl, latest, render };
}

describe("useTaskChecks", () => {
  it("PR が無い（enabled=false）間は取りに行かない。state は null", async () => {
    const { fetchImpl, latest, env } = await mount(() => json(200, done), { enabled: false });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(latest.state).toBeNull();
    expect(env.pending()).toEqual([]);
  });

  it("有効になると /checks を取り、ready になる", async () => {
    const { fetchImpl, latest } = await mount(() => json(200, done));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect((fetchImpl.mock.calls[0] as unknown as [string])[0]).toBe(
      `/dashboard/api/tasks/${ID}/checks`,
    );
    expect(latest.state).toEqual({ phase: "ready", data: done, stale: false });
  });

  it("実行中・待ちがあれば 10 秒、全部終わったら 60 秒で次を取る（detail の 5 秒とは別）", async () => {
    const { env, latest, fetchImpl } = await mount([
      () => json(200, checksFixture), // 実行中あり
      () => json(200, done), // 全部終わった
      () => json(200, done),
    ]);
    expect(env.pending()).toEqual([10_000]);
    await env.fire();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(latest.state).toMatchObject({ phase: "ready", data: done });
    expect(env.pending()).toEqual([60_000]);
  });

  it("後から push されて、終わっていた CI がまた動き出したら 10 秒に戻る", async () => {
    const { env } = await mount([() => json(200, done), () => json(200, checksFixture)]);
    expect(env.pending()).toEqual([60_000]);
    await env.fire();
    expect(env.pending()).toEqual([10_000]);
  });

  it("タブが隠れている間は予約しない（既存の poller のまま）", async () => {
    const { env, fetchImpl } = await mount(() => json(200, checksFixture));
    env.setHidden(true);
    expect(env.pending()).toEqual([]);
    env.setHidden(false);
    await act(async () => {
      await flush();
    });
    expect(fetchImpl.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("自動更新を切ると予約しない。refresh() では取れる", async () => {
    const { env, latest, fetchImpl } = await mount(() => json(200, checksFixture), {
      autoRefresh: false,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(env.pending()).toEqual([]);
    await act(async () => {
      latest.refresh();
      await flush();
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("PR が無くなる（enabled=false）と止まって state は null。別のタスクに替わると取り直して前の値を捨てる", async () => {
    const { env, latest, fetchImpl, render } = await mount([
      () => json(200, checksFailingFixture),
      () => json(200, done),
    ]);
    expect(latest.state).toMatchObject({ data: checksFailingFixture });
    await render({ id: ID2 });
    expect((fetchImpl.mock.calls.at(-1) as unknown as [string])[0]).toBe(
      `/dashboard/api/tasks/${ID2}/checks`,
    );
    expect(latest.state).toMatchObject({ phase: "ready", data: done });
    await render({ enabled: false });
    expect(latest.state).toBeNull();
    expect(env.pending()).toEqual([]);
  });

  it("最初の取得に失敗すると error。backoff で取り直して、直れば ready", async () => {
    const { env, latest } = await mount([() => json(503, {}), () => json(200, done)]);
    expect(latest.state).toEqual({ phase: "error" });
    // まだ何も取れていない間は 10 秒の間隔が基準なので、失敗の backoff は 20 秒（60 秒の倍にはしない）
    expect(env.pending()).toEqual([20_000]);
    await env.fire();
    expect(latest.state).toEqual({ phase: "ready", data: done, stale: false });
  });

  it("取れたあとの失敗は、前の値を出したまま stale", async () => {
    const { env, latest } = await mount([() => json(200, checksFixture), () => json(503, {})]);
    await env.fire();
    expect(latest.state).toEqual({ phase: "ready", data: checksFixture, stale: true });
  });

  it("読めない（unreadable）も ready として返す（画面が文言を出す）", async () => {
    const { latest } = await mount(() => json(200, checksUnreadableFixture));
    expect(latest.state).toMatchObject({ phase: "ready", data: { state: "unreadable" } });
  });

  it("401 / 404 は止まる（タスク本体の取得が扱う）。state は error", async () => {
    for (const status of [401, 404]) {
      const { env, latest } = await mount(() => json(status, {}));
      expect(latest.state).toEqual({ phase: "error" });
      expect(env.pending()).toEqual([]);
    }
  });
});
