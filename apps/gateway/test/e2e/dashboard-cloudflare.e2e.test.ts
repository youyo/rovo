import { CloudflareSummaryDtoSchema, ErrorDtoSchema } from "@rovo/dashboard-contract";
import { beforeEach, describe, expect, it } from "vitest";
import { CLOUDFLARE_UNIT_PRICES_USD } from "../../src/dashboard/cloudflare-pricing";
import { dashboardGet, dashboardLogin } from "./dashboard-session";
import { addMember, admin, baseUrl, newUser, resetDashboardCloudflareCache } from "./helpers";

// ダッシュボードの Cloudflare の概要（M9）を、実 Worker（wrangler dev）+ 偽 Cloudflare（GraphQL・残高）で通しに確かめる。
// 正常 / 一部が権限なし / 全面 5xx の 3 通りで、応答は 200 のまま、項目ごとの ok / reason が変わる。

beforeEach(async () => {
  await admin.reset();
  await admin.setCloudflareForbidden([]);
  await admin.setFault("cloudflare", null);
  await resetDashboardCloudflareCache();
});

async function viewer() {
  const user = newUser("cf-dash");
  await addMember(user);
  return dashboardLogin(user);
}

const KEYS = ["containers", "workers", "ai_gateway", "workers_ai", "credit_balance"] as const;

async function summary(cookie: string, query = "") {
  const r = await dashboardGet(cookie, `/cloudflare${query}`);
  return { r, dto: r.status === 200 ? CloudflareSummaryDtoSchema.parse(r.json()) : null };
}

describe("GET /dashboard/api/cloudflare", () => {
  it("正常: 5 項目が取れて、固定のクエリの結果が契約の形で返る", async () => {
    const cookie = await viewer();
    const { r, dto } = await summary(cookie);
    expect(r.status).toBe(200);
    expect(dto?.range).toBe("24h");
    expect(dto?.open_url).toBeNull();
    expect(dto?.containers).toMatchObject({
      ok: true,
      value: { running_instances: 2, vcpu_seconds: 10800, memory_gib_seconds: 9000 },
    });
    expect(dto?.workers).toMatchObject({ ok: true, value: { requests: 1200, errors: 7 } });
    expect(dto?.ai_gateway).toMatchObject({
      ok: true,
      value: { requests: 300, cached_requests: 30, errors: 3, cost_usd: 4.5 },
    });
    expect(dto?.workers_ai).toMatchObject({ ok: true, value: { neurons: 2500 } });
    expect(dto?.credit_balance).toEqual({ ok: true, value: { balance_usd: 18.25 } });
    // 残高 API の支払い方法・自動チャージの設定は応答に出さない
    expect(r.whole).not.toMatch(/visa|4242|topup|payment/i);
  });

  it("正常: cost_estimate は偽 API の使用量 × 単価で、無料枠を引く前。合計は Cloudflare の項目だけ（AI Gateway は別の項目・disk は除外）", async () => {
    const cookie = await viewer();
    const { r, dto } = await summary(cookie);
    expect(r.status).toBe(200);
    const est = dto?.cost_estimate;
    if (!est) throw new Error("cost_estimate が無い");
    const price = CLOUDFLARE_UNIT_PRICES_USD;
    // 期待値は偽の Cloudflare API の値（test/fake-github/server.ts）から計算する
    // vCPU: allocatedCpu 7200 + 3600 秒 / メモリ: 2 GiB × 3600 s + 1 GiB × 1800 s（= 9000 GiB 秒）
    // Workers: 1200 リクエスト / Workers AI: 2500 Neurons / AI Gateway: cost 4.5 USD（単価なし）
    const expected = {
      workers: 1200 * price.workers_request,
      vcpu: (7200 + 3600) * price.containers_vcpu_second,
      memory: (2 * 3600 + 1 * 1800) * price.containers_gib_second,
      workersAi: 2500 * price.workers_ai_neuron,
      aiGateway: 4.5,
    };
    expect(est.basis).toBe("before_free_tier");
    expect(est.items.workers_requests).toMatchObject({
      quantity: 1200,
      unit: "request",
      unit_price_usd: price.workers_request,
    });
    expect(est.items.workers_requests.estimated_usd_before_free_tier).toBeCloseTo(
      expected.workers,
      9,
    );
    expect(est.items.containers_vcpu).toMatchObject({
      quantity: 10800,
      unit: "vcpu_second",
      unit_price_usd: price.containers_vcpu_second,
    });
    expect(est.items.containers_vcpu.estimated_usd_before_free_tier).toBeCloseTo(expected.vcpu, 9);
    expect(est.items.containers_memory).toMatchObject({
      quantity: 9000,
      unit: "gib_second",
      unit_price_usd: price.containers_gib_second,
    });
    expect(est.items.containers_memory.estimated_usd_before_free_tier).toBeCloseTo(
      expected.memory,
      9,
    );
    // ディスクは使用量を取っていないので推定は null（合計に入らない）
    expect(est.items.containers_disk).toMatchObject({
      quantity: null,
      unit: "gb_second",
      unit_price_usd: price.containers_gb_second,
      estimated_usd_before_free_tier: null,
    });
    expect(est.items.workers_ai).toMatchObject({
      quantity: 2500,
      unit: "neuron",
      unit_price_usd: price.workers_ai_neuron,
    });
    expect(est.items.workers_ai.estimated_usd_before_free_tier).toBeCloseTo(expected.workersAi, 9);
    expect(est.items.ai_gateway.cost_usd).toBeCloseTo(expected.aiGateway, 9);
    // 合計は Cloudflare に払う分の取れた項目の和（AI Gateway の費用は含まない）
    const total = expected.workers + expected.vcpu + expected.memory + expected.workersAi;
    expect(est.total_estimated_usd_before_free_tier).toBeCloseTo(total, 9);
    // AI Gateway は合計にも excluded_items にも含めない（取れていても partial の判定に影響しない）
    expect(est.excluded_items).toEqual(["containers_disk"]);
    expect(est.partial).toBe(true);
  });

  it("一部が権限なし: その項目だけ forbidden で、他は取れる（200 のまま）", async () => {
    const cookie = await viewer();
    await admin.setCloudflareForbidden(["containers", "credit"]);
    const { r, dto } = await summary(cookie, "?range=7d");
    expect(r.status).toBe(200);
    expect(dto?.range).toBe("7d");
    expect(dto?.containers).toEqual({ ok: false, reason: "forbidden" });
    expect(dto?.credit_balance).toEqual({ ok: false, reason: "forbidden" });
    expect(dto?.workers?.ok).toBe(true);
    expect(dto?.ai_gateway.ok).toBe(true);
    expect(dto?.workers_ai?.ok).toBe(true);
  });

  it("全面 5xx: 200 のまま、全項目 unavailable", async () => {
    const cookie = await viewer();
    await admin.setFault("cloudflare", 503);
    const { r, dto } = await summary(cookie, "?range=1h");
    expect(r.status).toBe(200);
    for (const k of KEYS) expect(dto?.[k], k).toEqual({ ok: false, reason: "unavailable" });
  });

  it("キャッシュ: TTL 内の再呼び出しは上流を呼ばず、同じ結果が返る", async () => {
    const cookie = await viewer();
    const upstreamCalls = async () =>
      (await admin.requests()).filter((q) => q.path.startsWith("/client/v4/")).length;
    const before = await upstreamCalls();
    const first = await summary(cookie);
    const mid = await upstreamCalls();
    expect(mid - before).toBe(5);
    const second = await summary(cookie);
    expect(await upstreamCalls()).toBe(mid);
    expect(second.dto).toEqual(first.dto);
  });

  it("入力: range が列挙以外は 400、未ログインは 401。トークンと ID は応答に出ない", async () => {
    const cookie = await viewer();
    const bad = await dashboardGet(cookie, "/cloudflare?range=30d");
    expect(bad.status).toBe(400);
    expect(ErrorDtoSchema.parse(bad.json())).toEqual({ error: "bad_request" });
    const none = await fetch(`${baseUrl}/dashboard/api/cloudflare`, {
      headers: { "sec-fetch-site": "same-origin" },
    });
    expect(none.status).toBe(401);
    const ok = await dashboardGet(cookie, "/cloudflare");
    expect(ok.whole).not.toContain("e2e-cloudflare-token");
    expect(ok.whole).not.toContain("e2e-account");
    expect(ok.whole).not.toContain("e2e-gateway");
  });

  it("gateway が送ったクエリは固定（variables にだけ ID と期間が入り、prompt などを取らない）", async () => {
    const cookie = await viewer();
    await summary(cookie, "?range=1h");
    const calls = (await admin.requests()).filter((q) => q.path === "/client/v4/graphql");
    expect(calls).toHaveLength(4);
    for (const c of calls) {
      const body = c.body as unknown as { query: string; variables: Record<string, string> };
      expect(body.query).not.toContain("e2e-account");
      expect(body.query).not.toMatch(/prompt|metadata|body/i);
      expect(body.variables.accountTag).toBe("e2e-account");
      const span = Date.parse(body.variables.end ?? "") - Date.parse(body.variables.start ?? "");
      expect(span).toBe(3_600_000);
    }
  });
});
