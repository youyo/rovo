/**
 * 予算の延長の質問（kind: budget_extension）。タスクが予算に近づいたとき、子ではなく rovo（システム）が親に出す。
 * 文は rovo が数値だけで書く固定文で、子の自由文は入らない（なので <<<UNTRUSTED_CHILD_QUESTION>>> で囲まない。
 * 子の質問 ask_parent は今までどおり囲む）。AgentDO は数値だけを送り、文と選択肢は gateway がここで作る。
 */
export const BUDGET_EXTENSION_KIND = "budget_extension";

/** 延長は 1 タスクにつき最大この回数（1 回の延長は task_budget_usd と同じ額）。AgentDO の MAX_BUDGET_EXTENSIONS と同じ値 */
export const MAX_BUDGET_EXTENSIONS = 2;

export type BudgetQuestionNumbers = {
  spent_usd: number;
  total_usd: number;
  extension_usd: number;
  extensions_left: number;
};

const usd = (n: number): string => `$${n.toFixed(2)}`;

/** 選択肢は [続ける, 止める] の 2 つ。TaskDO は位置（0 番目 = 続ける）で回答を判定する */
export function budgetQuestionText(n: BudgetQuestionNumbers): {
  message: string;
  options: [string, string];
} {
  return {
    message: `タスクの予算 ${usd(n.total_usd)} のうち ${usd(n.spent_usd)} を使いました。あと ${usd(n.extension_usd)} 使って続けますか。延長できる残り回数: ${n.extensions_left} 回。`,
    options: [`あと ${usd(n.extension_usd)} 使って続ける`, "ここで止める"],
  };
}

/** 数値の項目を検証して取り出す。1 つでも不正なら undefined（その質問は子の質問として扱う） */
export function parseBudgetNumbers(d: Record<string, unknown>): BudgetQuestionNumbers | undefined {
  const get = (k: string): number | undefined => {
    const v = d[k];
    return typeof v === "number" && Number.isFinite(v) && v >= 0 && v < 1e6 ? v : undefined;
  };
  const spent = get("budget_spent_usd");
  const total = get("budget_total_usd");
  const ext = get("budget_extension_usd");
  const left = get("budget_extensions_left");
  if (
    spent === undefined ||
    total === undefined ||
    ext === undefined ||
    left === undefined ||
    ext <= 0 ||
    !Number.isInteger(left) ||
    left < 1 ||
    left > MAX_BUDGET_EXTENSIONS
  ) {
    return undefined;
  }
  return { spent_usd: spent, total_usd: total, extension_usd: ext, extensions_left: left };
}
