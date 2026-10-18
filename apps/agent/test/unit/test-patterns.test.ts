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
