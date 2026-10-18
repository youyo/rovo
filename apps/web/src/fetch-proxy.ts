import { fetchWeb, WebFetchError, type WebFetchVia } from "agents/webfetch";
import { WebResearchError } from "./errors";
import { createRobotsChecker, type RobotsCache, USER_AGENT } from "./robots";
import type { BlockedReason } from "./types";
import { checkUrl } from "./url-policy";

/**
 * Fetch Proxy: `agents/webfetch` の `fetchWeb`（createDirectWebFetch + 期限）で1ページを取得する。
 *
 * webfetch が行うこと: GET のみ・Cookie / 資格情報なし・redirect を手動で辿って行き先ごとに再検証・https→http の拒否・
 * 本文のストリーム読み取りと上限・HTML/文書の Markdown 変換・bot チャレンジの検出（web_fetch_blocked）。
 * webfetch の検査は private / loopback / link-local / CGNAT / localhost / .internal と userinfo まで。
 *
 * ここで足すこと: スキーム・ポート（80/443）・`.local` を含む自前の URL ポリシーを「すべてのリクエスト（redirect の行き先を含む）」に
 * かけること、robots.txt の確認、上限の固定、エラーの分類。注入する `fetch` を包んで実現する。
 */

export const FETCH_LIMITS = {
  maxBytes: 2 * 1024 * 1024,
  timeoutMs: 20_000,
  maxRedirects: 5,
} as const;

export type FetchProxyDeps = {
  fetch: typeof fetch;
  /** Workers AI バインディング（HTML / 文書の Markdown 変換に使う） */
  ai: Ai;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  /** robots.txt のキャッシュ。省略すると isolate 共有（10 分）。テストでは新しい Map を渡す */
  robotsCache?: RobotsCache;
};

export type FetchOutcome =
  | {
      kind: "page";
      url: string;
      finalUrl: string;
      via: WebFetchVia;
      content: string;
      title?: string;
      httpStatus: number;
      contentType: string;
      redirects: string[];
    }
  | {
      kind: "blocked";
      reason: BlockedReason;
      url: string;
      detail: string;
    };

/** 注入する fetch の中で投げる。webfetch が cause に包むので、外で拾って blocked にする。 */
class BlockedByPolicy extends Error {
  override readonly name = "BlockedByPolicy";
  constructor(
    readonly reason: BlockedReason,
    message: string,
  ) {
    super(message);
  }
}

function findBlocked(error: unknown): BlockedByPolicy | undefined {
  let e: unknown = error;
  for (let i = 0; i < 5 && e; i++) {
    if (e instanceof BlockedByPolicy) return e;
    e = (e as { cause?: unknown }).cause;
  }
  return undefined;
}

function requestUrl(input: string | URL | Request): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

export async function fetchPage(
  request: { url: string },
  deps: FetchProxyDeps,
  signal?: AbortSignal,
): Promise<FetchOutcome> {
  const checked = checkUrl(request.url);
  if (!checked.ok) throw new WebResearchError("invalid_url", checked.message);

  const robots = createRobotsChecker({
    fetch: deps.fetch,
    cache: deps.robotsCache,
    assertUrl: (u) => {
      const c = checkUrl(u.href);
      if (!c.ok) throw new BlockedByPolicy("redirect_policy", c.message);
    },
  });

  // webfetch が実際に送るすべてのリクエスト（最初の URL と、redirect の行き先）がここを通る
  const guardedFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const c = checkUrl(requestUrl(input));
    if (!c.ok) throw new BlockedByPolicy("redirect_policy", c.message);
    const rc = await robots.check(c.url, init?.signal ?? undefined);
    if (!rc.allowed) {
      throw new BlockedByPolicy(
        rc.reason ?? "robots_disallowed",
        `robots.txt of ${c.url.origin} does not allow fetching ${c.url.pathname}.`,
      );
    }
    return deps.fetch(input, init);
  }) as typeof fetch;

  try {
    const page = await fetchWeb(
      { url: checked.url.href },
      {
        binding: deps.ai,
        fetch: guardedFetch,
        userAgent: USER_AGENT,
        maxBytes: deps.maxBytes ?? FETCH_LIMITS.maxBytes,
        maxRedirects: deps.maxRedirects ?? FETCH_LIMITS.maxRedirects,
        timeoutMs: deps.timeoutMs ?? FETCH_LIMITS.timeoutMs,
        signal,
      },
    );
    return {
      kind: "page",
      url: request.url,
      finalUrl: page.finalUrl,
      via: page.via,
      content: page.content,
      ...(page.title ? { title: page.title } : {}),
      httpStatus: page.status,
      contentType: page.contentType,
      redirects: page.redirects,
    };
  } catch (error) {
    const blocked = findBlocked(error);
    if (blocked) {
      return { kind: "blocked", reason: blocked.reason, url: request.url, detail: blocked.message };
    }
    if (error instanceof WebFetchError) {
      switch (error.code) {
        case "web_fetch_blocked":
          return {
            kind: "blocked",
            reason: "bot_challenge",
            url: request.url,
            detail: error.message,
          };
        case "web_fetch_disallowed_redirect":
          return {
            kind: "blocked",
            reason: "redirect_policy",
            url: request.url,
            detail: error.message,
          };
        case "web_fetch_disallowed_url":
        case "invalid_web_fetch_input":
          throw new WebResearchError("invalid_url", error.message, { cause: error });
        case "web_fetch_too_many_redirects":
          throw new WebResearchError("too_many_redirects", error.message, { cause: error });
        case "web_fetch_timeout":
          throw new WebResearchError("timeout", error.message, { cause: error });
        case "web_fetch_too_large":
          throw new WebResearchError("too_large", error.message, { cause: error });
        case "web_fetch_unavailable":
          throw new WebResearchError("unavailable", error.message, { cause: error });
        default:
          throw new WebResearchError("fetch_failed", error.message, { cause: error });
      }
    }
    throw error;
  }
}
