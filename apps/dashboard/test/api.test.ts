import { overviewFixture } from "@rovo/dashboard-contract/fixtures";
import { describe, expect, it, vi } from "vitest";
import { fetchOverview, localDayRange, overviewUrl } from "../src/api";
import { loadAutoRefresh, saveAutoRefresh } from "../src/prefs";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("localDayRange（D18: ブラウザのローカル日の 0 時〜いま）", () => {
  it("from はローカルの 0 時、to はいま", () => {
    const now = new Date(2026, 9, 21, 15, 40, 12).getTime();
    expect(localDayRange(now)).toEqual({
      from: new Date(2026, 9, 21, 0, 0, 0, 0).getTime(),
      to: now,
    });
  });
});

describe("overviewUrl / fetchOverview", () => {
  it("同一オリジンの /dashboard/api/overview に from・to（epoch ms）と scope を付ける", () => {
    expect(overviewUrl({ from: 1000, to: 2000 }, "all")).toBe(
      "/dashboard/api/overview?from=1000&to=2000&scope=all",
    );
    expect(overviewUrl({ from: 1000, to: 2000 }, "me")).toBe(
      "/dashboard/api/overview?from=1000&to=2000&scope=me",
    );
  });

  it("200 なら ok。Cookie を送る（same-origin）", async () => {
    const f = vi.fn(async () => json(200, overviewFixture));
    const r = await fetchOverview({ from: 1, to: 2 }, "all", f as unknown as typeof fetch);
    expect(r).toEqual({ kind: "ok", data: overviewFixture });
    const [, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.credentials).toBe("same-origin");
  });

  it("401 は unauthorized、404 は not_found、それ以外・通信失敗・壊れた本文は error", async () => {
    const run = (f: () => Promise<Response>) =>
      fetchOverview({ from: 1, to: 2 }, "all", f as unknown as typeof fetch);
    expect(await run(async () => json(401, { error: "unauthorized" }))).toEqual({
      kind: "unauthorized",
    });
    expect(await run(async () => json(404, { error: "not_found" }))).toEqual({ kind: "not_found" });
    expect(await run(async () => json(503, { error: "unavailable" }))).toEqual({ kind: "error" });
    expect(await run(async () => json(400, { error: "bad_request" }))).toEqual({ kind: "error" });
    expect(
      await run(async () => {
        throw new TypeError("network");
      }),
    ).toEqual({ kind: "error" });
    expect(await run(async () => new Response("nope", { status: 200 }))).toEqual({ kind: "error" });
    expect(await run(async () => json(200, { tasks: "x" }))).toEqual({ kind: "error" });
  });
});

describe("自動更新の設定（localStorage。無くても動く）", () => {
  const mem = () => {
    const m = new Map<string, string>();
    return {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v),
    };
  };

  it("既定は入。保存した値を読む", () => {
    const s = mem();
    expect(loadAutoRefresh(s)).toBe(true);
    saveAutoRefresh(false, s);
    expect(loadAutoRefresh(s)).toBe(false);
    saveAutoRefresh(true, s);
    expect(loadAutoRefresh(s)).toBe(true);
  });

  it("storage が例外を投げても（プライベートモードなど）既定の入で動く", () => {
    const broken = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    expect(loadAutoRefresh(broken)).toBe(true);
    expect(() => saveAutoRefresh(false, broken)).not.toThrow();
    expect(loadAutoRefresh(undefined)).toBe(true);
  });
});
