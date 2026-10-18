import type { SandboxPort } from "../sandbox-port";

/** ツールが参照する実行時の情報。AgentDO が作って渡す。 */
export interface ToolContext {
  /** 作業ツリーのルート（コンテナ内の絶対パス） */
  workspaceRoot: string;
  /** 期限（epoch ms）。ツールの開始前に確かめ、超えていたらエラーにする。 */
  deadlineAt: number;
  /** git commit の作者 */
  commitAuthor: { name: string; email: string };
}

/**
 * Sandbox を操作するツール群（read_file / list_files / search / write_file / edit_file / bash / git_commit）を作る。
 * 戻り値は pi-durable の defineTool で作ったツールの配列。report_completion など AgentDO 固有のツールは含めない。
 */
export type SandboxToolsFactory = (
  port: SandboxPort,
  context: ToolContext,
) => ReturnType<typeof import("@earendil-works/pi-durable").defineTool>[];
