import { vi } from "vitest";
import type { BrowseDeps } from "../../src/browse";

export const REQ = "https://docs.example.com/guide";
export const reqUrl = () => new URL(REQ);

export function envelope(meta: Record<string, unknown> = {}, over: Record<string, unknown> = {}) {
  return {
    success: true,
    result: "# Guide\n\nbody",
    meta: {
      status: 200,
      title: "Guide",
      headers: { "content-type": "text/html" },
      finalUrl: REQ,
      ...meta,
    },
    ...over,
  };
}

export function fakeBrowser(respond: (opts: unknown) => Response | Promise<Response>) {
  const calls: { action: string; opts: unknown }[] = [];
  const quickAction = vi.fn(async (action: string, opts: unknown) => {
    calls.push({ action, opts });
    return respond(opts);
  });
  return { browser: { quickAction } as unknown as BrowseDeps["browser"], calls, quickAction };
}

/** DoH と robots.txt に答える fake fetch。dns: ホスト → 答える IP の一覧（A）。 */
export function fakeFetch(
  opts: { dns?: (host: string) => Response | Promise<Response>; robots?: string } = {},
) {
  const urls: string[] = [];
  const f = vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    urls.push(url);
    const u = new URL(url);
    if (u.hostname === "cloudflare-dns.com") {
      const host = u.searchParams.get("name") ?? "";
      const type = u.searchParams.get("type");
      if (opts.dns) return opts.dns(`${host}|${type}`);
      return Response.json({
        Status: 0,
        Answer: type === "A" ? [{ name: host, type: 1, data: "93.184.216.34" }] : [],
      });
    }
    if (u.pathname === "/robots.txt") {
      return opts.robots === undefined
        ? new Response("not found", { status: 404 })
        : new Response(opts.robots, { status: 200 });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;
  return { fetch: f, urls };
}
