import { describe, expect, it } from "vitest";
import { normalizeStructuredEvent, workspaceRelativePath } from "../src";

// 見た目を偽装できる文字（双方向の制御・ゼロ幅）をパスに入れさせない
const INVISIBLE = [
  ["U+202A", "‪"],
  ["U+202E", "‮"],
  ["U+2066", "⁦"],
  ["U+2069", "⁩"],
  ["U+200E", "‎"],
  ["U+200F", "‏"],
  ["U+061C", "؜"],
  ["U+200B", "​"],
  ["U+200C", "‌"],
  ["U+200D", "‍"],
  ["U+FEFF", "﻿"],
] as const;

describe("workspaceRelativePath: 見えない文字の拒否", () => {
  it.each(INVISIBLE)("%s を含むパスは拒否", (_n, ch) => {
    expect(workspaceRelativePath("/workspace", `src/a${ch}b.ts`)).toBeUndefined();
    expect(workspaceRelativePath("/workspace", `/workspace/src/a${ch}.ts`)).toBeUndefined();
    expect(workspaceRelativePath("/workspace", `${ch}a.ts`)).toBeUndefined();
  });

  it("edit イベントでもパスごと捨てる。通常の日本語パスは通る", () => {
    for (const [, ch] of INVISIBLE) {
      expect(
        normalizeStructuredEvent("edit", { path: `a${ch}.ts`, op: "modify", added: 1, removed: 0 }),
      ).toBeUndefined();
    }
    expect(
      normalizeStructuredEvent("edit", {
        path: "docs/設計.md",
        op: "modify",
        added: 1,
        removed: 0,
      }),
    ).toMatchObject({ path: "docs/設計.md" });
  });
});
