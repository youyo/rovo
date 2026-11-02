// Python / Go の依存の導入（D14 の近く。docs/specs/design.md「言語の依存の導入」）。
// 作業ツリーのルートのファイルから、言語ごとに 1 つだけ選ぶ。argv で実行する（シェルを通さない）。

/** Python の導入 1 回の時間の上限（uv sync / uv pip install） */
export const DEPS_PYTHON_TIMEOUT_MS = 5 * 60_000;
/** Go の導入 1 回の時間の上限（go mod download） */
export const DEPS_GO_TIMEOUT_MS = 5 * 60_000;
/**
 * Python と Go を合わせた時間の枠。導入は boot() の中で直列に走るので、言語ごとの上限を足した 10 分を取らず、
 * 1 つの枠で分け合う。各言語の上限は、枠の残りとタスクの期限までの残りのうち短いほうに縮める（depsLangTimeout）。
 */
export const DEPS_LANG_TOTAL_MS = 8 * 60_000;

/** 1 言語の導入に許す時間: 言語の上限・枠の残り・タスクの期限までの残りのうち一番短いもの（0 以下なら 0 = 実行しない） */
export function depsLangTimeout(input: {
  capMs: number;
  frameLeftMs: number;
  deadlineLeftMs: number;
}): number {
  return Math.max(0, Math.min(input.capMs, input.frameLeftMs, input.deadlineLeftMs));
}
/** ワーカーに伝える失敗の出力の末尾の長さ */
export const DEPS_LANG_TAIL_CHARS = 500;

export type DepsLangKind = "python" | "go";
export type DepsLangStatus = "ok" | "failed" | "timeout" | "skipped";

/** usage.deps_lang の 1 要素（command は argv の先頭 2〜3 語） */
export interface DepsLangResult {
  kind: DepsLangKind;
  command: string;
  status: DepsLangStatus;
  duration_ms: number;
}

export interface DepsLangPlan {
  kind: DepsLangKind;
  argv: string[];
  timeoutMs: number;
}

const REQUIREMENTS = ["requirements.txt", "requirements-dev.txt", "requirements-test.txt"] as const;

/** [project.optional-dependencies] にある dev / test のキー（無ければ空）。 */
export function pyprojectExtras(toml: string): string[] {
  const found: string[] = [];
  let section = "";
  for (const raw of toml.split("\n")) {
    const line = raw.trim();
    const head = /^\[\s*([^\]]+?)\s*\]\s*(?:#.*)?$/.exec(line);
    if (head && !line.startsWith("[[")) {
      section = head[1] ?? "";
      const dotted = /^project\.optional-dependencies\.(dev|test)$/.exec(section);
      if (dotted?.[1]) found.push(dotted[1]);
      continue;
    }
    if (section === "project.optional-dependencies") {
      const key = /^["']?(dev|test)["']?\s*=/.exec(line);
      if (key?.[1]) found.push(key[1]);
    }
  }
  return ["dev", "test"].filter((k) => found.includes(k));
}

export function hasProjectTable(toml: string): boolean {
  return /^\[\s*project\s*\]\s*(?:#.*)?$/m.test(toml);
}

/**
 * Python の導入を選ぶ。uv.lock > requirements*.txt > pyproject.toml の [project]。何も無ければ undefined。
 * pyproject.toml があるのに [project] が無いときは "skipped"（入れるものが無い）。
 */
export function planPython(
  files: readonly string[],
  readPyproject: () => string,
): DepsLangPlan | "skipped" | undefined {
  const timeoutMs = DEPS_PYTHON_TIMEOUT_MS;
  if (files.includes("uv.lock")) {
    return { kind: "python", argv: ["uv", "sync", "--active", "--frozen"], timeoutMs };
  }
  const reqs = REQUIREMENTS.filter((f) => files.includes(f));
  if (reqs.length > 0) {
    return {
      kind: "python",
      argv: ["uv", "pip", "install", ...reqs.flatMap((f) => ["-r", f])],
      timeoutMs,
    };
  }
  if (files.includes("pyproject.toml")) {
    const toml = readPyproject();
    if (!hasProjectTable(toml)) return "skipped";
    const extras = pyprojectExtras(toml);
    const target = extras.length > 0 ? `.[${extras.join(",")}]` : ".";
    return { kind: "python", argv: ["uv", "pip", "install", "-e", target], timeoutMs };
  }
  return undefined;
}

export function planGo(files: readonly string[]): DepsLangPlan | undefined {
  return files.includes("go.mod")
    ? { kind: "go", argv: ["go", "mod", "download"], timeoutMs: DEPS_GO_TIMEOUT_MS }
    : undefined;
}

/** 結果に載せる command（argv の先頭 3 語まで） */
export function depsLangCommand(argv: readonly string[]): string {
  return argv.slice(0, 3).join(" ");
}

/**
 * ワーカーの最初のプロンプトに足す英語の短い文。results が空なら undefined。
 * tails は言語ごとの、秘密を伏せた出力の末尾（失敗・時間切れした言語の分）。
 */
export function depsLangNote(
  results: readonly DepsLangResult[],
  tails: Partial<Record<DepsLangKind, string>>,
): string | undefined {
  if (results.length === 0) return undefined;
  const lines: string[] = [];
  const ok = results.filter((r) => r.status === "ok");
  if (ok.length > 0) {
    lines.push(
      `Installed at sandbox start: ${ok.map((r) => `${r.kind} (${r.command})`).join(", ")}. Python packages are in /opt/venv (python3 and pip see them); do not create a .venv.`,
    );
  }
  const bad = results.filter((r) => r.status === "failed" || r.status === "timeout");
  if (bad.length > 0) {
    lines.push(
      `Dependency install did not finish: ${bad.map((r) => `${r.kind} (${r.command}: ${r.status})`).join(", ")}.`,
    );
    for (const kind of new Set(bad.map((r) => r.kind))) {
      const tail = tails[kind];
      if (tail) lines.push(`Output tail (${kind}): ${tail}`);
    }
    lines.push(
      "If a dependency is missing, find the cause; if you cannot install it, tell the client with ask_parent.",
    );
  }
  return lines.length > 0 ? lines.join("\n") : undefined;
}

/** task_result の warnings に付ける固定コード */
export function depsLangWarnings(results: readonly DepsLangResult[]): string[] {
  return results.flatMap((r) =>
    r.status === "failed"
      ? [`deps_install_failed: ${r.kind}`]
      : r.status === "timeout"
        ? [`deps_install_timeout: ${r.kind}`]
        : [],
  );
}
