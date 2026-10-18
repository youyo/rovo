import { DurableObject } from "cloudflare:workers";
import type {
  AgentEventDto,
  AgentPhase,
  CancelResult,
  EventsPage,
  ResultDto,
  StartResult,
  TaskSpec,
  UsageDto,
} from "../../src/agent/contract";

/** start の台本 1 手。lose は「効果は起きたが応答が失われる」。 */
export type StartStep = "accept" | "reject" | "conflict" | "throw" | "lose";
/** cancel の台本 1 手。 */
export type CancelStep = "stopped" | "not_stopped" | "throw" | "lose";

export type FakeProgram = {
  /** 呼び出しごとに 1 手ずつ消費する。尽きたら accept。 */
  start?: StartStep[];
  /** 呼び出しごとに 1 手ずつ消費する。尽きたら stopped。 */
  cancel?: CancelStep[];
  /** accept したら starting -> running の phase イベントを積む（既定 true）。 */
  autoRun?: boolean;
  /** getEvents を先頭 n 回だけ失敗させる。 */
  getEventsFailures?: number;
  /** getEvents を n 回成功させた後は、以降の呼び出しをすべて失敗させる。 */
  getEventsFailAfter?: number;
  /** getEvents が返るまでの遅延（ms）。同時取り込みの再現に使う。 */
  getEventsDelayMs?: number;
  /** 1 ページの上限（呼び出し側の limit よりこちらが小さければ優先）。 */
  pageCap?: number;
  /** getEvents が返すイベントを seq <= n に制限する（hasMore は false）。読み取りの遅れの再現に使う。 */
  visibleThrough?: number;
  /** getEvents が 1 回だけ afterSeq を無視して先頭から返す（古いページの再配送）。 */
  staleOnce?: boolean;
  rejectReason?: string;
  /** getResult の戻り値。未設定なら phase が終端のとき合成する。 */
  result?: ResultDto;
};

export type FakeCalls = {
  start: number;
  cancel: number;
  getEvents: number;
  getResult: number;
  specs: TaskSpec[];
};

const TERMINAL: readonly AgentPhase[] = ["completed", "failed", "budget_exceeded", "cancelled"];

const ZERO_USAGE: UsageDto = {
  costUsd: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

/**
 * 台本で制御できる AgentDO の偽物。Gateway の Unit（vitest.config.ts）と E2E の偽 Worker で使う。
 * 本物と同じ規則だけを持つ: start の冪等と conflict、cancel の tombstone、イベントの seq、phase の終端。
 */
export class FakeAgentDO extends DurableObject {
  private program: FakeProgram = {};
  private spec: string | undefined;
  private tombstone = false;
  private phase: AgentPhase | undefined;
  private phaseSeq = 0;
  private events: AgentEventDto[] = [];
  private usage: UsageDto = ZERO_USAGE;
  private stale = false;
  private getEventsFails = 0;
  private callCounts: FakeCalls = { start: 0, cancel: 0, getEvents: 0, getResult: 0, specs: [] };

  // ---- 制御用 RPC（テストから呼ぶ）----

  setProgram(p: FakeProgram): void {
    this.program = { ...p, start: [...(p.start ?? [])], cancel: [...(p.cancel ?? [])] };
    this.stale = p.staleOnce === true;
    this.getEventsFails = p.getEventsFailures ?? 0;
  }

  calls(): FakeCalls {
    return { ...this.callCounts, specs: [...this.callCounts.specs] };
  }

  /** イベントを積む（phase 以外）。 */
  emit(type: string, data: unknown): number {
    return this.append(type, data);
  }

  /** phase を変えてイベントを積む。終端からは変えない。 */
  setPhase(next: AgentPhase, reason?: string): number {
    if (this.phase !== undefined && TERMINAL.includes(this.phase)) return this.phaseSeq;
    const seq = this.append(
      "phase",
      reason === undefined ? { phase: next } : { phase: next, reason },
    );
    this.phase = next;
    this.phaseSeq = seq;
    return seq;
  }

  /** 累計の usage を更新し、usage イベントを積む。 */
  setUsage(costUsd: number, extra: Partial<UsageDto> = {}): number {
    this.usage = { ...this.usage, ...extra, costUsd };
    return this.append("usage", this.usage);
  }

  private append(type: string, data: unknown): number {
    const seq = this.events.length + 1;
    this.events.push({ seq, ts: Date.now(), type, data: JSON.stringify(data) });
    return seq;
  }

  private isTerminal(): boolean {
    return this.phase !== undefined && TERMINAL.includes(this.phase);
  }

  // ---- AgentDO の RPC ----

  async start(spec: TaskSpec): Promise<StartResult> {
    this.callCounts.start++;
    this.callCounts.specs.push(spec);
    const step = this.program.start?.shift() ?? "accept";
    if (step === "throw") throw new Error("fake agent: start failed");
    const result = this.applyStart(spec, step);
    if (step === "lose") throw new Error("fake agent: start response lost");
    return result;
  }

  private applyStart(spec: TaskSpec, step: StartStep): StartResult {
    if (step === "reject") {
      return { status: "rejected", reason: this.program.rejectReason ?? "invalid_spec" };
    }
    if (step === "conflict") return { status: "conflict" };
    if (this.tombstone) return { status: "cancelled" };
    const canonical = JSON.stringify(spec);
    if (this.spec !== undefined && this.spec !== canonical) return { status: "conflict" };
    const already = this.spec !== undefined;
    if (!already) {
      this.spec = canonical;
      this.setPhase("starting");
      if (this.program.autoRun !== false) this.setPhase("running");
    }
    return { status: "accepted", phase: this.phase ?? "starting", alreadyAccepted: already };
  }

  async cancel(): Promise<CancelResult> {
    this.callCounts.cancel++;
    const step = this.program.cancel?.shift() ?? "stopped";
    if (step === "throw") throw new Error("fake agent: cancel failed");
    this.tombstone = true;
    if (this.spec !== undefined && !this.isTerminal()) this.setPhase("cancelled", "cancel");
    if (step === "lose") throw new Error("fake agent: cancel response lost");
    // 契約: stopped:true なら、以後イベントは追加されない。finalSeq は最後のイベントの seq。
    return step === "stopped"
      ? { stopped: true, finalSeq: this.events.length }
      : { stopped: false };
  }

  async getEvents(afterSeq: number, limit: number): Promise<EventsPage> {
    this.callCounts.getEvents++;
    const failAfter = this.program.getEventsFailAfter;
    if (failAfter !== undefined && this.callCounts.getEvents > failAfter) {
      throw new Error("fake agent: getEvents failed (after)");
    }
    if (this.getEventsFails > 0) {
      this.getEventsFails--;
      throw new Error("fake agent: getEvents failed");
    }
    // 古いページの再配送: afterSeq を無視して先頭から返す
    let from = afterSeq;
    if (this.stale) {
      this.stale = false;
      from = 0;
    }
    const delay = this.program.getEventsDelayMs ?? 0;
    const visible = this.program.visibleThrough;
    const snapshot = this.events.filter((e) => visible === undefined || e.seq <= visible);
    const phase = this.phase;
    const phaseSeq = this.phaseSeq;
    const usage = this.usage;
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    const n = Math.max(1, Math.min(limit, this.program.pageCap ?? limit));
    const rest = snapshot.filter((e) => e.seq > from);
    const page = rest.slice(0, n);
    return {
      events: page,
      throughSeq: page.length > 0 ? (page[page.length - 1]?.seq ?? from) : from,
      hasMore: rest.length > n,
      phase,
      phaseAsOfSeq: phaseSeq,
      usage,
    };
  }

  async getResult(): Promise<ResultDto> {
    this.callCounts.getResult++;
    if (this.program.result) return this.program.result;
    const phase = this.phase;
    if (phase === undefined || !this.isTerminal()) return { status: "not_ready" };
    return {
      status: phase as "completed" | "failed" | "budget_exceeded" | "cancelled",
      summary: "fake summary",
      verification: { commands: [], results: [], verified: false, attempts: 0 },
      warnings: [],
      patchTooLarge: false,
      usage: this.usage,
    };
  }
}
