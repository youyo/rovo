import type { ModelProvider } from "@rovo/models";

/**
 * AI Gateway に BYOK 登録されたプロバイダーキーの有無（D10b）。
 *
 * AI Gateway は byok_only（Require provider credentials）が有効で、Anthropic / OpenAI のキーが登録されていないと、
 * そのプロバイダーのモデルは 400 で失敗する。そこで Cloudflare API の List provider keys
 * （GET /accounts/{account_id}/ai-gateway/gateways/{gateway_id}/provider_configs。権限は Account / AI Gateway / Read だけ）で
 * 登録済みのキーを読み、キーが無いプロバイダーのモデルを選べなくする。
 *
 * 応答の形: { success, result: [{ provider_slug, alias, default_config, secret_preview, ... }] }。result_info は無く、
 * page / per_page（最大 100）で読む。AI バインディング経路が使うのは alias が "default" のキーだけなので、判定も default だけで行う。
 * 使うのは provider_slug と alias だけで、secret_preview（キーのマスク済みの表示）などは読まず、保持せず、ログにも出さない。
 *
 * キャッシュ: KV（OAUTH_KV）に { checkedAt, providers } だけを置く。fresh は 5 分。取得に失敗したら直前のキャッシュ
 * （24 時間まで）を使い、無ければ undefined（判定できない = 従来どおり AGENT_MODELS だけで決める）。
 */

export const PROVIDER_KEYS_FRESH_MS = 5 * 60_000;
/** 取得に失敗したときに使う古いキャッシュの上限 */
export const PROVIDER_KEYS_STALE_MAX_MS = 24 * 3600_000;
/** 取得に失敗したあと、この間は取り直さない（API が落ちているときにリクエストごとに待たない） */
export const PROVIDER_KEYS_RETRY_AFTER_MS = 60_000;

const API_BASE = "https://api.cloudflare.com/client/v4";
const PER_PAGE = 100;
const MAX_PAGES = 5;
const FETCH_TIMEOUT_MS = 3000;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const KEYED_PROVIDERS: readonly ModelProvider[] = ["anthropic", "openai"];

export type ProviderKeysEnv = {
  ENVIRONMENT?: string;
  /** Cloudflare API のトークン（Secret。Account / AI Gateway / Read だけ） */
  CLOUDFLARE_API_TOKEN?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  AI_GATEWAY_ID?: string;
  /** ENVIRONMENT=test のときだけ有効な API の接続先（偽サーバー） */
  CLOUDFLARE_API_BASE?: string;
  OAUTH_KV: KVNamespace;
};

export type ProviderKeysDeps = { fetch?: typeof fetch; now?: () => number };

type Record_ = { checkedAt: number; providers: string[] };
type Failure = { failedAt: number };

const inflight = new Map<string, Promise<ReadonlySet<ModelProvider> | undefined>>();

function isRecord(v: unknown): v is Record_ {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.checkedAt === "number" &&
    Array.isArray(r.providers) &&
    r.providers.every((p) => typeof p === "string")
  );
}

async function readJson(kv: KVNamespace, key: string): Promise<unknown> {
  try {
    return await kv.get(key, "json");
  } catch {
    return null; // KV の失敗はキャッシュが無いのと同じ
  }
}

async function writeJson(kv: KVNamespace, key: string, value: unknown, ttl: number) {
  try {
    await kv.put(key, JSON.stringify(value), { expirationTtl: ttl });
  } catch {
    // キャッシュの書き込み失敗で応答を壊さない
  }
}

/** 登録済みの default キーを持つプロバイダーを API から読む。失敗は undefined（理由は固定コードだけログに出す）。 */
async function fetchProviders(
  env: ProviderKeysEnv,
  account: string,
  gateway: string,
  token: string,
  doFetch: typeof fetch,
): Promise<string[] | undefined> {
  const base =
    env.ENVIRONMENT === "test" && env.CLOUDFLARE_API_BASE ? env.CLOUDFLARE_API_BASE : API_BASE;
  const found = new Set<string>();
  try {
    for (let page = 1; page <= MAX_PAGES; page++) {
      const url = `${base}/accounts/${account}/ai-gateway/gateways/${gateway}/provider_configs?page=${page}&per_page=${PER_PAGE}`;
      const res = await doFetch(url, {
        method: "GET",
        headers: { authorization: `Bearer ${token}`, accept: "application/json" },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) {
        await res.body?.cancel();
        console.error("provider_keys_fetch_failed", res.status);
        return undefined;
      }
      const body = (await res.json()) as { success?: unknown; result?: unknown };
      if (body.success !== true || !Array.isArray(body.result)) {
        console.error("provider_keys_fetch_failed", "bad_body");
        return undefined;
      }
      for (const entry of body.result as unknown[]) {
        if (typeof entry !== "object" || entry === null) continue;
        const { provider_slug: slug, alias } = entry as Record<string, unknown>;
        if (alias === "default" && typeof slug === "string") found.add(slug);
      }
      if (body.result.length < PER_PAGE) break;
    }
  } catch (e) {
    // 例外のメッセージにはトークンや URL が入りうるので、名前だけを出す
    console.error("provider_keys_fetch_failed", e instanceof Error ? e.name : typeof e);
    return undefined;
  }
  return [...found];
}

function toSet(providers: readonly string[]): ReadonlySet<ModelProvider> {
  return new Set(KEYED_PROVIDERS.filter((p) => providers.includes(p)));
}

/**
 * default キーが登録されているプロバイダー。API の設定が無い（トークン・account id・gateway id のどれかが空）・
 * 判定できない（取得に失敗してキャッシュも無い）ときは undefined（従来どおり AGENT_MODELS だけで決める）。
 */
export async function loadProviderKeys(
  env: ProviderKeysEnv,
  deps: ProviderKeysDeps = {},
): Promise<ReadonlySet<ModelProvider> | undefined> {
  const token = env.CLOUDFLARE_API_TOKEN;
  const account = env.CLOUDFLARE_ACCOUNT_ID;
  const gateway = env.AI_GATEWAY_ID;
  if (!token || !account || !gateway || !ID_RE.test(account) || !ID_RE.test(gateway)) {
    return undefined;
  }
  const now = (deps.now ?? Date.now)();
  const key = `provider-keys:${account}:${gateway}`;
  const failKey = `provider-keys-failed:${account}:${gateway}`;

  const raw = await readJson(env.OAUTH_KV, key);
  const cached =
    isRecord(raw) && now - raw.checkedAt <= PROVIDER_KEYS_STALE_MAX_MS ? raw : undefined;
  if (cached && now - cached.checkedAt < PROVIDER_KEYS_FRESH_MS) return toSet(cached.providers);

  const stale = () => (cached ? toSet(cached.providers) : undefined);
  const failed = (await readJson(env.OAUTH_KV, failKey)) as Failure | null;
  if (
    failed &&
    typeof failed.failedAt === "number" &&
    now - failed.failedAt < PROVIDER_KEYS_RETRY_AFTER_MS
  ) {
    return stale();
  }

  // 同じ isolate の同時リクエストは 1 回の取得にまとめる
  const flightKey = `${key}@${deps.fetch ? "injected" : "global"}`;
  const pending = inflight.get(flightKey);
  if (pending) return pending;
  const run = (async () => {
    const providers = await fetchProviders(env, account, gateway, token, deps.fetch ?? fetch);
    if (providers === undefined) {
      await writeJson(env.OAUTH_KV, failKey, { failedAt: now } satisfies Failure, 60);
      return stale();
    }
    await writeJson(
      env.OAUTH_KV,
      key,
      { checkedAt: now, providers } satisfies Record_,
      PROVIDER_KEYS_STALE_MAX_MS / 1000,
    );
    return toSet(providers);
  })().finally(() => inflight.delete(flightKey));
  inflight.set(flightKey, run);
  return run;
}

/** テスト用: キャッシュと失敗の記録を消す（ENVIRONMENT=test の /__test/provider-keys/reset が使う）。 */
export async function resetProviderKeysCache(kv: KVNamespace): Promise<void> {
  for (const prefix of ["provider-keys:", "provider-keys-failed:"]) {
    for (;;) {
      const page = await kv.list({ prefix });
      for (const k of page.keys) await kv.delete(k.name);
      if (page.list_complete) break;
    }
  }
}
