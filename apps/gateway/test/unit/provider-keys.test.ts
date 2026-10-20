import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { loadProviderKeys, PROVIDER_KEYS_FRESH_MS } from "../../src/provider-keys";

// 実 API は呼ばない。fetch は注入した偽物で、provider_configs の応答（List provider keys）の形を再現する。
// KV（OAUTH_KV）の中身はテストをまたいで残るので、テストごとに別の account / gateway の id を使う。

let seq = 0;
function setup(over: Record<string, unknown> = {}) {
  seq += 1;
  return {
    ...env,
    ENVIRONMENT: "production",
    CLOUDFLARE_API_TOKEN: "tok-secret-value-1234567890",
    CLOUDFLARE_ACCOUNT_ID: `acct${seq}`,
    AI_GATEWAY_ID: `gw${seq}`,
    ...over,
  } as unknown as Parameters<typeof loadProviderKeys>[0];
}

const item = (provider_slug: string, alias: string) => ({
  id: "x",
  alias,
  default_config: alias === "default",
  gateway_id: "g",
  modified_at: "2026-10-20T00:00:00Z",
  provider_slug,
  secret_id: "s",
  // 実 API では必ず返る。読まない・保持しない・ログに出さないことを確かめるための値
  secret_preview: "sk-ant-…SECRETPREVIEW",
});
const ok = (result: unknown[]) =>
  new Response(JSON.stringify({ success: true, result }), {
    headers: { "content-type": "application/json" },
  });

function fakeFetch(steps: (Response | "throw")[]) {
  const calls: { url: string; headers: Headers }[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), headers: new Headers(init?.headers) });
    const step = steps.shift() ?? new Response("exhausted", { status: 500 });
    if (step === "throw") throw new Error("network down sk-ant-LEAK");
    return step;
  }) as typeof fetch;
  return { fn, calls };
}

describe("loadProviderKeys: 応答の読み方", () => {
  it("alias が default のキーがある anthropic / openai だけを集める（default 以外の alias・他のプロバイダは数えない）", async () => {
    const f = fakeFetch([
      ok([
        item("anthropic", "default"),
        item("openai", "production"),
        item("workers-ai", "default"),
        item("groq", "default"),
      ]),
    ]);
    const keys = await loadProviderKeys(setup(), { fetch: f.fn });
    expect([...(keys ?? [])]).toEqual(["anthropic"]);
  });

  it("キーが 1 つも無ければ空の集合（判定できた）。判定できない（undefined）とは区別する", async () => {
    const f = fakeFetch([ok([])]);
    const keys = await loadProviderKeys(setup(), { fetch: f.fn });
    expect(keys).toBeDefined();
    expect(keys?.size).toBe(0);
  });

  it("List provider keys の URL に Bearer トークンで GET する（per_page=100、page=1 から）", async () => {
    const f = fakeFetch([ok([item("openai", "default")])]);
    await loadProviderKeys(setup({ CLOUDFLARE_ACCOUNT_ID: "acctA", AI_GATEWAY_ID: "gwA" }), {
      fetch: f.fn,
    });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]?.url).toBe(
      "https://api.cloudflare.com/client/v4/accounts/acctA/ai-gateway/gateways/gwA/provider_configs?page=1&per_page=100",
    );
    expect(f.calls[0]?.headers.get("authorization")).toBe("Bearer tok-secret-value-1234567890");
  });

  it("件数が per_page（100）に達していたら次のページを読む。100 未満で止まる", async () => {
    const page1 = Array.from({ length: 100 }, () => item("groq", "default"));
    const f = fakeFetch([ok(page1), ok([item("anthropic", "default")])]);
    const keys = await loadProviderKeys(setup(), { fetch: f.fn });
    expect(f.calls).toHaveLength(2);
    expect(f.calls[1]?.url).toContain("page=2");
    expect([...(keys ?? [])]).toEqual(["anthropic"]);
  });

  it("ページ数には上限がある（際限なく読まない）", async () => {
    const full = () => ok(Array.from({ length: 100 }, () => item("groq", "default")));
    const f = fakeFetch(Array.from({ length: 20 }, full));
    await loadProviderKeys(setup(), { fetch: f.fn });
    expect(f.calls.length).toBeLessThanOrEqual(5);
  });
});

describe("loadProviderKeys: 設定が無いとき（従来どおり）", () => {
  it("トークン・account id・gateway id のどれかが無ければ API を呼ばず undefined", async () => {
    for (const over of [
      { CLOUDFLARE_API_TOKEN: "" },
      { CLOUDFLARE_API_TOKEN: undefined },
      { CLOUDFLARE_ACCOUNT_ID: "" },
      { AI_GATEWAY_ID: "" },
      { AI_GATEWAY_ID: "../evil" }, // パスを壊せる値は使わない
      { CLOUDFLARE_ACCOUNT_ID: "a/b" },
    ]) {
      const f = fakeFetch([ok([item("anthropic", "default")])]);
      expect(await loadProviderKeys(setup(over), { fetch: f.fn }), JSON.stringify(over)).toBe(
        undefined,
      );
      expect(f.calls, JSON.stringify(over)).toHaveLength(0);
    }
  });

  it("CLOUDFLARE_API_BASE は ENVIRONMENT=test のときだけ効く", async () => {
    const f1 = fakeFetch([ok([])]);
    await loadProviderKeys(setup({ CLOUDFLARE_API_BASE: "http://127.0.0.1:9999/client/v4" }), {
      fetch: f1.fn,
    });
    expect(f1.calls[0]?.url.startsWith("https://api.cloudflare.com/client/v4/")).toBe(true);
    const f2 = fakeFetch([ok([])]);
    await loadProviderKeys(
      setup({ ENVIRONMENT: "test", CLOUDFLARE_API_BASE: "http://127.0.0.1:9999/client/v4" }),
      { fetch: f2.fn },
    );
    expect(f2.calls[0]?.url.startsWith("http://127.0.0.1:9999/client/v4/accounts/")).toBe(true);
  });
});

describe("loadProviderKeys: キャッシュ（OAUTH_KV。fresh は 5 分）", () => {
  it("fresh の間は API を呼び直さない。5 分を過ぎたら取り直す", async () => {
    const e = setup();
    let now = 1_000_000;
    const f = fakeFetch([ok([item("anthropic", "default")]), ok([item("openai", "default")])]);
    const deps = { fetch: f.fn, now: () => now };
    expect([...((await loadProviderKeys(e, deps)) ?? [])]).toEqual(["anthropic"]);
    now += PROVIDER_KEYS_FRESH_MS - 1;
    expect([...((await loadProviderKeys(e, deps)) ?? [])]).toEqual(["anthropic"]);
    expect(f.calls).toHaveLength(1);
    now += 2;
    expect([...((await loadProviderKeys(e, deps)) ?? [])]).toEqual(["openai"]);
    expect(f.calls).toHaveLength(2);
    expect(PROVIDER_KEYS_FRESH_MS).toBe(5 * 60_000);
  });

  it("キーが無い（空の集合）という結果もキャッシュする", async () => {
    const e = setup();
    const f = fakeFetch([ok([])]);
    const deps = { fetch: f.fn, now: () => 5 };
    await loadProviderKeys(e, deps);
    const again = await loadProviderKeys(e, deps);
    expect(again?.size).toBe(0);
    expect(f.calls).toHaveLength(1);
  });

  it("API が失敗したら、直前のキャッシュ（古くてもよい）を使う", async () => {
    const e = setup();
    let now = 0;
    const f = fakeFetch([ok([item("anthropic", "default")]), "throw"]);
    const deps = { fetch: f.fn, now: () => now };
    await loadProviderKeys(e, deps);
    now += PROVIDER_KEYS_FRESH_MS + 1;
    const keys = await loadProviderKeys(e, deps);
    expect([...(keys ?? [])]).toEqual(["anthropic"]);
  });

  it("キャッシュも無い状態で失敗したら undefined（判定できない）。すぐには取り直さず、少し後に取り直す", async () => {
    const e = setup();
    let now = 0;
    const f = fakeFetch([new Response("nope", { status: 500 }), ok([item("openai", "default")])]);
    const deps = { fetch: f.fn, now: () => now };
    expect(await loadProviderKeys(e, deps)).toBeUndefined();
    now += 1_000;
    expect(await loadProviderKeys(e, deps)).toBeUndefined();
    expect(f.calls).toHaveLength(1); // 失敗の直後は呼び直さない
    now += 60_000;
    expect([...((await loadProviderKeys(e, deps)) ?? [])]).toEqual(["openai"]);
  });

  it("失敗の応答（HTTP エラー・success: false・形の違う本文・例外・不正な JSON）はすべて判定できない扱い", async () => {
    const bad: (Response | "throw")[] = [
      new Response("x", { status: 401 }),
      new Response(JSON.stringify({ success: false, result: [] })),
      new Response(JSON.stringify({ success: true, result: "nope" })),
      new Response("not json"),
      "throw",
    ];
    for (const step of bad) {
      const f = fakeFetch([step]);
      expect(await loadProviderKeys(setup(), { fetch: f.fn })).toBeUndefined();
    }
  });

  it("24 時間より古いキャッシュは使わない（キーが消えていても使い続けない）", async () => {
    const e = setup();
    let now = 0;
    const f = fakeFetch([ok([item("anthropic", "default")]), "throw"]);
    const deps = { fetch: f.fn, now: () => now };
    await loadProviderKeys(e, deps);
    now += 24 * 3600_000 + 1;
    expect(await loadProviderKeys(e, deps)).toBeUndefined();
  });
});

describe("loadProviderKeys: 秘密の扱い", () => {
  it("トークン・応答の secret_preview・例外のメッセージをログに出さない", async () => {
    const logged: string[] = [];
    const orig = { log: console.log, error: console.error, warn: console.warn };
    const grab = (...a: unknown[]) => void logged.push(a.map(String).join(" "));
    console.log = grab;
    console.error = grab;
    console.warn = grab;
    try {
      await loadProviderKeys(setup(), { fetch: fakeFetch(["throw"]).fn });
      await loadProviderKeys(setup(), {
        fetch: fakeFetch([new Response("tok-secret-value-1234567890", { status: 403 })]).fn,
      });
      await loadProviderKeys(setup(), {
        fetch: fakeFetch([ok([item("anthropic", "default")])]).fn,
      });
    } finally {
      Object.assign(console, orig);
    }
    const all = logged.join("\n");
    expect(all).not.toContain("tok-secret-value");
    expect(all).not.toContain("SECRETPREVIEW");
    expect(all).not.toContain("sk-ant");
  });

  it("KV に保存するのは取得時刻とプロバイダ名だけ（キーの中身・トークンを保存しない）", async () => {
    const e = setup({ CLOUDFLARE_ACCOUNT_ID: "acctKV", AI_GATEWAY_ID: "gwKV" });
    await loadProviderKeys(e, {
      fetch: fakeFetch([ok([item("anthropic", "default")])]).fn,
      now: () => 42,
    });
    const page = await env.OAUTH_KV.list({ prefix: "provider-keys:" });
    const names = page.keys.map((k) => k.name).filter((n) => n.includes("acctKV"));
    expect(names.length).toBeGreaterThan(0);
    for (const n of names) {
      const v = (await env.OAUTH_KV.get(n)) ?? "";
      expect(v).not.toContain("SECRETPREVIEW");
      expect(v).not.toContain("tok-secret");
    }
  });
});
