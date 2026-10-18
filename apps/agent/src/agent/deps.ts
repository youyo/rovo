import type { ScriptStep } from "../pi/scripted-provider";
import type { SandboxPort } from "../sandbox-port";
import type { SandboxToolsFactory } from "../tools/types";

/**
 * AgentDO の差し替え点。本番では env から作る。Unit では ENVIRONMENT=test のときだけ、
 * DO 名（= task id）をキーに登録した値で差し替える（DO と同じ isolate の中なので、evict しても残る）。
 */
export interface AgentTestOverrides {
  sandbox?: SandboxPort;
  toolsFactory?: SandboxToolsFactory;
  now?: () => number;
  /** 台本付き fake モデルの台本 */
  script?: ScriptStep[];
  modelId?: string;
  maxOutputTokens?: number;
  /** cancel が abort / stop の完了を待つ上限（ms） */
  cancelWaitMs?: number;
  /** モデル呼び出し（fake provider が実際に呼ばれた回数の観測用） */
  onModelCall?: () => void;
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
