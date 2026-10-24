import { posix } from "node:path";
import { isSelectableSandboxInstance } from "@rovo/models";
import type { WorkspaceSpec } from "./sandbox-port";

/**
 * 入力パスを root 配下の絶対パスに正規化する（字面だけの検査）。外に出るものは拒否する。
 * シンボリックリンク経由の脱出は、コンテナ内で realpath を取って isInsideWorkspace で確かめる。
 */
export function resolveWorkspacePath(root: string, input: string): string {
  if (typeof input !== "string" || input === "") throw new Error("path must be a non-empty string");
  if (input.includes("\0")) throw new Error("path must not contain NUL");
  const abs = posix.normalize(input.startsWith("/") ? input : posix.join(root, input));
  const clean = abs.length > 1 && abs.endsWith("/") ? abs.slice(0, -1) : abs;
  if (!isInsideWorkspace(root, clean)) {
    throw new Error(`path is outside ${root}: ${input.slice(0, 200)}`);
  }
  return clean;
}

export function isInsideWorkspace(root: string, abs: string): boolean {
  return abs === root || abs.startsWith(`${root}/`);
}

const NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

/** "owner/name" を検証して分解する。.git 付きや URL 風の入力は拒否する。 */
export function parseRepository(repository: string): { owner: string; name: string } {
  const parts = typeof repository === "string" ? repository.split("/") : [];
  const [owner, name] = parts;
  if (
    parts.length !== 2 ||
    !owner ||
    !name ||
    !NAME.test(owner) ||
    !NAME.test(name) ||
    owner === ".." ||
    name === ".." ||
    name.endsWith(".git") ||
    owner.length > 100 ||
    name.length > 100
  ) {
    throw new Error("invalid repository: expected owner/name");
  }
  return { owner, name };
}

/** 外から来た spec を検証する。git の引数になるので、オプション注入できない形だけを通す。 */
export function validateWorkspaceSpec(spec: WorkspaceSpec): WorkspaceSpec {
  parseRepository(spec.repository);
  if (typeof spec.baseSha !== "string" || !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(spec.baseSha)) {
    throw new Error("invalid baseSha: expected a full commit sha");
  }
  if (
    typeof spec.initialSha !== "string" ||
    !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(spec.initialSha)
  ) {
    throw new Error("invalid initialSha: expected a full commit sha");
  }
  if (
    typeof spec.branch !== "string" ||
    spec.branch.length > 200 ||
    !/^[A-Za-z0-9_][A-Za-z0-9_./-]*$/.test(spec.branch) ||
    spec.branch.includes("..") ||
    spec.branch.endsWith("/") ||
    spec.branch.endsWith(".lock") ||
    spec.branch.includes("//")
  ) {
    throw new Error("invalid branch name");
  }
  if (spec.checkout !== undefined) {
    const c = spec.checkout;
    if (
      typeof c !== "object" ||
      c === null ||
      !Number.isSafeInteger(c.pullNumber) ||
      c.pullNumber < 1 ||
      typeof c.sha !== "string" ||
      !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(c.sha)
    ) {
      throw new Error("invalid checkout: expected a pull request number and a full commit sha");
    }
  }
  if (typeof spec.deadlineAt !== "number" || !Number.isFinite(spec.deadlineAt)) {
    throw new Error("invalid deadlineAt");
  }
  // タスクが選べる大きさは standard-1〜4 だけ（lite はメモリ不足で落ちた実績がある）。表に無い値は起動前に拒否する
  if (spec.instance !== undefined && !isSelectableSandboxInstance(spec.instance)) {
    throw new Error(
      "invalid instance: expected one of standard-1 / standard-2 / standard-3 / standard-4",
    );
  }
  return spec;
}
