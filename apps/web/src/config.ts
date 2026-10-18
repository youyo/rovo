import type { WebSearchProvider } from "agents/websearch";
import { WebResearchError } from "./errors";
import { DEFAULT_THRESHOLDS, type PolicyThresholds } from "./policy-engine";

export type WebConfig = {
  environment: string;
  /** AI Gateway の ID（必須） */
  gatewayId: string;
  provider: WebSearchProvider;
  thresholds: PolicyThresholds;
  /** web_browse を有効にするか（WEB_BROWSE_ENABLED が "true" のときだけ。既定は無効） */
  browseEnabled: boolean;
};

const PROVIDERS: readonly WebSearchProvider[] = ["ceramic", "exa", "linkup"];

type ConfigEnv = {
  ENVIRONMENT?: string;
  AI_GATEWAY_ID?: string;
  WEB_SEARCH_PROVIDER?: string;
  SAFETY_BLOCK_THRESHOLD?: string;
  SAFETY_CAUTION_THRESHOLD?: string;
  WEB_BROWSE_ENABLED?: string;
};

function parseThreshold(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 1) {
    throw new WebResearchError(
      "misconfigured",
      `${name} must be a number from 0 to 1; got ${JSON.stringify(raw)}.`,
    );
  }
  return n;
}

/** "true"（前後の空白・大文字小文字は無視）だけが有効。未設定・空・誤記はすべて無効（有効にならない側へ倒す）。 */
function parseEnabledFlag(raw: unknown): boolean {
  return typeof raw === "string" && raw.trim().toLowerCase() === "true";
}

/** web_browse が有効か。他の設定（AI_GATEWAY_ID など）の検査より先に判定する（無効なら何も読まない）。 */
export function isBrowseEnabled(env: { WEB_BROWSE_ENABLED?: unknown }): boolean {
  return parseEnabledFlag(env.WEB_BROWSE_ENABLED);
}

/**
 * 呼び出しのたびに読む（設定の誤りは、その呼び出しをエラーにする。fail closed）。
 * AI_GATEWAY_ID が空なら、AI Gateway を通さずに Clef や検索を呼ぶことになるので、環境を問わずエラーにする
 * （websearch も AI.run も呼ばない）。
 */
export function loadConfig(env: ConfigEnv): WebConfig {
  const environment = env.ENVIRONMENT ?? "production";
  const gatewayId = (env.AI_GATEWAY_ID ?? "").trim();
  if (gatewayId === "") {
    throw new WebResearchError("misconfigured", "AI_GATEWAY_ID is required.");
  }
  const providerRaw = (env.WEB_SEARCH_PROVIDER ?? "").trim() || "ceramic";
  if (!PROVIDERS.includes(providerRaw as WebSearchProvider)) {
    throw new WebResearchError(
      "misconfigured",
      `WEB_SEARCH_PROVIDER must be one of ${PROVIDERS.join(", ")}; got ${JSON.stringify(providerRaw)}.`,
    );
  }
  const block = parseThreshold(
    "SAFETY_BLOCK_THRESHOLD",
    env.SAFETY_BLOCK_THRESHOLD,
    DEFAULT_THRESHOLDS.block,
  );
  const caution = parseThreshold(
    "SAFETY_CAUTION_THRESHOLD",
    env.SAFETY_CAUTION_THRESHOLD,
    DEFAULT_THRESHOLDS.caution,
  );
  if (caution > block) {
    throw new WebResearchError(
      "misconfigured",
      "SAFETY_CAUTION_THRESHOLD must not exceed SAFETY_BLOCK_THRESHOLD.",
    );
  }
  return {
    environment,
    gatewayId,
    provider: providerRaw as WebSearchProvider,
    thresholds: { block, caution },
    browseEnabled: parseEnabledFlag(env.WEB_BROWSE_ENABLED),
  };
}
