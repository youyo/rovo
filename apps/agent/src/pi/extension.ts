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

  return defineExtension({
    name: "rovo",
    tools: [...sandboxTools, reportCompletion],
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
