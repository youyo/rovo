import { describe, expect, it } from "vitest";
import { isLightCommand } from "../../src/scale-cmd";

const sh = (script: string): string[] => ["bash", "-c", script];

describe("isLightCommand（明らかに軽いコマンドだけ true。迷う形は false）", () => {
  const cases: [string, string[], boolean][] = [
    ["ls -la", sh("ls -la"), true],
    ["git status && git diff --stat", sh("git status && git diff --stat"), true],
    ["cat a.txt | head -20", sh("cat a.txt | head -20"), true],
    ["cd apps/agent && ls", sh("cd apps/agent && ls"), true],
    ["sh -lc の束", ["sh", "-lc", "pwd; echo hi"], true],
    ["リダイレクト", sh("ls 2>&1 > out.txt"), true],
    ["改行区切り", sh("ls\npwd"), true],
    ["直の argv: ls", ["ls", "-la"], true],
    ["直の argv: パスつき", ["/usr/bin/cat", "a"], true],
    ["直の argv: git status", ["git", "status"], true],
    ["直の argv: git push", ["git", "push"], false],
    ["直の argv: git -C", ["git", "-C", "d", "status"], false],
    ["直の argv: pnpm", ["pnpm", "test"], false],
    ["git branch", sh("git branch -a"), true],
    ["pnpm test", sh("pnpm test"), false],
    ["ls && pnpm build", sh("ls && pnpm build"), false],
    ["FOO=1 ls", sh("FOO=1 ls"), false],
    ["echo $(pnpm -v)", sh("echo $(pnpm -v)"), false],
    ["バッククォート", sh("echo `ls`"), false],
    ["here-doc", sh("cat <<EOF\nx\nEOF"), false],
    ["timeout 10 ls", sh("timeout 10 ls"), false],
    ["env ls", sh("env ls"), false],
    ["git push", sh("git push"), false],
    ["git -C dir status", sh("git -C dir status"), false],
    ["git のみ", sh("git"), false],
    ["find . -name x", sh("find . -name x"), false],
    ["空のスクリプト", sh(""), false],
    ["空白だけ", sh("   "), false],
    ["閉じない引用符", sh("echo 'abc"), false],
    ["バックグラウンド + 重い", sh("ls & pnpm test"), false],
    ["-c が無い", ["bash", "script.sh"], false],
    ["空の argv", [], false],
  ];
  it.each(cases)("%s", (_name, argv, expected) => {
    expect(isLightCommand(argv)).toBe(expected);
  });
});
