// docs:check のエントリ。検査関数は docs-check-lib.mjs。失敗があれば終了コード 1。
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkClassificationCoverage,
  checkMappingTable,
  checkResultTables,
  checkSectionNumbers,
  maxSectionNumber,
} from "./docs-check-lib.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const acceptance = readFileSync(join(root, "docs/specs/acceptance.md"), "utf8");

const errors = [
  ...checkSectionNumbers(acceptance).map((m) => `acceptance.md 節番号: ${m}`),
  ...checkMappingTable(acceptance).map((m) => `acceptance.md 15 項目の対応表: ${m}`),
  ...checkResultTables(acceptance).map((m) => `acceptance.md 結果表: ${m}`),
  ...checkClassificationCoverage(acceptance, maxSectionNumber(acceptance)).map(
    (m) => `acceptance.md 区分表: ${m}`,
  ),
];

if (errors.length > 0) {
  for (const e of errors) console.error(`NG ${e}`);
  console.error(`docs:check 失敗（${errors.length} 件）`);
  process.exit(1);
}
console.log("docs:check OK");
