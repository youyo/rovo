import { CloudflareSummaryDtoSchema, ErrorDtoSchema } from "@rovo/dashboard-contract";
import { beforeEach, describe, expect, it } from "vitest";
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
