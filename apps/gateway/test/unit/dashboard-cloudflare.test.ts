import { CloudflareSummaryDtoSchema } from "@rovo/dashboard-contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CLOUDFLARE_QUERIES,
  type CloudflareEnv,
  loadCloudflareSummary,
  parseCloudflareRange,
  resetCloudflareSummaryCache,
} from "../../src/dashboard/cloudflare";
import {
  buildCostEstimate,
  CLOUDFLARE_PRICING_CHECKED_AT,
  CLOUDFLARE_PRICING_SOURCES,
  CLOUDFLARE_UNIT_PRICES_USD,
} from "../../src/dashboard/cloudflare-pricing";

// ダッシュボードの Cloudflare の概要（docs/specs/dashboard.md M9 / D13）。
// 上流（GraphQL Analytics API・AI Gateway の残高 API）は fetch を差し込んで偽物にする。

// 実在の値ではないテスト用の値（scan-patterns の規則に一致しない形）
const TOKEN = "cf-unit-token-AbCdEf-not-real";
const ACCOUNT = "acct-unit-1";
const GATEWAY = "gw-unit-1";
const WORKERS = "w-gateway,w-agent,w-web";

const NOW = Date.parse("2026-10-22T12:00:00.000Z");

const env = (over: Partial<CloudflareEnv> = {}): CloudflareEnv => ({
  ENVIRONMENT: "production",
  CLOUDFLARE_API_TOKEN: TOKEN,
  CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
  AI_GATEWAY_ID: GATEWAY,
  WORKER_NAMES: WORKERS,
  ...over,
});

type Item = "containers" | "workers" | "aiGateway" | "workersAi" | "credit";
type Reply = Response | Error | (() => Response | Error);

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const gql = (alias: string, rows: unknown) =>
  json({ data: { viewer: { accounts: [{ [alias]: rows }] } }, errors: null });

const OK: Record<Item, () => Response> = {
  containers: () =>
    gql("containers", [
      {
        dimensions: { instanceId: "i-1" },
        sum: { allocatedCpu: 3600, allocatedMemory: 2 * 2 ** 30 * 100 },
      },
      {
        dimensions: { instanceId: "i-2" },
        sum: { allocatedCpu: 400, allocatedMemory: 2 ** 30 * 50 },
      },
    ]),
  workers: () =>
    gql("workers", [{ sum: { requests: 120, errors: 3 } }, { sum: { requests: 30, errors: 0 } }]),
  aiGateway: () =>
    gql("aiGateway", [{ count: 40, sum: { cost: 1.25, cachedRequests: 5, erroredRequests: 2 } }]),
  workersAi: () => gql("workersAi", [{ sum: { totalNeurons: 777.5 } }]),
  credit: () => json({ success: true, errors: [], messages: [], result: { balance: 42.5 } }),
};

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: { query: string; variables: Record<string, unknown> } | null;
  item: Item;
}

/** 上流の偽物。リクエストの内容（query の中身）で応答を選び、呼び出しを記録する。 */
function upstream(replies: Partial<Record<Item, Reply>> = {}) {
  const calls: Call[] = [];
  const fetchStub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const raw = typeof init?.body === "string" ? init.body : null;
    const body = raw ? (JSON.parse(raw) as Call["body"]) : null;
    const q = body?.query ?? "";
    const item: Item = url.includes("/billing/credit-balance")
      ? "credit"
      : q.includes("containersMetricsAdaptiveGroups")
        ? "containers"
        : q.includes("workersInvocationsAdaptive")
          ? "workers"
          : q.includes("aiGatewayRequestsAdaptiveGroups")
            ? "aiGateway"
            : "workersAi";
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body,
      item,
    });
    const reply = replies[item];
    const r = typeof reply === "function" ? reply() : (reply ?? OK[item]());
    if (r instanceof Error) throw r;
    return r;
  });
  return { fetch: fetchStub as unknown as typeof fetch, calls };
}

beforeEach(() => resetCloudflareSummaryCache());
afterEach(() => vi.restoreAllMocks());

describe("range の検査", () => {
  it("1h / 24h / 7d だけ。省略は 24h。それ以外（式・大文字・空）は null", () => {
    expect(parseCloudflareRange(null)).toBe("24h");
    expect(parseCloudflareRange("1h")).toBe("1h");
    expect(parseCloudflareRange("24h")).toBe("24h");
    expect(parseCloudflareRange("7d")).toBe("7d");
    for (const bad of ["", "2h", "30d", "24H", "now-1d", "1h,7d", "1h ", "__proto__"]) {
      expect(parseCloudflareRange(bad), bad).toBeNull();
    }
  });
});

describe("正常系", () => {
  it("5 項目を集計して契約の形で返す（Workers は 3 つの合計、メモリは GiB 秒）", async () => {
    const up = upstream();
    const dto = await loadCloudflareSummary(env(), "24h", { fetch: up.fetch, now: () => NOW });
    expect(CloudflareSummaryDtoSchema.parse(dto)).toEqual(dto);
    const period = {
      start: "2026-10-21T12:00:00.000Z",
      end: "2026-10-22T12:00:00.000Z",
    };
    expect(dto.generated_at).toBe("2026-10-22T12:00:00.000Z");
    expect(dto.range).toBe("24h");
    expect(dto.open_url).toBeNull();
    expect(dto.containers).toEqual({
      ok: true,
      value: { period, running_instances: 2, vcpu_seconds: 4000, memory_gib_seconds: 250 },
    });
    expect(dto.workers).toEqual({ ok: true, value: { period, requests: 150, errors: 3 } });
    expect(dto.ai_gateway).toEqual({
      ok: true,
      value: { period, requests: 40, cached_requests: 5, errors: 2, cost_usd: 1.25 },
    });
    expect(dto.workers_ai).toEqual({ ok: true, value: { period, neurons: 777.5 } });
    expect(dto.credit_balance).toEqual({ ok: true, value: { balance_usd: 42.5 } });
    expect(up.calls).toHaveLength(5);
  });

  it("期間は range から決まる（1h・24h・7d）", async () => {
    const spans: Record<string, number> = { "1h": 3_600_000, "24h": 86_400_000, "7d": 604_800_000 };
    for (const [range, ms] of Object.entries(spans)) {
      resetCloudflareSummaryCache();
      const up = upstream();
      await loadCloudflareSummary(env(), range as "1h", { fetch: up.fetch, now: () => NOW });
      const gqlCalls = up.calls.filter((c) => c.body);
      expect(gqlCalls).toHaveLength(4);
      for (const c of gqlCalls) {
        expect(c.body?.variables.end, range).toBe(new Date(NOW).toISOString());
        expect(c.body?.variables.start, range).toBe(new Date(NOW - ms).toISOString());
      }
    }
  });

  it("行が無い（トラフィックが無い）ときは 0 の値。欠けた集計の行は 0 として足す", async () => {
    const up = upstream({
      containers: gql("containers", []),
      workers: gql("workers", [{ sum: {} }]),
      aiGateway: gql("aiGateway", []),
      workersAi: gql("workersAi", []),
    });
    const dto = await loadCloudflareSummary(env(), "1h", { fetch: up.fetch, now: () => NOW });
    expect(dto.containers).toMatchObject({
      ok: true,
      value: { running_instances: 0, vcpu_seconds: 0 },
    });
    expect(dto.workers).toMatchObject({ ok: true, value: { requests: 0, errors: 0 } });
    expect(dto.ai_gateway).toMatchObject({ ok: true, value: { requests: 0, cost_usd: 0 } });
    expect(dto.workers_ai).toMatchObject({ ok: true, value: { neurons: 0 } });
  });
});

describe("固定のクエリ（任意の GraphQL を受けない）", () => {
  it("送る query は定数と完全に一致し、アカウント ID・gateway id・Worker 名・期間は variables だけに入る", async () => {
    const up = upstream();
    await loadCloudflareSummary(env(), "7d", { fetch: up.fetch, now: () => NOW });
    const constants = new Set<string>(Object.values(CLOUDFLARE_QUERIES));
    const gqlCalls = up.calls.filter((c) => c.body);
    expect(gqlCalls.map((c) => c.item).sort()).toEqual([
      "aiGateway",
      "containers",
      "workers",
      "workersAi",
    ]);
    for (const c of gqlCalls) {
      expect(constants.has(c.body?.query ?? ""), c.item).toBe(true);
      for (const secret of [ACCOUNT, GATEWAY, "w-gateway", "w-agent", "2026-10", TOKEN]) {
        expect(c.body?.query, `${c.item} ${secret}`).not.toContain(secret);
      }
      expect(c.body?.variables.accountTag).toBe(ACCOUNT);
    }
    const byItem = Object.fromEntries(gqlCalls.map((c) => [c.item, c.body?.variables]));
    expect(byItem.workers?.scripts).toEqual(["w-gateway", "w-agent", "w-web"]);
    expect(byItem.aiGateway?.gateway).toBe(GATEWAY);
    // 残高の API は REST（GraphQL を使わない）
    const credit = up.calls.find((c) => c.item === "credit");
    expect(credit?.method).toBe("GET");
    expect(credit?.url).toBe(
      `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai-gateway/billing/credit-balance`,
    );
    expect(credit?.body).toBeNull();
  });

  it("query に prompt / body / ログ / メタデータを取る項目が無い（AI Gateway の中身は取らない）", () => {
    for (const q of Object.values(CLOUDFLARE_QUERIES)) {
      expect(q).not.toMatch(/prompt|metadata|logs?\b|response|request(Body|Headers)|body/i);
    }
  });

  it("query は読み取り（query）だけで、mutation・subscription・introspection を含まない", () => {
    for (const q of Object.values(CLOUDFLARE_QUERIES)) {
      expect(q.trimStart().startsWith("query ")).toBe(true);
      expect(q).not.toMatch(/mutation|subscription|__schema|__type/);
    }
  });

  it("設定の値が不正な形（引用符・空白・長すぎる Worker 名など）なら、その項目は not_configured で、その値を送らない", async () => {
    const up = upstream();
    const dto = await loadCloudflareSummary(
      env({ WORKER_NAMES: 'evil") { x } #,ok-worker', AI_GATEWAY_ID: 'gw" } }' }),
      "24h",
      { fetch: up.fetch, now: () => NOW },
    );
    expect(dto.workers).toEqual({ ok: false, reason: "not_configured" });
    expect(dto.ai_gateway).toEqual({ ok: false, reason: "not_configured" });
    expect(dto.containers.ok).toBe(true);
    expect(JSON.stringify(up.calls)).not.toContain("evil");
    expect(JSON.stringify(up.calls)).not.toContain('gw"');
  });
});

describe("未設定", () => {
  it("トークン・アカウント ID のどれかが空なら全項目 not_configured で、上流を呼ばない", async () => {
    for (const over of [
      { CLOUDFLARE_API_TOKEN: "" },
      { CLOUDFLARE_API_TOKEN: undefined },
      { CLOUDFLARE_ACCOUNT_ID: "" },
    ]) {
      resetCloudflareSummaryCache();
      const up = upstream();
      const dto = await loadCloudflareSummary(env(over), "24h", {
        fetch: up.fetch,
        now: () => NOW,
      });
      for (const k of [
        "containers",
        "workers",
        "ai_gateway",
        "workers_ai",
        "credit_balance",
      ] as const) {
        expect(dto[k], `${JSON.stringify(over)} ${k}`).toEqual({
          ok: false,
          reason: "not_configured",
        });
      }
      expect(up.calls).toHaveLength(0);
      CloudflareSummaryDtoSchema.parse(dto);
    }
  });

  it("gateway id が無ければ AI Gateway だけ、Worker 名が無ければ Workers だけ not_configured", async () => {
    const up = upstream();
    const dto = await loadCloudflareSummary(env({ AI_GATEWAY_ID: "", WORKER_NAMES: "" }), "24h", {
      fetch: up.fetch,
      now: () => NOW,
    });
    expect(dto.ai_gateway).toEqual({ ok: false, reason: "not_configured" });
    expect(dto.workers).toEqual({ ok: false, reason: "not_configured" });
    expect(dto.containers.ok).toBe(true);
    expect(dto.workers_ai?.ok).toBe(true);
    expect(dto.credit_balance.ok).toBe(true);
  });
});

describe("項目ごとの fail-soft", () => {
  it("一部が 403 / authz なら、その項目だけ forbidden で他は取れる（全体は常に返る）", async () => {
    const up = upstream({
      containers: json({ errors: [{ message: "denied" }] }, 403),
      workers: json({
        data: { viewer: { accounts: [null] } },
        errors: [{ message: "does not have access to the path", extensions: { code: "authz" } }],
      }),
      credit: json({ success: false }, 401),
    });
    const dto = await loadCloudflareSummary(env(), "24h", { fetch: up.fetch, now: () => NOW });
    expect(dto.containers).toEqual({ ok: false, reason: "forbidden" });
    expect(dto.workers).toEqual({ ok: false, reason: "forbidden" });
    expect(dto.credit_balance).toEqual({ ok: false, reason: "forbidden" });
    expect(dto.ai_gateway.ok).toBe(true);
    expect(dto.workers_ai?.ok).toBe(true);
    CloudflareSummaryDtoSchema.parse(dto);
  });

  it("5xx・429・タイムアウト・ネットワーク失敗・壊れた JSON は unavailable", async () => {
    const up = upstream({
      containers: json({}, 500),
      workers: json({}, 503),
      aiGateway: json({}, 429),
      workersAi: new DOMException("timeout", "TimeoutError"),
      credit: new Response("<html>not json</html>", { status: 200 }),
    });
    const dto = await loadCloudflareSummary(env(), "24h", { fetch: up.fetch, now: () => NOW });
    for (const k of [
      "containers",
      "workers",
      "ai_gateway",
      "workers_ai",
      "credit_balance",
    ] as const) {
      expect(dto[k], k).toEqual({ ok: false, reason: "unavailable" });
    }
  });

  it("GraphQL が 200 で errors だけ（authz 以外）を返したら unavailable", async () => {
    const up = upstream({
      containers: json({ data: null, errors: [{ message: "internal error" }] }),
    });
    const dto = await loadCloudflareSummary(env(), "24h", { fetch: up.fetch, now: () => NOW });
    expect(dto.containers).toEqual({ ok: false, reason: "unavailable" });
  });

  it("応答の整形: 欠け・null・負・NaN・文字列の数は empty（値を作らない）", async () => {
    const up = upstream({
      containers: json({ data: { viewer: { accounts: [{ containers: null }] } } }),
      workers: json({ data: { viewer: { accounts: [] } } }),
      aiGateway: gql("aiGateway", [{ count: -1, sum: { cost: 1 } }]),
      workersAi: gql("workersAi", [{ sum: { totalNeurons: "12" } }]),
      credit: json({ success: true, result: { balance: null } }),
    });
    const dto = await loadCloudflareSummary(env(), "24h", { fetch: up.fetch, now: () => NOW });
    for (const k of [
      "containers",
      "workers",
      "ai_gateway",
      "workers_ai",
      "credit_balance",
    ] as const) {
      expect(dto[k], k).toEqual({ ok: false, reason: "empty" });
    }
    CloudflareSummaryDtoSchema.parse(dto);
  });

  it("全面 5xx でも例外にならず、全項目 unavailable の DTO が返る", async () => {
    const boom = () => json({ message: "x" }, 502);
    const up = upstream({
      containers: boom,
      workers: boom,
      aiGateway: boom,
      workersAi: boom,
      credit: boom,
    });
    const dto = await loadCloudflareSummary(env(), "24h", { fetch: up.fetch, now: () => NOW });
    expect(CloudflareSummaryDtoSchema.parse(dto)).toEqual(dto);
    expect(dto.containers.ok || dto.workers?.ok || dto.ai_gateway.ok || dto.credit_balance.ok).toBe(
      false,
    );
  });
});

describe("キャッシュ（共有・メモリ）", () => {
  it("TTL（45 秒）内の再呼び出しは上流を呼ばず、同じ DTO を返す。TTL を過ぎたら取り直す", async () => {
    const up = upstream();
    let t = NOW;
    const deps = { fetch: up.fetch, now: () => t };
    const a = await loadCloudflareSummary(env(), "24h", deps);
    expect(up.calls).toHaveLength(5);
    t += 44_000;
    const b = await loadCloudflareSummary(env(), "24h", deps);
    expect(up.calls).toHaveLength(5);
    expect(b).toEqual(a);
    t += 2_000; // 合計 46 秒
    await loadCloudflareSummary(env(), "24h", deps);
    expect(up.calls).toHaveLength(10);
  });

  it("range ごとに別のキャッシュ", async () => {
    const up = upstream();
    const deps = { fetch: up.fetch, now: () => NOW };
    await loadCloudflareSummary(env(), "1h", deps);
    await loadCloudflareSummary(env(), "7d", deps);
    expect(up.calls).toHaveLength(10);
    await loadCloudflareSummary(env(), "1h", deps);
    expect(up.calls).toHaveLength(10);
  });

  it("unavailable を含む結果は短く（5 秒）しかキャッシュしない。forbidden は通常の TTL", async () => {
    let healthy = false;
    const up = upstream({
      containers: () => (healthy ? OK.containers() : json({}, 500)),
      workers: json({}, 403),
    });
    let t = NOW;
    const deps = { fetch: up.fetch, now: () => t };
    const first = await loadCloudflareSummary(env(), "24h", deps);
    expect(first.containers).toEqual({ ok: false, reason: "unavailable" });
    t += 4_000;
    await loadCloudflareSummary(env(), "24h", deps);
    expect(up.calls).toHaveLength(5); // まだキャッシュ
    healthy = true;
    t += 2_000; // 6 秒
    const again = await loadCloudflareSummary(env(), "24h", deps);
    expect(up.calls).toHaveLength(10);
    expect(again.containers.ok).toBe(true);
    expect(again.workers).toEqual({ ok: false, reason: "forbidden" });
    // いまは unavailable が無いので 45 秒キャッシュ
    t += 40_000;
    await loadCloudflareSummary(env(), "24h", deps);
    expect(up.calls).toHaveLength(10);
  });

  it("同じリクエスト内の 5 本は並列に飛ぶ（直列に待たない）", async () => {
    let inFlight = 0;
    let peak = 0;
    const slow = async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
    };
    const base = upstream();
    const fetchSlow = (async (...args: Parameters<typeof fetch>) => {
      await slow();
      return base.fetch(...args);
    }) as typeof fetch;
    await loadCloudflareSummary(env(), "24h", { fetch: fetchSlow, now: () => NOW });
    expect(peak).toBe(5);
  });
});

describe("接続先とトークンの扱い", () => {
  it("ENVIRONMENT=test のときだけ CLOUDFLARE_API_BASE を使う。本番では無視する", async () => {
    const up1 = upstream();
    await loadCloudflareSummary(
      env({ ENVIRONMENT: "test", CLOUDFLARE_API_BASE: "http://127.0.0.1:9/client/v4" }),
      "24h",
      { fetch: up1.fetch, now: () => NOW },
    );
    expect(up1.calls.every((c) => c.url.startsWith("http://127.0.0.1:9/client/v4/"))).toBe(true);
    expect(up1.calls.find((c) => c.body)?.url).toBe("http://127.0.0.1:9/client/v4/graphql");

    resetCloudflareSummaryCache();
    const up2 = upstream();
    await loadCloudflareSummary(
      env({ ENVIRONMENT: "production", CLOUDFLARE_API_BASE: "http://127.0.0.1:9/client/v4" }),
      "24h",
      { fetch: up2.fetch, now: () => NOW },
    );
    expect(up2.calls.every((c) => c.url.startsWith("https://api.cloudflare.com/client/v4/"))).toBe(
      true,
    );
  });

  it("トークンは Authorization ヘッダだけに載り、DTO・ログ・URL・query・variables に出ない（失敗時も）", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const warns = vi.spyOn(console, "warn").mockImplementation(() => {});
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});
    const up = upstream({
      // 例外のメッセージにトークンが入る最悪の場合
      containers: new Error(`connect failed for Bearer ${TOKEN}`),
      workers: json({ errors: [{ message: `bad token ${TOKEN}` }], token: TOKEN }, 500),
      aiGateway: json({ data: { viewer: { accounts: [{ aiGateway: "x" }] } }, token: TOKEN }),
    });
    const dto = await loadCloudflareSummary(env(), "24h", { fetch: up.fetch, now: () => NOW });
    for (const c of up.calls) {
      expect(c.headers.authorization, c.item).toBe(`Bearer ${TOKEN}`);
      expect(c.url).not.toContain(TOKEN);
      expect(JSON.stringify(c.body)).not.toContain(TOKEN);
    }
    expect(JSON.stringify(dto)).not.toContain(TOKEN);
    const logged = JSON.stringify([errors.mock.calls, warns.mock.calls, logs.mock.calls]);
    expect(logged).not.toContain(TOKEN);
    expect(logged).not.toContain("Bearer");
    expect(errors).toHaveBeenCalled(); // 失敗は理由コードだけ記録する
  });
});

// --- 推定の金額（無料枠を引く前。単価 × 使用量。合計は Cloudflare に払う分だけで、AI Gateway の費用は別の項目） ---

// 合計（Cloudflare に払う分）の項目。AI Gateway は BYOK のモデル費用なので含まない（excluded_items にも出ない）
const ALL_ITEMS = [
  "workers_requests",
  "containers_vcpu",
  "containers_memory",
  "containers_disk",
  "workers_ai",
] as const;

describe("単価の定数（cloudflare-pricing.ts）", () => {
  it("公開の単価（USD）。Workers 0.30 / 100 万リクエスト・Containers vCPU 秒 / GiB 秒 / GB 秒・Workers AI 0.011 / 1,000 Neurons", () => {
    expect(CLOUDFLARE_UNIT_PRICES_USD).toEqual({
      workers_request: 0.0000003,
      containers_vcpu_second: 0.00002,
      containers_gib_second: 0.0000025,
      containers_gb_second: 0.00000007,
      workers_ai_neuron: 0.000011,
    });
  });

  it("出典は developers.cloudflare.com の 3 ページ。確認日は YYYY-MM-DD か null（未確認）", () => {
    expect(Object.keys(CLOUDFLARE_PRICING_SOURCES).sort()).toEqual([
      "containers",
      "workers",
      "workers_ai",
    ]);
    for (const url of Object.values(CLOUDFLARE_PRICING_SOURCES)) {
      expect(url).toMatch(/^https:\/\/developers\.cloudflare\.com\/[a-z-]+\/platform\/pricing\/$/);
    }
    const checked = CLOUDFLARE_PRICING_CHECKED_AT;
    expect(checked === null || /^\d{4}-\d{2}-\d{2}$/.test(checked)).toBe(true);
  });
});

describe("buildCostEstimate（単価 × 使用量・無料枠を引かない・合計は Cloudflare の請求の推定）", () => {
  const full = {
    workersRequests: 150,
    vcpuSeconds: 4000,
    memoryGibSeconds: 250,
    diskGbSeconds: null,
    neurons: 777.5,
    aiGatewayCostUsd: 1.25,
  };

  it("項目ごとに単価 × 使用量。合計は取れた Cloudflare の項目の和（AI Gateway は含まない）。ディスクは使用量が無いので null", () => {
    const e = buildCostEstimate(full);
    expect(e.basis).toBe("before_free_tier");
    expect(e.items.workers_requests).toEqual({
      quantity: 150,
      unit: "request",
      unit_price_usd: 0.0000003,
      estimated_usd_before_free_tier: 0.000045,
    });
    expect(e.items.containers_vcpu).toEqual({
      quantity: 4000,
      unit: "vcpu_second",
      unit_price_usd: 0.00002,
      estimated_usd_before_free_tier: 0.08,
    });
    expect(e.items.containers_memory).toEqual({
      quantity: 250,
      unit: "gib_second",
      unit_price_usd: 0.0000025,
      estimated_usd_before_free_tier: 0.000625,
    });
    expect(e.items.containers_disk).toEqual({
      quantity: null,
      unit: "gb_second",
      unit_price_usd: 0.00000007,
      estimated_usd_before_free_tier: null,
    });
    expect(e.items.workers_ai).toEqual({
      quantity: 777.5,
      unit: "neuron",
      unit_price_usd: 0.000011,
      estimated_usd_before_free_tier: 0.0085525,
    });
    expect(e.items.ai_gateway).toEqual({ cost_usd: 1.25 });
    // 0.000045 + 0.08 + 0.000625 + 0.0085525（AI Gateway の 1.25 は合計に含まない）
    expect(e.total_estimated_usd_before_free_tier).toBeCloseTo(0.0892225, 9);
    expect(e.excluded_items).toEqual(["containers_disk"]);
    expect(e.partial).toBe(true);
    expect(e.pricing_checked_at).toBe(CLOUDFLARE_PRICING_CHECKED_AT);
  });

  it("無料枠・プランに含まれる分を引かない（月 1,000 万リクエスト・1 日 1 万 Neurons 以内でも 0 にならない）", () => {
    const e = buildCostEstimate({
      ...full,
      workersRequests: 5_000_000, // 月 1,000 万リクエストまで含まれるが、引かない
      neurons: 10_000, // 1 日 1 万 Neurons まで無料だが、引かない
      vcpuSeconds: 375 * 60, // 月 375 vCPU 分まで含まれるが、引かない
      memoryGibSeconds: 25 * 3600, // 月 25 GiB 時間まで含まれるが、引かない
    });
    expect(e.items.workers_requests.estimated_usd_before_free_tier).toBeCloseTo(1.5, 9);
    expect(e.items.workers_ai.estimated_usd_before_free_tier).toBeCloseTo(0.11, 9);
    expect(e.items.containers_vcpu.estimated_usd_before_free_tier).toBeCloseTo(0.45, 9);
    expect(e.items.containers_memory.estimated_usd_before_free_tier).toBeCloseTo(0.225, 9);
  });

  it("ディスクの使用量が取れていれば GB 秒 × 単価", () => {
    const e = buildCostEstimate({ ...full, diskGbSeconds: 1_000_000 });
    expect(e.items.containers_disk).toMatchObject({ quantity: 1_000_000, unit: "gb_second" });
    expect(e.items.containers_disk.estimated_usd_before_free_tier).toBeCloseTo(0.07, 9);
    expect(e.excluded_items).toEqual([]);
    expect(e.partial).toBe(false);
    expect(e.total_estimated_usd_before_free_tier).toBeCloseTo(0.0892225 + 0.07, 9);
  });

  it("使用量 0 は 0 USD（null ではない）。合計に含まれる", () => {
    const e = buildCostEstimate({
      workersRequests: 0,
      vcpuSeconds: 0,
      memoryGibSeconds: 0,
      diskGbSeconds: 0,
      neurons: 0,
      aiGatewayCostUsd: 0,
    });
    for (const k of [
      "workers_requests",
      "containers_vcpu",
      "containers_memory",
      "containers_disk",
      "workers_ai",
    ] as const) {
      expect(e.items[k].estimated_usd_before_free_tier, k).toBe(0);
    }
    expect(e.items.ai_gateway.cost_usd).toBe(0);
    expect(e.total_estimated_usd_before_free_tier).toBe(0);
    expect(e.excluded_items).toEqual([]);
    expect(e.partial).toBe(false);
  });

  it("取得できない項目（使用量 null）の推定は null で、合計に含まれず、excluded_items に出る", () => {
    const e = buildCostEstimate({
      ...full,
      vcpuSeconds: null,
      memoryGibSeconds: null,
      aiGatewayCostUsd: null,
    });
    expect(e.items.containers_vcpu.estimated_usd_before_free_tier).toBeNull();
    expect(e.items.containers_memory.estimated_usd_before_free_tier).toBeNull();
    expect(e.items.ai_gateway.cost_usd).toBeNull();
    expect(e.excluded_items).toEqual(["containers_vcpu", "containers_memory", "containers_disk"]);
    expect(e.partial).toBe(true);
    // 残りの 2 項目（Workers のリクエスト・Workers AI）だけの和
    expect(e.total_estimated_usd_before_free_tier).toBeCloseTo(0.000045 + 0.0085525, 9);
  });

  it("AI Gateway の費用は合計・excluded_items・partial に影響しない（別の項目として出るだけ）", () => {
    const withGw = buildCostEstimate({ ...full, diskGbSeconds: 1_000_000, aiGatewayCostUsd: 1.25 });
    const noGw = buildCostEstimate({ ...full, diskGbSeconds: 1_000_000, aiGatewayCostUsd: null });
    const hugeGw = buildCostEstimate({ ...full, diskGbSeconds: 1_000_000, aiGatewayCostUsd: 999 });
    expect(withGw.items.ai_gateway).toEqual({ cost_usd: 1.25 });
    expect(noGw.items.ai_gateway).toEqual({ cost_usd: null });
    // AI Gateway が取れなくても、Cloudflare の項目が全部取れていれば partial にならない
    expect(noGw.excluded_items).toEqual([]);
    expect(noGw.partial).toBe(false);
    expect(noGw.total_estimated_usd_before_free_tier).toBe(
      withGw.total_estimated_usd_before_free_tier,
    );
    expect(hugeGw.total_estimated_usd_before_free_tier).toBe(
      withGw.total_estimated_usd_before_free_tier,
    );
    // 合計 = Workers のリクエスト + コンテナ 3 項目 + Workers AI + ディスク(1,000,000 GB 秒 × 単価)
    expect(withGw.total_estimated_usd_before_free_tier).toBeCloseTo(0.1592225, 9);
  });

  it("Cloudflare の項目が 1 つも取れず AI Gateway だけ取れたときは合計 null・partial true（AI Gateway の金額で合計にしない）", () => {
    const e = buildCostEstimate({
      workersRequests: null,
      vcpuSeconds: null,
      memoryGibSeconds: null,
      diskGbSeconds: null,
      neurons: null,
      aiGatewayCostUsd: 1.25,
    });
    expect(e.total_estimated_usd_before_free_tier).toBeNull();
    expect(e.partial).toBe(true);
    expect(e.excluded_items).toEqual([...ALL_ITEMS]);
  });

  it("全項目が取れないときは合計も null（0 USD と見せない）", () => {
    const e = buildCostEstimate({
      workersRequests: null,
      vcpuSeconds: null,
      memoryGibSeconds: null,
      diskGbSeconds: null,
      neurons: null,
      aiGatewayCostUsd: null,
    });
    expect(e.total_estimated_usd_before_free_tier).toBeNull();
    expect([...e.excluded_items].sort()).toEqual([...ALL_ITEMS].sort());
    expect(e.partial).toBe(true);
  });
});

describe("推定の金額を DTO で返す（loadCloudflareSummary）", () => {
  it("正常系: 項目ごとの推定。合計は AI Gateway を含まない。ディスクは取っていないので null で、合計に含まれない", async () => {
    const up = upstream();
    const dto = await loadCloudflareSummary(env(), "24h", { fetch: up.fetch, now: () => NOW });
    expect(CloudflareSummaryDtoSchema.parse(dto)).toEqual(dto);
    const est = dto.cost_estimate;
    expect(est).toBeDefined();
    expect(est?.basis).toBe("before_free_tier");
    expect(est?.items.workers_requests.quantity).toBe(150);
    expect(est?.items.workers_requests.estimated_usd_before_free_tier).toBeCloseTo(0.000045, 9);
    expect(est?.items.containers_vcpu.quantity).toBe(4000);
    expect(est?.items.containers_vcpu.estimated_usd_before_free_tier).toBeCloseTo(0.08, 9);
    expect(est?.items.containers_memory.quantity).toBe(250);
    expect(est?.items.containers_memory.estimated_usd_before_free_tier).toBeCloseTo(0.000625, 9);
    expect(est?.items.containers_disk.estimated_usd_before_free_tier).toBeNull();
    expect(est?.items.workers_ai.quantity).toBe(777.5);
    expect(est?.items.workers_ai.estimated_usd_before_free_tier).toBeCloseTo(0.0085525, 9);
    expect(est?.items.ai_gateway.cost_usd).toBe(1.25);
    expect(est?.total_estimated_usd_before_free_tier).toBeCloseTo(0.0892225, 9);
    expect(est?.excluded_items).toEqual(["containers_disk"]);
    expect(est?.partial).toBe(true);
    // 既存の項目は変わらない
    expect(dto.ai_gateway).toMatchObject({ ok: true, value: { cost_usd: 1.25 } });
    expect(dto.credit_balance).toEqual({ ok: true, value: { balance_usd: 42.5 } });
  });

  it("range によらず使用量 × 単価（期間の按分や月の無料枠の調整をしない）", async () => {
    const a = await loadCloudflareSummary(env(), "1h", {
      fetch: upstream().fetch,
      now: () => NOW,
    });
    resetCloudflareSummaryCache();
    const b = await loadCloudflareSummary(env(), "7d", {
      fetch: upstream().fetch,
      now: () => NOW,
    });
    expect(a.cost_estimate?.total_estimated_usd_before_free_tier).toBe(
      b.cost_estimate?.total_estimated_usd_before_free_tier,
    );
  });

  it("Workers が forbidden なら Workers の推定だけ null。合計は残りの項目の和で、workers_requests が含まれない旨が出る", async () => {
    const up = upstream({ workers: json({ errors: [] }, 403) });
    const dto = await loadCloudflareSummary(env(), "24h", { fetch: up.fetch, now: () => NOW });
    const est = dto.cost_estimate;
    expect(dto.workers).toEqual({ ok: false, reason: "forbidden" });
    expect(est?.items.workers_requests).toMatchObject({
      quantity: null,
      estimated_usd_before_free_tier: null,
    });
    expect(est?.excluded_items).toContain("workers_requests");
    expect(est?.partial).toBe(true);
    expect(est?.total_estimated_usd_before_free_tier).toBeCloseTo(0.0892225 - 0.000045, 9);
    CloudflareSummaryDtoSchema.parse(dto);
  });

  it("コンテナが unavailable なら vCPU・メモリ・ディスクの推定が null で、3 つとも合計に含まれない", async () => {
    const up = upstream({ containers: json({}, 500) });
    const dto = await loadCloudflareSummary(env(), "24h", { fetch: up.fetch, now: () => NOW });
    const est = dto.cost_estimate;
    for (const k of ["containers_vcpu", "containers_memory", "containers_disk"] as const) {
      expect(est?.items[k].estimated_usd_before_free_tier, k).toBeNull();
      expect(est?.excluded_items, k).toContain(k);
    }
    expect(est?.total_estimated_usd_before_free_tier).toBeCloseTo(0.000045 + 0.0085525, 9);
  });

  it("AI Gateway が取れない（gateway id なし）と ai_gateway が null・合計に含まれない。Workers AI が empty なら workers_ai も null", async () => {
    const up = upstream({ workersAi: gql("workersAi", null) });
    const dto = await loadCloudflareSummary(env({ AI_GATEWAY_ID: "" }), "24h", {
      fetch: up.fetch,
      now: () => NOW,
    });
    const est = dto.cost_estimate;
    expect(dto.ai_gateway).toEqual({ ok: false, reason: "not_configured" });
    expect(est?.items.ai_gateway.cost_usd).toBeNull();
    expect(est?.items.workers_ai.estimated_usd_before_free_tier).toBeNull();
    expect(est?.excluded_items).toEqual(expect.arrayContaining(["workers_ai", "containers_disk"]));
    // AI Gateway は合計の項目ではないので、取れなくても excluded_items には出ない
    expect(est?.excluded_items).not.toContain("ai_gateway");
    expect(est?.total_estimated_usd_before_free_tier).toBeCloseTo(0.000045 + 0.08 + 0.000625, 9);
  });

  it("未設定（上流を呼ばない）でも例外にならず、全項目の推定が null・合計 null・契約を通る", async () => {
    const up = upstream();
    const dto = await loadCloudflareSummary(env({ CLOUDFLARE_API_TOKEN: "" }), "24h", {
      fetch: up.fetch,
      now: () => NOW,
    });
    expect(up.calls).toHaveLength(0);
    const est = dto.cost_estimate;
    expect(est?.total_estimated_usd_before_free_tier).toBeNull();
    expect([...(est?.excluded_items ?? [])].sort()).toEqual([...ALL_ITEMS].sort());
    for (const k of [
      "workers_requests",
      "containers_vcpu",
      "containers_memory",
      "containers_disk",
      "workers_ai",
    ] as const) {
      expect(est?.items[k].estimated_usd_before_free_tier, k).toBeNull();
    }
    expect(est?.items.ai_gateway.cost_usd).toBeNull();
    expect(CloudflareSummaryDtoSchema.parse(dto)).toEqual(dto);
  });

  it("トラフィックが無い（行が 0 件）ときの推定は 0 USD で、取得できない項目だけ null", async () => {
    const up = upstream({
      containers: gql("containers", []),
      workers: gql("workers", []),
      aiGateway: gql("aiGateway", []),
      workersAi: gql("workersAi", []),
    });
    const dto = await loadCloudflareSummary(env(), "1h", { fetch: up.fetch, now: () => NOW });
    const est = dto.cost_estimate;
    expect(est?.total_estimated_usd_before_free_tier).toBe(0);
    expect(est?.items.workers_requests.estimated_usd_before_free_tier).toBe(0);
    expect(est?.items.containers_disk.estimated_usd_before_free_tier).toBeNull();
    expect(est?.excluded_items).toEqual(["containers_disk"]);
  });

  it("推定はキャッシュされた DTO と一緒に返る（TTL 内は上流を呼ばず同じ値）", async () => {
    const up = upstream();
    const deps = { fetch: up.fetch, now: () => NOW };
    const a = await loadCloudflareSummary(env(), "24h", deps);
    const b = await loadCloudflareSummary(env(), "24h", deps);
    expect(up.calls).toHaveLength(5);
    expect(b.cost_estimate).toEqual(a.cost_estimate);
  });
});
