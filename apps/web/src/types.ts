import type { WebFetchVia } from "agents/webfetch";

/** apps/web（Web Research Service）の RPC の型。gateway / agent から service binding 経由で呼ぶ。 */

/** 評価したいリスク分類（設計 8.5）。Clef の question の id にもなる。 */
export const CATEGORIES = [
  "prompt_injection",
  "instruction_override",
  "role_spoofing",
  "tool_execution_inducement",
  "credential_exfiltration",
  "suspicious_external_transmission",
] as const;
export type Category = (typeof CATEGORIES)[number];

/** 設計 8.6 */
export type Verdict = "allow" | "caution" | "block" | "unknown";

export type Caller = "parent" | "child";

/** RPC の引数に載せる呼び出し元の識別。userId / taskId はログと AI Gateway の metadata に使う。 */
export type Identity = {
  userId: string;
  taskId?: string;
};

/**
 * 呼び出し元の種別は引数ではなく、service binding の `ctx.props`（{caller}）から取る。
 * WebResearch エントリポイントが props の caller を足したものが CallContext で、サービス内部はこれを使う。
 */
export type CallContext = Identity & { caller: Caller };

export type SearchRequest = Identity & { query: string; limit?: number };
export type FetchRequest = Identity & { url: string };
export type BrowseRequest = Identity & { url: string };

/** service binding の props（gateway は "parent"、agent は "child"）。M3 で両者の binding に設定する。 */
export type WebResearchProps = { caller: Caller };

/** モデル（Safety Evaluator）の出力。Policy Engine の判定とは別に保持する。 */
export type ModelEvaluation = {
  evaluator: string;
  modelVersion: string;
  /** すべての部分を評価でき、呼び出しも失敗しなかった */
  complete: boolean;
  /** カテゴリごとの確率（0〜1）。チャンクが複数あれば最大値。評価できた範囲のもの */
  scores: Partial<Record<Category, number>>;
  evaluatedChars: number;
  totalChars: number;
  failure?: string;
};

/** 設計 8.7 の safety。モデルのスコアと Policy Engine の判定は別々に持つ。 */
export type Safety = {
  evaluator: string;
  model_version: string;
  /** 最終判定（block / unknown のとき content は null） */
  verdict: Verdict;
  categories: Category[];
  reason: string;
  /** モデルが全文を評価できたか */
  evaluated: boolean;
  /** モデルのスコアと、閾値から出したモデル単体の判定 */
  model: { verdict: Verdict; scores: Partial<Record<Category, number>> | null };
  /** 決定論ルールの判定 */
  policy: { verdict: Exclude<Verdict, "unknown">; rules: string[] };
};

export type FetchSource = {
  url: string;
  final_url: string;
  retrieved_at: string;
  /** 取得経路。fetch は "direct"、browse は M2 で "rendered"（agents の WebFetchVia と同じ語彙） */
  via: "direct" | "rendered";
  /** 本文をどう Markdown にしたか（agents の WebFetchVia）。取得できなかったときはない */
  converted_by?: WebFetchVia;
};

export type BlockedReason =
  | "bot_challenge"
  | "robots_disallowed"
  | "robots_unreachable"
  | "redirect_policy";

export type FetchResult = {
  source: FetchSource;
  /** 生の Markdown（目印では囲まない。囲むのは呼び出し元）。block / unknown / blocked のときは null */
  content: string | null;
  safety: Safety;
  /** "blocked": 取得できなかった（bot チャレンジ・robots・redirect の拒否）。それ以外は "ok" */
  status: "ok" | "blocked";
  blocked_reason?: BlockedReason;
  title?: string;
  /** 本文が上限で切り詰められた */
  truncated?: boolean;
};

export type SearchItemResult = {
  source: { url: string; retrieved_at: string; via: "search" };
  title: string;
  /** description（600 文字まで）。block / unknown のとき、または元からなければ null */
  content: string | null;
  safety: Safety;
};

export type SearchResult = {
  results: SearchItemResult[];
  metadata: {
    /** AI Gateway の request id。ログと突き合わせる */
    requestId: string;
    latencyMs: number;
    provider: string | null;
    /** URL ポリシーで落とした件数 */
    dropped_urls: number;
  };
};

export type BrowseResult = FetchResult;
