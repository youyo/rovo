export type WebResearchErrorCode =
  | "invalid_request"
  | "misconfigured"
  | "not_implemented"
  | "invalid_url"
  | "search_failed"
  | "timeout"
  | "too_large"
  | "too_many_redirects"
  | "unavailable"
  | "fetch_failed";

/**
 * RPC 越しには message と name しか確実に届かないので、code を message の先頭に入れる（"code: 説明"）。
 * 呼び出し側は `message.split(":")[0]` で code を取れる。
 */
export class WebResearchError extends Error {
  override readonly name = "WebResearchError";
  readonly code: WebResearchErrorCode;
  constructor(code: WebResearchErrorCode, message: string, options?: { cause?: unknown }) {
    super(`${code}: ${message}`, options);
    this.code = code;
  }
}
