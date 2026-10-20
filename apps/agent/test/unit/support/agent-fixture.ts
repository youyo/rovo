import { env } from "cloudflare:test";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import { setAgentTestOverrides } from "../../../src/agent/deps";
import type { Phase, ResultDto, TaskSpec } from "../../../src/agent/types";
import type { ScriptStep } from "../../../src/pi/scripted-provider";
import type { ExecResult } from "../../../src/sandbox-port";
import type { SandboxToolsFactory } from "../../../src/tools/types";
import type { WebPort } from "../../../src/tools/web";
import { FakeSandbox } from "../../support/fake-sandbox";

export const T0 = 1_800_000_000_000;

export function makeSpec(taskId: string, over: Partial<TaskSpec> = {}): TaskSpec {
  return {
    taskId,
    userId: "user-1",
    repository: "octo/repo",
    baseSha: "base000",
    branch: `agent/task-${taskId}`,
    initialSha: "1".repeat(40),
    gitCredential: { token: "ghs_unit_token", expiresAt: T0 + 60 * 60 * 1000 },
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
export const call = (name: string, args: Record<string, unknown> = {}): ScriptStep => ({
  toolCall: { name, arguments: args },
});

/** ask_parent を呼ぶ台本の 1 ターン */
export const ask = (question: string, options?: string[]): ScriptStep => ({
  toolCall: { name: "ask_parent", arguments: options ? { question, options } : { question } },
});

/** 1 つの応答で複数のツールを呼ぶ台本の 1 ターン（各ステップの toolCall を並べる） */
export const round = (...steps: ScriptStep[]): ScriptStep => ({
  toolCalls: steps.flatMap((s) => (s.toolCall ? [s.toolCall] : [])),
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
  /** 検証コマンドを 1 本実行するごとに、時計（clock）を進める ms。先頭から順に使い、尽きたら進めない（durationMs の確認用） */
  verifyAdvanceMs: number[];
  /** toolResults: モデル呼び出しごとに、そのとき transcript に載っていたツール結果の本文 */
  modelCalls: {
    count: number;
    userTexts: string[][];
    toolResults: string[][];
    /** モデル呼び出しごとに Pi へ渡った思考レベル（options.reasoning。思考オフは undefined） */
    reasoning: (string | undefined)[];
    maxTokens: (number | undefined)[];
  };
  /** ask_parent の本体に入る直前（未回答の質問を記録する前）を止める */
  askGate: ExecGate;
  /** answer() が Pi へ回答を submit する直前を止める。throwOnce を立てると 1 回だけ例外にする */
  answerGate: ExecGate & { throwOnce: () => void };
  /** answer() の Pi への submit が戻った直後（再開済みの記録をする前）を止める */
  afterAnswerGate: ExecGate;
  /** steer を Pi へ submit する直前（phase を確かめた後）を止める（その間に phase が変わるケースの再現用） */
  steerGate: ExecGate;
  /** ask_parent が質問を記録した直後（ツールの結果を返す前）を止める */
  questionGate: ExecGate;
  gate: { waitEntered: () => Promise<void>; release: () => void };
  patch: { value: string };
  nameStatus: { value: string };
  testDiff: { value: string };
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
  /** リモートの作業ブランチの先頭（ls-remote の応答。push が成功すると push した SHA になる）。初期値は c0ffee */
  remote: { sha: string | undefined };
  /** git push の結果を先頭から順に使う。尽きたら成功。成功した push はリモートの先頭を更新する */
  pushResults: Partial<ExecResult>[];
  /** git ls-remote の結果を先頭から順に使う。尽きたらリモートの先頭を返す */
  lsRemoteResults: Partial<ExecResult>[];
  /** push の呼び出し（argv） */
  pushCalls: string[][];
}

/** AgentDO を 1 つ用意する。sandbox は fake、モデルは台本、ツールはテスト用の小さな factory。 */
export function newFixture(
  name: string,
  script: ScriptStep[],
  opts: {
    maxOutputTokens?: number;
    modelId?: string;
    /** env の MODEL_EFFORTS の代わり（モデルごとの思考レベルの上書き） */
    modelEfforts?: string;
    cancelWaitMs?: number;
    finalizeWaitMs?: number;
    usageReadWaitMs?: number;
    pushRetryDelayMs?: number;
    /** web_search / web_fetch の RPC の fake */
    web?: WebPort;
    /** タスクごとの web の回数の上限（既定は 50 / 100 / 20） */
    webLimits?: { search?: number; fetch?: number; browse?: number };
    /** web_browse を有効にするか（既定は無効。WEB_BROWSE_ENABLED の代わり） */
    webBrowse?: boolean;
  } = {},
): Fixture {
  const clock = { now: T0 };
  const verifyResults: Partial<ExecResult>[] = [];
  const verifyCalls: string[][] = [];
  const verifyAdvanceMs: number[] = [];
  const modelCalls = {
    count: 0,
    userTexts: [] as string[][],
    toolResults: [] as string[][],
    reasoning: [] as (string | undefined)[],
    maxTokens: [] as (number | undefined)[],
  };
  const patch = { value: "From abc\n--- a\n+++ b\n" };
  const nameStatus = { value: "" };
  const testDiff = { value: "" };
  // DO の中と外で Promise を共有すると I/O の所有者が混ざるので、フラグのポーリングにする
  const gateState = { entered: false, released: false };
  const patchState = { held: false, entered: false };
  const execState = {
    status: { held: false, entered: false },
    switch: { held: false, entered: false },
  };
  const usageState = { held: false, entered: false };
  const submitState = { held: false, entered: false };
  const askState = { held: false, entered: false };
  const answerState = { held: false, entered: false };
  const afterAnswerState = { held: false, entered: false };
  const steerState = { held: false, entered: false };
  const questionState = { held: false, entered: false };
  const answerThrow = { once: false };
  const hold = async (g: { held: boolean; entered: boolean }) => {
    if (!g.held) return;
    g.entered = true;
    while (g.held) await new Promise((r) => setTimeout(r, 10));
  };
  const revParse: string[] = [];
  const statusResults: Partial<ExecResult>[] = [];
  const remote: { sha: string | undefined } = { sha: "c0ffee" };
  const pushResults: Partial<ExecResult>[] = [];
  const lsRemoteResults: Partial<ExecResult>[] = [];
  const pushCalls: string[][] = [];

  const sandbox = new FakeSandbox(async (argv) => {
    // `git -c k=v <sub> ...` の -c を読み飛ばしてサブコマンドを見る
    const gitArgs = argv[0] === "git" && argv[1] === "-c" ? ["git", ...argv.slice(3)] : argv;
    const [a0, a1] = gitArgs;
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
    if (a0 === "git" && a1 === "ls-remote") {
      const injected = lsRemoteResults.shift();
      if (injected) return injected;
      const ref = argv[3] ?? "";
      return { stdout: remote.sha === undefined ? "" : `${remote.sha}\t${ref}\n` };
    }
    if (a0 === "git" && a1 === "push") {
      pushCalls.push(argv);
      const r = pushResults.shift() ?? {};
      if ((r.exitCode ?? 0) === 0 && !r.timedOut) {
        // 最後の引数が `<src>:<ref>`。src が HEAD なら、検証前の HEAD（c0ffee）
        const src = (argv[argv.length - 1] ?? "").split(":")[0] ?? "";
        remote.sha = src === "HEAD" ? "c0ffee" : src;
      }
      return r;
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
    if (a0 === "git" && a1 === "diff" && argv.includes("-U0")) return { stdout: testDiff.value };
    if (a0 === "git" && a1 === "diff") return { stdout: " a.txt | 1 +\n" };
    if (a0 === "git" && a1 === "show") return { exitCode: 128, stderr: "fatal" };
    verifyCalls.push(argv);
    clock.now += verifyAdvanceMs.shift() ?? 0;
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
      name: "echo",
      description: "return the text as the tool output",
      parameters: Type.Object({ text: Type.String() }),
      replay: "safe",
      async execute(args) {
        return { output: [{ type: "text", text: args.text }] };
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
    ...(opts.modelEfforts !== undefined ? { modelEfforts: opts.modelEfforts } : {}),
    cancelWaitMs: opts.cancelWaitMs,
    finalizeWaitMs: opts.finalizeWaitMs,
    usageReadWaitMs: opts.usageReadWaitMs,
    pushRetryDelayMs: opts.pushRetryDelayMs ?? 0,
    web: opts.web,
    webLimits: opts.webLimits,
    webBrowseEnabled: opts.webBrowse,
    beforeUsageRead: () => hold(usageState),
    beforeSubmit: () => hold(submitState),
    beforeAskParent: () => hold(askState),
    beforeAnswerSubmit: async () => {
      await hold(answerState);
      if (answerThrow.once) {
        answerThrow.once = false;
        throw new Error("answer submit failed");
      }
    },
    afterAnswerSubmit: () => hold(afterAnswerState),
    beforeSteerSubmit: () => hold(steerState),
    afterQuestion: () => hold(questionState),
    onModelCall: (ctx) => {
      modelCalls.count += 1;
      modelCalls.userTexts.push(ctx?.userTexts ?? []);
      modelCalls.toolResults.push(ctx?.toolResults ?? []);
      modelCalls.reasoning.push(ctx?.reasoning);
      modelCalls.maxTokens.push(ctx?.maxTokens);
    },
  });
  return {
    name,
    stub: env.AGENT_DO.getByName(name),
    sandbox,
    clock,
    verifyResults,
    verifyCalls,
    verifyAdvanceMs,
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
    testDiff,
    revParse,
    statusResults,
    remote,
    pushResults,
    lsRemoteResults,
    pushCalls,
    usageGate: gateOf(usageState),
    submitGate: gateOf(submitState),
    askGate: gateOf(askState),
    answerGate: {
      ...gateOf(answerState),
      throwOnce: () => {
        answerThrow.once = true;
      },
    },
    afterAnswerGate: gateOf(afterAnswerState),
    steerGate: gateOf(steerState),
    questionGate: gateOf(questionState),
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
