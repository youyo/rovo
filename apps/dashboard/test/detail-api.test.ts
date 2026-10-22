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
