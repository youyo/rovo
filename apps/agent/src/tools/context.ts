import type { ToolContext } from "./types";

/**
 * ツールに渡す ToolContext を作る。Pi のハーネスは start より前にツールを作るので、期限は固定値ではなく
 * 呼び出し時に評価する getter にする（AgentDO が永続化した deadlineAt を参照させる）。
 */
export function createToolContext(workspaceRoot: string, deadlineAt: () => number): ToolContext {
  return {
    workspaceRoot,
    get deadlineAt() {
      return deadlineAt();
    },
    commitAuthor: { name: "rovo-agent", email: "rovo-agent@users.noreply.github.com" },
  };
}
