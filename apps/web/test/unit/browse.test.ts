import { describe, expect, it } from "vitest";
import {
  BROWSE_LIMITS,
  type BrowseDeps,
  type BrowseOutcome,
  browsePage,
  buildQuickActionOptions,
  interpretEnvelope,
} from "../../src/browse";
import { checkResolution } from "../../src/dns-check";
import { envelope, fakeBrowser, fakeFetch, REQ, reqUrl } from "./browse-helpers";

function kind(o: BrowseOutcome): string {
  return o.kind === "blocked"
    ? `blocked:${o.reason}`
    : o.kind === "unknown"
      ? `unknown:${o.reason}`
      : o.kind;
}

describe("interpretEnvelope: 通常成功", () => {
  it("status 2xx・finalUrl 同一・chain なし → page", () => {
    const o = interpretEnvelope(reqUrl(), envelope());
    expect(o).toMatchObject({ kind: "page", finalUrl: REQ, markdown: "# Guide\n\nbody" });
    expect(o.kind === "page" && o.title).toBe("Guide");
  });

  it("redirectChain が [] でも、finalUrl が同一なら page", () => {
    expect(kind(interpretEnvelope(reqUrl(), envelope({ redirectChain: [] })))).toBe("page");
  });

  it("title が文字列でなければ title なしの page（title は返さない側へ倒れる）", () => {
    const o = interpretEnvelope(reqUrl(), envelope({ title: 123 }));
    expect(o.kind).toBe("page");
    expect(o.kind === "page" && o.title).toBeUndefined();
  });

  it("result が空文字でも page（空のページ）", () => {
    expect(kind(interpretEnvelope(reqUrl(), envelope({}, { result: "" })))).toBe("page");
  });
});

describe("interpretEnvelope: meta.status", () => {
  it.each([
    ["欠落", undefined],
    ["null", null],
    ["文字列", "200"],
    ["0", 0],
    ["99", 99],
    ["600", 600],
    ["小数", 200.5],
    ["NaN", Number.NaN],
    ["3xx", 301],
    ["1xx", 101],
  ])("異常値（%s）は unknown(invalid_status)", (_n, status) => {
    const meta = envelope().meta as Record<string, unknown>;
    const e = { ...envelope(), meta: { ...meta, status } };
    if (status === undefined) delete (e.meta as Record<string, unknown>).status;
    expect(kind(interpretEnvelope(reqUrl(), e))).toBe("unknown:invalid_status");
  });

  it("meta が無い・オブジェクトでない → unknown(invalid_status)", () => {
    expect(kind(interpretEnvelope(reqUrl(), { success: true, result: "x" }))).toBe(
      "unknown:invalid_status",
    );
    expect(kind(interpretEnvelope(reqUrl(), { success: true, result: "x", meta: "oops" }))).toBe(
      "unknown:invalid_status",
    );
    expect(kind(interpretEnvelope(reqUrl(), null))).toBe("unknown:invalid_status");
  });

  it.each([400, 403, 404, 429, 500, 503])("%i は http_error（httpStatus を持つ）", (status) => {
    const o = interpretEnvelope(reqUrl(), envelope({ status }));
    expect(o).toEqual({ kind: "http_error", httpStatus: status });
  });
});

describe("interpretEnvelope: cf-mitigated", () => {
  it.each([
    ["小文字", { "cf-mitigated": "challenge" }],
    ["ヘッダー名の大小", { "CF-Mitigated": "challenge" }],
    ["値の大小", { "cf-mitigated": "CHALLENGE" }],
    ["カンマ区切り", { "cf-mitigated": "foo, CHALLENGE" }],
    ["余白", { "cf-mitigated": "  challenge \t" }],
  ])("%s → blocked(bot_challenge)", (_n, headers) => {
    expect(kind(interpretEnvelope(reqUrl(), envelope({ status: 403, headers })))).toBe(
      "blocked:bot_challenge",
    );
  });

  it.each([200, 503, 429])(
    "status %i でも challenge は blocked（agents/webfetch と同じ）",
    (status) => {
      expect(
        kind(
          interpretEnvelope(
            reqUrl(),
            envelope({ status, headers: { "cf-mitigated": "challenge" } }),
          ),
        ),
      ).toBe("blocked:bot_challenge");
    },
  );

  it("status が欠落していても challenge なら blocked", () => {
    const e = envelope({ headers: { "cf-mitigated": "challenge" } });
    delete (e.meta as Record<string, unknown>).status;
    expect(kind(interpretEnvelope(reqUrl(), e))).toBe("blocked:bot_challenge");
  });

  it.each([
    ["challenge を含まない値", { "cf-mitigated": "challenged" }],
    ["別の値", { "cf-mitigated": "block" }],
    ["ヘッダーなし", {}],
  ])("%s は challenge ではない（403 は http_error）", (_n, headers) => {
    expect(kind(interpretEnvelope(reqUrl(), envelope({ status: 403, headers })))).toBe(
      "http_error",
    );
  });

  it.each([null, "x", 5, []])("headers が %j でも落ちない", (headers) => {
    expect(kind(interpretEnvelope(reqUrl(), envelope({ status: 403, headers })))).toBe(
      "http_error",
    );
    expect(kind(interpretEnvelope(reqUrl(), envelope({ headers })))).toBe("page");
  });

  it("配列の値（複数ヘッダー）にも対応する", () => {
    expect(
      kind(
        interpretEnvelope(
          reqUrl(),
          envelope({ status: 403, headers: { "cf-mitigated": ["challenge"] } }),
        ),
      ),
    ).toBe("blocked:bot_challenge");
  });
});

describe("interpretEnvelope: finalUrl / redirectChain", () => {
  it.each([
    ["欠落", undefined],
    ["空文字", ""],
    ["空白のみ", "   "],
    ["数値", 42],
    ["null", null],
    ["オブジェクト", { href: REQ }],
    ["不正な URL", "not a url"],
  ])("finalUrl が %s → unknown(invalid_final_url)", (_n, finalUrl) => {
    const e = envelope({ finalUrl });
    if (finalUrl === undefined) delete (e.meta as Record<string, unknown>).finalUrl;
    expect(kind(interpretEnvelope(reqUrl(), e))).toBe("unknown:invalid_final_url");
  });

  it.each([
    ["null", null],
    ["オブジェクト", { 0: { url: REQ } }],
    ["文字列", "https://a.example.com/"],
    ["要素が文字列", ["https://a.example.com/"]],
    ["要素が null", [null]],
    ["url 欠落", [{ status: 302 }]],
    ["url が数値", [{ url: 1, status: 302 }]],
    ["url が空", [{ url: "", status: 302 }]],
    ["url が不正", [{ url: "::::", status: 302 }]],
  ])("redirectChain が %s → unknown(invalid_redirect_chain)", (_n, redirectChain) => {
    expect(kind(interpretEnvelope(reqUrl(), envelope({ redirectChain })))).toBe(
      "unknown:invalid_redirect_chain",
    );
  });

  it("result が文字列でない → unknown(invalid_result)", () => {
    for (const result of [undefined, null, 5, { a: 1 }, ["x"]]) {
      expect(kind(interpretEnvelope(reqUrl(), envelope({}, { result })))).toBe(
        "unknown:invalid_result",
      );
    }
  });

  it("chain の途中のホップだけが禁止 → blocked(redirect_policy)", () => {
    const o = interpretEnvelope(
      reqUrl(),
      envelope({
        finalUrl: "https://docs.example.com/other",
        redirectChain: [
          { url: REQ, status: 302 },
          { url: "http://169.254.169.254/latest/meta-data/", status: 302 },
          { url: "https://docs.example.com/hop", status: 302 },
        ],
      }),
    );
    expect(kind(o)).toBe("blocked:redirect_policy");
  });

  it("finalUrl が禁止（chain なし。meta refresh 想定）→ blocked、許可内なら page", () => {
    expect(
      kind(interpretEnvelope(reqUrl(), envelope({ finalUrl: "https://10.0.0.1/admin" }))),
    ).toBe("blocked:redirect_policy");
    const ok = interpretEnvelope(reqUrl(), envelope({ finalUrl: "https://other.example.com/x" }));
    expect(ok).toMatchObject({ kind: "page", finalUrl: "https://other.example.com/x" });
  });

  it("finalUrl のスキーム・ポート・userinfo の違反も blocked", () => {
    for (const finalUrl of [
      "file:///etc/passwd",
      "data:text/html,hi",
      "https://docs.example.com:8443/x",
      "https://user:pw@docs.example.com/x",
      "https://localhost/x",
    ]) {
      expect(kind(interpretEnvelope(reqUrl(), envelope({ finalUrl })))).toBe(
        "blocked:redirect_policy",
      );
    }
  });
});

describe("interpretEnvelope: URL の正規化と https→http のダウングレード", () => {
  it.each([
    ["既定ポート", "https://docs.example.com:443/guide"],
    ["fragment", "https://docs.example.com/guide#section"],
    ["ホストの大文字", "https://DOCS.example.com/guide"],
  ])("%s の違いは同一の URL（finalUrl は正規化後の href）", (_n, finalUrl) => {
    expect(interpretEnvelope(reqUrl(), envelope({ finalUrl }))).toMatchObject({
      kind: "page",
      finalUrl: REQ,
    });
  });

  it.each([
    ["別 path", "https://docs.example.com/other"],
    ["別 query", "https://docs.example.com/guide?x=1"],
    ["末尾 slash", "https://docs.example.com/guide/"],
    ["percent encoding", "https://docs.example.com/%67uide"],
  ])("%s は別の URL（同一とはみなさず、finalUrl として検査して返す）", (_n, finalUrl) => {
    const o = interpretEnvelope(reqUrl(), envelope({ finalUrl }));
    expect(o.kind).toBe("page");
    expect(o.kind === "page" && o.finalUrl).not.toBe(REQ);
  });

  it("同一 host の別 path でも、禁止の host が混ざれば blocked（path で判断しない）", () => {
    const o = interpretEnvelope(
      reqUrl(),
      envelope({ redirectChain: [{ url: "https://127.0.0.1/guide" }], finalUrl: REQ }),
    );
    expect(kind(o)).toBe("blocked:redirect_policy");
  });

  it("https→http は blocked（最終 URL）", () => {
    expect(
      kind(interpretEnvelope(reqUrl(), envelope({ finalUrl: "http://docs.example.com/guide" }))),
    ).toBe("blocked:redirect_policy");
  });

  it("https→http は blocked（途中のホップ。最終は https に戻っていても）", () => {
    const o = interpretEnvelope(
      reqUrl(),
      envelope({
        finalUrl: "https://docs.example.com/guide",
        redirectChain: [{ url: REQ }, { url: "http://docs.example.com/guide" }],
      }),
    );
    expect(kind(o)).toBe("blocked:redirect_policy");
  });

  it("http で要求し https に上がるのは許可（アップグレード）", () => {
    const o = interpretEnvelope(
      new URL("http://docs.example.com/guide"),
      envelope({
        finalUrl: "https://docs.example.com/guide",
        redirectChain: [{ url: "http://docs.example.com/guide" }],
      }),
    );
    expect(o.kind).toBe("page");
  });
});

describe("buildQuickActionOptions", () => {
  it("url / browser:kitesurf / 固定の gotoOptions / サブリソースの補助だけ", () => {
    const o = buildQuickActionOptions(new URL("https://docs.example.com/guide?a=1#x"));
    expect(o).toEqual({
      browser: "kitesurf",
      url: "https://docs.example.com/guide?a=1",
      gotoOptions: { timeout: 30_000 },
      allowRequestPattern: ["^https?://docs\\.example\\.com(:443|:80)?/"],
      rejectResourceTypes: ["image", "media", "font"],
    });
    expect("html" in o).toBe(false);
  });

  it("ホストの正規表現の特殊文字をエスケープする", () => {
    const o = buildQuickActionOptions(new URL("https://a-b.c.example.com/"));
    expect(o.allowRequestPattern?.[0]).toBe("^https?://a-b\\.c\\.example\\.com(:443|:80)?/");
  });
});

// ---- browsePage（BROWSER・fetch は fake）----

const okResponse = (e: unknown = envelope()) => Response.json(e);

function deps(over: Partial<BrowseDeps> & { browser: BrowseDeps["browser"] }): BrowseDeps {
  return { fetch: fakeFetch().fetch, robotsCache: new Map(), ...over };
}

describe("browsePage: 通常の流れ", () => {
  it("DoH → robots.txt → quickAction の順で、markdown を取得する", async () => {
    const b = fakeBrowser(() => okResponse());
    const f = fakeFetch();
    const o = await browsePage({ url: REQ }, deps({ browser: b.browser, fetch: f.fetch }));
    expect(o.kind).toBe("page");
    expect(b.calls).toHaveLength(1);
    expect(b.calls[0]?.action).toBe("markdown");
    expect(f.urls[0]).toContain("cloudflare-dns.com/dns-query");
    expect(f.urls.some((u) => u.endsWith("/robots.txt"))).toBe(true);
  });

  it("checkUrl が禁止なら quickAction を呼ばない（invalid_url）", async () => {
    const b = fakeBrowser(() => okResponse());
    const f = fakeFetch();
    for (const url of [
      "http://169.254.169.254/",
      "https://localhost/",
      "file:///etc/passwd",
      "https://x.example.com:8443/",
      "not a url",
    ]) {
      await expect(
        browsePage({ url }, deps({ browser: b.browser, fetch: f.fetch })),
      ).rejects.toMatchObject({ code: "invalid_url" });
    }
    expect(b.quickAction).not.toHaveBeenCalled();
    expect(f.urls).toEqual([]);
  });

  it("robots.txt が Disallow なら quickAction を呼ばない（blocked: robots_disallowed）", async () => {
    const b = fakeBrowser(() => okResponse());
    const f = fakeFetch({ robots: "User-agent: *\nDisallow: /guide\n" });
    const o = await browsePage({ url: REQ }, deps({ browser: b.browser, fetch: f.fetch }));
    expect(kind(o)).toBe("blocked:robots_disallowed");
    expect(b.quickAction).not.toHaveBeenCalled();
  });
});

describe("browsePage: DoH の事前検査（補助。失敗は fail-closed）", () => {
  const dnsAnswers =
    (a: string[], aaaa: string[] = []) =>
    (key: string) => {
      const type = key.split("|")[1];
      const list = type === "A" ? a : aaaa;
      return Response.json({
        Status: 0,
        Answer: list.map((data) => ({ name: "x", type: type === "A" ? 1 : 28, data })),
      });
    };

  it.each([
    ["private (10/8)", dnsAnswers(["10.1.2.3"])],
    ["link-local", dnsAnswers(["169.254.169.254"])],
    ["loopback", dnsAnswers(["127.0.0.1"])],
    ["公開と private が混在", dnsAnswers(["93.184.216.34", "192.168.0.1"])],
    ["IPv6 の loopback", dnsAnswers(["93.184.216.34"], ["::1"])],
    ["IPv6 に埋めた private の IPv4", dnsAnswers(["93.184.216.34"], ["::ffff:10.0.0.1"])],
  ])("%s に解決される → blocked(private_address)。quickAction は呼ばない", async (_n, dns) => {
    const b = fakeBrowser(() => okResponse());
    const f = fakeFetch({ dns });
    const o = await browsePage({ url: REQ }, deps({ browser: b.browser, fetch: f.fetch }));
    expect(kind(o)).toBe("blocked:private_address");
    expect(b.quickAction).not.toHaveBeenCalled();
    expect(f.urls.some((u) => u.endsWith("/robots.txt"))).toBe(false);
  });

  it.each([
    ["ネットワークエラー", () => Promise.reject(new Error("network down"))],
    ["HTTP 500", () => new Response("oops", { status: 500 })],
    ["不正な JSON", () => new Response("not json", { status: 200 })],
    ["Status が SERVFAIL(2)", () => Response.json({ Status: 2 })],
    ["NXDOMAIN(3)", () => Response.json({ Status: 3 })],
    ["オブジェクトでない", () => Response.json([1, 2])],
    ["Answer が配列でない", () => Response.json({ Status: 0, Answer: "x" })],
  ])("DoH が失敗（%s）→ unknown(dns_check_failed)。quickAction は呼ばない", async (_n, dns) => {
    const b = fakeBrowser(() => okResponse());
    const f = fakeFetch({ dns });
    const o = await browsePage({ url: REQ }, deps({ browser: b.browser, fetch: f.fetch }));
    expect(kind(o)).toBe("unknown:dns_check_failed");
    expect(b.quickAction).not.toHaveBeenCalled();
  });

  it("A が成功しても AAAA が失敗したら unknown（検査できていない）", async () => {
    const b = fakeBrowser(() => okResponse());
    const f = fakeFetch({
      dns: (key) =>
        key.endsWith("|AAAA")
          ? new Response("oops", { status: 502 })
          : dnsAnswers(["93.184.216.34"])(key),
    });
    const o = await browsePage({ url: REQ }, deps({ browser: b.browser, fetch: f.fetch }));
    expect(kind(o)).toBe("unknown:dns_check_failed");
  });

  it("IP リテラルの URL は DoH を使わない（checkUrl が判定済み）", async () => {
    const b = fakeBrowser(() => okResponse(envelope({ finalUrl: "https://93.184.216.34/" })));
    const f = fakeFetch();
    const o = await browsePage(
      { url: "https://93.184.216.34/" },
      deps({ browser: b.browser, fetch: f.fetch }),
    );
    expect(o.kind).toBe("page");
    expect(f.urls.some((u) => u.includes("cloudflare-dns.com"))).toBe(false);
  });

  it("checkResolution: 公開のアドレスだけなら public", async () => {
    expect(await checkResolution("docs.example.com", fakeFetch().fetch)).toBe("public");
  });
});

describe("browsePage: quickAction の失敗の写像（固定コード。生のメッセージは出さない）", () => {
  const SECRET = "UPSTREAM-SECRET-MESSAGE";
  const err = (status: number, code: number | string = "x") =>
    Response.json({ success: false, errors: [{ code, message: SECRET }] }, { status });

  it.each([
    [400, "invalid_input", err(400, "invalid_value")],
    [422, "navigation_timeout", err(422, 6002)],
    [422, "upstream_error（6002 以外）", err(422, 7000)],
    [429, "upstream_error", err(429)],
    [500, "upstream_error", err(500)],
  ])("HTTP %i → %s", async (_s, code, res) => {
    const expected = code.split("（")[0];
    const b = fakeBrowser(() => res.clone());
    await expect(browsePage({ url: REQ }, deps({ browser: b.browser }))).rejects.toSatisfy(
      (e: Error) => (e as { code?: string }).code === expected && !e.message.includes(SECRET),
    );
  });

  it("外側 HTTP 非 2xx なのに success:true → upstream_error（本文は使わない）", async () => {
    const b = fakeBrowser(() => Response.json(envelope(), { status: 502 }));
    await expect(browsePage({ url: REQ }, deps({ browser: b.browser }))).rejects.toMatchObject({
      code: "upstream_error",
    });
  });

  it("外側 2xx なのに success:false / success 欠落 → upstream_error", async () => {
    for (const body of [
      { success: false, errors: [{ message: SECRET }] },
      { result: "x", meta: {} },
    ]) {
      const b = fakeBrowser(() => Response.json(body));
      const r = browsePage({ url: REQ }, deps({ browser: b.browser }));
      await expect(r).rejects.toMatchObject({ code: "upstream_error" });
      await expect(r).rejects.toSatisfy((e: Error) => !e.message.includes(SECRET));
    }
  });

  it("JSON が壊れている・オブジェクトでない → upstream_error", async () => {
    for (const text of ["not json{", "[1,2]", "null", '"str"', ""]) {
      const b = fakeBrowser(() => new Response(text, { status: 200 }));
      await expect(browsePage({ url: REQ }, deps({ browser: b.browser }))).rejects.toMatchObject({
        code: "upstream_error",
      });
    }
  });

  it("quickAction が throw → upstream_error（メッセージは出さない）", async () => {
    const b = fakeBrowser(() => {
      throw new Error(SECRET);
    });
    await expect(browsePage({ url: REQ }, deps({ browser: b.browser }))).rejects.toSatisfy(
      (e: Error) =>
        (e as { code?: string }).code === "upstream_error" && !e.message.includes(SECRET),
    );
  });

  it("期限を超えたら timeout", async () => {
    const b = fakeBrowser(() => new Promise<Response>(() => {}));
    await expect(
      browsePage({ url: REQ }, deps({ browser: b.browser, deadlineMs: 20 })),
    ).rejects.toMatchObject({ code: "timeout" });
  });
});

describe("browsePage: Response のバイト上限", () => {
  it("上限を超えたら too_large。上限を大きく超えて読まない", async () => {
    let pulled = 0;
    const chunk = new Uint8Array(1024).fill(97);
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += chunk.byteLength;
        controller.enqueue(chunk);
      },
    });
    const b = fakeBrowser(() => new Response(body, { status: 200 }));
    await expect(
      browsePage({ url: REQ }, deps({ browser: b.browser, maxResponseBytes: 10 * 1024 })),
    ).rejects.toMatchObject({ code: "too_large" });
    // 上限 + 数チャンクの範囲で止まる（無限のストリームを読み続けない）
    expect(pulled).toBeLessThanOrEqual(10 * 1024 + 64 * 1024);
  });

  it("Content-Length が上限を超えていれば、読む前に too_large", async () => {
    const b = fakeBrowser(
      () =>
        new Response("{}", {
          status: 200,
          headers: { "content-length": String(50 * 1024 * 1024) },
        }),
    );
    await expect(browsePage({ url: REQ }, deps({ browser: b.browser }))).rejects.toMatchObject({
      code: "too_large",
    });
  });

  it("既定の上限は web_fetch と同じ 2 MiB", () => {
    expect(BROWSE_LIMITS.maxResponseBytes).toBe(2 * 1024 * 1024);
    expect(BROWSE_LIMITS.deadlineMs).toBe(45_000);
  });
});
