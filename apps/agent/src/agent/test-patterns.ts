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

/**
 * `git diff --name-status -z` の出力（`M\0path\0D\0path\0`）を `M\tpath\nD\tpath` 形式に直す。
 * NUL を含まない（すでに行形式の）入力はそのまま返す。パス中のタブ・改行は `?` に置き換える。
 */
export function nameStatusFromZ(raw: string): string {
  if (!raw.includes("\0")) return raw;
  const tokens = raw.split("\0");
  const lines: string[] = [];
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    lines.push(`${tokens[i]}\t${(tokens[i + 1] ?? "").replace(/[\t\n]/g, "?")}`);
  }
  return lines.join("\n");
}

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
  // diff --git から最初の @@ までがヘッダー部。--- / +++ はここでだけ読み飛ばす
  let inHeader = false;
  const flush = () => {
    if (!path) return;
    if (removed) warnings.push(`既存のテストの行が削除または書き換えられています: ${path}`);
    if (skip) warnings.push(`テストに skip / only / todo が追加されています: ${path}`);
    if (timeout) warnings.push(`テストのタイムアウトが追加または延長されています: ${path}`);
  };
  for (const line of testDiff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      flush();
      inHeader = true;
      skip = removed = timeout = false;
      if (line.includes('"')) {
        // 引用符つきのパスは読めない（本来は core.quotepath=false で出ない）
        path = undefined;
        warnings.push(`差分のパスを読めないため、テストの弱体化を判定できていません: ${line}`);
        continue;
      }
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      path = m?.[2] && TEST_FILE.test(m[2]) ? m[2] : undefined;
      continue;
    }
    if (!path) continue;
    if (inHeader) {
      if (line.startsWith("@@")) {
        inHeader = false;
      } else if (line.startsWith("new file mode") || line.startsWith("deleted file mode")) {
        // 新規追加は対象外、削除は別の警告で拾う
        path = undefined;
      }
      continue;
    }
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

/** モデルが検証の門番を書き換えていないかを検出し、クライアントのレビュー向けの警告文を返す。 */
export function detectTestTampering(input: TamperingInput): string[] {
  const warnings: string[] = [];
  for (const line of input.nameStatus.split("\n")) {
    const [status, path] = line.split("\t");
    if (!status || !path) continue;
    if (path.startsWith('"')) {
      warnings.push(`変更されたパスを読めないため、テストの改ざんを判定できていません: ${path}`);
      continue;
    }
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
