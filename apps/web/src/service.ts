import { audit } from "@rovo/audit";
import type { WebSearchSource } from "agents/websearch";
import { createAIWebSearch } from "agents/websearch";
import { type BrowserLike, browsePage } from "./browse";
import { isBrowseEnabled, loadConfig } from "./config";
import { WebResearchError } from "./errors";
import { fetchPage } from "./fetch-proxy";
import { coveringRawPrefix, MAX_CONTENT_CHARS, normalizeContent } from "./normalizer";
import {
  decide,
  type PolicyDecision,
  type PolicyThresholds,
  runDeterministicRules,
  toSafety,
} from "./policy-engine";
import { readCallContext } from "./request";
import type { RobotsCache } from "./robots";
import { createClefEvaluator } from "./safety/clef";
import { evaluateSafely } from "./safety/evaluate";
import type { SafetyEvaluator } from "./safety/types";
import { searchWeb } from "./search-broker";
import { testHooks } from "./test-hooks";
import type {
  BlockedReason,
  BrowseRequest,
  BrowseResult,
  CallContext,
  FetchRequest,
  FetchResult,
  Safety,
  SearchRequest,
  SearchResult,
  UnknownReason,
} from "./types";

/** fake を差し込める境界（Unit / E2E）。省略すると本番の実装（env.AI を使う）になる。 */
export type ServiceDeps = {
  searchSource?: WebSearchSource;
  /** 取得に使う fetch（createDirectWebFetch / fetchWeb の fetch 差し替え） */
  fetch?: typeof fetch;
  evaluator?: SafetyEvaluator;
  now?: () => Date;
  robotsCache?: RobotsCache;
  /** web_browse の Browser Run（env.BROWSER の代わり） */
  browser?: BrowserLike;
  /** 評価器 1 回の期限（ms）。省略すると 60 秒 */
  evaluatorTimeoutMs?: number;
  /** web_browse の全体の期限（ms）。省略すると 45 秒 */
  browseDeadlineMs?: number;
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
      const first = result.results[0];
      // 判定は検索結果全体で1つ。host は出さない（結果の URL は複数あり、パスも含む）
      if (first) {
        auditSafety(ctx, "search", first.safety, { requestId: result.metadata.requestId });
      }
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
          fetch: fetchImpl(),
          ai,
          robotsCache: deps.robotsCache,
        },
      );
      const retrievedAt = now().toISOString();

      if (outcome.kind === "blocked") {
        logWeb(ctx, "fetch", req.url, "blocked", { blocked_reason: outcome.reason });
        auditWeb(ctx, "fetch", req.url, outcome.reason);
        return {
          source: { url: req.url, final_url: req.url, retrieved_at: retrievedAt, via: "direct" },
          content: null,
          safety: blockedSafety(info, outcome.reason),
          status: "blocked",
          blocked_reason: outcome.reason,
        };
      }

      const page = await assessContent(
        { content: outcome.content, title: outcome.title },
        { evaluator, info, ctx, thresholds: config.thresholds },
      );
      logWeb(ctx, "fetch", req.url, page.safety.verdict);
      auditSafety(ctx, "fetch", page.safety, { url: req.url });
      return {
        source: {
          url: req.url,
          final_url: outcome.finalUrl,
          retrieved_at: retrievedAt,
          via: "direct",
          converted_by: outcome.via,
        },
        content: page.content,
        safety: page.safety,
        status: "ok",
        ...(page.title !== undefined ? { title: page.title } : {}),
        truncated: page.truncated,
      };
    },

    async browse(req) {
      const ctx = readCallContext(req);
      // 無効なら、他の設定も読まず、BROWSER・DoH・評価器のどれも使わない（ツールを出さない側が主で、これは設定のずれに対する backstop）
      if (!isBrowseEnabled(env)) {
        throw new WebResearchError("disabled", "web_browse is not enabled.");
      }
      const config = loadConfig(env);
      const evaluator = evaluatorFor(config.gatewayId);
      const info = { evaluator: evaluator.name, modelVersion: evaluator.modelVersion };
      const browser = deps.browser ?? hooks?.browser ?? (env.BROWSER as unknown as BrowserLike);
      const outcome = await browsePage(
        { url: req.url },
        {
          browser,
          fetch: fetchImpl(),
          robotsCache: deps.robotsCache,
          ...(deps.browseDeadlineMs !== undefined ? { deadlineMs: deps.browseDeadlineMs } : {}),
        },
      );
      const retrievedAt = now().toISOString();
      const source = {
        url: req.url,
        final_url: req.url,
        retrieved_at: retrievedAt,
        via: "rendered",
      } as const;

      // 拒否・判定不能の経路: 本文も title も返さず、評価器は呼ばない
      if (outcome.kind === "blocked") {
        logWeb(ctx, "browse", req.url, "blocked", { blocked_reason: outcome.reason });
        auditWeb(ctx, "browse", req.url, outcome.reason);
        return {
          source,
          content: null,
          safety: blockedSafety(info, outcome.reason),
          status: "blocked",
          blocked_reason: outcome.reason,
        };
      }
      if (outcome.kind === "http_error") {
        logWeb(ctx, "browse", req.url, "http_error", { http_status: outcome.httpStatus });
        return {
          source,
          content: null,
          safety: unjudgedSafety(info, "http_error"),
          status: "http_error",
          http_status: outcome.httpStatus,
        };
      }
      if (outcome.kind === "unknown") {
        logWeb(ctx, "browse", req.url, "unknown", { unknown_reason: outcome.reason });
        auditWeb(ctx, "browse", req.url, outcome.reason);
        return {
          source,
          content: null,
          safety: unjudgedSafety(info, outcome.reason),
          status: "unknown",
          unknown_reason: outcome.reason,
        };
      }

      // フロントマターを含む markdown 全体と meta.title を、web_fetch と同じ評価にかける
      const page = await assessContent(
        { content: outcome.markdown, title: outcome.title },
        { evaluator, info, ctx, thresholds: config.thresholds },
      );
      logWeb(ctx, "browse", req.url, page.safety.verdict);
      auditSafety(ctx, "browse", page.safety, { url: req.url });
      return {
        source: { ...source, final_url: outcome.finalUrl },
        content: page.content,
        safety: page.safety,
        status: "ok",
        ...(page.title !== undefined ? { title: page.title } : {}),
        truncated: page.truncated,
      };
    },
  };

  /** DoH と robots.txt と web_fetch の取得に使う fetch（テストでは偽サーバーへ向ける） */
  function fetchImpl(): typeof fetch {
    return deps.fetch ?? hooks?.fetch ?? ((i, init) => fetch(i, init));
  }

  /**
   * 取得した本文と title を評価して、返してよいものだけを返す（web_fetch と web_browse で共用）。
   * - 評価の対象と返却の対象は同じ: 切り詰めた（50,000 文字）後の本文と、200 文字に切った後の title。
   * - 決定論ルールは、返す範囲に対応する生の本文・生の title（隠し文字を含む）にかける。block ならモデルには渡さない。
   * - block / unknown のときは、本文も title も返さない。
   */
  async function assessContent(
    input: { content: string; title?: string },
    ctx: {
      evaluator: SafetyEvaluator;
      info: { evaluator: string; modelVersion: string };
      ctx: CallContext;
      thresholds: PolicyThresholds;
    },
  ): Promise<{
    content: string | null;
    title: string | undefined;
    truncated: boolean;
    safety: Safety;
  }> {
    const normalized = normalizeContent(input.content, { maxChars: MAX_CONTENT_CHARS });
    // title も外部のコンテンツ。隠し文字を除いて 200 文字に切り詰め、本文と同じ評価にかける
    const title = input.title
      ? normalizeContent(input.title, { maxChars: MAX_TITLE_CHARS }).text.trim()
      : "";
    const evalPrefix = title ? `title: ${title}\n\n` : "";
    // 決定論ルールは、返す範囲（切り詰め後の本文と title）に対応する生のテキスト（隠し文字を含む）にかける。
    // Clef が評価する範囲と揃え、返さない末尾の語句で止めない
    const rawTitle = input.title
      ? `title: ${coveringRawPrefix(input.title, { maxChars: MAX_TITLE_CHARS })}\n\n`
      : "";
    const findings = runDeterministicRules(
      rawTitle + coveringRawPrefix(input.content, { maxChars: MAX_CONTENT_CHARS }),
    );
    const model = findings.some((f) => f.verdict === "block")
      ? null
      : await evaluateSafely(ctx.evaluator, evalPrefix + normalized.text, ctx.ctx, {
          timeoutMs: deps.evaluatorTimeoutMs,
        });
    const decision: PolicyDecision = decide({ findings, model }, ctx.thresholds);
    const releasable = decision.verdict === "allow" || decision.verdict === "caution";
    return {
      content: releasable ? normalized.text : null,
      title: releasable && title ? title : undefined,
      truncated: normalized.truncated,
      safety: toSafety(decision, ctx.info),
    };
  }

  /**
   * 監査ログ（@rovo/audit）。web_research（観測用）とは別に、拒否・判定不能だけを出す。
   * 本文・title・URL のパス / query は渡さない。host はホスト名だけ（audit() が長さとマスクを掛ける）。
   */
  function auditWeb(
    ctx: CallContext,
    kind: "search" | "fetch" | "browse",
    url: string | undefined,
    reason: string,
    requestId?: string,
  ) {
    let host: string | undefined;
    if (url !== undefined) {
      try {
        host = new URL(url).hostname;
      } catch {}
    }
    audit("web_blocked", {
      caller: ctx.caller,
      userId: ctx.userId,
      taskId: ctx.taskId,
      kind,
      reason,
      host,
      requestId,
    });
  }

  /** 本文の安全性の判定が block / unknown のときだけ出す。reason は固定コードに丸める。 */
  function auditSafety(
    ctx: CallContext,
    kind: "search" | "fetch" | "browse",
    safety: Safety,
    extra: { url?: string; requestId?: string },
  ) {
    if (safety.verdict !== "block" && safety.verdict !== "unknown") return;
    auditWeb(ctx, kind, extra.url, safetyAuditReason(safety), extra.requestId);
  }

  function logWeb(
    ctx: CallContext,
    op: "fetch" | "browse",
    url: string,
    verdict: string,
    extra: Record<string, string | number> = {},
  ) {
    let host = "";
    try {
      host = new URL(url).host;
    } catch {}
    // 本文・title・URL のパス / query は載せない。理由は固定のコードだけ
    log({
      event: "web_research",
      op,
      caller: ctx.caller,
      userId: ctx.userId,
      taskId: ctx.taskId,
      host,
      verdict,
      ...extra,
    });
  }
}

/** 取得結果を返さない（block）ときの safety。理由は固定のコード。 */
function blockedSafety(
  info: { evaluator: string; modelVersion: string },
  reason: BlockedReason,
): Safety {
  return {
    evaluator: info.evaluator,
    model_version: info.modelVersion,
    verdict: "block",
    categories: [],
    reason,
    evaluated: false,
    model: { verdict: "unknown", scores: null },
    policy: { verdict: "block", rules: [reason] },
  };
}

/** 判定できなかった・評価に回さなかった（http_error など）ときの safety。評価はしていない。 */
function unjudgedSafety(
  info: { evaluator: string; modelVersion: string },
  reason: UnknownReason | "http_error",
): Safety {
  return {
    evaluator: info.evaluator,
    model_version: info.modelVersion,
    verdict: "unknown",
    categories: [],
    reason,
    evaluated: false,
    model: { verdict: "unknown", scores: null },
    policy: { verdict: "allow", rules: [] },
  };
}

/**
 * safety.reason は "a; b" のような複数の理由の連結（`injection_rule:<rule>` など）なので、監査の固定コードに丸める。
 * block: 決定論ルール（injection_rule）かモデル（model_score）。unknown: evaluator_failed / state_truncated / model_not_performed。
 */
function safetyAuditReason(safety: Safety): string {
  if (safety.verdict === "block") {
    return safety.policy.verdict === "block" ? "injection_rule" : "model_score";
  }
  if (safety.reason.includes("state_truncated")) return "state_truncated";
  if (safety.reason.includes("evaluator_failed")) return "evaluator_failed";
  if (safety.reason.includes("model_not_performed")) return "model_not_performed";
  return "unknown";
}
