import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { inject } from "vitest";
import { type FakeAdmin, fakeGitHubAdmin } from "./fake-admin";
import { connectAuthenticated } from "./oauth-client";

export const baseUrl = inject("baseUrl");
export const githubUrl = inject("githubUrl");
export const admin: FakeAdmin = fakeGitHubAdmin(githubUrl);

export const ORG = "acme";
export const TEAM = "core";
export const REPO = { id: 4242, fullName: "acme/widgets", push: true };
export const INSTALLATION_ID = 77;

// DO の状態は wrangler dev の間ずっと残るので、テストごとに別のユーザーを使う
let seq = (Date.now() % 1_000_000) * 100;
export function newUser(prefix = "user") {
  const id = ++seq;
  return { id, login: `${prefix}-${id}` };
}

/** ユーザーを偽 GitHub に作り、team の active メンバーにして、現在のユーザーにする。 */
export async function addMember(user: { id: number; login: string }) {
  await admin.addUser(user);
  await admin.setTeam(ORG, TEAM, user.login, "active");
}

/** 偽 GitHub に Installation（acme/widgets に push 可）を用意する。 */
export async function installApp() {
  await admin.setInstallation(INSTALLATION_ID, [REPO]);
}

export async function login(user: { id: number; login: string }): Promise<Client> {
  await admin.setCurrentUser(user.login);
  return connectAuthenticated(baseUrl);
}

export type ToolResult = Awaited<ReturnType<Client["callTool"]>>;
export function bodyOf(r: ToolResult): Record<string, unknown> {
  return JSON.parse((r.content as { text: string }[])[0]?.text ?? "{}");
}

export const startArgs = (title: string, extra: Record<string, unknown> = {}) => ({
  repository: "acme/widgets",
  base_ref: "main",
  base_sha: "0123456789abcdef",
  title,
  instructions: "do it",
  ...extra,
});

export type AuditRecord = {
  audit: true;
  event: string;
  ts: number;
  userId?: number | string;
  taskId?: string;
  caller?: string;
  reason?: string;
  requestId?: string;
  host?: string;
  kind?: string;
};

/** ENVIRONMENT=test のときだけある /__test/audit から、監査イベント（Worker 側 + 指定したタスクの TaskDO 側）を読む。 */
export async function auditRecords(taskId?: string): Promise<AuditRecord[]> {
  const res = await fetch(`${baseUrl}/__test/audit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(taskId === undefined ? {} : { task_id: taskId }),
  });
  if (!res.ok) throw new Error(`/__test/audit failed: ${res.status}`);
  return ((await res.json()) as { records: AuditRecord[] }).records;
}

/** 条件を満たす監査イベントが現れるまで読み直す（DO の外の記録は非同期のため、少し遅れうる）。 */
export async function waitForAudit(
  predicate: (r: AuditRecord) => boolean,
  opts: { taskId?: string; timeoutMs?: number } = {},
): Promise<AuditRecord> {
  const deadline = Date.now() + (opts.timeoutMs ?? 10_000);
  for (;;) {
    const hit = (await auditRecords(opts.taskId)).find(predicate);
    if (hit) return hit;
    if (Date.now() > deadline) {
      throw new Error(
        `監査イベントが現れませんでした: ${JSON.stringify(await auditRecords(opts.taskId))}`,
      );
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}

export type ArchivedObject = { key: string; size: number; uploaded: number; text: string };

/** ENVIRONMENT=test のときだけある /__test/archive から、そのタスクについて R2（LOGS）に保存されたオブジェクトを読む。 */
export async function archivedObjects(
  taskId: string,
): Promise<{ bound: boolean; objects: ArchivedObject[] }> {
  const res = await fetch(`${baseUrl}/__test/archive`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ task_id: taskId }),
  });
  if (!res.ok) throw new Error(`/__test/archive failed: ${res.status}`);
  return (await res.json()) as { bound: boolean; objects: ArchivedObject[] };
}
