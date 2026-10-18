import { describe, expect, it, vi } from "vitest";
import { type FetchProxyDeps, fetchPage } from "../../src/fetch-proxy";

type FakeResponder = (url: string, init?: RequestInit) => Response | Promise<Response>;

function setup(responder: FakeResponder, over: Partial<FetchProxyDeps> = {}) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fakeFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });
    if (url.endsWith("/robots.txt")) {
      const r = await responder(url, init);
      return r;
    }
    return responder(url, init);
  }) as unknown as typeof fetch;
  const ai = {
    toMarkdown: vi.fn(async (f: { name: string; blob: Blob }) => ({
      name: f.name,
      mimeType: "text/markdown",
      format: "markdown",
      tokens: 1,
      data: `# converted\n\n${await f.blob.text()}`,
    })),
  } as unknown as Ai;
  const deps: FetchProxyDeps = { fetch: fakeFetch, ai, robotsCache: new Map(), ...over };
  return { deps, calls, fakeFetch, ai };
}

const md = (body: string, headers: Record<string, string> = {}) =>
  new Response(body, { status: 200, headers: { "content-type": "text/markdown", ...headers } });
const ROBOTS_OK = () => new Response("User-agent: *\nAllow: /\n", { status: 200 });
const redirect = (to: string, status = 302) =>
  new Response(null, { status, headers: { location: to } });

function router(routes: Record<string, () => Response>): FakeResponder {
  return (url) => {
    const h = routes[url];
    if (h) return h();
    if (url.endsWith("/robots.txt")) return ROBOTS_OK();
    return new Response("not found", { status: 404, headers: { "content-type": "text/plain" } });
  };
}

describe("fetchPage: 正常系", () => {
  it("Markdown のページを取得し、本文と取得元・via を返す", async () => {
    const { deps } = setup(router({ "https://example.com/doc": () => md("# Title\n\nbody") }));
    const r = await fetchPage({ url: "https://example.com/doc" }, deps);
    expect(r.kind).toBe("page");
    if (r.kind !== "page") return;
    expect(r.finalUrl).toBe("https://example.com/doc");
    expect(r.via).toBe("markdown-negotiated");
    expect(r.content).toContain("body");
    expect(r.title).toBe("Title");
  });

  it("HTML は AI.toMarkdown で変換する", async () => {
    const { deps, ai } = setup(
      router({
        "https://example.com/": () =>
          new Response("<html><title>t</title><body>hi</body></html>", {
            headers: { "content-type": "text/html; charset=utf-8" },
          }),
      }),
    );
    const r = await fetchPage({ url: "https://example.com/" }, deps);
    expect(r.kind).toBe("page");
    expect((ai.toMarkdown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  it("rovo 固有の User-Agent で取得する（資格情報・Cookie は付けない）", async () => {
    const { deps, calls } = setup(router({ "https://example.com/doc": () => md("x") }));
    await fetchPage({ url: "https://example.com/doc" }, deps);
    for (const c of calls) {
      const h = new Headers(c.init?.headers);
      expect(h.get("user-agent")).toMatch(/^rovo-web\/\d/);
      expect(h.get("cookie")).toBeNull();
      expect(h.get("authorization")).toBeNull();
    }
  });
});

describe("fetchPage: URL の検査", () => {
  it.each([
    "http://169.254.169.254/latest/meta-data/",
    "http://localhost/",
    "https://user:pw@example.com/",
    "https://example.com:8443/",
    "ftp://example.com/",
    "http://2130706433/",
    "http://printer.local/",
  ])("取得の前に拒否し、fetch は一度も呼ばない: %s", async (url) => {
    const { deps, fakeFetch } = setup(router({}));
    await expect(fetchPage({ url }, deps)).rejects.toMatchObject({ code: "invalid_url" });
    expect(fakeFetch).not.toHaveBeenCalled();
  });
});

describe("fetchPage: redirect の行き先ごとの検査", () => {
  it("公開 → 公開の redirect は辿る", async () => {
    const { deps } = setup(
      router({
        "https://a.example.com/": () => redirect("https://b.example.com/x"),
        "https://b.example.com/x": () => md("landed"),
      }),
    );
    const r = await fetchPage({ url: "https://a.example.com/" }, deps);
    expect(r.kind).toBe("page");
    if (r.kind === "page") expect(r.finalUrl).toBe("https://b.example.com/x");
  });

  it.each([
    "http://169.254.169.254/latest/meta-data/",
    "https://localhost/",
    "https://10.0.0.5/",
    "https://[::ffff:127.0.0.1]/",
    "https://2130706433/",
    "https://user:pw@evil.example.com/", // userinfo
    "https://evil.example.com:8443/", // ポート
    "https://printer.local/", // .local（webfetch の既定にはない。自前の検査で拒否する）
  ])(
    "redirect の行き先が許可外なら blocked（redirect_policy）で、行き先は取得しない: %s",
    async (target) => {
      const { deps, calls } = setup(
        router({ "https://example.com/": () => redirect(target, 301) }),
      );
      const r = await fetchPage({ url: "https://example.com/" }, deps);
      expect(r.kind).toBe("blocked");
      if (r.kind === "blocked") expect(r.reason).toBe("redirect_policy");
      expect(calls.some((c) => c.url === target)).toBe(false);
    },
  );

  it("https から http へのダウングレードは blocked", async () => {
    const { deps } = setup(
      router({
        "https://example.com/": () => redirect("http://example.org/x"),
        "http://example.org/x": () => md("plain"),
      }),
    );
    const r = await fetchPage({ url: "https://example.com/" }, deps);
    expect(r.kind).toBe("blocked");
  });

  it("redirect は5回まで。6回目は too_many_redirects のエラー", async () => {
    const chain = (n: number) =>
      router(
        Object.fromEntries(
          Array.from({ length: n }, (_, i) => [
            `https://example.com/${i}`,
            () => (i === n - 1 ? md("end") : redirect(`https://example.com/${i + 1}`)),
          ]),
        ),
      );
    const ok = setup(chain(6)); // 0 → 1 → ... → 5（redirect 5回）
    const r = await fetchPage({ url: "https://example.com/0" }, ok.deps);
    expect(r.kind).toBe("page");

    const ng = setup(chain(7)); // redirect 6回
    await expect(fetchPage({ url: "https://example.com/0" }, ng.deps)).rejects.toMatchObject({
      code: "too_many_redirects",
    });
  });
});

describe("fetchPage: robots.txt", () => {
  it("Disallow なら本文を取得せず blocked（robots_disallowed）", async () => {
    const { deps, calls } = setup((url) => {
      if (url.endsWith("/robots.txt")) return new Response("User-agent: *\nDisallow: /private\n");
      return md("secret");
    });
    const r = await fetchPage({ url: "https://example.com/private/page" }, deps);
    expect(r.kind).toBe("blocked");
    if (r.kind === "blocked") expect(r.reason).toBe("robots_disallowed");
    expect(calls.map((c) => c.url)).toEqual(["https://example.com/robots.txt"]);
  });

  it("rovo 固有の User-Agent の Disallow に従う", async () => {
    const { deps } = setup((url) => {
      if (url.endsWith("/robots.txt"))
        return new Response("User-agent: rovo-web\nDisallow: /\n\nUser-agent: *\nAllow: /\n");
      return md("x");
    });
    const r = await fetchPage({ url: "https://example.com/a" }, deps);
    expect(r.kind).toBe("blocked");
  });

  it("redirect の行き先のホストの robots.txt も確かめる", async () => {
    const { deps } = setup((url) => {
      if (url === "https://other.example.com/robots.txt")
        return new Response("User-agent: *\nDisallow: /\n");
      if (url.endsWith("/robots.txt")) return ROBOTS_OK();
      if (url === "https://example.com/go") return redirect("https://other.example.com/x");
      return md("x");
    });
    const r = await fetchPage({ url: "https://example.com/go" }, deps);
    expect(r.kind).toBe("blocked");
    if (r.kind === "blocked") expect(r.reason).toBe("robots_disallowed");
  });
});

describe("fetchPage: bot チャレンジ・上限", () => {
  it("cf-mitigated: challenge は blocked（bot_challenge）として返す", async () => {
    const { deps } = setup(
      router({
        "https://example.com/": () =>
          new Response("<html>Just a moment...</html>", {
            status: 403,
            headers: { "content-type": "text/html", "cf-mitigated": "challenge" },
          }),
      }),
    );
    const r = await fetchPage({ url: "https://example.com/" }, deps);
    expect(r.kind).toBe("blocked");
    if (r.kind === "blocked") expect(r.reason).toBe("bot_challenge");
  });

  it("本文が 2MB を超えたら too_large のエラー（content-length が嘘でもストリームで止める）", async () => {
    const big = "x".repeat(2 * 1024 * 1024 + 10);
    const { deps } = setup(
      router({
        "https://example.com/big": () =>
          new Response(big, { headers: { "content-type": "text/plain" } }),
      }),
    );
    await expect(fetchPage({ url: "https://example.com/big" }, deps)).rejects.toMatchObject({
      code: "too_large",
    });
    const ok = "x".repeat(2 * 1024 * 1024);
    const r = await fetchPage(
      { url: "https://example.com/ok" },
      setup(
        router({
          "https://example.com/ok": () =>
            new Response(ok, { headers: { "content-type": "text/plain" } }),
        }),
      ).deps,
    );
    expect(r.kind).toBe("page");
  });

  it("20 秒で timeout（時間は deps で縮められる）", async () => {
    const { deps } = setup(
      (url, init) => {
        if (url.endsWith("/robots.txt")) return ROBOTS_OK();
        return new Promise<Response>((_res, rej) => {
          init?.signal?.addEventListener("abort", () =>
            rej(init.signal?.reason ?? new Error("aborted")),
          );
        });
      },
      { timeoutMs: 50 },
    );
    await expect(fetchPage({ url: "https://example.com/slow" }, deps)).rejects.toMatchObject({
      code: "timeout",
    });
  });

  it("既定の上限は maxBytes 2MB・timeout 20 秒・redirect 5 回", async () => {
    const { FETCH_LIMITS } = await import("../../src/fetch-proxy");
    expect(FETCH_LIMITS).toEqual({ maxBytes: 2 * 1024 * 1024, timeoutMs: 20_000, maxRedirects: 5 });
  });
});
