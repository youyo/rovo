export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  /** 既定 10 分。超えたら kill して timedOut を立てる。 */
  timeoutMs?: number;
  /** 既定 64KiB。超えた分は捨て、末尾を残す。 */
  maxOutputBytes?: number;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** 出力が上限を超えて切り詰められたか */
  truncated: boolean;
}

/** AgentDO から見た Sandbox。Unit では fake に差し替え、E2E では SandboxDO（実コンテナ）を使う。 */
export interface SandboxPort {
  exec(argv: string[], options?: ExecOptions): Promise<ExecResult>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
}
