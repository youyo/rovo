import { preflightHost } from "./dns-check";
import { WebResearchError } from "./errors";
import { createRobotsChecker, type RobotsCache } from "./robots";
import type { BlockedReason, UnknownReason } from "./types";
import { checkUrl } from "./url-policy";

/**
 * Browse: Browser Run の Kitesurf（`env.BROWSER.quickAction("markdown", ...)`）で、JS 描画後のページを Markdown で取得する。
 *
 * 保証するのは「禁止先・判定不能の取得結果を返さない」ことまで（返却の抑止）。
 * 取得は Browser Run の側で済んでいるので、禁止先への通信が発生しないことは保証できない
 * （iframe・meta refresh・JS 遷移・popup・service worker・data: / blob:・A→B→A など。詳細は phase5.md）。
 *
 * 取得前: URL の検査（checkUrl）・DoH による解決先の検査（補助）・robots.txt。
 * 取得後: エンベロープを fail-closed で解釈する（interpretEnvelope。分岐表は phase5.md）。
 */

export const BROWSE_LIMITS = {
  /** Response の上限。web_fetch の maxBytes（FETCH_LIMITS.maxBytes）と同じ */
  maxResponseBytes: 2 * 1024 * 1024,
  /** 全体の期限。gotoOptions.timeout（30 秒）に余裕を足したもの */
  deadlineMs: 45_000,
  navigationTimeoutMs: 30_000,
} as const;

/** エラー応答（400 / 422 など）の本文は、コードを読むだけなので小さく読む */
const MAX_ERROR_BODY_BYTES = 64 * 1024;
const NAVIGATION_TIMEOUT_CODE = 6002;

/** quickAction("markdown", ...) だけを使うので、その形だけを要求する（テストでは fake を渡す） */
export type BrowserLike = {
  quickAction(action: "markdown", options: QuickActionOptions): Promise<Response>;
};

export type QuickActionOptions = {
  browser: "kitesurf";
  url: string;
  gotoOptions: { timeout: number };
  allowRequestPattern: string[];
  rejectResourceTypes: ("image" | "media" | "font")[];
};

export type BrowseDeps = {
  browser: BrowserLike;
  /** DoH と robots.txt の取得に使う fetch */
  fetch: typeof fetch;
  robotsCache?: RobotsCache;
  maxResponseBytes?: number;
  deadlineMs?: number;
};

export type BrowseOutcome =
  | { kind: "page"; finalUrl: string; markdown: string; title?: string }
  | { kind: "blocked"; reason: BlockedReason }
  | { kind: "http_error"; httpStatus: number }
  | { kind: "unknown"; reason: UnknownReason };

const unknown = (reason: UnknownReason): BrowseOutcome => ({ kind: "unknown", reason });
const blocked = (reason: BlockedReason): BrowseOutcome => ({ kind: "blocked", reason });

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * quickAction へ渡す引数。呼び出し元が指定できるのは url だけで、他はすべて固定。
 * url: のみ（html: は使わない。finalUrl が付かず、検査できないため）。
 * allowRequestPattern / rejectResourceTypes はサブリソースにだけ効く補助層で、トップレベルの URL とリダイレクト先には効かない。
 */
export function buildQuickActionOptions(input: URL): QuickActionOptions {
  const url = new URL(input.href);
  url.hash = "";
  return {
    browser: "kitesurf",
    url: url.href,
    gotoOptions: { timeout: BROWSE_LIMITS.navigationTimeoutMs },
    allowRequestPattern: [`^https?://${escapeRegExp(url.hostname)}(:443|:80)?/`],
    rejectResourceTypes: ["image", "media", "font"],
  };
}

// ---- エンベロープの解釈（純関数）----

/** ヘッダー名は大文字小文字を区別せずに引く。meta.headers がオブジェクトでなければ空。 */
function headerValues(headers: unknown, name: string): string[] {
  if (typeof headers !== "object" || headers === null || Array.isArray(headers)) return [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() !== name) continue;
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v)) for (const x of v) if (typeof x === "string") out.push(x);
  }
  return out;
}

/** cf-mitigated の値（カンマ区切り）に challenge が含まれるか。値は trim・大文字小文字無視。 */
function isChallenge(headers: unknown): boolean {
  return headerValues(headers, "cf-mitigated").some((v) =>
    v
      .split(",")
      .map((t) => t.trim().toLowerCase())
      .includes("challenge"),
  );
}

type Parsed = { ok: true; url: URL } | { ok: false; verdict: "malformed" | "forbidden" };

/** 文字列の URL を checkUrl にかける。URL として読めないものは malformed、ポリシー違反は forbidden。 */
function parseCheckedUrl(value: unknown): Parsed {
  if (typeof value !== "string" || value.trim() === "") return { ok: false, verdict: "malformed" };
  const c = checkUrl(value);
  if (c.ok) return { ok: true, url: c.url };
  return { ok: false, verdict: c.reason === "invalid_url" ? "malformed" : "forbidden" };
}

/**
 * quickAction の JSON エンベロープ（success が true と確かめた後のもの）を解釈する。
 * 通常成功は「meta.status が 200〜299 の整数」かつ「finalUrl が妥当で許可内」かつ「result が文字列」のときだけ。
 * それ以外は blocked / http_error / unknown で、本文を返さない。上から順に判定する（phase5.md の分岐表）。
 */
export function interpretEnvelope(requested: URL, envelope: unknown): BrowseOutcome {
  const env =
    typeof envelope === "object" && envelope !== null ? (envelope as Record<string, unknown>) : {};
  const meta =
    typeof env.meta === "object" && env.meta !== null && !Array.isArray(env.meta)
      ? (env.meta as Record<string, unknown>)
      : undefined;
  if (!meta) return unknown("invalid_status");

  // bot チャレンジは meta.status を問わず返さない（agents/webfetch と同じ）
  if (isChallenge(meta.headers)) return blocked("bot_challenge");

  const status = meta.status;
  if (typeof status !== "number" || !Number.isInteger(status) || status < 200 || status > 599) {
    return unknown("invalid_status");
  }
  if (status >= 300 && status < 400) return unknown("invalid_status");
  if (status >= 400) return { kind: "http_error", httpStatus: status };

  // finalUrl: 必須。要求 URL と正規化後（href）に等しければ検査済み。等しくなくても同じ関数で検査する
  const final = parseCheckedUrl(meta.finalUrl);
  if (!final.ok && final.verdict === "malformed") return unknown("invalid_final_url");

  // redirectChain: 欠落と [] はリダイレクトなし。それ以外が壊れていたら判定できない
  const rawChain = meta.redirectChain;
  const hops: URL[] = [];
  let chainForbidden = false;
  if (rawChain !== undefined) {
    if (!Array.isArray(rawChain)) return unknown("invalid_redirect_chain");
    for (const hop of rawChain) {
      const url =
        typeof hop === "object" && hop !== null ? (hop as { url?: unknown }).url : undefined;
      const p = parseCheckedUrl(url);
      if (p.ok) hops.push(p.url);
      else if (p.verdict === "malformed") return unknown("invalid_redirect_chain");
      else chainForbidden = true;
    }
  }

  if (!final.ok || chainForbidden) return blocked("redirect_policy");

  // 要求 → ホップ → … → finalUrl の隣り合う組に、https→http があれば拒否する（web_fetch と同じ）
  const path = [requested, ...hops, final.url];
  for (let i = 1; i < path.length; i++) {
    if ((path[i - 1] as URL).protocol === "https:" && (path[i] as URL).protocol === "http:") {
      return blocked("redirect_policy");
    }
  }

  if (typeof env.result !== "string") return unknown("invalid_result");

  return {
    kind: "page",
    finalUrl: final.url.href,
    markdown: env.result,
    ...(typeof meta.title === "string" && meta.title !== "" ? { title: meta.title } : {}),
  };
}

// ---- Response の読み取り ----

/** body をストリームで読み、上限を超えたら中断して too_large を投げる。 */
async function readTextCapped(res: Response, maxBytes: number): Promise<string> {
  const declared = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw new WebResearchError("too_large", "The rendered page response is too large.");
  }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new WebResearchError("too_large", "The rendered page response is too large.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }
  const all = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    all.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  try {
    const v = JSON.parse(text) as unknown;
    return typeof v === "object" && v !== null && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

const upstreamError = () =>
  new WebResearchError("upstream_error", "The browser service returned an unusable response.");

/** HTTP 非 2xx の応答を固定のエラーコードに写す（上流のメッセージは使わない）。 */
async function mapFailure(res: Response): Promise<WebResearchError> {
  let codes: unknown[] = [];
  if (res.status === 422) {
    try {
      const body = parseJsonObject(await readTextCapped(res, MAX_ERROR_BODY_BYTES));
      const errors = body?.errors;
      if (Array.isArray(errors)) {
        codes = errors.map((e) =>
          typeof e === "object" && e !== null ? (e as { code?: unknown }).code : undefined,
        );
      }
    } catch {
      // 読めなければ upstream_error
    }
  } else {
    await res.body?.cancel().catch(() => {});
  }
  if (res.status === 400) {
    return new WebResearchError("invalid_input", "The browser could not open the given URL.");
  }
  if (res.status === 422 && codes.includes(NAVIGATION_TIMEOUT_CODE)) {
    return new WebResearchError("navigation_timeout", "The page did not finish loading in time.");
  }
  return upstreamError();
}

function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new WebResearchError("timeout", "The browser did not respond in time.")),
      ms,
    );
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

// ---- 全体の流れ ----

export async function browsePage(
  request: { url: string },
  deps: BrowseDeps,
  signal?: AbortSignal,
): Promise<BrowseOutcome> {
  const checked = checkUrl(request.url);
  if (!checked.ok) throw new WebResearchError("invalid_url", checked.message);
  const requested = checked.url;

  // 補助: 解決先が private なら取得しない。検査できなかったときも取得しない（fail-closed）。web_fetch と同じ検査
  const pre = await preflightHost(requested.hostname, deps.fetch);
  if (pre) return pre;

  // robots.txt（指定された URL のオリジンだけ。リダイレクト先とサブリソースは確認できない）
  const robots = createRobotsChecker({
    fetch: deps.fetch,
    cache: deps.robotsCache,
    assertUrl: (u) => {
      const c = checkUrl(u.href);
      if (!c.ok) throw new Error("robots.txt redirected to a disallowed URL");
    },
  });
  const rc = await robots.check(requested, signal);
  if (!rc.allowed) return blocked(rc.reason ?? "robots_disallowed");

  const maxBytes = deps.maxResponseBytes ?? BROWSE_LIMITS.maxResponseBytes;
  const deadline = deps.deadlineMs ?? BROWSE_LIMITS.deadlineMs;

  const run = async (): Promise<BrowseOutcome> => {
    let res: Response;
    try {
      res = await deps.browser.quickAction("markdown", buildQuickActionOptions(requested));
    } catch {
      throw upstreamError();
    }
    if (!res.ok) throw await mapFailure(res);

    const body = parseJsonObject(await readTextCapped(res, maxBytes));
    // 外側が 2xx なのに success が true でない（false・欠落）、JSON でない: 使えない応答
    if (body?.success !== true) throw upstreamError();
    return interpretEnvelope(requested, body);
  };
  return withDeadline(run(), deadline);
}
