import type { ToolAnnotations } from "@modelcontextprotocol/server";

/**
 * MCP の tool annotations（title・readOnlyHint など）を、ツール名 → 値の表 1 か所にまとめる。
 * クライアント（claude.ai など）はこのヒントでツールを「読み取り専用」「書き込み/削除」に分類する。
 * ツールを足したら、ここにも足す（表に無い名前は toolConfig が例外にする）。
 */
type Entry = { title: string; annotations: ToolAnnotations };

const read = (title: string, openWorldHint: boolean): Entry => ({
  title,
  annotations: { readOnlyHint: true, openWorldHint },
});

const write = (
  title: string,
  hints: { destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean },
): Entry => ({ title, annotations: { readOnlyHint: false, ...hints } });

export const TOOL_ANNOTATIONS = {
  // 読み取り専用
  task_status: read("Task status", false),
  task_wait: read("Wait for task events", false),
  task_result: read("Task result", false),
  task_console: read("Task console", false),
  models_list: read("List models", false),
  budget_status: read("Budget status", false),
  sandbox_instances_list: read("List sandbox sizes", false),
  web_search: read("Web search", true),
  web_fetch: read("Fetch web page", true),
  web_browse: read("Browse web page", true),
  // 書き込み
  task_start: write("Start task", {
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  }),
  task_answer: write("Answer task question", {
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  }),
  task_steer: write("Steer task", {
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  }),
  task_cancel: write("Cancel task", {
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  }),
  task_pr_ready: write("Mark PR ready for review", {
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  }),
  task_pr_merge: write("Merge PR", {
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  }),
  consult: write("Consult a model", {
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  }),
} as const satisfies Record<string, Entry>;

export type RovoToolName = keyof typeof TOOL_ANNOTATIONS;

/** registerTool の config に展開する title と annotations。表に無いツール名は例外にする。 */
export function toolConfig(name: RovoToolName): Entry {
  const entry = (TOOL_ANNOTATIONS as Record<string, Entry>)[name];
  if (!entry) throw new Error(`tool annotations are not defined for ${name}`);
  return entry;
}
