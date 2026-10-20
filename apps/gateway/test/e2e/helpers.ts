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
  base_sha: "0123456789abcdef0123456789abcdef01234567",
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
  model?: string;
  consult_id?: string;
  cost_usd?: number;
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

/** 索引（DirectoryDO）の 1 タスクの行。無ければ null（ENVIRONMENT=test のときだけある /__test/directory/task）。 */
export async function directoryRow(taskId: string): Promise<Record<string, unknown> | null> {
  const res = await fetch(`${baseUrl}/__test/directory/task`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ task_id: taskId }),
  });
  if (!res.ok) throw new Error(`/__test/directory/task failed: ${res.status}`);
  return ((await res.json()) as { row: Record<string, unknown> | null }).row;
}

/** 索引（DirectoryDO）にある、ある利用者の consult の行（新しい順。/__test/directory/consults。ENVIRONMENT=test のときだけ）。 */
export async function directoryConsults(ownerId: number): Promise<Record<string, unknown>[]> {
  const res = await fetch(`${baseUrl}/__test/directory/consults`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ owner_id: ownerId }),
  });
  if (!res.ok) throw new Error(`/__test/directory/consults failed: ${res.status}`);
  return ((await res.json()) as { rows: Record<string, unknown>[] }).rows;
}

export type TokenState = {
  finalizeDone: boolean;
  rows: number;
  encEmpty: number;
  encPresent: number;
};

/** ENVIRONMENT=test のときだけある /__test/task/token-state から、git_token の暗号文が空かどうか（件数だけ。暗号文は返らない）を読む。 */
export async function tokenState(taskId: string): Promise<TokenState> {
  const res = await fetch(`${baseUrl}/__test/task/token-state`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ task_id: taskId }),
  });
  if (!res.ok) throw new Error(`/__test/task/token-state failed: ${res.status}`);
  return (await res.json()) as TokenState;
}

/** 偽の子エージェントを終端にする（ENVIRONMENT=test のときだけある /__test/agent/finish）。 */
export async function finishAgent(
  taskId: string,
  phase: "completed" | "failed",
  result?: unknown,
): Promise<void> {
  const res = await fetch(`${baseUrl}/__test/agent/finish`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ task_id: taskId, phase, ...(result !== undefined ? { result } : {}) }),
  });
  if (!res.ok) throw new Error(`/__test/agent/finish failed: ${res.status}`);
}

/**
 * consult の台本を預ける（ENVIRONMENT=test のときだけある /__test/agent/set-script）。key は consult の最初の user メッセージ。
 * 偽の AgentDO が text と usage をそのまま返し、費用はキャッシュ込みの scripted の単価（$1/100万、cacheRead $0.1、cacheWrite $1.25）で計算する。
 */
export async function setConsultScript(
  key: string,
  step: {
    text?: string;
    usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
    /** 失敗を返す（model_rejected = モデルの 4xx、model_error = 5xx など）。費用は 0 */
    fail?: { code: "model_rejected" | "model_error" };
  },
): Promise<void> {
  const res = await fetch(`${baseUrl}/__test/agent/set-script`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key, script: [step] }),
  });
  if (!res.ok) throw new Error(`/__test/agent/set-script failed: ${res.status}`);
}

/** COMPLETED の結果（検証済みの commit = push した commit = sha）。 */
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

/** task_result が返せる（終端 + 停止確認済み + 終端の PR 更新が済んで head を読めた）まで待つ。 */
export async function waitForResult(
  client: Client,
  taskId: string,
  opts: { timeoutMs?: number; needHead?: boolean } = {},
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + (opts.timeoutMs ?? 90_000);
  for (;;) {
    const r = await client.callTool({ name: "task_result", arguments: { task_id: taskId } });
    const body = bodyOf(r);
    const pr = body.pr as { head_sha: string | null } | null | undefined;
    if (!r.isError && (opts.needHead === false || pr == null || pr.head_sha !== null)) return body;
    if (Date.now() > deadline)
      throw new Error(`task_result が揃いませんでした: ${JSON.stringify(body)}`);
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

export type FakePullView = {
  number: number;
  draft: boolean;
  state: string;
  merged: boolean;
  head: string;
  mergeMethod?: string;
  mergeSha?: string;
};

/** 偽 GitHub 上の acme/widgets の PR（ブランチ名で探す）。 */
export async function pullOf(branch: string): Promise<FakePullView | undefined> {
  const pulls = await admin.app<FakePullView[]>("pulls", "acme/widgets");
  return pulls.find((p) => p.head === branch);
}

/** gateway が KV に持つ provider_configs のキャッシュ（5 分）と失敗の記録を消す（D10b。E2E でキーの有無を切り替えるため）。 */
export async function resetProviderKeysCache(): Promise<void> {
  const res = await fetch(`${baseUrl}/__test/provider-keys/reset`, { method: "POST" });
  if (!res.ok) throw new Error(`/__test/provider-keys/reset failed: ${res.status}`);
}

/** 偽の Cloudflare API（provider_configs）への呼び出し回数 */
export async function providerConfigsCalls(): Promise<number> {
  return (await admin.requests()).filter((r) => r.path.endsWith("/provider_configs")).length;
}
