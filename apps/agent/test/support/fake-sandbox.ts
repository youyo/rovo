import type { GitCredential, SandboxMetrics } from "../../src/agent/types";
import type {
  ExecOptions,
  ExecResult,
  PeekedOutput,
  SandboxPort,
  WorkspaceSpec,
} from "../../src/sandbox-port";

/**
 * 自動の git（push・ls-remote・rev-parse）が先頭に付ける、子の gitconfig を切り離す上書き（src/git-isolation.ts の GIT_ISOLATION_ARGS）を
 * 取り除いた argv。ハンドラが `argv[1]` をサブコマンドとして読む台本で使う。
 */
export function stripGitIsolation(argv: string[]): string[] {
  const head = ["git", "-c", "core.hooksPath=/dev/null", "-c", "credential.helper="];
  return head.every((h, i) => argv[i] === h) ? ["git", ...argv.slice(head.length)] : argv;
}

export type ExecHandler = (
  argv: string[],
  options: ExecOptions,
) => Partial<ExecResult> | Promise<Partial<ExecResult>>;

/** Unit 用の SandboxPort。ファイルはメモリ上、exec は台本（ハンドラ）で応答し、呼び出しを記録する。 */
export class FakeSandbox implements SandboxPort {
  readonly files = new Map<string, string>();
  readonly calls: { argv: string[]; options: ExecOptions }[] = [];
  readonly readySpecs: WorkspaceSpec[] = [];
  /** setGitCredential で預けられた値（古い順） */
  readonly credentials: GitCredential[] = [];
  /** ensureReady と setGitCredential が呼ばれた順（"credential" / "ready"） */
  readonly order: string[] = [];
  /** 設定すると setGitCredential がこの例外を投げる */
  credentialError: Error | undefined;
  stopCount = 0;
  /** stop() の戻り値を先頭から順に使う（空なら stopped:true）。後方互換の追加。 */
  stopResults: boolean[] = [];
  terminateCount = 0;
  /** terminate() の戻り値を先頭から順に使う（空なら stopped:true）。 */
  terminateResults: boolean[] = [];

  /** metrics() の戻り値。undefined なら読めない実装の再現（undefined を返す）。metricsError を立てると例外 */
  metricsValue: SandboxMetrics | undefined;
  metricsError: Error | undefined;

  /** suspend（回答待ちの間の中断）の再現。suspendCalls は受け取った引数、suspendResult を Error にすると例外 */
  readonly suspendCalls: { allowReclone: boolean }[] = [];
  suspendResult: { mode: "snapshot" | "destroyed" | "running" } | Error = { mode: "snapshot" };
  /** 中断中（次の exec / readFile / writeFile で戻り、resumes が増える） */
  suspended = false;
  resumes = 0;

  /** extendDeadline で受け取った期限（古い順） */
  readonly extended: number[] = [];
  /** 設定すると extendDeadline がこの例外を投げる（1 回で消える） */
  extendError: Error | undefined;
  /** setDeadline で受け取った期限（古い順） */
  readonly deadlines: number[] = [];
  /** 設定すると setDeadline がこの例外を投げる（1 回で消える） */
  setDeadlineError: Error | undefined;

  /**
   * SandboxDO の期限切れの再現（opt-in）。clock を渡すと、期限を過ぎた exec / readFile / writeFile は
   * "sandbox deadline exceeded" で失敗し、expireIfDue()（SandboxDO の alarm 相当）が認証トークンを消して破棄済みにする。
   * extendDeadline は単調増加だけ受け付ける。setDeadline は短くもできる（SandboxDO と同じ）。
   */
  clock: (() => number) | undefined;
  deadlineAt: number | undefined;
  destroyed = false;
  /** 保持している認証トークン（expireIfDue が消す）。 */
  credentialAlive = false;

  /**
   * peekOutput の再現。exec の実行中だけ running: true で、live の中身を返す（ハンドラが exec の途中で書き換える）。
   * peekError を立てると peekOutput が例外を投げる。peekCalls は呼ばれた回数。
   */
  live = { stdout: "", stderr: "" };
  peekError: Error | undefined;
  peekCalls = 0;
  private execStartedAt: number | undefined;

  constructor(private handler: ExecHandler = () => ({})) {}

  /** exec の台本を差し替える（ハンドラが sandbox 自身の live を書き換えるときに使う） */
  setHandler(handler: ExecHandler): void {
    this.handler = handler;
  }

  async ensureReady(spec: WorkspaceSpec): Promise<void> {
    this.order.push("ready");
    this.readySpecs.push(spec);
    this.deadlineAt ??= spec.deadlineAt;
    this.requireAlive();
  }

  async setGitCredential(credential: GitCredential): Promise<void> {
    if (this.credentialError) throw this.credentialError;
    this.order.push("credential");
    this.credentials.push(credential);
    this.credentialAlive = true;
  }

  async metrics(): Promise<SandboxMetrics | undefined> {
    if (this.metricsError) throw this.metricsError;
    return this.metricsValue && { ...this.metricsValue };
  }

  async extendDeadline(deadlineAt: number): Promise<void> {
    if (this.extendError) {
      const e = this.extendError;
      this.extendError = undefined;
      throw e;
    }
    this.order.push("extend");
    this.extended.push(deadlineAt);
    if (this.deadlineAt === undefined || deadlineAt > this.deadlineAt) this.deadlineAt = deadlineAt;
  }

  /** setDeadline の入口を止める（止めている間に別の出来事を起こすため）。 */
  readonly deadlineGate = { held: false, entered: false };

  /** 期限を短くもできる（SandboxDO と同じ）。 */
  async setDeadline(deadlineAt: number): Promise<void> {
    if (this.deadlineGate.held) {
      this.deadlineGate.entered = true;
      while (this.deadlineGate.held) await new Promise((r) => setTimeout(r, 10));
    }
    if (this.setDeadlineError) {
      const e = this.setDeadlineError;
      this.setDeadlineError = undefined;
      throw e;
    }
    this.order.push("set_deadline");
    this.deadlines.push(deadlineAt);
    this.deadlineAt = deadlineAt;
  }

  /** SandboxDO の alarm 相当。期限を過ぎていれば認証トークンを消し、コンテナを破棄する。 */
  expireIfDue(): void {
    if (this.clock && this.deadlineAt !== undefined && this.clock() >= this.deadlineAt) {
      this.credentialAlive = false;
      this.destroyed = true;
    }
  }

  private requireAlive(): void {
    this.expireIfDue();
    if (this.destroyed) throw new Error("sandbox deadline exceeded");
  }

  async suspend(options: {
    allowReclone: boolean;
  }): Promise<{ mode: "snapshot" | "destroyed" | "running" }> {
    this.suspendCalls.push(options);
    if (this.suspendResult instanceof Error) throw this.suspendResult;
    if (this.suspendResult.mode !== "running") this.suspended = true;
    return this.suspendResult;
  }

  private resumeIfSuspended(): void {
    if (this.suspended) {
      this.suspended = false;
      this.resumes += 1;
    }
  }

  async stop(): Promise<{ stopped: boolean }> {
    this.stopCount += 1;
    return { stopped: this.stopResults.shift() ?? true };
  }

  /** 終端停止。terminate を持たない実装の再現は Object.defineProperty(sb, "terminate", {value: undefined}) で行う。 */
  async terminate(): Promise<{ stopped: boolean }> {
    this.terminateCount += 1;
    return { stopped: this.terminateResults.shift() ?? true };
  }

  async exec(argv: string[], options: ExecOptions = {}): Promise<ExecResult> {
    this.requireAlive();
    this.resumeIfSuspended();
    this.calls.push({ argv, options });
    if (options.origin !== undefined) {
      this.execStartedAt = Date.now();
      this.live = { stdout: "", stderr: "" };
    }
    let r: Partial<ExecResult>;
    try {
      r = await this.handler(argv, options);
    } finally {
      this.execStartedAt = undefined;
    }
    return {
      exitCode: 0,
      stdout: "",
      stderr: "",
      timedOut: false,
      truncated: false,
      ...r,
    };
  }

  async peekOutput(): Promise<PeekedOutput> {
    this.peekCalls += 1;
    if (this.peekError) throw this.peekError;
    if (this.execStartedAt === undefined) return { running: false, stdout: "", stderr: "" };
    return { running: true, startedAt: this.execStartedAt, ...this.live };
  }

  async readFile(path: string): Promise<string> {
    this.requireAlive();
    this.resumeIfSuspended();
    const v = this.files.get(path);
    if (v === undefined) throw new Error(`ENOENT: ${path}`);
    return v;
  }

  async writeFile(path: string, content: string): Promise<void> {
    this.requireAlive();
    this.resumeIfSuspended();
    this.files.set(path, content);
  }
}
