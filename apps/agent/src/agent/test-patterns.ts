const TEST_FILE =
  /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)test_[^/]+\.py$|_test\.(go|py)$/;
const TEST_CONFIG =
  /(^|\/)(vitest|jest|playwright|cypress|karma|ava|mocha)\.config\.[cm]?[jt]s$|(^|\/)\.mocharc[^/]*$|(^|\/)(pytest\.ini|tox\.ini|conftest\.py)$/;

export interface TamperingInput {
  /** `git diff --name-status --no-renames <base>..HEAD` の出力 */
  nameStatus: string;
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
