/**
 * タスクの費用の確定: Cloudflare AI Gateway の Logs API から、そのタスクのログの cost を合計する。
 *
 * - GET {base}/accounts/{account}/ai-gateway/gateways/{gateway}/logs
 *   クエリ: filters（JSON 文字列の配列 [{key:"metadata.value", operator:"eq", value:[taskId]}]）・per_page=50・page・order_by=created_at
 * - metadata（JSON 文字列）を読み、taskId が一致するログだけを数える（value の一致が別のキーで起きても混ざらない）
 * - 確定できる条件: 一致したログの件数 >= max(1, model_calls) で、success のログすべてに数値の cost がある
 * - 環境の設定（CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID / AI_GATEWAY_ID）が揃っていなければ何もしない
 * - API のエラー・例外・壊れた応答は「まだ」。例外は投げない。トークンは Authorization ヘッダだけに載せる
 */

export interface GatewayCostEnv {
  ENVIRONMENT?: string;
  CLOUDFLARE_API_TOKEN?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  AI_GATEWAY_ID?: string;
  /** ENVIRONMENT=test のときだけ有効な接続先（偽サーバー） */
  CLOUDFLARE_API_BASE?: string;
}

export type GatewayCostResult =
  | { state: "confirmed"; micro: number }
  | { state: "pending" }
  | { state: "unconfigured" };

const API_BASE = "https://api.cloudflare.com/client/v4";
const PER_PAGE = 50;
const MAX_PAGES = 200;
const FETCH_TIMEOUT_MS = 10_000;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function gatewayCostConfigured(env: GatewayCostEnv): boolean {
  return (
    !!env.CLOUDFLARE_API_TOKEN &&
    !!env.CLOUDFLARE_ACCOUNT_ID &&
    ID_RE.test(env.CLOUDFLARE_ACCOUNT_ID) &&
    !!env.AI_GATEWAY_ID &&
    ID_RE.test(env.AI_GATEWAY_ID)
  );
}

interface LogRow {
  success?: unknown;
  cost?: unknown;
  metadata?: unknown;
}

function taskIdOf(metadata: unknown): string | undefined {
  if (typeof metadata !== "string") return undefined;
  try {
    const v: unknown = JSON.parse(metadata);
    if (typeof v !== "object" || v === null) return undefined;
    const id = (v as Record<string, unknown>).taskId;
    return typeof id === "string" ? id : undefined;
  } catch {
    return undefined;
  }
}

export async function fetchGatewayCost(
  env: GatewayCostEnv,
  taskId: string,
  modelCalls: number,
  deps: { fetch?: typeof fetch } = {},
): Promise<GatewayCostResult> {
  if (!gatewayCostConfigured(env)) return { state: "unconfigured" };
  const base =
    env.ENVIRONMENT === "test" && env.CLOUDFLARE_API_BASE ? env.CLOUDFLARE_API_BASE : API_BASE;
  const url = `${base}/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/ai-gateway/gateways/${env.AI_GATEWAY_ID}/logs`;
  const filters = JSON.stringify([{ key: "metadata.value", operator: "eq", value: [taskId] }]);
  const doFetch = (input: string, init: RequestInit) => (deps.fetch ?? fetch)(input, init);
  let matched = 0;
  let sum = 0;
  let complete = true;
  try {
    let total = Number.POSITIVE_INFINITY;
    let seen = 0;
    for (let page = 1; page <= MAX_PAGES && seen < total; page++) {
      const q = new URLSearchParams({
        filters,
        per_page: String(PER_PAGE),
        page: String(page),
        order_by: "created_at",
        order_by_direction: "asc",
      });
      const res = await doFetch(`${url}?${q.toString()}`, {
        headers: { authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) return { state: "pending" };
      const body = (await res.json()) as {
        success?: unknown;
        result?: unknown;
        result_info?: { total_count?: unknown };
      };
      if (body.success === false || !Array.isArray(body.result)) return { state: "pending" };
      const t = body.result_info?.total_count;
      if (typeof t !== "number" || !Number.isFinite(t)) return { state: "pending" };
      total = t;
      const rows = body.result as LogRow[];
      if (rows.length === 0) break;
      seen += rows.length;
      for (const r of rows) {
        if (taskIdOf(r?.metadata) !== taskId) continue;
        matched++;
        if (typeof r.cost === "number" && Number.isFinite(r.cost) && r.cost >= 0) sum += r.cost;
        else if (r.success === true) complete = false;
      }
    }
  } catch {
    return { state: "pending" };
  }
  if (!complete || matched < Math.max(1, modelCalls)) return { state: "pending" };
  return { state: "confirmed", micro: Math.round(sum * 1_000_000) };
}
