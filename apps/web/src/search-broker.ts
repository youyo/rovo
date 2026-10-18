import type { WebSearchSource } from "agents/websearch";
import { WebResearchError } from "./errors";
import { normalizeContent } from "./normalizer";
import { decide, type PolicyThresholds, runDeterministicRules, toSafety } from "./policy-engine";
import { readCallContext } from "./request";
import { evaluateSafely } from "./safety/evaluate";
import type { SafetyEvaluator } from "./safety/types";
import type { ModelEvaluation, SearchItemResult, SearchRequest, SearchResult } from "./types";
import { checkUrl } from "./url-policy";

/**
 * Search Broker: `agents/websearch` の WebSearchSource（本番は createAIWebSearch）で検索し、結果を検査して返す。
 * - 結果の URL は URL ポリシーで検査し、許可外のものは落とす
 * - title と description は外部のコンテンツ。title は 200 文字、description は 600 文字に切り詰めてから、
 *   1回の評価でまとめて Safety Evaluator にかける
 * - 判定は検索結果全体で1つ。verdict が block / unknown なら、すべての項目の description を落とし、title も
 *   "(title withheld)" に置き換えて、URL だけを返す
 *   （項目ごとの判定はしない。どの項目が原因か特定できないため、保守的に全項目を落とす）
 */

export const MAX_QUERY_CHARS = 1024;
export const MAX_LIMIT = 10;
export const DEFAULT_LIMIT = 5;
export const DESCRIPTION_MAX_CHARS = 600;
export const TITLE_MAX_CHARS = 200;
/** block / unknown のとき、title の代わりに返す */
export const TITLE_WITHHELD = "(title withheld)";

export type SearchBrokerDeps = {
  source: WebSearchSource;
  evaluator: SafetyEvaluator;
  thresholds: PolicyThresholds;
  now: () => Date;
};

export async function searchWeb(
  req: SearchRequest & { caller?: unknown },
  deps: SearchBrokerDeps,
): Promise<SearchResult> {
  const ctx = readCallContext(req);
  const query = typeof req.query === "string" ? req.query.trim() : "";
  if (query.length < 1 || query.length > MAX_QUERY_CHARS) {
    throw new WebResearchError(
      "invalid_request",
      `query must be 1 to ${MAX_QUERY_CHARS} characters.`,
    );
  }
  const limit = req.limit ?? DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new WebResearchError(
      "invalid_request",
      `limit must be an integer from 1 to ${MAX_LIMIT}.`,
    );
  }

  let response: Awaited<ReturnType<WebSearchSource["search"]>>;
  try {
    response = await deps.source.search({ query, limit });
  } catch (cause) {
    const code = (cause as { code?: unknown } | null)?.code;
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new WebResearchError(
      "search_failed",
      `${typeof code === "string" ? `${code}: ` : ""}${message}`,
      {
        cause,
      },
    );
  }

  const retrievedAt = deps.now().toISOString();
  const items: { url: string; title: string; description: string | null }[] = [];
  let dropped = 0;
  for (const item of response.items) {
    const checked = checkUrl(item.url);
    if (!checked.ok) {
      dropped++;
      continue;
    }
    const raw = typeof item.description === "string" ? item.description : "";
    const description =
      raw.trim() === "" ? null : normalizeContent(raw, { maxChars: DESCRIPTION_MAX_CHARS }).text;
    items.push({
      url: checked.url.href,
      title: normalizeContent(typeof item.title === "string" ? item.title : "", {
        maxChars: TITLE_MAX_CHARS,
      }).text.trim(),
      description,
    });
  }

  const info = { evaluator: deps.evaluator.name, modelVersion: deps.evaluator.modelVersion };
  // title と description は項目ごとにまとめて、1回の評価にかける。どちらも空の項目は対象にしない
  const blocks = items.flatMap((i, idx) => {
    if (i.title === "" && i.description === null) return [];
    const lines = [`[result ${idx + 1}]`];
    if (i.title !== "") lines.push(`title: ${i.title}`);
    if (i.description !== null) lines.push(`description: ${i.description}`);
    return [lines.join("\n")];
  });
  let model: ModelEvaluation | null = null;
  let findings: ReturnType<typeof runDeterministicRules> = [];
  if (blocks.length === 0) {
    model = {
      evaluator: info.evaluator,
      modelVersion: info.modelVersion,
      complete: true,
      scores: {},
      evaluatedChars: 0,
      totalChars: 0,
    };
  } else {
    const batch = blocks.join("\n\n");
    findings = runDeterministicRules(batch);
    // 決定論ルールで block なら、モデルには渡さない
    if (!findings.some((f) => f.verdict === "block")) {
      model = await evaluateSafely(deps.evaluator, batch, ctx);
    }
  }
  const decision = decide({ findings, model }, deps.thresholds);
  const safety = toSafety(decision, info);
  const releasable = decision.verdict === "allow" || decision.verdict === "caution";

  const results: SearchItemResult[] = items.map((i) => ({
    source: { url: i.url, retrieved_at: retrievedAt, via: "search" as const },
    title: releasable ? i.title : TITLE_WITHHELD,
    content: releasable ? i.description : null,
    safety,
  }));

  return {
    results,
    metadata: {
      requestId: response.metadata.requestId,
      latencyMs: response.metadata.latencyMs,
      provider: deps.source.provider ?? null,
      dropped_urls: dropped,
    },
  };
}
