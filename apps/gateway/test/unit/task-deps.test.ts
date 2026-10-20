import { runDurableObjectAlarm } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getFakeApp, type UnitGitHubEnv } from "../support/unit-github";
import { fakeAgent, newTaskId, sampleInput, taskStub } from "./helpers";

// D14（依存関係のキャッシュ）: TaskDO が base_sha 時点のルート直下の lockfile を GitHub から読み、
// TaskSpec.deps として agent に渡す。読めなくてもタスクは普通に始まる（deps: null）。

const OWNER = 702;
const REPO = "acme/widgets";
const BASE = "0123456789abcdef"; // sampleInput の base_sha（偽 GitHub が 40 桁に解決する）
const BLOB = "d".repeat(40);
const app = () => getFakeApp(env as unknown as UnitGitHubEnv);

async function createTask() {
  const id = newTaskId();
  const stub = taskStub(id);
  const r = await stub.ensureCreated(sampleInput(id, OWNER));
  if (!r.ok) throw new Error(`ensureCreated failed: ${r.code}`);
  return { id, stub, agent: fakeAgent(id) };
}
const statusOf = async (stub: ReturnType<typeof taskStub>) => {
  const r = await stub.getStatus(OWNER);
  if (!r.ok) throw new Error("not found");
  return r.task.status;
};

describe("TaskSpec.deps", () => {
  it("ルート直下に lockfile があれば、blob SHA・repository_id・導入のコマンドを spec に載せる", async () => {
    await app().seedRootFiles(REPO, BASE, {
      "package-lock.json": BLOB,
      "package.json": "e".repeat(40),
    });
    const { stub, agent } = await createTask();
    await stub.advance();
    expect(await statusOf(stub)).toBe("RUNNING");
    const { specs } = await agent.calls();
    expect(specs[0]?.deps).toEqual({
      repositoryId: 4242,
      lockfilePath: "package-lock.json",
      blobSha: BLOB,
      installCommand: "npm ci",
      packageJsonSha: "e".repeat(40),
      workspaceSha: null,
      manifestsSha: null,
    });
  });

  it("入れ子の package.json（workspace の各パッケージ）があれば manifestsSha が非 null で、pnpm-workspace.yaml は workspaceSha に載る", async () => {
    await app().seedRootFiles(REPO, BASE, {
      "pnpm-lock.yaml": BLOB,
      "package.json": "e".repeat(40),
      "pnpm-workspace.yaml": "d".repeat(40),
      "packages/a/package.json": "1".repeat(40),
    });
    const { stub, agent } = await createTask();
    await stub.advance();
    expect(await statusOf(stub)).toBe("RUNNING");
    const deps = (await agent.calls()).specs[0]?.deps;
    expect(deps?.workspaceSha).toBe("d".repeat(40));
    expect(deps?.manifestsSha).toMatch(/^[0-9a-f]{64}$/);
  });

  it("lockfile が無ければ deps: null（キャッシュなし）", async () => {
    await app().seedRootFiles(REPO, BASE, { "package.json": "e".repeat(40) });
    const { stub, agent } = await createTask();
    await stub.advance();
    expect(await statusOf(stub)).toBe("RUNNING");
    expect((await agent.calls()).specs[0]?.deps).toBeNull();
  });

  it("tree を読めなくても（GitHub の API のエラー）、タスクは失敗せず deps: null で始まる", async () => {
    await app().seedRootFiles(REPO, BASE, {
      "pnpm-lock.yaml": BLOB,
      "package.json": "e".repeat(40),
    });
    app().setFault({ pattern: "^GET /repos/.*/git/trees/", status: 502 });
    try {
      const { stub, agent } = await createTask();
      await stub.advance();
      expect(await statusOf(stub)).toBe("RUNNING");
      expect((await agent.calls()).specs[0]?.deps).toBeNull();
    } finally {
      app().setFault({ pattern: "^GET /repos/.*/git/trees/", status: null });
    }
  });

  it("start の再送でも同じ deps を送る（API が後から読めるようになっても spec は変わらない）", async () => {
    await app().seedRootFiles(REPO, BASE, { "yarn.lock": BLOB, "package.json": "e".repeat(40) });
    const { stub, agent } = await createTask();
    await agent.setProgram({ start: ["lose"] });
    await stub.advance();
    // 再送の前に lockfile が変わった（base_sha は同じでも API の答えが変わりうる状況）としても、保存済みの値を使う
    await app().seedRootFiles(REPO, BASE, {
      "pnpm-lock.yaml": "f".repeat(40),
      "package.json": "e".repeat(40),
    });
    await runDurableObjectAlarm(stub);
    const { specs } = await agent.calls();
    expect(specs).toHaveLength(2);
    expect(JSON.stringify(specs[1])).toBe(JSON.stringify(specs[0]));
    expect(specs[0]?.deps).toMatchObject({ lockfilePath: "yarn.lock", blobSha: BLOB });
  });

  it("GitHub の資格はコンテナ向けの spec 以外に増えない: deps に token は含まれない", async () => {
    await app().seedRootFiles(REPO, BASE, {
      "package-lock.json": BLOB,
      "package.json": "e".repeat(40),
    });
    const { stub, agent } = await createTask();
    await stub.advance();
    const deps = (await agent.calls()).specs[0]?.deps;
    expect(JSON.stringify(deps)).not.toMatch(/ghs_|token/i);
  });
});
