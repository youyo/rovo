import type { ScriptStep } from "../pi/scripted-provider";
import type { SandboxPort } from "../sandbox-port";
import type { SandboxToolsFactory } from "../tools/types";
import type { WebPort } from "../tools/web";

/**
 * AgentDO の差し替え点。本番では env から作る。Unit では ENVIRONMENT=test のときだけ、
 * DO 名（= task id）をキーに登録した値で差し替える（DO と同じ isolate の中なので、evict しても残る）。
 */
export interface AgentTestOverrides {
  sandbox?: SandboxPort;
  toolsFactory?: SandboxToolsFactory;
  now?: () => number;
  /** web_search / web_fetch / web_browse の RPC（service binding の WEB の代わり） */
  web?: WebPort;
  /** タスクごとの web の回数の上限（env の WEB_SEARCH_LIMIT_PER_TASK / WEB_FETCH_LIMIT_PER_TASK / WEB_BROWSE_LIMIT_PER_TASK の代わり） */
  webLimits?: { search?: number; fetch?: number; browse?: number };
  /** web_browse を有効にするか（env の WEB_BROWSE_ENABLED の代わり） */
  webBrowseEnabled?: boolean;
  /** 台本付き fake モデルの台本 */
  script?: ScriptStep[];
  modelId?: string;
  maxOutputTokens?: number;
  /** cancel が abort / stop の完了を待つ上限（ms） */
  cancelWaitMs?: number;
  /** 停止の意図による確定が Pi の abort を待つ上限（ms） */
  finalizeWaitMs?: number;
  /** 費用の読み取り（pi.usage）を待つ上限（ms）。既定 2000 */
  usageReadWaitMs?: number;
  /** 完了時の push の再試行の間隔（ms）。既定 2000 */
  pushRetryDelayMs?: number;
  /** refreshUsage が Pi の usage を読む直前に待つ（読み取りが遅れて戻るケースの再現用） */
  beforeUsageRead?: () => Promise<void>;
  /** doLaunch が Pi へ run を投入する直前に待つ（投入中に cancel が確定するケースの再現用） */
  beforeSubmit?: () => Promise<void>;
  /** ask_parent が未 commit の確認と質問の記録に入る直前 */
  beforeAskParent?: () => Promise<void>;
  /** ask_parent が質問を記録した直後（ツールの結果を返す前） */
  afterQuestion?: () => Promise<void>;
  /** answer() が Pi へ回答を submit する直前（期限の延長は済んでいる）。例外を投げると submit の失敗になる */
  beforeAnswerSubmit?: () => Promise<void>;
  /** answer() の Pi への submit が戻った直後（再開済みの記録をする前）。その間に cancel が確定するケースの再現用 */
  afterAnswerSubmit?: () => Promise<void>;
  /** steer を Pi へ submit する直前（phase を確かめた後） */
  beforeSteerSubmit?: () => Promise<void>;
  /** モデル呼び出し（fake provider が実際に呼ばれた回数と、そのとき見えていた user メッセージの観測用） */
  onModelCall?: (context?: { userTexts: string[]; toolResults: string[] }) => void;
}

const overrides = new Map<string, AgentTestOverrides>();

export function setAgentTestOverrides(name: string, value: AgentTestOverrides): void {
  overrides.set(name, value);
}

export function clearAgentTestOverrides(): void {
  overrides.clear();
}

export function getAgentTestOverrides(env: Env, name: string | undefined): AgentTestOverrides {
  if (env.ENVIRONMENT !== "test" || name === undefined) return {};
  return overrides.get(name) ?? {};
}
