export type WebResearchErrorCode =
  | "invalid_request"
  | "misconfigured"
  | "not_implemented"
  | "invalid_url"
  | "search_failed"
  // 検索プロバイダが 5xx を返した。message は固定の形 "provider=<名前> status=<番号>" だけ（上流の本文は載せない）
  | "search_provider_error"
  | "timeout"
  | "too_large"
  | "too_many_redirects"
  | "unavailable"
  | "fetch_failed"
  // web_browse（Browser Run）。上流のメッセージは載せず、固定の文だけにする
  | "disabled"
  | "invalid_input"
  | "navigation_timeout"
  | "upstream_error";

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
