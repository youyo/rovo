export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  /** 既定 10 分。超えたらプロセスグループごと kill して timedOut を立てる。 */
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

/** Sandbox の作業環境を用意するための指定。認証済みの taskSpec から作る。 */
export interface WorkspaceSpec {
  /** owner/name */
  repository: string;
  baseSha: string;
  /** 作業ブランチ名（例: agent/task-<id>） */
  branch: string;
  /** epoch ms。超えたら SandboxDO は自分でコンテナを止める。 */
  deadlineAt: number;
}

/** AgentDO から見た Sandbox。Unit では fake に差し替え、E2E では SandboxDO（実コンテナ）を使う。 */
export interface SandboxPort {
  /**
   * コンテナを起動し、/workspace に作業ツリーを用意する（冪等）。
   * 傍受の登録と CA 設定が終わるまで clone / exec はしない。
   */
  ensureReady(spec: WorkspaceSpec): Promise<void>;
  exec(argv: string[], options?: ExecOptions): Promise<ExecResult>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  /** 実行中のプロセスグループを止め、止まらなければコンテナを止める。停止を確かめてから戻る。 */
  stop(): Promise<{ stopped: boolean }>;
}
