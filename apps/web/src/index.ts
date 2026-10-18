import { WorkerEntrypoint } from "cloudflare:workers";
import { WebResearchError } from "./errors";
import { createWebResearchService } from "./service";
import type {
  BrowseRequest,
  BrowseResult,
  Caller,
  FetchRequest,
  FetchResult,
  SearchRequest,
  SearchResult,
  WebResearchProps,
} from "./types";

export { WebResearchError } from "./errors";
export type * from "./types";

/**
 * Web Research Service の RPC。gateway（caller: "parent"）と agent（caller: "child"）から service binding で呼ぶ。
 *
 * 呼び出し元の種別は引数ではなく binding の props（`ctx.props.caller`）から取る。props が無い・不正なら拒否する（fail-closed）。
 * 引数に caller を載せても無視する。userId / taskId は引数のまま。
 *
 * メソッド名について: WorkerEntrypoint の `fetch` は HTTP のハンドラ名で、RPC のメソッドにはできない
 * （binding の `.fetch()` は HTTP リクエストになる）。そのため取得は `fetchUrl` にしている。
 */
export class WebResearch extends WorkerEntrypoint<Env, WebResearchProps> {
  private caller(): Caller {
    const caller = (this.ctx.props as { caller?: unknown } | undefined)?.caller;
    if (caller !== "parent" && caller !== "child") {
      throw new WebResearchError(
        "invalid_request",
        "service binding props.caller is missing or invalid.",
      );
    }
    return caller;
  }

  private service() {
    return createWebResearchService(this.env);
  }

  async search(req: SearchRequest): Promise<SearchResult> {
    const caller = this.caller();
    return this.service().search({ ...req, caller });
  }

  async fetchUrl(req: FetchRequest): Promise<FetchResult> {
    const caller = this.caller();
    return this.service().fetch({ ...req, caller });
  }

  async browse(req: BrowseRequest): Promise<BrowseResult> {
    const caller = this.caller();
    return this.service().browse({ ...req, caller });
  }
}

// 公開の HTTP ルートは持たない（workers_dev: false）
export default {
  async fetch(): Promise<Response> {
    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
