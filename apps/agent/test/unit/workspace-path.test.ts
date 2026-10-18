import { describe, expect, it } from "vitest";
import {
  isInsideWorkspace,
  parseRepository,
  resolveWorkspacePath,
  validateWorkspaceSpec,
} from "../../src/workspace-path";

describe("resolveWorkspacePath", () => {
  it("相対パスは /workspace 基準で解決する", () => {
    expect(resolveWorkspacePath("/workspace", "src/a.ts")).toBe("/workspace/src/a.ts");
    expect(resolveWorkspacePath("/workspace", "./src/../a.ts")).toBe("/workspace/a.ts");
    expect(resolveWorkspacePath("/workspace", ".")).toBe("/workspace");
  });

  it("絶対パスは /workspace 配下ならそのまま、正規化する", () => {
    expect(resolveWorkspacePath("/workspace", "/workspace/a//b/./c")).toBe("/workspace/a/b/c");
    expect(resolveWorkspacePath("/workspace", "/workspace")).toBe("/workspace");
  });

  it.each(["../etc/passwd", "/etc/passwd", "a/../../x", "/workspace/../etc", "/workspacex/a", "/"])(
    "外に出る %s は拒否する",
    (p) => {
      expect(() => resolveWorkspacePath("/workspace", p)).toThrow(/outside/);
    },
  );

  it("空文字・NUL 文字・非文字列は拒否する", () => {
    expect(() => resolveWorkspacePath("/workspace", "")).toThrow();
    expect(() => resolveWorkspacePath("/workspace", "a\0b")).toThrow();
    expect(() => resolveWorkspacePath("/workspace", 1 as unknown as string)).toThrow();
  });
});

describe("isInsideWorkspace", () => {
  it("realpath の結果などが root 配下かを判定する", () => {
    expect(isInsideWorkspace("/workspace", "/workspace")).toBe(true);
    expect(isInsideWorkspace("/workspace", "/workspace/a/b")).toBe(true);
    expect(isInsideWorkspace("/workspace", "/workspace2")).toBe(false);
    expect(isInsideWorkspace("/workspace", "/etc")).toBe(false);
  });
});

describe("parseRepository", () => {
  it("owner/name を分解する", () => {
    expect(parseRepository("octocat/Hello-World")).toEqual({
      owner: "octocat",
      name: "Hello-World",
    });
    expect(parseRepository("a.b/c_d.e")).toEqual({ owner: "a.b", name: "c_d.e" });
  });
  it.each([
    "",
    "a",
    "a/b/c",
    "/b",
    "a/",
    "a b/c",
    "a/b?x=1",
    "../x",
    "a/..",
    "a/b.git",
    "-x/y",
    "a/b\n",
  ])("不正な %j は拒否する", (s) => {
    expect(() => parseRepository(s)).toThrow();
  });
});

describe("validateWorkspaceSpec", () => {
  const ok = {
    repository: "acme/hello",
    baseSha: "a".repeat(40),
    branch: "agent/task-abc123",
    initialSha: "b".repeat(40),
    deadlineAt: Date.now() + 1000,
  };
  it("正しい spec を通す", () => {
    expect(validateWorkspaceSpec(ok)).toEqual(ok);
  });
  it.each([
    ["baseSha", "main"],
    ["baseSha", "--upload-pack=x"],
    ["baseSha", "abc"],
    ["initialSha", "main"],
    ["initialSha", "--upload-pack=x"],
    ["initialSha", ""],
    ["branch", "-evil"],
    ["branch", "a b"],
    ["branch", "a..b"],
    ["branch", ""],
    ["branch", "x;rm"],
    ["repository", "a/b/c"],
    ["deadlineAt", Number.NaN],
    ["deadlineAt", "soon"],
  ])("%s=%j は拒否する", (key, value) => {
    expect(() => validateWorkspaceSpec({ ...ok, [key]: value })).toThrow();
  });
});
