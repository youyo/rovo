import {
  cloudflareSummaryWithEstimateFixture,
  overviewFixture,
} from "@rovo/dashboard-contract/fixtures";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/app";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const period = { start: "2026-10-21T00:00:00Z", end: "2026-10-22T00:00:00Z" };
const cfBody = {
  generated_at: "2026-10-22T00:00:00Z",
  open_url: null,
  range: "24h",
  workers: { ok: false, reason: "forbidden" },
  containers: { ok: false, reason: "forbidden" },
  ai_gateway: {
    ok: true,
    value: { period, requests: 316, cached_requests: 0, errors: 18, cost_usd: 3 },
  },
  workers_ai: { ok: false, reason: "forbidden" },
  credit_balance: { ok: true, value: { balance_usd: 954.63 } },
};

type Cf = () => Response | Promise<Response>;
function router(cf: Cf) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname === "/dashboard/api/me") return json(200, { login: "alice-example" });
    if (url.pathname === "/dashboard/api/overview")
      return json(200, { ...overviewFixture, scope: "me" });
    if (url.pathname === "/dashboard/api/cloudflare") return cf();
    return json(404, { error: "not_found" });
  });
}
const cfCalls = (f: ReturnType<typeof router>) =>
  f.mock.calls
    .map((c) => new URL(String(c[0]), "http://localhost"))
    .filter((u) => u.pathname === "/dashboard/api/cloudflare");

const roots: { unmount: () => void }[] = [];
beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  });
});
afterEach(() => {
  for (const r of roots.splice(0)) act(() => r.unmount());
  vi.unstubAllGlobals();
  vi.useRealTimers();
  document.body.innerHTML = "";
});
async function mount(f: ReturnType<typeof router>) {
  vi.stubGlobal("fetch", f);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(createElement(App));
  });
  return { container, root };
}
const panel = (c: HTMLElement) => c.querySelector("[data-cloudflare]") as HTMLElement;

describe("Cloudflare の枠", () => {
  it("見出しに直近 24 時間、項目と値、理由ごとの言葉、開くリンクを出す", async () => {
    const f = router(() => json(200, cfBody));
    const { container } = await mount(f);
    const p = panel(container);
    expect(p.querySelector("h2")?.textContent).toBe("Cloudflare");
    expect(p.textContent).toContain("直近 24 時間");
    expect(p.textContent).toContain("316 件、エラー 18 件、費用 $3.00");
    expect(p.textContent).toContain("$954.63");
    expect(p.textContent).toContain("取得できない（トークンの権限を確認）");
    expect(cfCalls(f)[0]?.searchParams.get("range")).toBe("24h");
    const links = [...p.querySelectorAll("a")];
    expect(links).toHaveLength(5);
    for (const a of links) {
      expect(a.getAttribute("href")).toBe("https://dash.cloudflare.com/");
      expect(a.getAttribute("rel")).toBe("noopener noreferrer");
      expect(a.getAttribute("target")).toBe("_blank");
    }
  });

  it("API が失敗（500・通信失敗・壊れた応答）でも一覧は出る", async () => {
    for (const cf of [
      () => json(500, { error: "x" }),
      () => {
        throw new Error("network");
      },
      () => json(200, { nope: 1 }),
    ] as Cf[]) {
      const { container, root } = await mount(router(cf));
      expect(container.querySelector("[data-lane]")).not.toBeNull();
      expect(container.querySelector("[data-budget='month']")).not.toBeNull();
      expect(panel(container).textContent).toContain("取得できませんでした");
      act(() => root.unmount());
      document.body.innerHTML = "";
    }
  });

  it("401 は一覧と同じくログインし直しの表示へ", async () => {
    const { container } = await mount(router(() => json(401, { error: "unauthorized" })));
    const link = [...container.querySelectorAll("a")].find((a) =>
      a.textContent?.includes("GitHub でログイン"),
    );
    expect(link?.getAttribute("href")).toBe("/dashboard/auth/login");
  });

  it("60 秒ごとに取り直す（5 秒では取り直さない）", async () => {
    vi.useFakeTimers();
    const f = router(() => json(200, cfBody));
    await mount(f);
    expect(cfCalls(f)).toHaveLength(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(cfCalls(f)).toHaveLength(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(55_000);
    });
    expect(cfCalls(f)).toHaveLength(2);
  });
});

describe("Cloudflare の推定の金額", () => {
  it("欄の頭に合計と注記、各行に金額を出す", async () => {
    const f = router(() => json(200, cloudflareSummaryWithEstimateFixture));
    const { container } = await mount(f);
    const p = panel(container);
    const head = p.querySelector("[data-cf-total]");
    expect(head?.textContent).toContain("推定 $1.34（無料枠を引く前）");
    expect(head?.textContent).toContain("一部の項目は含まない");
    expect(p.querySelector("[data-cf='ai_gateway'] .cf-cost")?.textContent).toBe("推定 $1.25");
    expect(p.querySelector("[data-cf='containers'] .cf-cost")?.textContent).toBe("推定 $0.0806");
    expect(p.querySelector("[data-cf='credit_balance'] .cf-cost")).toBeNull();
  });

  it("cost_estimate が無いときは合計を出さず、件数だけで壊れない", async () => {
    const f = router(() => json(200, cfBody));
    const { container } = await mount(f);
    const p = panel(container);
    expect(p.querySelector("[data-cf-total]")).toBeNull();
    expect(p.querySelectorAll(".cf-cost")).toHaveLength(0);
    expect(p.textContent).toContain("316 件、エラー 18 件、費用 $3.00");
  });
});
