import { waitingFixture } from "@rovo/dashboard-contract/fixtures";
import { describe, expect, it, vi } from "vitest";
import { fetchWaiting, waitingUrl } from "../src/api";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const stub = (r: Response | Error) =>
  vi.fn(async () => {
    if (r instanceof Error) throw r;
    return r;
  }) as unknown as typeof fetch;

describe("fetchWaiting（日付に関係なく待ちだけ）", () => {
  it("URL は scope だけ（期間を渡さない）", () => {
    expect(waitingUrl("me")).toBe("/dashboard/api/waiting?scope=me");
    expect(waitingUrl("all")).toBe("/dashboard/api/waiting?scope=all");
  });

  it("200 は ok。401 は unauthorized、404 は not_found、それ以外・壊れた本文・例外は error", async () => {
    expect(await fetchWaiting("all", stub(json(200, waitingFixture)))).toEqual({
      kind: "ok",
      data: waitingFixture,
    });
    expect((await fetchWaiting("all", stub(json(401, {})))).kind).toBe("unauthorized");
    expect((await fetchWaiting("all", stub(json(404, {})))).kind).toBe("not_found");
    expect((await fetchWaiting("all", stub(json(503, {})))).kind).toBe("error");
    expect((await fetchWaiting("all", stub(json(200, { tasks: "x" })))).kind).toBe("error");
    expect((await fetchWaiting("all", stub(new Error("net")))).kind).toBe("error");
  });
});
