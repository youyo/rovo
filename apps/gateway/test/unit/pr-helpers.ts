import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { AuditRecord } from "@rovo/audit";
import type { ResultDto } from "../../src/agent/contract";
import { getFakeApp, type UnitGitHubEnv } from "../support/unit-github";
import { fakeAgent, newTaskId, sampleInput, taskStub } from "./helpers";

// PR 操作（D9）のテストの共通部品: COMPLETED まで進めた TaskDO を作る。

export const REPO = "acme/widgets";
export const app = () => getFakeApp(env as unknown as UnitGitHubEnv);

export type TaskStub = ReturnType<typeof taskStub>;

export async function createTask(overrides: Record<string, unknown> = {}, owner = 801) {
  const id = newTaskId();
  const stub = taskStub(id);
  const r = await stub.ensureCreated(sampleInput(id, owner, overrides));
  if (!r.ok) throw new Error(`ensureCreated failed: ${r.code}`);
  // ENVIRONMENT=test にして、DO の中に監査の記録（test_audit）を残すようにする
  await runInDurableObject(stub, (i) => {
    const o = i as unknown as { env: Record<string, unknown> };
    o.env = { ...o.env, ENVIRONMENT: "test" };
  });
  return { id, stub, agent: fakeAgent(id), branch: `agent/task-${id}` };
}

/** testAudit は DO の中でだけ呼べる（RPC の戻り値に載せない型のため）。 */
export const audits = (stub: TaskStub): Promise<AuditRecord[]> =>
  runInDurableObject(stub, (i) => (i as unknown as { testAudit(): AuditRecord[] }).testAudit());

export function completedResult(sha: string, over: Record<string, unknown> = {}): ResultDto {
  return {
    status: "completed",
    summary: "All good",
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
      costUsd: 1,
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      web: { search: 0, fetch: 0, browse: 0 },
    },
    ...over,
  } as ResultDto;
}

/** COMPLETED まで進める（PR の head = pushedSha = 検証済みの commit）。 */
export async function runToCompleted(overrides: Record<string, unknown> = {}, owner = 801) {
  const t = await createTask(overrides, owner);
  await t.stub.advance();
  const head = app().branch(REPO, t.branch) as string;
  await t.agent.setProgram({ result: completedResult(head) });
  await t.agent.setPhase("completed");
  await t.stub.advance();
  return { ...t, head };
}
