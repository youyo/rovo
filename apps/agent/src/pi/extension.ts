import { Type } from "@earendil-works/pi-ai";
import {
  defineExtension,
  defineTool,
  type Extension,
  GenerationTask,
  hook,
  section,
  type ToolRegistration,
  ToolTask,
} from "@earendil-works/pi-durable";

/** AgentDO が Pi に差し込む振る舞い。Pi の型はこのファイルに閉じ込める。 */
export interface AgentPiHooks {
  /** ツール開始前。拒否理由を返すとツールは実行されない。 */
  beforeTool(call: { id: string; name: string; arguments: unknown }): Promise<string | undefined>;
  afterTool(
    call: { id: string; name: string },
    result: { isError: boolean; text: string },
  ): Promise<void>;
  /** ツールの 1 ラウンドが終わった直後 */
  afterTools(): Promise<void>;
  /** モデルがツールを呼ばずに答えたとき。続行させる指示を返す */
  onYield(): Promise<string | undefined>;
  reportCompletion(
    summary: string,
  ): Promise<{ text: string; isError: boolean; terminate: boolean }>;
  /** 親への質問。terminate が true なら、このラウンドで run を終える（回答まで再開しない） */
  askParent(args: {
    question: string;
    options?: string[];
    context?: string;
  }): Promise<{ text: string; isError: boolean; terminate: boolean }>;
  /** システムプロンプトの section（key → 本文。本文が undefined なら出さない） */
  sections(): { key: string; text: string | undefined }[];
}

const SECTION_KEYS = [
  "role",
  "acceptance_criteria",
  "constraints",
  "verification",
  "procedure",
  "untrusted_data",
  "ask_parent",
  "no_push",
] as const;

function textOf(output: unknown): string {
  if (!Array.isArray(output)) return "";
  return output
    .map((c) =>
      c && typeof c === "object" && "text" in c ? String((c as { text: unknown }).text) : "",
    )
    .join("");
}

export function createAgentExtension(
  sandboxTools: readonly ToolRegistration[],
  hooks: AgentPiHooks,
): Extension {
  const reportCompletion = defineTool({
    name: "report_completion",
    description:
      "Report that the task is finished. Call this only after all changes are committed with git_commit. " +
      "The parent verifies the committed HEAD; if verification fails you get the output back and must fix it.",
    parameters: Type.Object({
      summary: Type.String({ description: "What you did and the result" }),
    }),
    replay: "unsafe",
    async execute(args) {
      const r = await hooks.reportCompletion(args.summary);
      return {
        output: [{ type: "text" as const, text: r.text }],
        isError: r.isError,
        ...(r.terminate ? { control: { terminate: true as const } } : {}),
      };
    },
  });

  const askParent = defineTool({
    name: "ask_parent",
    description:
      "Ask the parent a question and stop until it answers. Use it only for a decision you cannot make yourself " +
      "(see the system prompt). Commit your work with git_commit first (WIP is fine). " +
      "Limits: question and context together up to 4000 characters, up to 10 options of up to 500 characters each.",
    parameters: Type.Object({
      question: Type.String({ description: "The question for the parent" }),
      options: Type.Optional(
        Type.Array(Type.String(), { description: "Answer choices, if the answer is a choice" }),
      ),
      context: Type.Optional(Type.String({ description: "Background the parent needs" })),
    }),
    replay: "unsafe",
    async execute(args) {
      const r = await hooks.askParent({
        question: args.question,
        ...(args.options !== undefined ? { options: args.options } : {}),
        ...(args.context !== undefined ? { context: args.context } : {}),
      });
      return {
        output: [{ type: "text" as const, text: r.text }],
        isError: r.isError,
        ...(r.terminate ? { control: { terminate: true as const } } : {}),
      };
    },
  });

  return defineExtension({
    name: "rovo",
    tools: [...sandboxTools, reportCompletion, askParent],
    sections: SECTION_KEYS.map((key) =>
      section(key, () => hooks.sections().find((s) => s.key === key)?.text),
    ),
    hooks: [
      hook(ToolTask, {
        beforeTool: async (call) => {
          const reason = await hooks.beforeTool(call);
          return reason === undefined ? undefined : { block: reason };
        },
        afterTool: async (call, result) => {
          await hooks.afterTool(call, {
            isError: result.isError === true,
            text: textOf(result.output),
          });
          return undefined;
        },
      }),
      hook(GenerationTask, {
        afterTools: async () => {
          await hooks.afterTools();
        },
        onYield: async () => {
          const next = await hooks.onYield();
          return next === undefined ? undefined : { continue: next };
        },
      }),
    ],
  });
}
