import { describe, expect, it, vi } from "vitest";
import { createRobotsChecker, isPathAllowed, parseRobots, ROBOTS_TOKEN } from "../../src/robots";

describe("parseRobots / isPathAllowed", () => {
  it("rovo 固有のグループがあればそれを使い、* は使わない", () => {
    const rules = parseRobots(
      `User-agent: *\nDisallow: /\n\nUser-agent: ${ROBOTS_TOKEN}\nDisallow: /private\n`,
      ROBOTS_TOKEN,
    );
    expect(isPathAllowed(rules, "/public")).toBe(true);
    expect(isPathAllowed(rules, "/private/x")).toBe(false);
  });

  it("固有のグループがなければ * を使う", () => {
    const rules = parseRobots(
      "User-agent: *\nDisallow: /admin\nAllow: /admin/open\n",
      ROBOTS_TOKEN,
    );
    expect(isPathAllowed(rules, "/admin/secret")).toBe(false);
    expect(isPathAllowed(rules, "/admin/open/x")).toBe(true);
    expect(isPathAllowed(rules, "/")).toBe(true);
  });

  it("最も長く一致したルールが勝つ。同じ長さなら Allow", () => {
    const rules = parseRobots("User-agent: *\nDisallow: /a\nAllow: /a\n", ROBOTS_TOKEN);
    expect(isPathAllowed(rules, "/a/b")).toBe(true);
  });

  it("ワイルドカードと $ を扱う。空の Disallow は何も禁止しない", () => {
    const rules = parseRobots(
      "User-agent: *\nDisallow: /*.pdf$\nDisallow: /tmp*/x\n",
      ROBOTS_TOKEN,
    );
    expect(isPathAllowed(rules, "/a/b.pdf")).toBe(false);
    expect(isPathAllowed(rules, "/a/b.pdf?x=1")).toBe(true);
    expect(isPathAllowed(rules, "/tmp123/x")).toBe(false);
    expect(
      isPathAllowed(parseRobots("User-agent: *\nDisallow:\n", ROBOTS_TOKEN), "/anything"),
    ).toBe(true);
  });

  it("コメント・大文字小文字・複数の User-agent 行を扱う", () => {
    const rules = parseRobots(
      "# comment\nUSER-AGENT: foo\nuser-agent: Rovo-Web\nDISALLOW: /x # tail\n",
      ROBOTS_TOKEN,
    );
    expect(isPathAllowed(rules, "/x")).toBe(false);
  });

  it("ルールがなければすべて許可", () => {
    expect(isPathAllowed(parseRobots("", ROBOTS_TOKEN), "/x")).toBe(true);
  });
});

function res(status: number, body = "", headers: Record<string, string> = {}) {
  return new Response(body, { status, headers });
}

describe("createRobotsChecker", () => {
  const url = (s: string) => new URL(s);

  it("Disallow の URL は不許可、許可された URL は許可。origin ごとに1回だけ取得する", async () => {
    const f = vi.fn(async () => res(200, "User-agent: *\nDisallow: /secret\n"));
    const c = createRobotsChecker({ fetch: f as unknown as typeof fetch, cache: new Map() });
    expect((await c.check(url("https://example.com/secret/a"))).allowed).toBe(false);
    expect((await c.check(url("https://example.com/ok"))).allowed).toBe(true);
    expect(f).toHaveBeenCalledTimes(1);
    expect((f.mock.calls[0] as unknown[])[0]).toBe("https://example.com/robots.txt");
  });

  it("4xx（robots.txt なし）は許可", async () => {
    const c = createRobotsChecker({
      fetch: (async () => res(404)) as unknown as typeof fetch,
      cache: new Map(),
    });
    expect((await c.check(url("https://example.com/x"))).allowed).toBe(true);
  });

  it("5xx・ネットワークエラーは、取得できないものとして不許可（RFC 9309）", async () => {
    const c5 = createRobotsChecker({
      fetch: (async () => res(503)) as unknown as typeof fetch,
      cache: new Map(),
    });
    const r5 = await c5.check(url("https://example.com/x"));
    expect(r5.allowed).toBe(false);
    expect(r5.reason).toBe("robots_unreachable");
    const ce = createRobotsChecker({
      fetch: (async () => {
        throw new Error("net");
      }) as unknown as typeof fetch,
      cache: new Map(),
    });
    expect((await ce.check(url("https://example.com/x"))).allowed).toBe(false);
  });

  it("robots.txt 自体は常に取得できる（循環しない）", async () => {
    const f = vi.fn(async () => res(200, "User-agent: *\nDisallow: /\n"));
    const c = createRobotsChecker({ fetch: f as unknown as typeof fetch, cache: new Map() });
    expect((await c.check(url("https://example.com/robots.txt"))).allowed).toBe(true);
  });

  it("robots.txt の redirect を最大5回まで辿る。行き先は検査関数に通す", async () => {
    const seen: string[] = [];
    const f = vi.fn(async (u: string) => {
      seen.push(u);
      if (u === "https://example.com/robots.txt")
        return res(301, "", { location: "https://cdn.example.com/robots.txt" });
      return res(200, "User-agent: *\nDisallow: /nope\n");
    });
    const c = createRobotsChecker({
      fetch: f as unknown as typeof fetch,
      assertUrl: () => {},
      cache: new Map(),
    });
    expect((await c.check(url("https://example.com/nope"))).allowed).toBe(false);
    expect(seen).toEqual(["https://example.com/robots.txt", "https://cdn.example.com/robots.txt"]);

    const bad = createRobotsChecker({
      fetch: (async () =>
        res(302, "", { location: "http://169.254.169.254/robots.txt" })) as unknown as typeof fetch,
      cache: new Map(),
      assertUrl: (u) => {
        if (u.hostname === "169.254.169.254") throw new Error("forbidden");
      },
    });
    expect((await bad.check(url("https://example.com/x"))).allowed).toBe(false);
  });

  it("巨大な robots.txt は先頭 512KiB だけ読む", async () => {
    const big = `User-agent: *\nDisallow: /a\n${"#".repeat(2_000_000)}\nDisallow: /late\n`;
    const c = createRobotsChecker({
      fetch: (async () => res(200, big)) as unknown as typeof fetch,
      cache: new Map(),
    });
    expect((await c.check(url("https://example.com/a"))).allowed).toBe(false);
    expect((await c.check(url("https://example.com/late"))).allowed).toBe(true);
  });

  it("取得できたルールは 10 分キャッシュし、期限が切れたら取り直す。取得できなかった結果はキャッシュしない", async () => {
    let t = 0;
    const cache = new Map();
    const f = vi.fn(async () => res(200, "User-agent: *\nDisallow: /x\n"));
    const c = createRobotsChecker({ fetch: f as unknown as typeof fetch, cache, now: () => t });
    await c.check(url("https://example.com/a"));
    const c2 = createRobotsChecker({ fetch: f as unknown as typeof fetch, cache, now: () => t });
    t = 9 * 60 * 1000;
    await c2.check(url("https://example.com/b"));
    expect(f).toHaveBeenCalledTimes(1);
    t = 10 * 60 * 1000 + 1;
    await createRobotsChecker({ fetch: f as unknown as typeof fetch, cache, now: () => t }).check(
      url("https://example.com/c"),
    );
    expect(f).toHaveBeenCalledTimes(2);

    const bad = vi.fn(async () => res(503));
    const cache2 = new Map();
    await createRobotsChecker({ fetch: bad as unknown as typeof fetch, cache: cache2 }).check(
      url("https://example.org/a"),
    );
    await createRobotsChecker({ fetch: bad as unknown as typeof fetch, cache: cache2 }).check(
      url("https://example.org/a"),
    );
    expect(bad).toHaveBeenCalledTimes(2);
  });
});
