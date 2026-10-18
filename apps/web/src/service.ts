import type { WebSearchSource } from "agents/websearch";
import { createAIWebSearch } from "agents/websearch";
import { loadConfig } from "./config";
import { WebResearchError } from "./errors";
import { fetchPage } from "./fetch-proxy";
import { MAX_CONTENT_CHARS, normalizeContent } from "./normalizer";
import { decide, runDeterministicRules, toSafety } from "./policy-engine";
import { readCallContext } from "./request";
import type { RobotsCache } from "./robots";
import { createClefEvaluator } from "./safety/clef";
import { evaluateSafely } from "./safety/evaluate";
import type { SafetyEvaluator } from "./safety/types";
import { searchWeb } from "./search-broker";
import { testHooks } from "./test-hooks";
import type {
  BrowseRequest,
  BrowseResult,
  CallContext,
  FetchRequest,
  FetchResult,
  Safety,
  SearchRequest,
  SearchResult,
} from "./types";

/** fake を差し込める境界（Unit / E2E）。省略すると本番の実装（env.AI を使う）になる。 */
export type ServiceDeps = {
  searchSource?: WebSearchSource;
  /** 取得に使う fetch（createDirectWebFetch / fetchWeb の fetch 差し替え） */
  fetch?: typeof fetch;
  evaluator?: SafetyEvaluator;
  now?: () => Date;
  robotsCache?: RobotsCache;
  log?: (entry: Record<string, unknown>) => void;
};

type ServiceEnv = Env;

export type WebResearchService = {
  search(req: SearchRequest & { caller: unknown }): Promise<SearchResult>;
  fetch(req: FetchRequest & { caller: unknown }): Promise<FetchResult>;
  browse(req: BrowseRequest & { caller: unknown }): Promise<BrowseResult>;
};

const MAX_TITLE_CHARS = 200;

const defaultLog = (entry: Record<string, unknown>) => console.log(JSON.stringify(entry));

export function createWebResearchService(
  env: ServiceEnv,
  deps: ServiceDeps = {},
): WebResearchService {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? defaultLog;

  // ENVIRONMENT=test のときだけ、AI と fetch を偽サーバーへ向けられる
  const hooks = testHooks(env);
  const ai = hooks?.ai ?? env.AI;

  function evaluatorFor(gatewayId: string): SafetyEvaluator {
    return deps.evaluator ?? createClefEvaluator({ ai, gatewayId });
  }

  return {
    async search(req) {
      const ctx = readCallContext(req);
      const config = loadConfig(env);
      const source =
        deps.searchSource ??
        createAIWebSearch({ binding: ai, gateway: config.gatewayId, provider: config.provider });
      const result = await searchWeb(req, {
        source,
        evaluator: evaluatorFor(config.gatewayId),
        thresholds: config.thresholds,
        now,
      });
      log({
        event: "web_research",
        op: "search",
        caller: ctx.caller,
        userId: ctx.userId,
        taskId: ctx.taskId,
        requestId: result.metadata.requestId,
        results: result.results.length,
        verdict: result.results[0]?.safety.verdict ?? null,
      });
      return result;
    },

    async fetch(req) {
      const ctx = readCallContext(req);
      const config = loadConfig(env);
      const evaluator = evaluatorFor(config.gatewayId);
      const info = { evaluator: evaluator.name, modelVersion: evaluator.modelVersion };
      const outcome = await fetchPage(
        { url: req.url },
        {
          fetch: deps.fetch ?? hooks?.fetch ?? ((i, init) => fetch(i, init)),
          ai,
          robotsCache: deps.robotsCache,
        },
      );
      const retrievedAt = now().toISOString();

      if (outcome.kind === "blocked") {
        const safety: Safety = {
          evaluator: info.evaluator,
          model_version: info.modelVersion,
          verdict: "block",
          categories: [],
          reason: outcome.reason,
          evaluated: false,
          model: { verdict: "unknown", scores: null },
          policy: { verdict: "block", rules: [outcome.reason] },
        };
        logFetch(ctx, req.url, "blocked", outcome.reason);
        return {
          source: { url: req.url, final_url: req.url, retrieved_at: retrievedAt, via: "direct" },
          content: null,
          safety,
          status: "blocked",
          blocked_reason: outcome.reason,
        };
      }

      const normalized = normalizeContent(outcome.content, { maxChars: MAX_CONTENT_CHARS });
      // title も外部のコンテンツ。隠し文字を除いて 200 文字に切り詰め、本文と同じ評価にかける
      const title = outcome.title
        ? normalizeContent(outcome.title, { maxChars: MAX_TITLE_CHARS }).text.trim()
        : "";
      const evalPrefix = title ? `title: ${title}\n\n` : "";
      // 決定論ルールは生の本文・生の title（隠し文字を含む）にかける。生の title は長さだけ制限する
      const rawTitle = outcome.title ? `title: ${outcome.title.slice(0, 2000)}\n\n` : "";
      const findings = runDeterministicRules(rawTitle + outcome.content);
      // 決定論ルールで block なら、モデルには渡さない
      const model = findings.some((f) => f.verdict === "block")
        ? null
        : await evaluateSafely(evaluator, evalPrefix + normalized.text, ctx);
      const decision = decide({ findings, model }, config.thresholds);
      const releasable = decision.verdict === "allow" || decision.verdict === "caution";
      logFetch(ctx, req.url, decision.verdict);
      return {
        source: {
          url: req.url,
          final_url: outcome.finalUrl,
          retrieved_at: retrievedAt,
          via: "direct",
          converted_by: outcome.via,
        },
        content: releasable ? normalized.text : null,
        safety: toSafety(decision, info),
        status: "ok",
        // block / unknown のときは title も返さない（本文と同じ扱い）
        ...(releasable && title ? { title } : {}),
        truncated: normalized.truncated,
      };
    },

    async browse(req) {
      readCallContext(req);
      throw new WebResearchError("not_implemented", "web_browse is not implemented yet.");
    },
  };

  function logFetch(ctx: CallContext, url: string, verdict: string, blockedReason?: string) {
    let host = "";
    try {
      host = new URL(url).host;
    } catch {}
    log({
      event: "web_research",
      op: "fetch",
      caller: ctx.caller,
      userId: ctx.userId,
      taskId: ctx.taskId,
      host,
      verdict,
      blocked_reason: blockedReason,
    });
  }
}
