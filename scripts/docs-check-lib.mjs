// docs:check の検査関数。入力は Markdown の文字列、出力はエラーメッセージの配列（空なら合格）。

/** コードブロックの中身を空行に置き換える（見出し・表の誤検出を避ける。行番号は保つ） */
function stripCodeBlocks(md) {
  let inCode = false;
  return md
    .split("\n")
    .map((line) => {
      if (line.trimStart().startsWith("```")) {
        inCode = !inCode;
        return "";
      }
      return inCode ? "" : line;
    })
    .join("\n");
}

/** 受入の節番号（`## N. 見出し`）を、ファイルの出現順に返す */
function sectionNumbers(md) {
  return [...stripCodeBlocks(md).matchAll(/^## (\d+)\. /gm)].map((m) => Number(m[1]));
}

export function maxSectionNumber(md) {
  return Math.max(0, ...sectionNumbers(md));
}

/** 節番号が 1 から連続していて、重複が無い */
export function checkSectionNumbers(md) {
  const nums = sectionNumbers(md);
  if (nums.length === 0) return ["節（`## N. 見出し`）が 1 つも無い"];
  const errors = [];
  const seen = new Set();
  for (const n of nums) {
    if (seen.has(n)) errors.push(`節 ${n} が重複している`);
    seen.add(n);
  }
  let expected = 1;
  for (const n of nums) {
    if (n === expected - 1 && seen.has(n)) continue; // 重複は上で報告済み
    if (n !== expected) {
      errors.push(`節の番号が連続していない（${expected} のはずが ${n}）`);
      expected = n;
    }
    expected += 1;
  }
  return errors;
}

/** `startRe` に一致する見出しから、同じか浅い階層の次の見出しまでの本文 */
function blockAfterHeading(md, startRe) {
  const lines = stripCodeBlocks(md).split("\n");
  const i = lines.findIndex((l) => /^#{1,6} /.test(l) && startRe.test(l));
  if (i < 0) return null;
  const level = lines[i].match(/^(#+)/)[1].length;
  const body = [];
  for (let j = i + 1; j < lines.length; j++) {
    const m = lines[j].match(/^(#+) /);
    if (m && m[1].length <= level) break;
    body.push(lines[j]);
  }
  return body;
}

/** 表の行の、先頭セルが整数のものの値 */
function leadingIntegers(lines) {
  const out = [];
  for (const l of lines) {
    const m = l.match(/^\|\s*(\d+)\s*\|/);
    if (m) out.push(Number(m[1]));
  }
  return out;
}

/** design 12 の Phase 7 の 15 項目の対応表に、1〜15 が 1 回ずつある */
export function checkMappingTable(md, count = 15) {
  const body = blockAfterHeading(md, /^## \d+\. .*15 項目/);
  if (!body) return ["「15 項目」を含む節（`## N. ...15 項目...`）が無い"];
  const nums = leadingIntegers(body);
  const errors = [];
  const seen = new Set();
  for (const n of nums) {
    if (seen.has(n)) errors.push(`項目 ${n} が重複している`);
    seen.add(n);
  }
  for (let n = 1; n <= count; n++) {
    if (!seen.has(n)) errors.push(`項目 ${n} が対応表に無い（1〜${count} の全部が要る）`);
  }
  for (const n of seen) {
    if (n < 1 || n > count) errors.push(`項目 ${n} は範囲外（1〜${count}）`);
  }
  return errors;
}

const RESULT_HEADER = /^\|\s*実施者\s*\|\s*日付\s*\|\s*環境\s*\|\s*結果\s*\|\s*備考\s*\|\s*$/m;

/** 各 Phase のブロック（`# Phase N ...`）に、結果表（実施者・日付・環境・結果・備考）がある */
export function checkResultTables(md, phases = [1, 2, 3, 4, 5, 6, 7]) {
  const text = stripCodeBlocks(md);
  const heads = [...text.matchAll(/^# Phase (\d+)\b.*$/gm)].map((m) => ({
    phase: Number(m[1]),
    start: m.index,
  }));
  const errors = [];
  for (const p of phases) {
    const idx = heads.findIndex((h) => h.phase === p);
    if (idx < 0) {
      errors.push(`Phase ${p} の見出し（\`# Phase ${p} ...\`）が無い`);
      continue;
    }
    const end = text.indexOf("\n# ", heads[idx].start + 1);
    const block = text.slice(heads[idx].start, end < 0 ? undefined : end);
    if (!RESULT_HEADER.test(block)) {
      errors.push(`Phase ${p} に結果表（実施者・日付・環境・結果・備考）が無い`);
    }
  }
  return errors;
}

/** 区分表（`## 節ごとの区分` の節の中だけ。見積もりの表は数えない）に、節 1〜max が全部ある */
export function checkClassificationCoverage(md, max) {
  const body = blockAfterHeading(md, /^## 節ごとの区分/);
  if (!body) return ["区分表の見出し（`## 節ごとの区分`）が無い"];
  const seen = new Set(leadingIntegers(body));
  const errors = [];
  for (let n = 1; n <= max; n++) {
    if (!seen.has(n)) errors.push(`節 ${n} が区分表に無い`);
  }
  return errors;
}
