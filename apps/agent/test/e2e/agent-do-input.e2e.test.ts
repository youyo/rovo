import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TaskSpec } from "../../src/agent/types";
import type { ScriptStep } from "../../src/pi/scripted-provider";
import { agentClient } from "../support/agent-client";
import { type FakeUpstream, startFakeUpstream, TEST_GIT_TOKEN } from "../support/fake-upstream";
import { sandboxClient } from "../support/sandbox-client";
import { E2E_TOKEN_ENC_KEY, type RunningWrangler, startWrangler } from "../support/wrangler";

// 実コンテナ上で ask_parent → 回答待ち → answer / cancel を通す。モデルだけが台本付きの fake。
let upstream: FakeUpstream;
let wrangler: RunningWrangler;
let persistDir: string;
const sandboxes: ReturnType<typeof sandboxClient>[] = [];

beforeAll(async () => {
  upstream = await startFakeUpstream();
  persistDir = mkdtempSync(join(tmpdir(), "rovo-agent-input-"));
  wrangler = await startWrangler({
    configs: ["apps/agent/wrangler.jsonc"],
    vars: { ENVIRONMENT: "test", TEST_UPSTREAM: upstream.url, TOKEN_ENC_KEY: E2E_TOKEN_ENC_KEY },
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

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const tool = (name: string, args: Record<string, unknown>): ScriptStep => ({
  toolCall: { name, arguments: args },
});
const FIX = tool("edit_file", { path: "calc.js", old_string: "a - b", new_string: "a + b" });

function spec(task: string, over: Partial<TaskSpec> = {}): TaskSpec {
  const { branch, initialSha } = upstream.createTaskBranch("calc", task, { initialCommit: true });
  return {
    taskId: task,
    userId: "user-e2e",
    repository: "acme/calc",
    baseSha: upstream.calcSha,
    branch,
    initialSha,
    gitCredential: { token: TEST_GIT_TOKEN, expiresAt: Date.now() + 60 * 60 * 1000 },
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

async function waitForPhase(
  agent: ReturnType<typeof agentClient>,
  phase: string,
  timeoutMs = 150_000,
) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const page = await agent.getEvents(0, 1);
    if (page.phase === phase) return;
    if (Date.now() > deadline) throw new Error(`timeout waiting ${phase}; phase=${page.phase}`);
    await sleep(500);
  }
}

describe("ask_parent + 実コンテナ", () => {
  it("質問して止まり、元の期限を過ぎてから回答しても、exec と再 clone が成功して完了する", async () => {
    const {
      agent,
      sandbox,
      spec: s,
    } = await setup(
      "ask-answer",
      [
        FIX,
        tool("git_commit", { message: "fix: correct add" }),
        tool("ask_parent", { question: "このまま完了してよいですか", options: ["はい", "いいえ"] }),
        // 回答の後の最初の操作は、コンテナが作り直された（再 clone した）ことを知らせるエラーになる
        tool("read_file", { path: "calc.js" }),
        tool("read_file", { path: "calc.js" }),
        tool("bash", { command: "npm test" }),
        tool("report_completion", { summary: "回答を受けて完了した" }),
      ],
      // 元の期限（時刻は短く設定する）。clone・編集・commit・質問が期限より前に終わり（下限）、質問した時点で 60 秒以上残る
      // （回答の後に再 clone と検証ができる）ように 110 秒にしている。待ちは期限を過ぎるまで（約 2 分）
      { deadlineAt: Date.now() + 110_000 },
    );
    expect(await agent.start(s)).toMatchObject({ status: "accepted" });
    await waitForPhase(agent, "input_required");

    // 質問が届いている。Sandbox は止めていない
    const q = (await agent.allEvents()).find((e) => e.type === "question");
    expect(q?.data).toMatchObject({
      question_id: "q-1",
      message: "このまま完了してよいですか",
      options: JSON.stringify(["はい", "いいえ"]),
    });
    expect((await sandbox.status()).terminated).toBe(false);

    // 元の期限を過ぎるまで待つ。質問のとき AgentDO が SandboxDO の期限を延ばしているので、
    // SandboxDO は期限切れにならず、認証トークンもコンテナも消えない（トークンの入れ直しは要らない）
    while (Date.now() <= s.deadlineAt + 3_000) await sleep(1_000);
    expect((await agent.getEvents(0, 1)).phase).toBe("input_required");
    expect((await sandbox.status()).expired).toBe(false);
    // コンテナも落ちている状態から再開する（push 済みのチェックポイントから再 clone する）
    await sandbox.destroy();

    expect(await agent.answer("q-1", "はい、完了してください")).toEqual({ ok: true });
    expect((await sandbox.status()).expired).toBe(false);
    expect(await agent.waitForTerminal(180_000)).toBe("completed");

    const events = await agent.allEvents();
    const answered = events.filter((e) => e.type === "answered").map((e) => e.data);
    expect(answered).toEqual([{ question_id: "q-1" }]);
    const ends = events.filter((e) => e.type === "tool_end").map((e) => e.data);
    const reads = ends.filter((e) => e.name === "read_file");
    expect(reads).toHaveLength(2);
    // 1 回目: 再起動（再 clone）の通知。2 回目: 再 clone された作業ツリーに commit 済みの修正がある
    expect(reads[0]?.isError).toBe(true);
    expect(String(reads[0]?.summary)).toMatch(/re-cloned/);
    expect(reads[1]?.isError).toBe(false);
    expect(String(reads[1]?.summary)).toContain("a + b");
    expect(ends.find((e) => e.name === "bash")?.isError).toBe(false);

    const r = await agent.getResult();
    if (r.status === "not_ready") throw new Error("not ready");
    expect(r.status).toBe("completed");
    expect(r.verification.verified).toBe(true);
    // 同じ回答の再送は成功のまま（終端の後は ignored）
    expect(await agent.answer("q-1", "はい、完了してください")).toMatchObject({ ok: true });
  }, 300_000);

  it("回答待ちの間に cancel すると、stopped:true と finalSeq に収束し、Sandbox は終端になる", async () => {
    const {
      agent,
      sandbox,
      spec: s,
    } = await setup("ask-cancel", [
      FIX,
      tool("git_commit", { message: "fix: correct add" }),
      tool("ask_parent", { question: "続けますか" }),
      tool("report_completion", { summary: "到達しない" }),
    ]);
    await agent.start(s);
    await waitForPhase(agent, "input_required");
    const res = await agent.cancel();
    expect(res).toMatchObject({ stopped: true });
    const st = await sandbox.status();
    expect(st.terminated).toBe(true);
    expect(st.running).toBe(false);
    expect(await agent.waitForTerminal(60_000)).toBe("cancelled");
    const events = await agent.allEvents();
    expect(events[events.length - 1]).toMatchObject({
      type: "phase",
      data: { phase: "cancelled" },
    });
    expect(res.finalSeq).toBe(events[events.length - 1]?.seq);
    // 取り消し後の回答は何もしない
    expect(await agent.answer("q-1", "遅い回答")).toEqual({ ok: true, ignored: true });
    expect(await agent.cancel()).toMatchObject({ stopped: true, finalSeq: res.finalSeq });
  });
});
