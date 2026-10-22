import { CloudflareSummaryDtoSchema } from "@rovo/dashboard-contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CLOUDFLARE_QUERIES,
  type CloudflareEnv,
  loadCloudflareSummary,
  parseCloudflareRange,
  resetCloudflareSummaryCache,
} from "../../src/dashboard/cloudflare";

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
