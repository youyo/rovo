import { describe, expect, it } from "vitest";
import { detectTestTampering } from "../../src/agent/test-patterns";

describe("テスト関連ファイルの変更検出", () => {
  it("変更が無ければ警告なし", () => {
    expect(
      detectTestTampering({
        nameStatus: "M\tsrc/a.ts\nA\tsrc/b.ts",
        baseScripts: { test: "vitest" },
        headScripts: { test: "vitest" },
      }),
    ).toEqual([]);
  });

  it("package.json の scripts の変更を検出する", () => {
    const w = detectTestTampering({
      nameStatus: "M\tpackage.json",
      baseScripts: { test: "vitest run" },
      headScripts: { test: "true" },
    });
    expect(w.join("\n")).toContain("package.json");
    expect(w.join("\n")).toContain("test");
  });

  it("テストファイルの削除とテスト設定の変更を検出する", () => {
    const w = detectTestTampering({
      nameStatus: "D\ttest/a.test.ts\nM\tvitest.config.ts\nA\ttest/new.test.ts\nM\tsrc/x.ts",
      baseScripts: undefined,
      headScripts: undefined,
    });
    expect(w).toHaveLength(2);
    expect(w.join("\n")).toContain("test/a.test.ts");
    expect(w.join("\n")).toContain("vitest.config.ts");
  });
});

function fileDiff(path: string, body: string[], kind: "M" | "A" = "M"): string {
  return [
    `diff --git a/${path} b/${path}`,
    ...(kind === "A" ? ["new file mode 100644"] : []),
    `--- ${kind === "A" ? "/dev/null" : `a/${path}`}`,
    `+++ b/${path}`,
    "@@ -1,3 +1,3 @@",
    ...body,
  ].join("\n");
}

const NO_SCRIPTS = { baseScripts: undefined, headScripts: undefined };

describe("既存テストの弱体化の検出", () => {
  it("既存テストの期待値の書き換えを検出する", () => {
    const w = detectTestTampering({
      nameStatus: "M\ttest/a.test.ts",
      testDiff: fileDiff("test/a.test.ts", [
        "-    expect(x).not.toHaveProperty('a');",
        "+    expect(x).toBe(0);",
      ]),
      ...NO_SCRIPTS,
    });
    expect(w).toHaveLength(1);
    expect(w[0]).toContain("test/a.test.ts");
    expect(w[0]).toContain("削除または書き換え");
  });

  it("既存テストの削除行を検出する", () => {
    const w = detectTestTampering({
      nameStatus: "M\ttest/a.test.ts",
      testDiff: fileDiff("test/a.test.ts", ["-  it('x', () => {});"]),
      ...NO_SCRIPTS,
    });
    expect(w.join("\n")).toContain("test/a.test.ts");
  });

  it.each([
    "+  it.skip('x', () => {});",
    "+  describe.only('x', () => {});",
    "+  xit('x', () => {});",
    "+  it.todo('x');",
    "+@pytest.mark.skip(reason='x')",
    '+  t.Skip("x")',
  ])("skip / only / todo の追加を検出する: %s", (line) => {
    const w = detectTestTampering({
      nameStatus: "M\ttest/a.test.ts",
      testDiff: fileDiff("test/a.test.ts", [line]),
      ...NO_SCRIPTS,
    });
    expect(w).toHaveLength(1);
    expect(w[0]).toContain("skip");
  });

  it.each([
    "+  }, 20000);",
    "+  it('x', () => {}, 30_000);",
    "+  testTimeout: 20000,",
    "+  jest.setTimeout(60000);",
    "+  it('x', { timeout: 20000 }, () => {});",
  ])("タイムアウトの追加・延長を検出する: %s", (line) => {
    const w = detectTestTampering({
      nameStatus: "M\ttest/a.test.ts",
      testDiff: fileDiff("test/a.test.ts", [line]),
      ...NO_SCRIPTS,
    });
    expect(w).toHaveLength(1);
    expect(w[0]).toContain("タイムアウト");
  });

  it("新規テストファイルの追加だけなら警告なし", () => {
    const w = detectTestTampering({
      nameStatus: "A\ttest/new.test.ts",
      testDiff: fileDiff("test/new.test.ts", ["+it('x', () => {});"], "A"),
      ...NO_SCRIPTS,
    });
    expect(w).toEqual([]);
  });

  it("既存テストファイルにテストを足しただけなら警告なし", () => {
    const w = detectTestTampering({
      nameStatus: "M\ttest/a.test.ts",
      testDiff: fileDiff("test/a.test.ts", [
        "+  it('new', () => {",
        "+    expect(1).toBe(1);",
        "+  });",
      ]),
      ...NO_SCRIPTS,
    });
    expect(w).toEqual([]);
  });

  it("テストファイル以外の差分は見ない", () => {
    const w = detectTestTampering({
      nameStatus: "M\tsrc/a.ts",
      testDiff: fileDiff("src/a.ts", ["-  a();", "+  it.skip();"]),
      ...NO_SCRIPTS,
    });
    expect(w).toEqual([]);
  });

  it("ファイルごとに別々の警告を返す", () => {
    const w = detectTestTampering({
      nameStatus: "M\ttest/a.test.ts\nM\ttest/b.test.ts",
      testDiff: [
        fileDiff("test/a.test.ts", ["-  x", "+  y"]),
        fileDiff("test/b.test.ts", ["+  it.skip('z', () => {});"]),
      ].join("\n"),
      ...NO_SCRIPTS,
    });
    expect(w).toHaveLength(2);
  });
});
