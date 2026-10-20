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
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { CLOUDFLARE_AI_GATEWAY_MODELS } from "@earendil-works/pi-ai/providers/cloudflare-ai-gateway.models";
import { CLOUDFLARE_WORKERS_AI_MODELS } from "@earendil-works/pi-ai/providers/cloudflare-workers-ai.models";

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
  // Workers AI（D10b）。Workers の無料プランでも使えるものだけ（kimi-k2.7-code・glm-5.x・deepseek-v4 は有料プラン専用なので入れない）。
  // カタログのキーは `workers-ai/@cf/...`（gateway カタログの "openai-completions"）。Pi（createAI）に渡す id は `@cf/...`（piModelId）。
  "workers-ai/@cf/openai/gpt-oss-120b": "workers-ai/@cf/openai/gpt-oss-120b",
  "workers-ai/@cf/openai/gpt-oss-20b": "workers-ai/@cf/openai/gpt-oss-20b",
  "workers-ai/@cf/qwen/qwen3.8-27b": "workers-ai/@cf/qwen/qwen3.8-27b",
  "workers-ai/@cf/nvidia/nemotron-3-120b-a12b": "workers-ai/@cf/nvidia/nemotron-3-120b-a12b",
  "workers-ai/@cf/zai-org/glm-4.7-flash": "workers-ai/@cf/zai-org/glm-4.7-flash",
  "workers-ai/@cf/google/gemma-4-26b-a4b-it": "workers-ai/@cf/google/gemma-4-26b-a4b-it",
};

const WORKERS_AI_PREFIX = "workers-ai/";

/** モデルのプロバイダー。AI Gateway の BYOK が要るのは anthropic / openai で、workers-ai はキー不要。 */
export type ModelProvider = "anthropic" | "openai" | "workers-ai";

/** rovo の id のプロバイダー。許可リストに無ければ undefined。 */
export function providerOf(modelId: string): ModelProvider | undefined {
  if (!Object.hasOwn(MODEL_CATALOG_IDS, modelId)) return undefined;
  if (modelId.startsWith("anthropic/")) return "anthropic";
  if (modelId.startsWith("openai/")) return "openai";
  if (modelId.startsWith(WORKERS_AI_PREFIX)) return "workers-ai";
  return undefined;
}

/**
 * Pi（agents の createAI）に渡す id。Workers AI は `@cf/...`（createAI は `workers-ai/...` の specifier を TypeError で拒否し、
 * `@cf/` の id を env.AI.run に流す）。それ以外は rovo の id のまま（`<プロバイダー>/<カタログの id>` の specifier）。
 */
export function piModelId(modelId: string): string {
  return modelId.startsWith(WORKERS_AI_PREFIX) ? modelId.slice(WORKERS_AI_PREFIX.length) : modelId;
}

/**
 * 既定のモデルを決める固定の順序（D10b）。Anthropic → gpt-oss-120b → 残りの Workers AI → OpenAI。
 * 希望のモデル（AGENT_MODEL）が使えなければ、使えるモデルのうち、この順で最初のものを選ぶ。
 * Anthropic のキーが無いとき、またはキーが 1 つも無いときの既定が gpt-oss-120b になる。
 */
export const DEFAULT_MODEL_ORDER: readonly string[] = [
  "anthropic/claude-sonnet-5-5",
  "anthropic/claude-haiku-5-5",
  "anthropic/claude-opus-5-5",
  "anthropic/claude-fable-5-1",
  "workers-ai/@cf/openai/gpt-oss-120b",
  "workers-ai/@cf/openai/gpt-oss-20b",
  "workers-ai/@cf/qwen/qwen3.8-27b",
  "workers-ai/@cf/nvidia/nemotron-3-120b-a12b",
  "workers-ai/@cf/zai-org/glm-4.7-flash",
  "workers-ai/@cf/google/gemma-4-26b-a4b-it",
  "openai/gpt-6-sol",
  "openai/gpt-6-luna",
  "openai/gpt-6-astra",
];

/** 希望のモデルが available に含まれればそれ。なければ DEFAULT_MODEL_ORDER の順で最初の available なモデル。無ければ undefined。 */
export function pickDefaultModel(
  preferred: string | undefined,
  available: readonly string[],
): string | undefined {
  if (preferred !== undefined && available.includes(preferred)) return preferred;
  return DEFAULT_MODEL_ORDER.find((id) => available.includes(id));
}

/** 思考をオフにするときに Anthropic へ送る thinking.type の値。 */
export type ThinkingOff = "between_tools" | "disabled";

/**
 * モデルごとの「思考をオフにするときの値」（rovo の id → 値）。Pi は一律 disabled を送るが、
 * モデルによって受け付ける値が違う（本番の AI Gateway のログで確認）:
 * - sonnet-5-5: disabled を 400 で拒否し between_tools を要求する
 * - haiku-5-5: between_tools を 400 で拒否する（"thinking.type.between_tools" is not supported）ので disabled のまま
 * - opus-5-5: between_tools を 400 で拒否する（haiku と同じ）ので disabled のまま（本番で確認済み 2026-10-20）
 * - fable-5-1: カタログの thinkingLevelMap.off が null で Pi が disabled を送らないので対象外（載せない）
 * OpenAI は対象外。表に無いモデルは置き換えない（Pi の値のまま）。
 */
export const THINKING_OFF: Readonly<Record<string, ThinkingOff>> = {
  "anthropic/claude-sonnet-5-5": "between_tools",
  "anthropic/claude-haiku-5-5": "disabled",
  "anthropic/claude-opus-5-5": "disabled", // 本番で確認済み 2026-10-20
};

/** rovo の id またはカタログの id から、思考オフの値を引く。表に無ければ undefined（置き換えない）。 */
export function thinkingOffFor(modelId: string): ThinkingOff | undefined {
  const rovoId = Object.hasOwn(MODEL_CATALOG_IDS, modelId)
    ? modelId
    : Object.keys(MODEL_CATALOG_IDS).find((k) => MODEL_CATALOG_IDS[k] === modelId);
  if (rovoId === undefined || !Object.hasOwn(THINKING_OFF, rovoId)) return undefined;
  return THINKING_OFF[rovoId];
}

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
  provider: ModelProvider;
  api: ModelApi;
  price: ModelPrice;
  contextWindow: number;
  /** カタログの reasoning（思考に対応するか） */
  reasoning: boolean;
  /** カタログの thinkingLevelMap（null は「そのレベルを受け付けない」）。無ければ空 */
  thinkingLevelMap: Readonly<Record<string, string | null>>;
  /** カタログの compat.forceAdaptiveThinking（Anthropic の adaptive thinking。思考が max_tokens の中に収まる） */
  forceAdaptiveThinking: boolean;
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

function readThinkingLevelMap(raw: unknown): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  if (typeof raw !== "object" || raw === null) return out;
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === "string" || v === null) out[k] = v;
  }
  return out;
}

/**
 * Workers AI のモデルの thinkingLevelMap。gateway カタログのエントリには無く、Pi が実際に使う Workers AI のレジストリ
 * （cloudflare-workers-ai.models。agents の buildWorkersAIModel と同じ）にある。無ければ undefined（全レベル可）。
 */
function workersAiThinkingLevelMap(rovoId: string): unknown {
  const wire = piModelId(rovoId);
  const entry = Object.values(CLOUDFLARE_WORKERS_AI_MODELS as unknown as Record<string, unknown>)
    .map((v) => v as { id?: unknown; thinkingLevelMap?: unknown })
    .find((v) => v.id === wire);
  return entry?.thinkingLevelMap;
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
  const provider = providerOf(id);
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
    reasoning: e.reasoning === true,
    thinkingLevelMap: readThinkingLevelMap(
      provider === "workers-ai" ? workersAiThinkingLevelMap(id) : e.thinkingLevelMap,
    ),
    forceAdaptiveThinking:
      typeof e.compat === "object" &&
      e.compat !== null &&
      (e.compat as Record<string, unknown>).forceAdaptiveThinking === true,
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

// ---- モデルごとの思考レベル（effort）----

/** 思考レベル。pi-ai の ModelThinkingLevel（off / minimal / low / medium / high / xhigh / max）。 */
export type Effort = ModelThinkingLevel;

const EFFORT_ORDER: readonly Effort[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * 思考レベルの初期値（upstream の既定。モデルごとに固定で、タスクごとには変えない）。
 * デプロイごとに env MODEL_EFFORTS で上書きできる（resolveEfforts）。
 * 思考のトークンは出力として課金されるので、考える量が多いほど費用が増える。
 */
export const EFFORTS: Readonly<Record<string, Effort>> = {
  "anthropic/claude-haiku-5-5": "low",
  "anthropic/claude-sonnet-5-5": "high",
  "anthropic/claude-opus-5-5": "medium",
  "anthropic/claude-fable-5-1": "low",
  "openai/gpt-6-luna": "low",
  "openai/gpt-6-sol": "medium",
  "openai/gpt-6-astra": "low",
  // Workers AI: 6 つとも low から。gemma は low を受け付けない（Workers AI のレジストリでは off / high だけ）ので high
  "workers-ai/@cf/openai/gpt-oss-120b": "low",
  "workers-ai/@cf/openai/gpt-oss-20b": "low",
  "workers-ai/@cf/qwen/qwen3.8-27b": "low",
  "workers-ai/@cf/nvidia/nemotron-3-120b-a12b": "low",
  "workers-ai/@cf/zai-org/glm-4.7-flash": "low",
  "workers-ai/@cf/google/gemma-4-26b-a4b-it": "high",
};

/**
 * そのモデルが受け付ける思考レベル（pi-ai の getSupportedThinkingLevels と同じ規則）。
 * thinkingLevelMap が null のレベルは不可（fable・astra の off、luna / sol の minimal）。xhigh / max は map に載っているものだけ。
 * 許可リストに無い・カタログに無いモデルは空。
 */
export function supportedEfforts(modelId: string): Effort[] {
  const info = INFOS.get(modelId);
  if (!info) return [];
  if (!info.reasoning) return ["off"];
  return EFFORT_ORDER.filter((level) => {
    const mapped = info.thinkingLevelMap[level];
    if (mapped === null) return false;
    if (level === "xhigh" || level === "max") return mapped !== undefined;
    return true;
  });
}

/**
 * env MODEL_EFFORTS（`<モデルの id>=<レベル>` のカンマ区切り。例 `anthropic/claude-sonnet-5-5=medium,anthropic/claude-haiku-5-5=off`）を
 * 初期値に重ねた最終の値を返す。同じモデルを複数回書いたら後が勝つ。
 * 不正な項目（書式の誤り・許可リストに無いモデル・知らないレベル・そのモデルが受け付けないレベル）は無視して初期値のままにし、
 * 無視した項目を ignored に返す（起動はエラーにしない。AGENT_MODELS と同じ流儀。呼び出し側がログに出す）。
 */
export function resolveEfforts(raw: string | undefined): {
  efforts: Readonly<Record<string, Effort>>;
  ignored: string[];
} {
  const efforts: Record<string, Effort> = { ...EFFORTS };
  const ignored: string[] = [];
  for (const part of (raw ?? "").split(",")) {
    const item = part.trim();
    if (item === "") continue;
    const pieces = item.split("=");
    const id = pieces[0]?.trim() ?? "";
    const level = pieces[1]?.trim() ?? "";
    if (
      pieces.length !== 2 ||
      !INFOS.has(id) ||
      !(EFFORT_ORDER as readonly string[]).includes(level) ||
      !supportedEfforts(id).includes(level as Effort)
    ) {
      ignored.push(item);
      continue;
    }
    efforts[id] = level as Effort;
  }
  return { efforts, ignored };
}

/** モデルの最終の思考レベル（MODEL_EFFORTS の上書き込み）。許可リストに無いモデルは undefined。 */
export function effortFor(modelId: string, raw: string | undefined): Effort | undefined {
  if (!Object.hasOwn(EFFORTS, modelId)) return undefined;
  return resolveEfforts(raw).efforts[modelId];
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
