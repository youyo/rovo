import type { ToolContext } from "./types";

/** git_commit と、予算超過の停止時の WIP commit が使う commit の作者。 */
export const COMMIT_AUTHOR = { name: "rovo-agent", email: "rovo-agent@users.noreply.github.com" };

/**
 * ツールに渡す ToolContext を作る。Pi のハーネスは start より前にツールを作るので、期限は固定値ではなく
 * 呼び出し時に評価する getter にする（AgentDO が永続化した deadlineAt を参照させる）。
 */
export function createToolContext(
  workspaceRoot: string,
  deadlineAt: () => number,
  extra: {
    branch?: string | (() => string | undefined);
    onPush?: ToolContext["onPush"];
    lastPushedSha?: ToolContext["lastPushedSha"];
    onEvent?: ToolContext["onEvent"];
  } = {},
): ToolContext {
  const branch = extra.branch;
  return {
    onPush: extra.onPush,
    lastPushedSha: extra.lastPushedSha,
    onEvent: extra.onEvent,
    get branch() {
      return typeof branch === "function" ? branch() : branch;
    },
    workspaceRoot,
    get deadlineAt() {
      return deadlineAt();
    },
    commitAuthor: COMMIT_AUTHOR,
  };
}
