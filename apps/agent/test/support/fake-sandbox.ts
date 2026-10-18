import type { GitCredential } from "../../src/agent/types";
import type { ExecOptions, ExecResult, SandboxPort, WorkspaceSpec } from "../../src/sandbox-port";

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

  /** extendDeadline で受け取った期限（古い順） */
  readonly extended: number[] = [];
  /** 設定すると extendDeadline がこの例外を投げる（1 回で消える） */
  extendError: Error | undefined;

  /**
   * SandboxDO の期限切れの再現（opt-in）。clock を渡すと、期限を過ぎた exec / readFile / writeFile は
   * "sandbox deadline exceeded" で失敗し、expireIfDue()（SandboxDO の alarm 相当）が認証トークンを消して破棄済みにする。
   * extendDeadline は単調増加だけ受け付ける（SandboxDO と同じ）。
   */
  clock: (() => number) | undefined;
  deadlineAt: number | undefined;
  destroyed = false;
  /** 保持している認証トークン（expireIfDue が消す）。 */
  credentialAlive = false;

  constructor(private readonly handler: ExecHandler = () => ({})) {}

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
    this.calls.push({ argv, options });
    const r = await this.handler(argv, options);
    return {
      exitCode: 0,
      stdout: "",
      stderr: "",
      timedOut: false,
      truncated: false,
      ...r,
    };
  }

  async readFile(path: string): Promise<string> {
    this.requireAlive();
    const v = this.files.get(path);
    if (v === undefined) throw new Error(`ENOENT: ${path}`);
    return v;
  }

  async writeFile(path: string, content: string): Promise<void> {
    this.requireAlive();
    this.files.set(path, content);
  }
}
