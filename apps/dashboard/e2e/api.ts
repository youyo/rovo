import { fakeGitHubAdmin } from "../../gateway/test/e2e/fake-admin";
import { connectAuthenticated } from "../../gateway/test/e2e/oauth-client";
import { readState } from "./state";

// gateway の /__test/*（ENVIRONMENT=test のときだけある）と MCP 経路でデータを作る小さな関数。
// vitest の helpers.ts は inject() に依存してブラウザ側から使えないので、同じことをここに持つ。
// タスクは実際の MCP 経路（task_start）で作り、偽の agent に台本（構造化イベント・終端）を流す。

export const WIDGETS = { id: 4242, fullName: "acme/widgets", push: true };
export const SECRET = { id: 4343, fullName: "acme/secret", push: true };
export const INSTALLATION_ID = 77;
export const SHA = "0123456789abcdef0123456789abcdef01234567";

export function admin(githubUrl = readState().githubUrl) {
  return fakeGitHubAdmin(githubUrl);
}

async function post(baseUrl: string, path: string, body: Record<string, unknown>) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} が ${res.status}: ${await res.text()}`);
  return (await res.json()) as Record<string, unknown>;
}

/** 偽の子エージェントにイベントを 1 つ積ませる（構造化イベントの台本）。 */
export async function emit(
  baseUrl: string,
  taskId: string,
  type: string,
  data: Record<string, unknown>,
): Promise<void> {
  await post(baseUrl, "/__test/agent/emit", { task_id: taskId, type, data });
}

/** 偽の子エージェントを終端にする。 */
export async function finish(
  baseUrl: string,
  taskId: string,
  phase: "completed" | "failed",
  result?: unknown,
): Promise<void> {
  await post(baseUrl, "/__test/agent/finish", {
    task_id: taskId,
    phase,
    ...(result === undefined ? {} : { result }),
  });
}

export function completedResult(sha: string) {
  return {
    status: "completed",
    summary: "implemented",
    verification: {
      commands: [{ argv: ["npm", "test"] }],
      results: [{ argv: ["npm", "test"], exitCode: 0, timedOut: false, output: "ok" }],
      verified: true,
      attempts: 1,
      commitSha: sha,
    },
    warnings: [],
    patchTooLarge: false,
    pushedSha: sha,
    usage: {
      costUsd: 0.5,
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      web: { search: 0, fetch: 0, browse: 0 },
    },
  };
}

/** ユーザーとして MCP で task_start する（実際の OAuth 経路）。 */
export async function startTask(
  baseUrl: string,
  githubUrl: string,
  user: { id: number; login: string },
  repository: string,
  title: string,
): Promise<string> {
  await admin(githubUrl).setCurrentUser(user.login);
  const client = await connectAuthenticated(baseUrl);
  try {
    const res = await client.callTool({
      name: "task_start",
      arguments: {
        repository,
        base_ref: "main",
        base_sha: SHA,
        title,
        instructions: `do it ${title.length}`,
      },
    });
    const text = (res.content as { text: string }[])[0]?.text ?? "{}";
    const taskId = (JSON.parse(text) as { task_id?: string }).task_id;
    if (!taskId) throw new Error(`task_start が失敗: ${text}`);
    return taskId;
  } finally {
    await client.close();
  }
}

/** 索引（DirectoryDO）に行が現れるまで待つ（一覧に出る条件）。 */
export async function waitForIndex(baseUrl: string, taskId: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const body = await post(baseUrl, "/__test/directory/task", { task_id: taskId });
    if (body.row) return;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`索引に行が現れませんでした: ${taskId}`);
}
