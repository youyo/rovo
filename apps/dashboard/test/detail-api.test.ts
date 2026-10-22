import { taskDetailRunningFixture, taskEventsFixture } from "@rovo/dashboard-contract/fixtures";
import { describe, expect, it, vi } from "vitest";
import { eventsUrl, fetchTaskDetail, fetchTaskEvents } from "../src/detail-api";

const ID = "01K8ZF00000000000000000004";
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const f = (res: () => Response | Promise<Response>) => vi.fn(async () => res());

describe("eventsUrl", () => {
  it("指定なしは末尾から（クエリなし）", () => {
    expect(eventsUrl(ID, {})).toBe(`/dashboard/api/tasks/${ID}/events`);
  });
  it("cursor は最後の seq。before は遡り", () => {
    expect(eventsUrl(ID, { cursor: 9 })).toBe(`/dashboard/api/tasks/${ID}/events?cursor=9`);
    expect(eventsUrl(ID, { before: 3 })).toBe(`/dashboard/api/tasks/${ID}/events?before=3`);
  });
  it("cursor=0 や不正な値は送らない（400 になる）", () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(eventsUrl(ID, { cursor: bad }), String(bad)).toBe(`/dashboard/api/tasks/${ID}/events`);
      expect(eventsUrl(ID, { before: bad }), String(bad)).toBe(`/dashboard/api/tasks/${ID}/events`);
    }
  });
  it("cursor と before を同時に送らない（cursor を優先）", () => {
    expect(eventsUrl(ID, { cursor: 5, before: 2 })).toBe(
      `/dashboard/api/tasks/${ID}/events?cursor=5`,
    );
  });
});

describe("fetchTaskDetail", () => {
  it("200 で ok。same-origin の Cookie で取る", async () => {
    const fetchImpl = f(() => json(200, taskDetailRunningFixture));
    const r = await fetchTaskDetail(ID, fetchImpl);
    expect(r).toEqual({ kind: "ok", data: taskDetailRunningFixture });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`/dashboard/api/tasks/${ID}`);
    expect(init.credentials).toBe("same-origin");
  });
  it("fresh: true のときだけ ?fresh=1 を付ける（既定は付けない）", async () => {
    const fetchImpl = f(() => json(200, taskDetailRunningFixture));
    await fetchTaskDetail(ID, fetchImpl, { fresh: true });
    await fetchTaskDetail(ID, fetchImpl, { fresh: false });
    await fetchTaskDetail(ID, fetchImpl);
    const urls = fetchImpl.mock.calls.map((c) => (c as unknown as [string])[0]);
    expect(urls).toEqual([
      `/dashboard/api/tasks/${ID}?fresh=1`,
      `/dashboard/api/tasks/${ID}`,
      `/dashboard/api/tasks/${ID}`,
    ]);
  });
  it("signal を渡すと fetch に引き渡す（前の取得を止められる）。渡さなければ付けない", async () => {
    const fetchImpl = f(() => json(200, taskDetailRunningFixture));
    const ac = new AbortController();
    await fetchTaskDetail(ID, fetchImpl, { signal: ac.signal });
    await fetchTaskDetail(ID, fetchImpl);
    const inits = fetchImpl.mock.calls.map((c) => (c as unknown as [string, RequestInit])[1]);
    expect(inits[0]?.signal).toBe(ac.signal);
    expect(inits[1]?.signal).toBeUndefined();
  });
  it("止めた取得は error（例外にしない）", async () => {
    const ac = new AbortController();
    const fetchImpl = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("a", "AbortError")),
          );
        }),
    );
    const p = fetchTaskDetail(ID, fetchImpl as unknown as typeof fetch, { signal: ac.signal });
    ac.abort();
    expect(await p).toEqual({ kind: "error" });
  });
  it("401 / 404 / その他", async () => {
    expect(
      await fetchTaskDetail(
        ID,
        f(() => json(401, { error: "unauthorized" })),
      ),
    ).toEqual({
      kind: "unauthorized",
    });
    expect(
      await fetchTaskDetail(
        ID,
        f(() => json(404, { error: "not_found" })),
      ),
    ).toEqual({
      kind: "not_found",
    });
    expect(
      await fetchTaskDetail(
        ID,
        f(() => json(500, {})),
      ),
    ).toEqual({ kind: "error" });
    expect(
      await fetchTaskDetail(
        ID,
        f(() => json(400, {})),
      ),
    ).toEqual({ kind: "error" });
  });
  it("壊れた応答・ネットワーク障害は error（例外にしない）", async () => {
    expect(
      await fetchTaskDetail(
        ID,
        f(() => json(200, { task: 1 })),
      ),
    ).toEqual({ kind: "error" });
    expect(
      await fetchTaskDetail(
        ID,
        f(() => json(200, null)),
      ),
    ).toEqual({ kind: "error" });
    expect(
      await fetchTaskDetail(
        ID,
        vi.fn(async () => {
          throw new Error("net");
        }),
      ),
    ).toEqual({ kind: "error" });
  });
});

describe("fetchTaskEvents", () => {
  it("signal を渡すと fetch に引き渡す", async () => {
    const fetchImpl = f(() => json(200, taskEventsFixture));
    const ac = new AbortController();
    await fetchTaskEvents(ID, {}, fetchImpl, ac.signal);
    const init = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.signal).toBe(ac.signal);
  });
  it("200 で ok", async () => {
    const r = await fetchTaskEvents(
      ID,
      { cursor: 3 },
      f(() => json(200, taskEventsFixture)),
    );
    expect(r).toEqual({ kind: "ok", data: taskEventsFixture });
  });
  it("401 / 404 / その他 / 壊れた応答", async () => {
    expect(
      (
        await fetchTaskEvents(
          ID,
          {},
          f(() => json(401, {})),
        )
      ).kind,
    ).toBe("unauthorized");
    expect(
      (
        await fetchTaskEvents(
          ID,
          {},
          f(() => json(404, {})),
        )
      ).kind,
    ).toBe("not_found");
    expect(
      (
        await fetchTaskEvents(
          ID,
          {},
          f(() => json(503, {})),
        )
      ).kind,
    ).toBe("error");
    expect(
      (
        await fetchTaskEvents(
          ID,
          {},
          f(() => json(200, { events: "x" })),
        )
      ).kind,
    ).toBe("error");
  });
});
