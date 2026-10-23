import type { ToolContext } from "./types";

/**
 * git_commit と、予算超過の停止時の WIP commit が使う commit の作者の、代わりの値。
 * 作者は gateway が spec で渡す（GitHub App の bot: `<slug>[bot]` / `<id>+<slug>[bot]@users.noreply.github.com`）。
 * 渡されなかったとき（古い gateway・gateway が bot を引けなかったとき）はこれを使う。`.invalid` は RFC 2606 の予約で、
 * GitHub のどのアカウントにも結び付かない。`@users.noreply.github.com` で bot の id が付かない形は、他人のアカウントとみなされるので使わない。
 */
export const COMMIT_AUTHOR = { name: "rovo", email: "rovo@noreply.invalid" };

/** spec で渡された作者が使える形か（文字列で、改行や <> を含まない）。使えなければ代わりの作者にする。 */
export function commitAuthorOf(given: { name: string; email: string } | undefined): {
  name: string;
  email: string;
} {
  const ok = (v: unknown): v is string =>
    typeof v === "string" && v !== "" && v.length <= 200 && !/[\r\n<>\0]/.test(v);
  return given && ok(given.name) && ok(given.email)
    ? { name: given.name, email: given.email }
    : COMMIT_AUTHOR;
}

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
    baseSha?: ToolContext["baseSha"];
    repository?: ToolContext["repository"];
    onEvent?: ToolContext["onEvent"];
    /** gateway が spec で渡した作者。呼び出し時に評価する（start より前にツールを作るため） */
    commitAuthor?: () => { name: string; email: string } | undefined;
  } = {},
): ToolContext {
  const branch = extra.branch;
  return {
    onPush: extra.onPush,
    lastPushedSha: extra.lastPushedSha,
    baseSha: extra.baseSha,
    repository: extra.repository,
    onEvent: extra.onEvent,
    get branch() {
      return typeof branch === "function" ? branch() : branch;
    },
    workspaceRoot,
    get deadlineAt() {
      return deadlineAt();
    },
    get commitAuthor() {
      return commitAuthorOf(extra.commitAuthor?.());
    },
  };
}
