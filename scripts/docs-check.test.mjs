// docs:check の検査関数の Unit テスト（node:test。外部 I/O なし）
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  checkClassificationCoverage,
  checkMappingTable,
  checkResultTables,
  checkSectionNumbers,
} from "./docs-check-lib.mjs";

const RESULT_HEADER = "| 実施者 | 日付 | 環境 | 結果 | 備考 |\n|---|---|---|---|---|\n| | | | | |";

describe("checkSectionNumbers", () => {
  it("連続していれば通る", () => {
    assert.deepEqual(checkSectionNumbers("## 1. a\n## 2. b\n## 3. c\n"), []);
  });
  it("重複を検出する", () => {
    const e = checkSectionNumbers("## 1. a\n## 2. b\n## 2. c\n");
    assert.ok(e.some((m) => m.includes("重複")));
  });
  it("欠番を検出する", () => {
    const e = checkSectionNumbers("## 1. a\n## 3. c\n");
    assert.ok(e.length > 0);
  });
  it("節が 1 つも無ければ失敗する", () => {
    assert.ok(checkSectionNumbers("# nothing\n").length > 0);
  });
  it("コードブロックの中の見出しは数えない", () => {
    assert.deepEqual(checkSectionNumbers("## 1. a\n```\n## 9. x\n```\n## 2. b\n"), []);
  });
});

describe("checkMappingTable", () => {
  const rows = (n) => Array.from({ length: n }, (_, i) => `| ${i + 1} | x | y | z |`).join("\n");
  const doc = (body) =>
    `## 19. design 12 の Phase 7（15 項目）の対応\n\n| # | a | b | c |\n|---|---|---|---|\n${body}\n\n## 20. next\n`;
  it("15 項目そろえば通る", () => {
    assert.deepEqual(checkMappingTable(doc(rows(15))), []);
  });
  it("足りない項目を名指しで失敗する", () => {
    const e = checkMappingTable(doc(rows(14)));
    assert.ok(e.some((m) => m.includes("15")));
  });
  it("重複を検出する", () => {
    const e = checkMappingTable(doc(`${rows(15)}\n| 3 | dup | | |`));
    assert.ok(e.some((m) => m.includes("重複")));
  });
  it("対応表の節が無ければ失敗する", () => {
    assert.ok(checkMappingTable("## 1. a\n").length > 0);
  });
});

describe("checkResultTables", () => {
  const phases = [1, 2, 3];
  it("すべての Phase に結果表があれば通る", () => {
    const md = phases.map((p) => `# Phase ${p} 受入試験\n\n${RESULT_HEADER}\n`).join("\n");
    assert.deepEqual(checkResultTables(md, phases), []);
  });
  it("結果表が無い Phase を名指しで失敗する", () => {
    const md = `# Phase 1 受入試験\n\n${RESULT_HEADER}\n# Phase 2 受入試験\n\n本文だけ\n# Phase 3 受入試験\n\n${RESULT_HEADER}\n`;
    const e = checkResultTables(md, phases);
    assert.equal(e.length, 1);
    assert.ok(e[0].includes("Phase 2"));
  });
  it("Phase の見出し自体が無ければ失敗する", () => {
    const md = `# Phase 1 受入試験\n\n${RESULT_HEADER}\n`;
    assert.equal(checkResultTables(md, phases).length, 2);
  });
  it("列が違う表は結果表と認めない", () => {
    const md = "# Phase 1 受入試験\n\n| 日付 | 結果 |\n|---|---|\n";
    assert.equal(checkResultTables(md, [1]).length, 1);
  });
});

describe("checkClassificationCoverage", () => {
  const table = (nums) =>
    `| 節 | 区分 |\n|---|---|\n${nums.map((n) => `| ${n} | 自動で済 |`).join("\n")}`;
  const doc = (nums, estimate = "") =>
    `# 実施の区分と結果の記録のしかた\n\n## 節ごとの区分\n\n${table(nums)}\n\n## M8〜M10 の見積もり\n\n${estimate}\n\n# Phase 1 受入試験\n`;
  it("全節が載っていれば通る", () => {
    assert.deepEqual(checkClassificationCoverage(doc([1, 2, 3]), 3), []);
  });
  it("載っていない節を名指しで失敗する", () => {
    const e = checkClassificationCoverage(doc([1, 3]), 3);
    assert.equal(e.length, 1);
    assert.ok(e[0].includes("2"));
  });
  it("見積もりの表の 1、2、3 を節として数えない", () => {
    const e = checkClassificationCoverage(doc([], table([1, 2, 3])), 3);
    assert.equal(e.length, 3);
  });
  it("区分表が無ければ失敗する", () => {
    assert.ok(checkClassificationCoverage("# x\n", 3).length > 0);
  });
});
