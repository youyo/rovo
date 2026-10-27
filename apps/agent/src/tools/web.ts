/**
 * apps/web（Web Research Service）の RPC の型と、ワーカー（Pi のツール）への見せ方。
 * 応答の型と整形（formatWeb*）は consult と共有するため packages/web-format にある。ここは RPC の口（WebPort）だけを持つ。
 * web 側の実装との一致は apps/web/test/contract/consumers.ts（型の検査）で確かめる。
 */
import type { WebBrowseResponse, WebFetchResponse, WebSearchResponse } from "@rovo/web-format";

export {
  formatWebBrowse,
  formatWebError,
  formatWebFetch,
  formatWebSearch,
  type Verdict,
  type WebBrowseResponse,
  type WebFetchResponse,
  type WebSafety,
  type WebSearchItem,
  type WebSearchResponse,
  type WebToolResult,
} from "@rovo/web-format";

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
