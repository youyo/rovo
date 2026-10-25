import { describe, expect, it } from "vitest";
import { normalizeBashArgs, splitLeadingCd } from "../../src/tools/leading-cd";

const same = (c: string, cwd?: string) => {
  expect(splitLeadingCd(c, cwd)).toEqual({ command: c, cwd });
};

describe("splitLeadingCd", () => {
  it("; と && の先頭 cd を cwd に移す", () => {
    expect(splitLeadingCd("cd apps/agent; grep x")).toEqual({
      command: "grep x",
      cwd: "apps/agent",
    });
    expect(splitLeadingCd("  cd apps/agent && grep x  ")).toEqual({
      command: "grep x",
      cwd: "apps/agent",
    });
  });
  it("素朴な引用符は外す", () => {
    expect(splitLeadingCd(`cd "a/b"; ls`)).toEqual({ command: "ls", cwd: "a/b" });
    expect(splitLeadingCd(`cd 'a/b' && ls`)).toEqual({ command: "ls", cwd: "a/b" });
  });
  it("cwd を基点に合成する", () => {
    expect(splitLeadingCd("cd src; ls", "apps/agent")).toEqual({
      command: "ls",
      cwd: "apps/agent/src",
    });
    expect(splitLeadingCd("cd ..; ls", "apps/agent")).toEqual({ command: "ls", cwd: "apps" });
  });
  it("連続した cd を外す", () => {
    expect(splitLeadingCd("cd a; cd b && ls")).toEqual({ command: "ls", cwd: "a/b" });
    expect(splitLeadingCd("cd a; cd $HOME; ls")).toEqual({ command: "cd $HOME; ls", cwd: "a" });
  });
  it("絶対パス: ルート配下は相対に、外は変換しない", () => {
    expect(splitLeadingCd("cd /workspace/apps; ls")).toEqual({ command: "ls", cwd: "apps" });
    expect(splitLeadingCd("cd /workspace; ls")).toEqual({ command: "ls", cwd: "." });
    same("cd /etc; ls");
    same("cd /workspacex; ls");
  });
  it(".. でルートの外に出るものは変換しない", () => {
    same("cd ..; ls");
    same("cd ../..; ls", "a");
    same("cd /workspace/../etc; ls");
  });
  it("危うい形は変換しない", () => {
    same("cd x || exit");
    same("cd x | cat");
    same("cd x");
    same("cd x;");
    same("cd x; ");
    same("cd -; ls");
    same("cd; ls");
    same("cd $HOME; ls");
    same("cd ~; ls");
    same("cd ~/x; ls");
    same(`cd "a b"; ls`);
    same("cd a\\ b; ls");
    same("cd `pwd`; ls");
    same("cd *; ls");
    same("cd x; | cat");
    same("cd x && || y");
    same("pushd x; ls");
  });
});

describe("normalizeBashArgs", () => {
  it("bash の引数だけ変換する", () => {
    expect(normalizeBashArgs("bash", { command: "cd a; ls", timeout_seconds: 5 })).toEqual({
      command: "ls",
      cwd: "a",
      timeout_seconds: 5,
    });
    const other = { command: "cd a; ls" };
    expect(normalizeBashArgs("search", other)).toBe(other);
    expect(normalizeBashArgs("bash", "x")).toBe("x");
  });
});
