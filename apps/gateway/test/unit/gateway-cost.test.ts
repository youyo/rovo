import { describe, expect, it } from "vitest";
import {
  fetchConsultGatewayCost,
  fetchGatewayCost,
  gatewayCostConfigured,
} from "../../src/tasks/gateway-cost";

const TASK = "01JTESTTASK0000000000000000";
const ENV = {
  ENVIRONMENT: "test",
  CLOUDFLARE_API_TOKEN: "token-example",
  CLOUDFLARE_ACCOUNT_ID: "acct-example",
  AI_GATEWAY_ID: "gw-example",
  CLOUDFLARE_API_BASE: "http://cf.example/client/v4",
};

type Log = { success?: boolean; cost?: number | null; metadata?: string | Record<string, unknown> };
const log = (cost: number | null | undefined, over: Log = {}): Log => ({
  success: true,
  ...(cost === undefined ? {} : { cost }),
  metadata: JSON.stringify({ userId: "1", taskId: TASK }),
  ...over,
});

/** logs を per_page ごとに返す偽の Logs API。呼び出された URL を記録する。 */
function fakeApi(logs: Log[], total = logs.length) {
  const urls: URL[] = [];
  const headers: (string | null)[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input));
    urls.push(u);
    headers.push(new Headers(init?.headers).get("authorization"));
    const per = Number(u.searchParams.get("per_page"));
    const page = Number(u.searchParams.get("page") ?? "1");
    return Response.json({
      success: true,
      result: logs.slice((page - 1) * per, page * per),
      result_info: { page, per_page: per, count: 0, total_count: total },
    });
  }) as typeof fetch;
  return { f, urls, headers };
}

describe("gatewayCostConfigured", () => {
  it("3 つの設定が揃っているときだけ true", () => {
    expect(gatewayCostConfigured(ENV)).toBe(true);
    expect(gatewayCostConfigured({ ...ENV, CLOUDFLARE_API_TOKEN: undefined })).toBe(false);
    expect(gatewayCostConfigured({ ...ENV, CLOUDFLARE_ACCOUNT_ID: "" })).toBe(false);
    expect(gatewayCostConfigured({ ...ENV, AI_GATEWAY_ID: undefined })).toBe(false);
  });
});

describe("fetchGatewayCost", () => {
  it("設定が無ければ API を呼ばず unconfigured", async () => {
    const api = fakeApi([]);
    const r = await fetchGatewayCost({ ...ENV, AI_GATEWAY_ID: undefined }, TASK, 1, {
      fetch: api.f,
    });
    expect(r).toEqual({ state: "unconfigured" });
    expect(api.urls).toHaveLength(0);
  });

  it("URL・filters・per_page・Authorization の書式", async () => {
    const api = fakeApi([log(0.5)]);
    await fetchGatewayCost(ENV, TASK, 1, { fetch: api.f });
    const u = api.urls[0] as URL;
    expect(u.origin + u.pathname).toBe(
      "http://cf.example/client/v4/accounts/acct-example/ai-gateway/gateways/gw-example/logs",
    );
    expect(JSON.parse(u.searchParams.get("filters") ?? "null")).toEqual([
      { key: "metadata.value", operator: "eq", value: [TASK] },
    ]);
    expect(u.searchParams.get("per_page")).toBe("50");
    expect(api.headers[0]).toBe("Bearer token-example");
  });

  it("全ページを読んで cost を合計する（マイクロドルに丸める）", async () => {
    const logs = Array.from({ length: 120 }, () => log(0.01));
    const api = fakeApi(logs);
    const r = await fetchGatewayCost(ENV, TASK, 120, { fetch: api.f });
    expect(api.urls.map((u) => u.searchParams.get("page"))).toEqual(["1", "2", "3"]);
    expect(r).toEqual({ state: "confirmed", micro: 1_200_000 });
  });

  it("metadata の taskId が一致するものだけ数える（別のキーで value が一致したものは除く）", async () => {
    const other = log(9, { metadata: JSON.stringify({ userId: TASK, taskId: "other" }) });
    const broken = log(9, { metadata: "not json" });
    const none = log(9, { metadata: undefined });
    const api = fakeApi([log(0.25), other, broken, none, log(0.25)]);
    const r = await fetchGatewayCost(ENV, TASK, 2, { fetch: api.f });
    expect(r).toEqual({ state: "confirmed", micro: 500_000 });
  });

  it("metadata がオブジェクトで返っても読める（本番の形）", async () => {
    const o = (cost: number) => log(cost, { metadata: { userId: "1", taskId: TASK } });
    const other = log(9, { metadata: { taskId: "other" } });
    const r = await fetchGatewayCost(ENV, TASK, 2, { fetch: fakeApi([o(0.25), other, o(0.25)]).f });
    expect(r).toEqual({ state: "confirmed", micro: 500_000 });
  });

  it("metadata が文字列でもオブジェクトでも混在して読める", async () => {
    const obj = log(0.1, { metadata: { taskId: TASK } });
    const str = log(0.2, { metadata: JSON.stringify({ taskId: TASK }) });
    const r = await fetchGatewayCost(ENV, TASK, 2, { fetch: fakeApi([obj, str]).f });
    expect(r).toEqual({ state: "confirmed", micro: 300_000 });
  });

  it("caller が sandbox_scale のログは合計にも件数にも数えない", async () => {
    const work = log(0.5, { metadata: { taskId: TASK } });
    const scale = log(9, { metadata: { caller: "sandbox_scale", taskId: TASK } });
    const scaleStr = log(9, {
      metadata: JSON.stringify({ caller: "sandbox_scale", taskId: TASK }),
    });
    expect(
      await fetchGatewayCost(ENV, TASK, 1, { fetch: fakeApi([work, scale, scaleStr]).f }),
    ).toEqual({
      state: "confirmed",
      micro: 500_000,
    });
    // 件数にも数えない: 作業が 1 件しかなければ model_calls 2 には足りない
    expect(await fetchGatewayCost(ENV, TASK, 2, { fetch: fakeApi([work, scale]).f })).toEqual({
      state: "pending",
    });
    // sandbox_scale の cost 欠けで pending にならない
    const scaleNoCost = log(undefined, { metadata: { caller: "sandbox_scale", taskId: TASK } });
    expect(await fetchGatewayCost(ENV, TASK, 1, { fetch: fakeApi([work, scaleNoCost]).f })).toEqual(
      {
        state: "confirmed",
        micro: 500_000,
      },
    );
  });

  it("caller が review のログ（ワーカーレビュー）は数える", async () => {
    const work = log(0.5, { metadata: { taskId: TASK } });
    const review = log(0.25, { metadata: { caller: "review", taskId: TASK } });
    const r = await fetchGatewayCost(ENV, TASK, 2, { fetch: fakeApi([work, review]).f });
    expect(r).toEqual({ state: "confirmed", micro: 750_000 });
  });

  it("件数が model_calls に足りなければ pending", async () => {
    const api = fakeApi([log(0.1), log(0.1)]);
    expect(await fetchGatewayCost(ENV, TASK, 3, { fetch: api.f })).toEqual({ state: "pending" });
  });

  it("成功したログに cost が無ければ pending。失敗したログの cost 欠けは許す", async () => {
    expect(
      await fetchGatewayCost(ENV, TASK, 2, { fetch: fakeApi([log(0.1), log(undefined)]).f }),
    ).toEqual({ state: "pending" });
    expect(await fetchGatewayCost(ENV, TASK, 2, { fetch: fakeApi([log(null)]).f })).toEqual({
      state: "pending",
    });
    expect(
      await fetchGatewayCost(ENV, TASK, 2, {
        fetch: fakeApi([log(0.1), log(undefined, { success: false })]).f,
      }),
    ).toEqual({ state: "confirmed", micro: 100_000 });
  });

  it("API のエラー・例外・壊れた応答は pending（例外を投げない）", async () => {
    const r500 = (async () => new Response("x", { status: 500 })) as unknown as typeof fetch;
    const boom = (async () => {
      throw new Error("network");
    }) as unknown as typeof fetch;
    const bad = (async () => Response.json({ success: false })) as unknown as typeof fetch;
    for (const f of [r500, boom, bad]) {
      expect(await fetchGatewayCost(ENV, TASK, 1, { fetch: f })).toEqual({ state: "pending" });
    }
  });

  it("ログが 0 件のときは確定しない（model_calls が 0 でも）", async () => {
    expect(await fetchGatewayCost(ENV, TASK, 0, { fetch: fakeApi([]).f })).toEqual({
      state: "pending",
    });
  });
});

const CONSULT = "consult-01JTESTCONSULT0000000000000";
const clog = (cost: number | null | undefined, over: Log = {}): Log => ({
  success: true,
  ...(cost === undefined ? {} : { cost }),
  metadata: { userId: "1", consultId: CONSULT, caller: "consult" },
  ...over,
});

describe("fetchConsultGatewayCost", () => {
  it("設定が無ければ API を呼ばず unconfigured", async () => {
    const api = fakeApi([]);
    const r = await fetchConsultGatewayCost({ ...ENV, AI_GATEWAY_ID: undefined }, CONSULT, 1, {
      fetch: api.f,
    });
    expect(r).toEqual({ state: "unconfigured" });
    expect(api.urls).toHaveLength(0);
  });

  it("consultId で絞り、caller が consult で consultId が一致するログの cost を合計する", async () => {
    const api = fakeApi([clog(0.25)]);
    const r = await fetchConsultGatewayCost(ENV, CONSULT, 1, { fetch: api.f });
    expect(JSON.parse(api.urls[0]?.searchParams.get("filters") ?? "null")).toEqual([
      { key: "metadata.value", operator: "eq", value: [CONSULT] },
    ]);
    expect(r).toEqual({ state: "confirmed", micro: 250_000 });
  });

  it("文字列の metadata も読める。別の consultId・caller 違い・caller 無しは数えない", async () => {
    const str = clog(0.1, {
      metadata: JSON.stringify({ consultId: CONSULT, caller: "consult" }),
    });
    const otherId = clog(9, { metadata: { consultId: "consult-other", caller: "consult" } });
    const otherCaller = clog(9, { metadata: { consultId: CONSULT, caller: "review" } });
    const noCaller = clog(9, { metadata: { consultId: CONSULT } });
    const taskLike = clog(9, { metadata: { taskId: CONSULT } });
    const r = await fetchConsultGatewayCost(ENV, CONSULT, 1, {
      fetch: fakeApi([str, otherId, otherCaller, noCaller, taskLike]).f,
    });
    expect(r).toEqual({ state: "confirmed", micro: 100_000 });
  });

  it("件数が足りない・成功したログの cost が欠けるときは pending", async () => {
    expect(await fetchConsultGatewayCost(ENV, CONSULT, 1, { fetch: fakeApi([]).f })).toEqual({
      state: "pending",
    });
    expect(
      await fetchConsultGatewayCost(ENV, CONSULT, 1, { fetch: fakeApi([clog(undefined)]).f }),
    ).toEqual({ state: "pending" });
  });

  it("API のエラーは pending（例外にしない）", async () => {
    const f = (async () => new Response("x", { status: 500 })) as typeof fetch;
    expect(await fetchConsultGatewayCost(ENV, CONSULT, 1, { fetch: f })).toEqual({
      state: "pending",
    });
  });

  it("タスクの判定は変わらない: consult のログは taskId の照合に混ざらない", async () => {
    const r = await fetchGatewayCost(ENV, TASK, 1, { fetch: fakeApi([clog(9), log(0.5)]).f });
    expect(r).toEqual({ state: "confirmed", micro: 500_000 });
  });
});
