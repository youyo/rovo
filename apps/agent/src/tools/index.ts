import { createSandboxToolsImpl } from "./sandbox-tools";
import type { SandboxToolsFactory } from "./types";

/** Sandbox を操作するツール群（read_file / list_files / search / write_file / edit_file / bash / git_commit）。 */
export const createSandboxTools: SandboxToolsFactory = (port, context) =>
  createSandboxToolsImpl(port, context) as unknown as ReturnType<SandboxToolsFactory>;

export type { SandboxToolsFactory, ToolContext } from "./types";
