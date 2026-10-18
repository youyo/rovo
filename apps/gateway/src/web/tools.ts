import type { WebFetchResponse, WebSafety, WebSearchResponse } from "./contract";
import { wrapUntrustedWeb } from "./untrusted";

/** web が一時的に使えないときにクライアントへ示す待ち時間。 */
export const WEB_UPSTREAM_RETRY_AFTER_SECONDS = 30;

/** 検索結果 1 件。url は検査済み。title / content（description）は非信頼データなのでマーカーで囲む。 */
export type ShapedSearchResult = {
  results: {
    url: string;
    title: string;
    content: string | null;
    safety: WebSafety;
  }[];
  metadata: { request_id: string; provider: string | null; dropped_urls: number };
};

export function shapeSearchResult(r: WebSearchResponse): ShapedSearchResult {
  return {
    results: r.results.map((i) => ({
      url: i.source.url,
      title: wrapUntrustedWeb(i.title),
      content: i.content === null ? null : wrapUntrustedWeb(i.content),
      safety: i.safety,
    })),
    metadata: {
      request_id: r.metadata.requestId,
      provider: r.metadata.provider,
      dropped_urls: r.metadata.dropped_urls,
    },
  };
}

/** web_fetch の応答。content / title は非信頼データなのでマーカーで囲む。source と safety は web の値のまま。 */
export type ShapedFetchResult = Omit<WebFetchResponse, "content" | "title"> & {
  content: string | null;
  title?: string;
};

export function shapeFetchResult(r: WebFetchResponse): ShapedFetchResult {
  const { content, title, ...rest } = r;
  return {
    ...rest,
    content: content === null ? null : wrapUntrustedWeb(content),
    ...(title !== undefined && title !== "" ? { title: wrapUntrustedWeb(title) } : {}),
  };
}

export type WebToolError = {
  code: "invalid_input" | "upstream_unavailable" | "internal";
  message: string;
  retry_after_seconds?: number;
};

const MAX_PASSTHROUGH = 200;

/**
 * web の RPC のエラーを MCP のエラーに写す。RPC 越しに届くのは message だけなので、先頭の "code: " で分類する。
 * 呼び出し側（親）が入力した値に関する検査のメッセージ（invalid_request / invalid_url）だけを返し、
 * それ以外は固定の文言にする（取得先が決めうる文字列を、親のモデルに渡さない）。
 */
export function mapWebError(e: unknown): WebToolError {
  const message = e instanceof Error ? e.message : "";
  const m = /^([a-z_]+): ([\s\S]*)$/.exec(message);
  const code = m?.[1];
  const detail = (m?.[2] ?? "").slice(0, MAX_PASSTHROUGH);
  const unavailable: WebToolError = {
    code: "upstream_unavailable",
    message: "web research is temporarily unavailable; retry later",
    retry_after_seconds: WEB_UPSTREAM_RETRY_AFTER_SECONDS,
  };
  switch (code) {
    case "invalid_request":
    case "invalid_url":
      return { code: "invalid_input", message: detail };
    case "too_large":
      return { code: "invalid_input", message: "the page is too large to fetch" };
    case "too_many_redirects":
      return { code: "invalid_input", message: "the page redirected too many times" };
    case "search_failed":
    case "timeout":
    case "unavailable":
    case "fetch_failed":
      return unavailable;
    case "misconfigured":
    case "not_implemented":
      return { code: "internal", message: "web research service is not available" };
    default:
      break;
  }
  const flags = (e ?? {}) as { retryable?: unknown; overloaded?: unknown };
  if (flags.retryable === true || flags.overloaded === true) return unavailable;
  return { code: "internal", message: "internal error" };
}
