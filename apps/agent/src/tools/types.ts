import type { SandboxPort } from "../sandbox-port";

/** ツールが参照する実行時の情報。AgentDO が作って渡す。 */
export interface ToolContext {
  /** 作業ツリーのルート（コンテナ内の絶対パス） */
  workspaceRoot: string;
  /** 期限（epoch ms）。ツールの開始前に確かめ、超えていたらエラーにする。 */
  deadlineAt: number;
  /** git commit の作者 */
  commitAuthor: { name: string; email: string };
  /** 作業ブランチ名（`agent/task-<id>`）。git_commit の成功のたびに、ここへ push する。未設定なら push しない。 */
  branch?: string;
  /** git_commit の push の結果（best-effort。失敗しても git_commit は失敗にならない）。 */
  onPush?: (result: PushResult) => Promise<void>;
  /**
   * 構造化イベント（command / edit / commit。D14）の出口。ツールが成功したときに、許可した項目だけを渡す。
   * 渡す前にツール側で正規化（マスク・整形・上限）する。ここが例外を投げてもツールの結果には影響させない。
   */
  onEvent?: (type: string, data: Record<string, unknown>) => void;
}

export type PushResult = { ok: true; sha: string } | { ok: false; sha: string; error: string };

/**
 * Sandbox を操作するツール群（read_file / list_files / search / write_file / edit_file / bash / git_commit）を作る。
 * 戻り値は pi-durable の defineTool で作ったツールの配列。report_completion など AgentDO 固有のツールは含めない。
 */
export type SandboxToolsFactory = (
  port: SandboxPort,
  context: ToolContext,
) => ReturnType<typeof import("@earendil-works/pi-durable").defineTool>[];
