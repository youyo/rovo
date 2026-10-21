/**
 * apps/web（Web Research Service）の RPC の型。service binding（WEB）経由で呼ぶ。
 * Gateway は web の実装を import しない（Env の型が混ざるため）ので、使う分だけをここに写す。
 * web 側の実装との一致は apps/web/test/contract/consumers.ts（型の検査）で確かめる。
 */

export type Verdict = "allow" | "caution" | "block" | "unknown";

export interface WebSafety {
  evaluator: string;
  model_version: string;
  verdict: Verdict;
  categories: string[];
  reason: string;
  evaluated: boolean;
  model: { verdict: Verdict; scores: Record<string, number> | null };
  policy: { verdict: Exclude<Verdict, "unknown">; rules: string[] };
}

export interface WebSearchItem {
  source: { url: string; retrieved_at: string; via: "search" };
  title: string;
  content: string | null;
  safety: WebSafety;
}

export interface WebSearchResponse {
  results: WebSearchItem[];
  metadata: { requestId: string; latencyMs: number; provider: string | null; dropped_urls: number };
}

export interface WebFetchResponse {
  source: {
    url: string;
    final_url: string;
    retrieved_at: string;
    via: "direct" | "rendered";
    converted_by?: string;
  };
  content: string | null;
  safety: WebSafety;
  /** ok / blocked（取得結果を返さない）/ http_error（取得先が 4xx / 5xx。http_status）/ unknown（判定できなかった。unknown_reason） */
  status: "ok" | "blocked" | "http_error" | "unknown";
  blocked_reason?: string;
  http_status?: number;
  unknown_reason?: string;
  title?: string;
  truncated?: boolean;
}

/** web_browse の結果。web_fetch と同じ形（理由は固定のコードだけで、取得先の文字列は含まれない） */
export type WebBrowseResponse = WebFetchResponse;

export interface WebPort {
  search(req: {
    userId: string;
    taskId?: string;
    query: string;
    limit?: number;
  }): Promise<WebSearchResponse>;
  fetchUrl(req: { userId: string; taskId?: string; url: string }): Promise<WebFetchResponse>;
  browse(req: { userId: string; taskId?: string; url: string }): Promise<WebBrowseResponse>;
}
