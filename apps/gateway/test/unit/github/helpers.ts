import { vi } from "vitest";

export type Handler = (req: Request) => Response | Promise<Response>;

export function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

/** "METHOD /path" -> handler のルーターから fetch スタブを作る。呼び出し履歴は calls に残る。 */
export function routerFetch(routes: Record<string, Handler | Handler[]>) {
  const calls: Request[] = [];
  const counters = new Map<string, number>();
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    calls.push(req);
    const url = new URL(req.url);
    const key = `${req.method} ${url.pathname}`;
    const entry = routes[key];
    if (!entry) return new Response(`no route: ${key}`, { status: 599 });
    if (Array.isArray(entry)) {
      const i = counters.get(key) ?? 0;
      counters.set(key, i + 1);
      const h = entry[Math.min(i, entry.length - 1)];
      if (!h) throw new Error("empty handler list");
      return h(req);
    }
    return entry(req);
  });
  return { fetch: fn as unknown as typeof fetch, calls, fn };
}

export function tokenResponse(over: Record<string, unknown> = {}): Response {
  return json({
    access_token: "ghu_new",
    token_type: "bearer",
    expires_in: 28800,
    refresh_token: "ghr_new",
    refresh_token_expires_in: 15811200,
    ...over,
  });
}
