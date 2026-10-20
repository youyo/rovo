/**
 * 使えるモデルと単価（D10）。gateway（models_list）と agent（費用の見積り・計算）が共有する。
 *
 * 単価は手書きしない。pi-ai の Cloudflare AI Gateway カタログ（providers/data/cloudflare-ai-gateway.json）から、
 * 下の許可リストに載った id だけを取り出す。カタログに無い・cost が無いモデルは「単価が分からない」ので使えない
 * （fail-closed）。
 *
 * JSON は pi-ai の exports に無いので直接は import できない。同じ内容を平坦化した
 * `@earendil-works/pi-ai/providers/cloudflare-ai-gateway.models`（agents/models/pi-ai が使う経路と同じ）を import する。
 */
import { CLOUDFLARE_AI_GATEWAY_MODELS } from "@earendil-works/pi-ai/providers/cloudflare-ai-gateway.models";

/** 既定のモデル（AGENT_MODEL が未設定のとき）。 */
export const DEFAULT_MODEL = "anthropic/claude-sonnet-5-5";

/**
 * 許可リスト: rovo の id → カタログの id の対応（ここ 1 か所）。
 * rovo の id は `<プロバイダー>/<カタログの id>`（AI Gateway の specifier と同じ形）。
 * 足すときは、カタログに cost 付きで存在することを unit テストが確かめる。
 */
export const MODEL_CATALOG_IDS: Readonly<Record<string, string>> = {
  "anthropic/claude-haiku-5-5": "claude-haiku-5-5",
  "anthropic/claude-sonnet-5-5": "claude-sonnet-5-5",
  "anthropic/claude-opus-5-5": "claude-opus-5-5",
  "anthropic/claude-fable-5-1": "claude-fable-5-1",
  "openai/gpt-6-luna": "gpt-6-luna",
  "openai/gpt-6-sol": "gpt-6-sol",
  "openai/gpt-6-astra": "gpt-6-astra",
};

export const ALLOWED_MODEL_IDS: readonly string[] = Object.keys(MODEL_CATALOG_IDS);

/** 入力トークンがしきい値を超える呼び出しに適用する上位の単価（キャッシュの単価まで持つ）。 */
export interface PriceTier {
  inputTokensAbove: number;
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok: number;
  cacheWritePerMTok: number;
}

/** モデルの単価（USD / 100 万トークン）。 */
export interface ModelPrice {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok: number;
  cacheWritePerMTok: number;
  tiers: readonly PriceTier[];
}

export type ModelApi = "anthropic-messages" | "openai-responses" | "openai-completions";

export interface ModelInfo {
  /** rovo の id（"anthropic/claude-sonnet-5-5"） */
  id: string;
  provider: "anthropic" | "openai";
  api: ModelApi;
  price: ModelPrice;
  contextWindow: number;
}

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

function readTier(raw: unknown): PriceTier | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const t = raw as Record<string, unknown>;
  if (
    !isNum(t.inputTokensAbove) ||
    !isNum(t.input) ||
    !isNum(t.output) ||
    !isNum(t.cacheRead) ||
    !isNum(t.cacheWrite)
  ) {
    return undefined;
  }
  return {
    inputTokensAbove: t.inputTokensAbove,
    inputPerMTok: t.input,
    outputPerMTok: t.output,
    cacheReadPerMTok: t.cacheRead,
    cacheWritePerMTok: t.cacheWrite,
  };
}

/** カタログの 1 エントリから ModelInfo を作る。形が合わない（cost が無いなど）なら undefined。 */
function readEntry(id: string, raw: unknown): ModelInfo | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const e = raw as Record<string, unknown>;
  const cost = e.cost as Record<string, unknown> | undefined;
  if (typeof cost !== "object" || cost === null) return undefined;
  if (
    !isNum(cost.input) ||
    !isNum(cost.output) ||
    !isNum(cost.cacheRead) ||
    !isNum(cost.cacheWrite)
  ) {
    return undefined;
  }
  const api = e.api;
  if (api !== "anthropic-messages" && api !== "openai-responses" && api !== "openai-completions") {
    return undefined;
  }
  const provider = id.startsWith("anthropic/")
    ? "anthropic"
    : id.startsWith("openai/")
      ? "openai"
      : undefined;
  if (provider === undefined || !isNum(e.contextWindow)) return undefined;
  const tiers: PriceTier[] = [];
  if (cost.tiers !== undefined) {
    if (!Array.isArray(cost.tiers)) return undefined;
    for (const raw of cost.tiers) {
      const tier = readTier(raw);
      if (!tier) return undefined; // 読めない tier があれば単価が分からない扱い（過少見積もりを避ける）
      tiers.push(tier);
    }
  }
  return {
    id,
    provider,
    api,
    contextWindow: e.contextWindow,
    price: {
      inputPerMTok: cost.input,
      outputPerMTok: cost.output,
      cacheReadPerMTok: cost.cacheRead,
      cacheWritePerMTok: cost.cacheWrite,
      tiers,
    },
  };
}

const INFOS: ReadonlyMap<string, ModelInfo> = (() => {
  const catalog = CLOUDFLARE_AI_GATEWAY_MODELS as unknown as Record<string, unknown>;
  const map = new Map<string, ModelInfo>();
  for (const [id, catalogId] of Object.entries(MODEL_CATALOG_IDS)) {
    if (!Object.hasOwn(catalog, catalogId)) continue;
    const info = readEntry(id, catalog[catalogId]);
    if (info) map.set(id, info);
  }
  return map;
})();

/** 許可リストにあり、カタログに cost 付きで存在するモデルの情報。それ以外は undefined。 */
export function modelInfo(id: string): ModelInfo | undefined {
  return INFOS.get(id);
}

/**
 * AGENT_MODELS（カンマ区切り）を解釈する。未設定・空なら既定のモデルだけ（fail-closed）。
 * 空白を取り、重複を除き、順序を保つ。既定のモデルは（許可リストにあれば）常に含める。
 * 許可リストに無い id は無視して ignored に返す（呼び出し側が記録する。起動はエラーにしない）。
 */
export function parseAgentModels(
  raw: string | undefined,
  defaultModel: string,
): { models: string[]; ignored: string[] } {
  const requested = (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  const models: string[] = [];
  const ignored: string[] = [];
  for (const id of requested) {
    if (INFOS.has(id)) {
      if (!models.includes(id)) models.push(id);
    } else if (!ignored.includes(id)) {
      ignored.push(id);
    }
  }
  if (INFOS.has(defaultModel) && !models.includes(defaultModel)) models.push(defaultModel);
  return { models, ignored };
}

const finite = (n: number): number => (Number.isFinite(n) && n > 0 ? n : 0);

/**
 * 実費（USD）。pi-ai の calculateCost と同じ規則: 入力側の合計（input + cacheRead + cacheWrite）が
 * tier の inputTokensAbove を超えたら、いちばん高いしきい値の tier の単価を全体に使う。
 */
export function computeCostUsd(price: ModelPrice, usage: TokenUsage): number {
  const input = finite(usage.input);
  const output = finite(usage.output);
  const cacheRead = finite(usage.cacheRead);
  const cacheWrite = finite(usage.cacheWrite);
  const total = input + cacheRead + cacheWrite;
  let rates = {
    input: price.inputPerMTok,
    output: price.outputPerMTok,
    cacheRead: price.cacheReadPerMTok,
    cacheWrite: price.cacheWritePerMTok,
  };
  let matched = -1;
  for (const t of price.tiers) {
    if (total > t.inputTokensAbove && t.inputTokensAbove > matched) {
      matched = t.inputTokensAbove;
      rates = {
        input: t.inputPerMTok,
        output: t.outputPerMTok,
        cacheRead: t.cacheReadPerMTok,
        cacheWrite: t.cacheWritePerMTok,
      };
    }
  }
  return (
    (input * rates.input +
      output * rates.output +
      cacheRead * rates.cacheRead +
      cacheWrite * rates.cacheWrite) /
    1_000_000
  );
}
