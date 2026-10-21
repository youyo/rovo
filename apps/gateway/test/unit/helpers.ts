import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { ulid } from "../../src/tasks/ulid";
import type { FakeAgentDO } from "../support/fake-agent-do";

export function newTaskId(): string {
  return ulid();
}

export function taskStub(taskId: string) {
  return env.TASK_DO.getByName(taskId);
}

/** 偽の AgentDO（vitest.config.ts で AGENT_DO を差し替えている）。台本の登録と呼び出し回数の確認に使う。 */
export function fakeAgent(taskId: string) {
  return (env.AGENT_DO as unknown as DurableObjectNamespace<FakeAgentDO>).getByName(taskId);
}

let userSeq = 1_000_000 + Math.floor(Math.random() * 1_000_000);
export function newUserId(): number {
  return userSeq++;
}

export function userStub(userId: number) {
  return env.USER_DO.getByName(String(userId));
}

export function sampleInput(
  taskId: string,
  ownerId: number,
  overrides: Record<string, unknown> = {},
) {
  return {
    task_id: taskId,
    owner_id: ownerId,
    owner_login: "alice",
    repository_id: 4242,
    installation_id: 77,
    repository: "acme/widgets",
    base_ref: "main",
    base_sha: "0123456789abcdef0123456789abcdef01234567",
    title: "Implement authentication",
    instructions: "Implement OAuth authentication.",
    acceptance_criteria: ["tests pass"],
    constraints: ["do not merge"],
    ...overrides,
  };
}

/**
 * 最初の DO 呼び出しの初期化（モジュール読み込み・SQLite のスキーマ作成など）を済ませておくための、使い捨てのタスクを作る。
 * setup.ts の beforeAll が呼ぶ。作ったタスクの ID を返す。
 *
 * TaskDO は作成の 10 秒後に alarm を置く。alarm が残ると、ファイルの開始から 10 秒後に、そのときに走っている別のテストの
 * 最中に発火し、偽 GitHub（全テストで共有）へ準備のリクエストを送って、そのテストが張った「1 回だけ失敗させる障害」を
 * 先に消費してしまう。このタスクは初期化のためだけで、進める必要はないので、alarm は消しておく。
 */
export async function warmUpTaskDo(): Promise<string> {
  const id = newTaskId();
  const created = await taskStub(id).ensureCreated(sampleInput(id, newUserId()));
  if (!created.ok) throw new Error("warm-up: ensureCreated");
  await fakeAgent(id).getEvents(0, 1);
  await runInDurableObject(taskStub(id), (_i, state) => state.storage.deleteAlarm());
  return id;
}

export const FP = "f".repeat(64);

/** test 用シンク（KV）に残った Worker 側の監査記録を消す（KV の中身はテストをまたいで残るため、各テストの前に呼ぶ）。 */
export async function clearWorkerAudit(): Promise<void> {
  for (;;) {
    const page = await env.OAUTH_KV.list({ prefix: "test-audit:" });
    if (page.keys.length === 0) return;
    for (const k of page.keys) await env.OAUTH_KV.delete(k.name);
    if (page.list_complete) return;
  }
}
