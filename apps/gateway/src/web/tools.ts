import type { WebBrowseResponse, WebFetchResponse, WebSafety, WebSearchResponse } from "./contract";
import { wrapUntrustedWeb } from "./untrusted";

/** web が一時的に使えないときにクライアントへ示す待ち時間。 */
export const WEB_UPSTREAM_RETRY_AFTER_SECONDS = 30;

/** 返す URL の長さの上限。web 側の入力の上限（MAX_URL_LENGTH）と同じ。超える URL は親のモデルに渡さない。 */
export const MAX_RETURNED_URL_LENGTH = 2000;
const URL_OMITTED = "[url omitted: too long]";

const clampUrl = (u: string): string => (u.length > MAX_RETURNED_URL_LENGTH ? URL_OMITTED : u);

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
  // 長すぎる URL の項目は落とす（切り詰めた URL は別のものを指すので返さない）
  const kept = r.results.filter((i) => i.source.url.length <= MAX_RETURNED_URL_LENGTH);
  return {
    results: kept.map((i) => ({
      url: i.source.url,
      title: wrapUntrustedWeb(i.title),
      content: i.content === null ? null : wrapUntrustedWeb(i.content),
      safety: i.safety,
    })),
    metadata: {
      request_id: r.metadata.requestId,
      provider: r.metadata.provider,
      dropped_urls: r.metadata.dropped_urls + (r.results.length - kept.length),
    },
  };
}

/** web_fetch の応答。content / title は非信頼データなのでマーカーで囲む。source と safety は web の値のまま。 */
export type ShapedFetchResult = Omit<WebFetchResponse, "content" | "title"> & {
  content: string | null;
  title?: string;
};

export function shapeFetchResult(r: WebFetchResponse): ShapedFetchResult {
  return shapePage(r);
}

/** web_browse の応答。web_fetch と同じ整形（content / title を囲み、長い URL を固定の文言にする）。 */
export type ShapedBrowseResult = Omit<WebBrowseResponse, "content" | "title"> & {
  content: string | null;
  title?: string;
};

export function shapeBrowseResult(r: WebBrowseResponse): ShapedBrowseResult {
  return shapePage(r);
}

function shapePage<
  R extends {
    content: string | null;
    title?: string;
    source: { url: string; final_url: string };
  },
>(r: R): Omit<R, "content" | "title"> & { content: string | null; title?: string } {
  const { content, title, source, ...rest } = r;
  return {
    ...rest,
    source: { ...source, url: clampUrl(source.url), final_url: clampUrl(source.final_url) },
    content: content === null ? null : wrapUntrustedWeb(content),
    ...(title !== undefined && title !== "" ? { title: wrapUntrustedWeb(title) } : {}),
  } as Omit<R, "content" | "title"> & { content: string | null; title?: string };
}

/**
 * web_browse を公開するか。WEB_BROWSE_ENABLED が "true"（前後の空白・大文字小文字は無視）のときだけ。
 * 未設定・空・誤記はすべて無効（ツールを tools/list に出さない）。
 */
export function isWebBrowseEnabled(env: { WEB_BROWSE_ENABLED?: unknown }): boolean {
  const v = env.WEB_BROWSE_ENABLED;
  return typeof v === "string" && v.trim().toLowerCase() === "true";
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
    case "invalid_input":
      // web_browse: ブラウザが開けない URL。上流の文字列は使わず、固定の文にする
      return { code: "invalid_input", message: "the URL could not be opened by the browser" };
    case "too_large":
      return { code: "invalid_input", message: "the page is too large to fetch" };
    case "too_many_redirects":
      return { code: "invalid_input", message: "the page redirected too many times" };
    case "search_failed":
    case "timeout":
    case "unavailable":
    case "fetch_failed":
    case "navigation_timeout":
    case "upstream_error":
      return unavailable;
    case "misconfigured":
    case "not_implemented":
    case "disabled":
      return { code: "internal", message: "web research service is not available" };
    default:
      break;
  }
  const flags = (e ?? {}) as { retryable?: unknown; overloaded?: unknown };
  if (flags.retryable === true || flags.overloaded === true) return unavailable;
  return { code: "internal", message: "internal error" };
}
