const TEST_FILE =
  /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)test_[^/]+\.py$|_test\.(go|py)$/;
const TEST_CONFIG =
  /(^|\/)(vitest|jest|playwright|cypress|karma|ava|mocha)\.config\.[cm]?[jt]s$|(^|\/)\.mocharc[^/]*$|(^|\/)(pytest\.ini|tox\.ini|conftest\.py)$/;

const SKIP_LINE = new RegExp(
  [
    String.raw`\b(it|test|describe|suite|context)\.(skip|only|todo|fixme)\w*\b`,
    String.raw`\b(xit|xtest|xdescribe|fit|fdescribe)\s*\(`,
    String.raw`\.todo\s*\(`,
    String.raw`@pytest\.mark\.(skip|skipif|xfail)\b`,
    String.raw`\bpytest\.(skip|xfail)\s*\(`,
    String.raw`@unittest\.skip\w*`,
    String.raw`\bt\.Skip(Now)?\s*\(`,
  ].join("|"),
);
const TIMEOUT_LINE = new RegExp(
  [
    String.raw`\b(testTimeout|hookTimeout|teardownTimeout)\b`,
    String.raw`\b(jest|vi|vitest)\.setTimeout\s*\(`,
    String.raw`\btimeout\s*:\s*\d`,
    // it("...", async () => {...}, 20000) の末尾の第 3 引数
    String.raw`[})]\s*,\s*\d[\d_]*\s*\)\s*;?\s*$`,
    String.raw`@pytest\.mark\.timeout\b`,
  ].join("|"),
);

/** 変更されたテストファイル（追加・削除を除く）のパス。弱体化の判定に使う差分の取得対象。 */
export function modifiedTestFiles(nameStatus: string): string[] {
  const out: string[] = [];
  for (const line of nameStatus.split("\n")) {
    const [status, path] = line.split("\t");
    if (status?.startsWith("M") && path && TEST_FILE.test(path)) out.push(path);
  }
  return out;
}

/** 既存テストファイルの差分から、テストを弱めた疑いのある変更を拾う。保守的に、疑わしければ警告にする。 */
function detectWeakening(testDiff: string): string[] {
  const warnings: string[] = [];
  let path: string | undefined;
  let skip = false;
  let removed = false;
  let timeout = false;
  const flush = () => {
    if (!path) return;
    if (removed) warnings.push(`既存のテストの行が削除または書き換えられています: ${path}`);
    if (skip) warnings.push(`テストに skip / only / todo が追加されています: ${path}`);
    if (timeout) warnings.push(`テストのタイムアウトが追加または延長されています: ${path}`);
  };
  for (const line of testDiff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      flush();
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      path = m?.[2] && TEST_FILE.test(m[2]) ? m[2] : undefined;
      skip = removed = timeout = false;
      continue;
    }
    if (!path) continue;
    if (line.startsWith("new file mode") || line.startsWith("deleted file mode")) {
      // 新規追加は対象外、削除は別の警告で拾う
      path = undefined;
      continue;
    }
    if (line.startsWith("--- ") || line.startsWith("+++ ")) continue;
    if (line.startsWith("-")) removed = true;
    else if (line.startsWith("+")) {
      if (SKIP_LINE.test(line)) skip = true;
      if (TIMEOUT_LINE.test(line.slice(1))) timeout = true;
    }
  }
  flush();
  return warnings;
}

export interface TamperingInput {
  /** `git diff --name-status --no-renames <base>..HEAD` の出力 */
  nameStatus: string;
  /** 変更されたテストファイルだけの差分（`git diff --no-renames -U0 <base>..HEAD -- <files>`） */
  testDiff?: string;
  baseScripts: Record<string, string> | undefined;
  headScripts: Record<string, string> | undefined;
}

/** モデルが検証の門番を書き換えていないかを検出し、親のレビュー向けの警告文を返す。 */
export function detectTestTampering(input: TamperingInput): string[] {
  const warnings: string[] = [];
  for (const line of input.nameStatus.split("\n")) {
    const [status, path] = line.split("\t");
    if (!status || !path) continue;
    if (status.startsWith("D") && TEST_FILE.test(path)) {
      warnings.push(`テストファイルが削除されています: ${path}`);
    } else if (!status.startsWith("A") && TEST_CONFIG.test(path)) {
      warnings.push(`テスト設定が変更されています: ${path}`);
    }
  }
  if (input.testDiff) warnings.push(...detectWeakening(input.testDiff));
  const base = input.baseScripts ?? {};
  const head = input.headScripts ?? {};
  const changed = [...new Set([...Object.keys(base), ...Object.keys(head)])]
    .filter((k) => base[k] !== head[k])
    .sort();
  if (changed.length > 0) {
    warnings.push(`package.json の scripts が変更されています: ${changed.join(", ")}`);
  }
  return warnings;
}
