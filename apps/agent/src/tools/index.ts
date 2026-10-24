import { createReadOnlySandboxToolsImpl, createSandboxToolsImpl } from "./sandbox-tools";
import type { SandboxToolsFactory } from "./types";

/** Sandbox を操作するツール群（read_file / list_files / search / write_file / edit_file / bash / git_commit）。 */
export const createSandboxTools: SandboxToolsFactory = (port, context) =>
  createSandboxToolsImpl(port, context) as unknown as ReturnType<SandboxToolsFactory>;

/** 読み取り専用の部分集合（read_file / list_files / search）。レビューのモデルに渡す。書き込み・実行の道具は含めない。 */
export const createReadOnlySandboxTools: SandboxToolsFactory = (port, context) =>
  createReadOnlySandboxToolsImpl(port, context) as unknown as ReturnType<SandboxToolsFactory>;

export type { SandboxToolsFactory, ToolContext } from "./types";
