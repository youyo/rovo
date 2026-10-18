import { env } from "cloudflare:test";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import { setAgentTestOverrides } from "../../../src/agent/deps";
import type { Phase, ResultDto, TaskSpec } from "../../../src/agent/types";
import type { ScriptStep } from "../../../src/pi/scripted-provider";
import type { ExecResult } from "../../../src/sandbox-port";
import type { SandboxToolsFactory } from "../../../src/tools/types";
import { FakeSandbox } from "../../support/fake-sandbox";

export const T0 = 1_800_000_000_000;

export function makeSpec(taskId: string, over: Partial<TaskSpec> = {}): TaskSpec {
  return {
    taskId,
    userId: "user-1",
    repository: "octo/repo",
    baseSha: "base000",
    instructions: `taskId=${taskId} を実装して`,
    acceptanceCriteria: ["テストが通る"],
    verificationCommands: [{ argv: ["npm", "test"] }],
    constraints: ["push しない"],
    budgetUsd: 10,
    deadlineAt: T0 + 2 * 60 * 60 * 1000,
    ...over,
  };
}

export const report = (summary = "done"): ScriptStep => ({
  toolCall: { name: "report_completion", arguments: { summary } },
});
export const call = (
  name: string,
  args: Record<string, string | number | boolean> = {},
): ScriptStep => ({
  toolCall: { name, arguments: args },
});

export interface ExecGate {
  hold: () => void;
  waitEntered: () => Promise<void>;
  release: () => void;
}

export interface Fixture {
  name: string;
  stub: DurableObjectStub<import("../../../src/agent-do").AgentDO>;
  sandbox: FakeSandbox;
  clock: { now: number };
  /** 検証コマンド（npm test）の結果を順に返す。尽きたら成功 */
  verifyResults: Partial<ExecResult>[];
  verifyCalls: string[][];
  modelCalls: { count: number };
  gate: { waitEntered: () => Promise<void>; release: () => void };
  patch: { value: string };
  nameStatus: { value: string };
  /** git format-patch を止めておく（finalize の patch 取得中に別の出来事を起こすため） */
  patchGate: { hold: () => void; waitEntered: () => Promise<void>; release: () => void };
  /** git status / git switch の exec を止めておく（report_completion が sandbox RPC を await 中に別の出来事を起こすため） */
  execGate: Record<"status" | "switch", ExecGate>;
  /** 費用の読み取り（pi.usage）の直前を止める。止めた読み取りは release まで戻らない */
  usageGate: ExecGate;
  /** Pi への run の投入（harness.submit）の直前を止める */
  submitGate: ExecGate;
  /** git rev-parse HEAD の応答を先頭から順に使う。尽きたら c0ffee */
  revParse: string[];
  /** git status --porcelain の結果を先頭から順に使う。尽きたら clean */
  statusResults: Partial<ExecResult>[];
}

/** AgentDO を 1 つ用意する。sandbox は fake、モデルは台本、ツールはテスト用の小さな factory。 */
export function newFixture(
  name: string,
  script: ScriptStep[],
  opts: {
    maxOutputTokens?: number;
    modelId?: string;
    cancelWaitMs?: number;
    finalizeWaitMs?: number;
    usageReadWaitMs?: number;
  } = {},
): Fixture {
  const clock = { now: T0 };
  const verifyResults: Partial<ExecResult>[] = [];
  const verifyCalls: string[][] = [];
  const modelCalls = { count: 0 };
  const patch = { value: "From abc\n--- a\n+++ b\n" };
  const nameStatus = { value: "" };
  // DO の中と外で Promise を共有すると I/O の所有者が混ざるので、フラグのポーリングにする
  const gateState = { entered: false, released: false };
  const patchState = { held: false, entered: false };
  const execState = {
    status: { held: false, entered: false },
    switch: { held: false, entered: false },
  };
  const usageState = { held: false, entered: false };
  const submitState = { held: false, entered: false };
  const hold = async (g: { held: boolean; entered: boolean }) => {
    if (!g.held) return;
    g.entered = true;
    while (g.held) await new Promise((r) => setTimeout(r, 10));
  };
  const revParse: string[] = [];
  const statusResults: Partial<ExecResult>[] = [];

  const sandbox = new FakeSandbox(async (argv) => {
    const [a0, a1] = argv;
    if (a0 === "git" && a1 === "rev-parse") return { stdout: `${revParse.shift() ?? "c0ffee"}\n` };
    if (a0 === "git" && (a1 === "status" || a1 === "switch")) {
      const g = execState[a1];
      if (g.held) {
        g.entered = true;
        while (g.held) await new Promise((r) => setTimeout(r, 10));
      }
      if (a1 === "status") return statusResults.shift() ?? { stdout: "" };
      return {};
    }
    if (a0 === "git" && a1 === "checkout") return {};
    if (a0 === "git" && a1 === "format-patch") {
      if (patchState.held) {
        patchState.entered = true;
        while (patchState.held) await new Promise((r) => setTimeout(r, 10));
      }
      return { stdout: patch.value };
    }
    if (a0 === "git" && a1 === "diff" && argv.includes("--name-status")) {
      return { stdout: nameStatus.value };
    }
    if (a0 === "git" && a1 === "diff") return { stdout: " a.txt | 1 +\n" };
    if (a0 === "git" && a1 === "show") return { exitCode: 128, stderr: "fatal" };
    verifyCalls.push(argv);
    return verifyResults.shift() ?? {};
  });

  const toolsFactory: SandboxToolsFactory = (port) => [
    defineTool({
      name: "write_note",
      description: "write a note",
      parameters: Type.Object({ text: Type.String() }),
      replay: "safe",
      async execute(args) {
        await port.writeFile("/workspace/note.txt", args.text);
        return { output: [{ type: "text", text: "written" }] };
      },
    }),
    defineTool({
      name: "gate",
      description: "block until released",
      parameters: Type.Object({}),
      replay: "safe",
      async execute() {
        gateState.entered = true;
        while (!gateState.released) await new Promise((r) => setTimeout(r, 10));
        return { output: [{ type: "text", text: "released" }] };
      },
    }),
    defineTool({
      name: "advance_clock",
      description: "advance the test clock by ms",
      parameters: Type.Object({ ms: Type.Number() }),
      replay: "safe",
      async execute(args) {
        clock.now += args.ms;
        return { output: [{ type: "text", text: "advanced" }] };
      },
    }),
  ];

  setAgentTestOverrides(name, {
    sandbox,
    toolsFactory,
    script,
    now: () => clock.now,
    maxOutputTokens: opts.maxOutputTokens,
    modelId: opts.modelId,
    cancelWaitMs: opts.cancelWaitMs,
    finalizeWaitMs: opts.finalizeWaitMs,
    usageReadWaitMs: opts.usageReadWaitMs,
    beforeUsageRead: () => hold(usageState),
    beforeSubmit: () => hold(submitState),
    onModelCall: () => {
      modelCalls.count += 1;
    },
  });
  return {
    name,
    stub: env.AGENT_DO.getByName(name),
    sandbox,
    clock,
    verifyResults,
    verifyCalls,
    modelCalls,
    gate: {
      waitEntered: async () => {
        while (!gateState.entered) await new Promise((r) => setTimeout(r, 10));
      },
      release: () => {
        gateState.released = true;
      },
    },
    patch,
    nameStatus,
    revParse,
    statusResults,
    usageGate: gateOf(usageState),
    submitGate: gateOf(submitState),
    execGate: {
      status: gateOf(execState.status),
      switch: gateOf(execState.switch),
    },
    patchGate: {
      hold: () => {
        patchState.held = true;
      },
      waitEntered: async () => {
        while (!patchState.entered) await new Promise((r) => setTimeout(r, 10));
      },
      release: () => {
        patchState.held = false;
      },
    },
  };
}

function gateOf(state: { held: boolean; entered: boolean }): ExecGate {
  return {
    hold: () => {
      state.held = true;
    },
    waitEntered: async () => {
      while (!state.entered) await new Promise((r) => setTimeout(r, 10));
    },
    release: () => {
      state.held = false;
    },
  };
}

const TERMINAL: Phase[] = ["completed", "failed", "budget_exceeded", "cancelled"];

export async function waitForTerminal(fx: Fixture, timeoutMs = 10_000): Promise<Phase> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const page = await fx.stub.getEvents(0, 1);
    if (page.phase && TERMINAL.includes(page.phase)) return page.phase;
    if (Date.now() > deadline) throw new Error(`timeout; phase=${page.phase}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

export async function waitForPhase(fx: Fixture, phase: Phase, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const page = await fx.stub.getEvents(0, 1);
    if (page.phase === phase) return;
    if (Date.now() > deadline) throw new Error(`timeout waiting ${phase}; phase=${page.phase}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

export async function allEvents(fx: Fixture) {
  const out: { seq: number; type: string; data: Record<string, unknown> }[] = [];
  let after = 0;
  for (;;) {
    const page = await fx.stub.getEvents(after, 3);
    for (const e of page.events) {
      out.push({ seq: e.seq, type: e.type, data: JSON.parse(e.data) as Record<string, unknown> });
    }
    after = page.throughSeq;
    if (!page.hasMore) return out;
  }
}

export function done(r: ResultDto) {
  if (r.status === "not_ready") throw new Error("not ready");
  return r;
}

export async function waitUntil(cond: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("waitUntil timeout");
    await new Promise((r) => setTimeout(r, 25));
  }
}
