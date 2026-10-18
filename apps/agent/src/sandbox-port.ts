import type { GitCredential } from "./agent/types";

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
  /** 終端（terminate 済み）のため実行しなかった。exitCode は -1。 */
  terminated?: boolean;
}

/** Sandbox の作業環境を用意するための指定。認証済みの taskSpec から作る。 */
export interface WorkspaceSpec {
  /** owner/name */
  repository: string;
  baseSha: string;
  /** 作業ブランチ名（例: agent/task-<id>）。リモートに既にある（TaskDO が作成済み）ことが前提。 */
  branch: string;
  /** 作業ブランチの初期コミット（base_sha の上の空コミット）。 */
  initialSha: string;
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
  /**
   * GitHub の Installation Token を預ける（暗号化して SandboxDO の storage に保存。コンテナには入れない）。
   * ensureReady より前に呼ぶ（clone にも使うため）。冪等で、保存済みより新しい expiresAt のものだけ採用する。
   * 終端後は例外。terminate で削除される。
   */
  setGitCredential(credential: GitCredential): Promise<void>;
  /** terminate 後は例外ではなく `terminated: true` の結果を返す。 */
  exec(argv: string[], options?: ExecOptions): Promise<ExecResult>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  /**
   * 期限を延ばす（回答待ちの間に止めていた分を戻す）。単調増加だけ受け付け（小さい値は無視）、
   * 上限は作成時刻 + 2 時間 + 24 時間。超える値・準備前・終端後は例外。alarm も張り直す。
   */
  extendDeadline(deadlineAt: number): Promise<void>;
  /** 実行中のプロセスグループを止め、止まらなければコンテナを止める。停止を確かめてから戻る。 */
  stop(): Promise<{ stopped: boolean }>;
  /**
   * 永続的な終端停止。コンテナを止め、以後の ensureReady / exec / ファイル操作を拒否する（再開させない）。
   * cancel と、タスクの終端（期限・予算・失敗・完了）の片付けで使う。無い実装には stop で代用する。
   */
  terminate?(): Promise<{ stopped: boolean }>;
}
