import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TaskSpec } from "../../src/agent/types";
import type { ScriptStep } from "../../src/pi/scripted-provider";
import { agentClient } from "../support/agent-client";
import { type FakeUpstream, startFakeUpstream } from "../support/fake-upstream";
import { sandboxClient } from "../support/sandbox-client";
import { type RunningWrangler, startWrangler } from "../support/wrangler";

// 実コンテナ上で AgentDO → 本番のツール群 → SandboxDO を通す。モデルだけが台本付きの fake。
// AgentDO と SandboxDO は同じ名前（= task id）で引く。
let upstream: FakeUpstream;
let wrangler: RunningWrangler;
let persistDir: string;
const sandboxes: ReturnType<typeof sandboxClient>[] = [];

beforeAll(async () => {
  upstream = await startFakeUpstream();
  persistDir = mkdtempSync(join(tmpdir(), "rovo-agent-do-"));
  wrangler = await startWrangler({
    configs: ["apps/agent/wrangler.jsonc"],
    vars: { ENVIRONMENT: "test", TEST_UPSTREAM: upstream.url },
    readyPath: "/",
    persistDir,
  });
});

afterAll(async () => {
  await Promise.all(sandboxes.map((c) => c.terminate().catch(() => {})));
  await wrangler?.stop();
  await upstream?.stop();
  if (persistDir) rmSync(persistDir, { recursive: true, force: true });
});

const tool = (name: string, args: Record<string, string | number | boolean>): ScriptStep => ({
  toolCall: { name, arguments: args },
});
const report = (summary: string) => tool("report_completion", { summary });
const FIX = tool("edit_file", { path: "calc.js", old_string: "a - b", new_string: "a + b" });
const WRONG_FIX = tool("edit_file", { path: "calc.js", old_string: "a - b", new_string: "a * b" });

function spec(task: string, over: Partial<TaskSpec> = {}): TaskSpec {
  return {
    taskId: task,
    userId: "user-e2e",
    repository: "acme/calc",
    baseSha: upstream.calcSha,
    instructions: `scenario:${task}`,
    acceptanceCriteria: ["npm test が通る"],
    verificationCommands: [{ argv: ["npm", "test"], timeoutSeconds: 120 }],
    constraints: [],
    budgetUsd: 10,
    deadlineAt: Date.now() + 60 * 60 * 1000,
    ...over,
  };
}

async function setup(task: string, script: ScriptStep[], over: Partial<TaskSpec> = {}) {
  const agent = agentClient(wrangler.baseUrl, task);
  const sandbox = sandboxClient(wrangler.baseUrl, task);
  sandboxes.push(sandbox);
  const s = spec(task, over);
  await agent.setScript(s.instructions, script);
  return { agent, sandbox, spec: s };
}

describe("AgentDO + 実コンテナ", () => {
  it("read_file → edit_file → bash → git_commit → report_completion で completed。検証が実コンテナで走り、patch が取れる", async () => {
    const {
      agent,
      sandbox,
      spec: s,
    } = await setup("happy", [
      tool("read_file", { path: "calc.js" }),
      FIX,
      tool("bash", { command: "npm test" }),
      tool("git_commit", { message: "fix: correct add" }),
      report("add を修正した"),
    ]);
    expect(await agent.start(s)).toMatchObject({ status: "accepted", alreadyAccepted: false });
    expect(await agent.waitForTerminal()).toBe("completed");

    const r = await agent.getResult();
    expect(r.status).toBe("completed");
    if (r.status === "not_ready") throw new Error("not ready");
    expect(r.summary).toBe("add を修正した");
    expect(r.verification.verified).toBe(true);
    expect(r.verification.attempts).toBe(1);
    expect(r.verification.results).toHaveLength(1);
    expect(r.verification.results[0]).toMatchObject({ argv: ["npm", "test"], exitCode: 0 });
    expect(r.verification.commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(r.patch).toContain("-exports.add = (a, b) => a - b;");
    expect(r.patch).toContain("+exports.add = (a, b) => a + b;");
    expect(r.patch).toContain("fix: correct add");

    const events = await agent.allEvents();
    const toolEnds = events.filter((e) => e.type === "tool_end").map((e) => e.data);
    expect(toolEnds.map((e) => [e.name, e.isError])).toEqual([
      ["read_file", false],
      ["edit_file", false],
      ["bash", false],
      ["git_commit", false],
    ]);

    // 完了後の片付けは terminate。終端の後に sandbox は再開しない
    await expect.poll(async () => (await sandbox.status()).terminated).toBe(true);
    expect(await sandbox.exec(["true"])).toMatchObject({ exitCode: -1, terminated: true });
  });

  it("getEvents のページングは seq が単調で、終端の phase イベントが最後", async () => {
    const agent = agentClient(wrangler.baseUrl, "happy");
    const all = await agent.allEvents(100);
    const small = await agent.allEvents(2);
    expect(small).toEqual(all);
    const seqs = all.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
    const last = all[all.length - 1];
    expect(last).toMatchObject({ type: "phase", data: { phase: "completed" } });
    const page = await agent.getEvents(0, 2);
    expect(page.hasMore).toBe(true);
    expect(page.throughSeq).toBe(page.events[1]?.seq);
    const tail = await agent.getEvents((last?.seq ?? 0) - 1, 100);
    expect(tail.hasMore).toBe(false);
    expect(tail.events.map((e) => e.seq)).toEqual([last?.seq]);
    expect(tail.phase).toBe("completed");
    expect(tail.phaseAsOfSeq).toBe(last?.seq);
    const phases = all.filter((e) => e.type === "phase").map((e) => e.data.phase);
    expect(phases).toEqual(["starting", "running", "verifying", "completed"]);
  });

  it("検証失敗 → 結果がモデルに返り、修正 → 成功", async () => {
    const { agent, spec: s } = await setup("retry", [
      WRONG_FIX,
      tool("git_commit", { message: "wip: 間違った修正" }),
      report("直した（つもり）"),
      FIX_AGAIN(),
      tool("git_commit", { message: "fix: 正しい修正" }),
      report("直した"),
    ]);
    await agent.start(s);
    expect(await agent.waitForTerminal()).toBe("completed");
    const r = await agent.getResult();
    if (r.status === "not_ready") throw new Error("not ready");
    expect(r.status).toBe("completed");
    expect(r.verification.attempts).toBe(2);
    expect(r.verification.verified).toBe(true);
    const events = await agent.allEvents();
    const verifications = events.filter((e) => e.type === "verification").map((e) => e.data);
    expect(verifications.map((v) => v.passed)).toEqual([false, true]);
    expect(r.patch).toContain("a + b");
  });

  it("cancel で terminate され、以後の exec が拒否される", async () => {
    const {
      agent,
      sandbox,
      spec: s,
    } = await setup("cancel", [tool("bash", { command: "sleep 120" }), report("到達しない")]);
    await agent.start(s);
    await expect
      .poll(async () => (await agent.allEvents()).some((e) => e.type === "tool_start"), {
        timeout: 60_000,
      })
      .toBe(true);
    expect(await agent.cancel()).toMatchObject({ stopped: true });
    const st = await sandbox.status();
    expect(st.terminated).toBe(true);
    expect(st.running).toBe(false);
    expect(await sandbox.exec(["true"])).toMatchObject({ exitCode: -1, terminated: true });
    expect(await agent.waitForTerminal(60_000)).toBe("cancelled");
    const events = await agent.allEvents();
    expect(events[events.length - 1]).toMatchObject({
      type: "phase",
      data: { phase: "cancelled" },
    });
    // 冪等: 2 回目も stopped:true
    expect(await agent.cancel()).toMatchObject({ stopped: true });
    // 遅れて届いた start は拒否される
    expect(await agent.start(s)).toEqual({ status: "cancelled" });
  });

  it("deadline 超過で failed（理由 deadline）になり、terminate される", async () => {
    const {
      agent,
      sandbox,
      spec: s,
    } = await setup("deadline", [tool("bash", { command: "sleep 120" }), report("到達しない")], {
      deadlineAt: Date.now() + 45_000,
    });
    await agent.start(s);
    expect(await agent.waitForTerminal(120_000)).toBe("failed");
    const r = await agent.getResult();
    if (r.status === "not_ready") throw new Error("not ready");
    expect(r.status).toBe("failed");
    expect(r.reason).toBe("deadline");
    await expect
      .poll(async () => (await sandbox.status()).terminated, { timeout: 60_000 })
      .toBe(true);
    expect(await sandbox.exec(["true"])).toMatchObject({ exitCode: -1, terminated: true });
    const events = await agent.allEvents();
    expect(events[events.length - 1]).toMatchObject({ type: "phase", data: { phase: "failed" } });
  });
});

function FIX_AGAIN(): ScriptStep {
  return tool("edit_file", { path: "calc.js", old_string: "a * b", new_string: "a + b" });
}
