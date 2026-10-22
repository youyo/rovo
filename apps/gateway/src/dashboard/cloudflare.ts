import { CLOUDFLARE_RANGES, type CloudflareSummaryDto } from "@rovo/dashboard-contract";
import { buildCostEstimate } from "./cloudflare-pricing";

/**
 * ダッシュボードの Cloudflare の概要（docs/specs/dashboard.md M9 / D13）。
 *
 * - GraphQL Analytics API（POST /client/v4/graphql）に、**このファイルの定数のクエリ**だけを送る。アカウント ID・Worker 名・
 *   gateway id・期間は variables で渡し、クエリの文字列には入れない。クライアントは range（1h / 24h / 7d）しか選べない
 * - データセット（Cloudflare の GraphQL スキーマで確認）:
 *   containersMetricsAdaptiveGroups（sum.allocatedCpu = vCPU 秒 / sum.allocatedMemory = バイト秒 / dimensions.instanceId）、
 *   workersInvocationsAdaptive（sum.requests / sum.errors。filter.scriptName_in）、
 *   aiGatewayRequestsAdaptiveGroups（count / sum.cost / sum.cachedRequests / sum.erroredRequests。filter.gateway）、
 *   aiInferenceAdaptiveGroups（sum.totalNeurons = Workers AI）。AI Gateway のログ（prompt / body / metadata）は取らない
 * - 推定の金額（`cost_estimate`）: 単価 × 使用量。**無料枠・プランに含まれる分を引く前**の推定で、AI Gateway の費用を含む合計。
 *   単価・出典・確認日は `cloudflare-pricing.ts` の定数だけ。取れない項目は推定 null で合計に含めない。コンテナのディスクは取っていない
 * - クレジット残高: GET /accounts/{id}/ai-gateway/billing/credit-balance（AI Gateway Read で読める）
 * - トークン: secret の CLOUDFLARE_API_TOKEN（Terraform の cloudflare_api_token.ai_gateway_read。AI Gateway Read + Account Analytics Read）。
 *   Authorization ヘッダだけに載せ、応答・ログ・エラーに出さない
 * - 項目ごとに fail-soft: 403 / authz → forbidden、5xx・429・時間切れ・壊れた応答 → unavailable、設定が無い → not_configured、
 *   形が合わない・欠け・null → empty。全面が失敗しても 200 で DTO を返す
 * - キャッシュ: この isolate のメモリに、整形済みの DTO（ただのデータ）だけを置く。全員で共有（閲覧者に依らない集計）。
 *   成功は 45 秒、unavailable を含むときは 5 秒。**別リクエストの Promise は待たない**（workerd で他リクエストの I/O を待つと
 *   TypeError になりうる）ので、同時に切れたときは各リクエストが取りに行く（TTL が上限を決める）。束ねるのは同じリクエストの中の 5 本の並列だけ
 */

export type CloudflareRange = (typeof CLOUDFLARE_RANGES)[number];

export type CloudflareEnv = {
  ENVIRONMENT?: string;
  CLOUDFLARE_API_TOKEN?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  AI_GATEWAY_ID?: string;
  /** rovo の Worker 名（カンマ区切り。秘密ではない）。Workers のリクエスト数の対象 */
  WORKER_NAMES?: string;
  /** ENVIRONMENT=test のときだけ有効な接続先（偽サーバー） */
  CLOUDFLARE_API_BASE?: string;
};

export interface CloudflareDeps {
  fetch?: typeof fetch;
  now?: () => number;
}

const API_BASE = "https://api.cloudflare.com/client/v4";
const FETCH_TIMEOUT_MS = 3000;
const OK_TTL_MS = 45_000;
const FAILED_TTL_MS = 5_000;
const MAX_ENTRIES = 16;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const WORKER_NAME_RE = /^[A-Za-z0-9_-]{1,63}$/;
const MAX_WORKERS = 10;
const GIB = 2 ** 30;

const SPAN_MS: Record<CloudflareRange, number> = {
  "1h": 3_600_000,
  "24h": 86_400_000,
  "7d": 604_800_000,
};

/** range の検査。省略は 24h、列挙以外は null（400）。 */
export function parseCloudflareRange(raw: string | null): CloudflareRange | null {
  if (raw === null) return "24h";
  return (CLOUDFLARE_RANGES as readonly string[]).includes(raw) ? (raw as CloudflareRange) : null;
}

/** 固定のクエリ（定数）。値はすべて variables。読み取り専用で、AI Gateway のログ（prompt / body）は選ばない。 */
export const CLOUDFLARE_QUERIES = {
  containers: `query ContainersSummary($accountTag: string!, $start: Time!, $end: Time!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      containers: containersMetricsAdaptiveGroups(limit: 1000, filter: { datetime_geq: $start, datetime_leq: $end }) {
        dimensions { instanceId }
        sum { allocatedCpu allocatedMemory }
      }
    }
  }
}`,
  workers: `query WorkersSummary($accountTag: string!, $start: Time!, $end: Time!, $scripts: [string!]) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      workers: workersInvocationsAdaptive(limit: 10, filter: { scriptName_in: $scripts, datetime_geq: $start, datetime_leq: $end }) {
        sum { requests errors }
      }
    }
  }
}`,
  aiGateway: `query AiGatewaySummary($accountTag: string!, $start: Time!, $end: Time!, $gateway: string!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      aiGateway: aiGatewayRequestsAdaptiveGroups(limit: 10, filter: { gateway: $gateway, datetime_geq: $start, datetime_leq: $end }) {
        count
        sum { cost cachedRequests erroredRequests }
      }
    }
  }
}`,
  workersAi: `query WorkersAiSummary($accountTag: string!, $start: Time!, $end: Time!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      workersAi: aiInferenceAdaptiveGroups(limit: 10, filter: { datetime_geq: $start, datetime_leq: $end }) {
        sum { totalNeurons }
      }
    }
  }
}`,
} as const;

type Reason = "forbidden" | "unavailable" | "not_configured" | "empty";
type Item<T> = { ok: true; value: T } | { ok: false; reason: Reason };
type Period = { start: string; end: string };

class ItemFailure extends Error {
  constructor(
    readonly reason: Reason,
    readonly status?: number,
  ) {
    super(reason); // メッセージは理由コードだけ（上流の本文・トークンを持たない）
  }
}

const fail = (reason: Reason): { ok: false; reason: Reason } => ({ ok: false, reason });

// --- 上流の呼び出し ---

type Ctx = {
  base: string;
  token: string;
  account: string;
  doFetch: typeof fetch;
};

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    throw new ItemFailure("unavailable", res.status);
  }
}

async function request(ctx: Ctx, url: string, init: { method: string; body?: string }) {
  let res: Response;
  try {
    res = await ctx.doFetch(url, {
      method: init.method,
      headers: {
        authorization: `Bearer ${ctx.token}`,
        accept: "application/json",
        ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(init.body !== undefined ? { body: init.body } : {}),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch {
    // 例外のメッセージにはトークンや URL が入りうるので読まない（時間切れ・接続失敗は unavailable）
    throw new ItemFailure("unavailable");
  }
  if (res.status === 401 || res.status === 403) {
    await res.body?.cancel().catch(() => {});
    throw new ItemFailure("forbidden", res.status);
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new ItemFailure("unavailable", res.status);
  }
  return readJson(res);
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** GraphQL を 1 本呼び、`viewer.accounts[0][alias]` の配列を返す。権限の無さ → forbidden、その他の errors → unavailable、形が違う → empty。 */
async function graphql(
  ctx: Ctx,
  query: string,
  variables: Record<string, unknown>,
  alias: string,
): Promise<Record<string, unknown>[]> {
  const body = await request(ctx, `${ctx.base}/graphql`, {
    method: "POST",
    body: JSON.stringify({ query, variables: { accountTag: ctx.account, ...variables } }),
  });
  if (!isObj(body)) throw new ItemFailure("empty");
  if (Array.isArray(body.errors) && body.errors.length > 0) {
    const denied = body.errors.some((e) => {
      if (!isObj(e)) return false;
      const code = isObj(e.extensions) ? e.extensions.code : undefined;
      return (
        code === "authz" ||
        (typeof e.message === "string" &&
          /does not have access|not authorized|unauthorized/i.test(e.message))
      );
    });
    throw new ItemFailure(denied ? "forbidden" : "unavailable", 200);
  }
  const data = isObj(body.data) ? body.data : null;
  const viewer = data && isObj(data.viewer) ? data.viewer : null;
  const accounts = viewer && Array.isArray(viewer.accounts) ? viewer.accounts : null;
  const account = accounts?.[0];
  const rows = isObj(account) ? account[alias] : undefined;
  if (!Array.isArray(rows)) throw new ItemFailure("empty");
  return rows.filter(isObj);
}

/** 0 以上の有限な数だけ。欠け（undefined）は 0 として足してよいが、null・文字列・負・NaN は形が違う。 */
function num(v: unknown): number {
  if (v === undefined) return 0;
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) throw new ItemFailure("empty");
  return v;
}

const sumOf = (row: Record<string, unknown>): Record<string, unknown> =>
  isObj(row.sum) ? row.sum : {};

// --- 項目ごとの集計 ---

async function containers(ctx: Ctx, vars: Record<string, unknown>, period: Period) {
  const rows = await graphql(ctx, CLOUDFLARE_QUERIES.containers, vars, "containers");
  let cpu = 0;
  let mem = 0;
  const instances = new Set<string>();
  for (const r of rows) {
    const s = sumOf(r);
    cpu += num(s.allocatedCpu);
    mem += num(s.allocatedMemory);
    const id = isObj(r.dimensions) ? r.dimensions.instanceId : undefined;
    instances.add(typeof id === "string" ? id : `row-${instances.size}`);
  }
  return {
    period,
    running_instances: instances.size,
    vcpu_seconds: cpu,
    memory_gib_seconds: mem / GIB,
  };
}

async function workers(ctx: Ctx, vars: Record<string, unknown>, period: Period) {
  const rows = await graphql(ctx, CLOUDFLARE_QUERIES.workers, vars, "workers");
  let requests = 0;
  let errors = 0;
  for (const r of rows) {
    const s = sumOf(r);
    requests += num(s.requests);
    errors += num(s.errors);
  }
  return { period, requests: Math.round(requests), errors: Math.round(errors) };
}

async function aiGateway(ctx: Ctx, vars: Record<string, unknown>, period: Period) {
  const rows = await graphql(ctx, CLOUDFLARE_QUERIES.aiGateway, vars, "aiGateway");
  let requests = 0;
  let cached = 0;
  let errors = 0;
  let cost = 0;
  for (const r of rows) {
    const s = sumOf(r);
    requests += num(r.count);
    cached += num(s.cachedRequests);
    errors += num(s.erroredRequests);
    cost += num(s.cost);
  }
  return {
    period,
    requests: Math.round(requests),
    cached_requests: Math.round(cached),
    errors: Math.round(errors),
    cost_usd: cost,
  };
}

async function workersAi(ctx: Ctx, vars: Record<string, unknown>, period: Period) {
  const rows = await graphql(ctx, CLOUDFLARE_QUERIES.workersAi, vars, "workersAi");
  let neurons = 0;
  for (const r of rows) neurons += num(sumOf(r).totalNeurons);
  return { period, neurons };
}

/** AI Gateway のクレジット残高（Unified Billing）。残高の数値だけを読む（支払い方法・自動チャージの設定は読まない）。単位は USD として扱う。 */
async function creditBalance(ctx: Ctx) {
  const body = await request(
    ctx,
    `${ctx.base}/accounts/${ctx.account}/ai-gateway/billing/credit-balance`,
    {
      method: "GET",
    },
  );
  const result = isObj(body) && body.success === true && isObj(body.result) ? body.result : null;
  const balance = result?.balance;
  if (typeof balance !== "number" || !Number.isFinite(balance) || balance < 0) {
    throw new ItemFailure("empty");
  }
  return { balance_usd: balance };
}

// --- 組み立て ---

async function settle<T>(name: string, run: () => Promise<T>): Promise<Item<T>> {
  try {
    return { ok: true, value: await run() };
  } catch (e) {
    const failure = e instanceof ItemFailure ? e : new ItemFailure("unavailable");
    // 項目名・理由コード・HTTP ステータスだけを記録する（トークン・URL・上流の本文は出さない）
    console.error("dashboard_cloudflare_item_failed", name, failure.reason, failure.status ?? "-");
    return fail(failure.reason);
  }
}

function parseWorkerNames(raw: string | undefined): string[] | null {
  const names = (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  if (names.length === 0 || names.length > MAX_WORKERS) return null;
  return names.every((n) => WORKER_NAME_RE.test(n)) ? names : null;
}

type CacheEntry = { expires: number; dto: CloudflareSummaryDto };
const cache = new Map<string, CacheEntry>();

/** テスト用: キャッシュを空にする（ENVIRONMENT=test の /__test/dashboard-cloudflare/reset も使う）。 */
export function resetCloudflareSummaryCache(): void {
  cache.clear();
}

/**
 * 集計の DTO を作る（キャッシュあり）。例外を投げない（上流の失敗は項目ごとの reason にする）。
 * 呼び出し側（api.ts）が認証・range の検査をしてから呼ぶ。
 */
export async function loadCloudflareSummary(
  env: CloudflareEnv,
  range: CloudflareRange,
  deps: CloudflareDeps = {},
): Promise<CloudflareSummaryDto> {
  const now = (deps.now ?? Date.now)();
  const token = env.CLOUDFLARE_API_TOKEN;
  const account = env.CLOUDFLARE_ACCOUNT_ID;
  const gateway = env.AI_GATEWAY_ID;
  const workerNames = parseWorkerNames(env.WORKER_NAMES);
  const accountOk = !!token && !!account && ID_RE.test(account);
  const gatewayOk = !!gateway && ID_RE.test(gateway);

  const key = JSON.stringify([account ?? "", gateway ?? "", env.WORKER_NAMES ?? "", range]);
  const hit = cache.get(key);
  if (hit && hit.expires > now) return hit.dto;

  const period: Period = {
    start: new Date(now - SPAN_MS[range]).toISOString(),
    end: new Date(now).toISOString(),
  };
  const ctx: Ctx | null = accountOk
    ? {
        base:
          env.ENVIRONMENT === "test" && env.CLOUDFLARE_API_BASE
            ? env.CLOUDFLARE_API_BASE
            : API_BASE,
        token: token as string,
        account: account as string,
        doFetch: (input, init) => (deps.fetch ?? fetch)(input, init), // fetch を ctx のメソッドとして呼ぶと workerd で Illegal invocation になる
      }
    : null;
  const vars = { start: period.start, end: period.end };

  const run = <T>(
    name: string,
    configured: boolean,
    f: (c: Ctx) => Promise<T>,
  ): Promise<Item<T>> =>
    ctx && configured ? settle(name, () => f(ctx)) : Promise.resolve(fail("not_configured"));

  // 同じリクエストの中で 5 本を並列に呼ぶ（別リクエストの Promise は待たない）
  const [c, w, g, ai, credit] = await Promise.all([
    run("containers", true, (x) => containers(x, vars, period)),
    run("workers", workerNames !== null, (x) =>
      workers(x, { ...vars, scripts: workerNames }, period),
    ),
    run("ai_gateway", gatewayOk, (x) => aiGateway(x, { ...vars, gateway }, period)),
    run("workers_ai", true, (x) => workersAi(x, vars, period)),
    run("credit_balance", true, (x) => creditBalance(x)),
  ]);

  const dto: CloudflareSummaryDto = {
    generated_at: new Date(now).toISOString(),
    range,
    // アカウント ID を含む URL は DTO に載せない（画面側が dash.cloudflare.com のトップへのリンクにする）
    open_url: null,
    containers: c,
    workers: w,
    ai_gateway: g,
    workers_ai: ai,
    credit_balance: credit,
    cost_estimate: buildCostEstimate({
      workersRequests: w.ok ? w.value.requests : null,
      vcpuSeconds: c.ok ? c.value.vcpu_seconds : null,
      memoryGibSeconds: c.ok ? c.value.memory_gib_seconds : null,
      diskGbSeconds: null, // ディスクの使用量は GraphQL で取っていない（合計に含まれず excluded_items に出る）
      neurons: ai.ok ? ai.value.neurons : null,
      aiGatewayCostUsd: g.ok ? g.value.cost_usd : null,
    }),
  };

  const unavailable = [c, w, g, ai, credit].some((i) => !i.ok && i.reason === "unavailable");
  if (cache.size >= MAX_ENTRIES) {
    for (const [k, e] of cache) if (e.expires <= now) cache.delete(k);
    if (cache.size >= MAX_ENTRIES) cache.clear();
  }
  cache.set(key, { expires: now + (unavailable ? FAILED_TTL_MS : OK_TTL_MS), dto });
  return dto;
}
