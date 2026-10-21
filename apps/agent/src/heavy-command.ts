/**
 * 「重いコマンド」の判定（Sandbox の昇格の引き金。docs/deploy.md の 11）。
 *
 * 子が Sandbox で実行するコマンド（argv）が、テスト・型検査・ビルドのように CPU を長く使うものかを、argv のパターンだけで判定する
 * （実行しない・ファイルを読まない・副作用なし）。重いコマンドの初回に、小さい Sandbox から大きい Sandbox へ昇格する。
 * 判定の一覧はこのファイルの 1 か所だけに置く（足す・外すときはここと heavy-command.test.ts だけを直す）。
 *
 * 誤検知は「数十秒早く昇格する」、見逃しは「小さいまま遅く動く」だけで、どちらも結果は変わらない（昇格は fail-soft）。
 * なので凝りすぎない: シェルの文字列は `&&` `||` `;` `|` 改行 `(` `)` などで雑に区切り、各区間の先頭から環境変数・ラッパー
 * （env / time / timeout / npx / pnpm exec / uv run など）を外して、先頭のコマンドを表と照合する。
 */

import type { SandboxRuleMatch } from "@rovo/models";

/** 引数なしでも重いコマンド（テストランナー・型検査・ビルド） */
const HEAVY_PROGRAMS: ReadonlySet<string> = new Set([
  "vitest",
  "jest",
  "mocha",
  "ava",
  "karma",
  "pytest",
  "py.test",
  "tox",
  "nosetests",
  "rspec",
  "phpunit",
  "tsc",
  "tsgo",
  "webpack",
]);

/** サブコマンドが `test` / `run` のときだけ重いコマンド（引数なしや他のサブコマンドは重くない） */
const HEAVY_SUBCOMMANDS: Readonly<Record<string, ReadonlySet<string>>> = {
  go: new Set(["test", "build", "vet"]),
  cargo: new Set(["test", "build", "check", "clippy", "bench", "nextest"]),
  deno: new Set(["test", "check", "compile"]),
  dotnet: new Set(["test", "build"]),
  mvn: new Set(["test", "verify", "package", "compile"]),
  mvnw: new Set(["test", "verify", "package", "compile"]),
  gradle: new Set(["test", "build", "check", "assemble"]),
  gradlew: new Set(["test", "build", "check", "assemble"]),
  swift: new Set(["test", "build"]),
  rake: new Set(["test", "spec"]),
  playwright: new Set(["test"]),
  cypress: new Set(["run"]),
  vite: new Set(["build"]),
  next: new Set(["build"]),
  nuxt: new Set(["build"]),
  astro: new Set(["build"]),
};

/** package.json の scripts / mise のタスク名のうち、重いもの（`test` `test:unit` `build:web` `typecheck` など） */
const HEAVY_SCRIPT = /^(test|tests|build|typecheck|type-check|e2e)($|[:_.-])/;
/** make の目標のうち、重いもの（目標なしの `make` も重い） */
const HEAVY_MAKE_TARGET = /^(test|tests|build|check|all)($|[:_.-])/;

/** 外して、その後ろのコマンドを見る（引数の一部を読み飛ばすものは SKIP_ARGS） */
const WRAPPERS: ReadonlySet<string> = new Set([
  "env",
  "time",
  "nohup",
  "command",
  "exec",
  "sudo",
  "nice",
  "timeout",
  "npx",
  "bunx",
  "corepack",
]);

/** 値を 1 つ取るオプション（値を読み飛ばす）。pnpm / yarn / npm の作業場所・絞り込み */
const VALUE_FLAGS: ReadonlySet<string> = new Set([
  "--filter",
  "-F",
  "--dir",
  "-C",
  "--prefix",
  "--cwd",
  "--workspace",
  "-w",
]);

const PACKAGE_MANAGERS: ReadonlySet<string> = new Set(["npm", "pnpm", "yarn", "bun"]);
const PYTHON_MODULES: ReadonlySet<string> = new Set(["pytest", "unittest", "tox", "nose"]);
const SHELLS: ReadonlySet<string> = new Set(["bash", "sh", "zsh", "dash", "ash", "ksh"]);

const MAX_DEPTH = 8;

function basename(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? p : p.slice(i + 1);
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** シェルの文字列を、コマンドの区間に雑に分ける（引用符の中も分けてしまうが、見逃しより誤検知を許す） */
function segments(script: string): string[][] {
  return script
    .split(/&&|\|\||\$\(|[;|&\n()`{}]/)
    .map((seg) =>
      seg
        .trim()
        .split(/\s+/)
        .map((t) => t.replace(/^["'`]+|["'`]+$/g, ""))
        .filter((t) => t !== ""),
    )
    .filter((tokens) => tokens.length > 0);
}

/** シェルの `-c` の脚本。`-c` `-lc` `-ec` のように c を含む短いオプションの次の引数 */
function shellScript(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(a)) return args[i + 1];
    if (!a.startsWith("-")) return undefined; // スクリプトファイル。中身は見ない
  }
  return undefined;
}

/** 先頭のオプション（-y / --no-install など）を外す。`--` はその後ろがコマンド */
function dropFlags(tokens: string[]): string[] {
  let i = 0;
  while (i < tokens.length && (tokens[i] ?? "").startsWith("-")) {
    const t = tokens[i] ?? "";
    i += 1;
    if (t === "--") break;
  }
  return tokens.slice(i);
}

/** オプションと、値を取るオプションの値を外して、最初の位置引数以降を返す */
function afterFlags(tokens: string[]): string[] {
  let i = 0;
  while (i < tokens.length && (tokens[i] ?? "").startsWith("-")) {
    i += VALUE_FLAGS.has(tokens[i] ?? "") ? 2 : 1;
  }
  return tokens.slice(i);
}

function isHeavyScript(name: string | undefined): boolean {
  return name !== undefined && HEAVY_SCRIPT.test(name);
}

/** npm / pnpm / yarn / bun の呼び出し（先頭の npm などは外した残り）。重ければ一致した表の名前 */
function packageManagerHeavy(pm: string, rest: string[], depth: number): string | undefined {
  let args = afterFlags(rest);
  // yarn workspace <名前> <コマンド>
  if (pm === "yarn" && (args[0] === "workspace" || args[0] === "workspaces")) {
    args = afterFlags(args.slice(args[0] === "workspace" ? 2 : 1));
  }
  const sub = args[0];
  if (sub === undefined) return undefined;
  if (sub === "test" || sub === "t" || sub === "tst") return `${pm} test`;
  if (sub === "run" || sub === "run-script" || sub === "r" || sub === "rum") {
    return isHeavyScript(afterFlags(args.slice(1))[0]) ? `${pm} run` : undefined;
  }
  // 実行系: npm exec -- vitest / pnpm exec vitest / pnpm dlx tsc / yarn dlx jest
  if (sub === "exec" || sub === "dlx" || sub === "x") {
    return simpleHeavy(dropFlags(args.slice(1)), depth + 1);
  }
  // pnpm / yarn / bun は `pnpm build` のように script 名を直接書ける
  return pm !== "npm" && isHeavyScript(sub) ? `${pm} run` : undefined;
}

/** 1 つの単純なコマンド（区間のトークン列）が重いか。重ければ一致した表の名前 */
function simpleHeavy(input: string[], depth: number): string | undefined {
  if (depth > MAX_DEPTH) return undefined;
  let tokens = input;
  // 先頭の環境変数と、ラッパーを外す
  for (let guard = 0; guard < MAX_DEPTH && tokens.length > 0; guard++) {
    const first = tokens[0] ?? "";
    if (ASSIGNMENT.test(first)) {
      tokens = tokens.slice(1);
      continue;
    }
    const name = basename(first);
    if (WRAPPERS.has(name)) {
      let rest = tokens.slice(1);
      if (name === "timeout")
        rest = dropFlags(rest).slice(1); // 期限の値
      else if (name === "nice") rest = rest[0] === "-n" ? rest.slice(2) : dropFlags(rest);
      else if (name === "env") {
        rest = dropFlags(rest);
        while (rest.length > 0 && ASSIGNMENT.test(rest[0] ?? "")) rest = rest.slice(1);
      } else rest = dropFlags(rest);
      tokens = rest;
      continue;
    }
    // uv run / poetry run / pipenv run / bundle exec / mise exec -- <コマンド>
    const second = tokens[1];
    if (
      ((name === "uv" || name === "poetry" || name === "pipenv") && second === "run") ||
      ((name === "bundle" || name === "mise") && second === "exec")
    ) {
      tokens = dropFlags(tokens.slice(2));
      continue;
    }
    break;
  }
  const head = tokens[0];
  if (head === undefined) return undefined;
  const name = basename(head);
  const args = tokens.slice(1);

  if (SHELLS.has(name)) {
    const script = shellScript(args);
    return script === undefined ? undefined : scriptHeavy(script, depth + 1);
  }
  if (HEAVY_PROGRAMS.has(name)) {
    if (name === "tsc" || name === "tsgo") {
      // バージョンやヘルプの表示は重くない
      return args.some((a) => ["-v", "--version", "-h", "--help", "--init"].includes(a))
        ? undefined
        : name;
    }
    return name;
  }
  if (name === "make" || name === "gmake") {
    const target = afterFlags(args)[0];
    return target === undefined || HEAVY_MAKE_TARGET.test(target) ? "make" : undefined;
  }
  if (name === "mise" || name === "task" || name === "just") {
    // mise run <タスク> / mise r <タスク>
    if (name === "mise" && (args[0] === "run" || args[0] === "r")) {
      return isHeavyScript(afterFlags(args.slice(1))[0]) ? "mise run" : undefined;
    }
    return undefined;
  }
  if (name === "node") return args.includes("--test") ? "node --test" : undefined;
  if (/^python[0-9.]*$/.test(name)) {
    const m = args.indexOf("-m");
    const mod = m === -1 ? undefined : args[m + 1];
    return mod !== undefined && PYTHON_MODULES.has(mod) ? `python -m ${mod}` : undefined;
  }
  if (name === "bun" && args[0] === "test") return "bun test";
  if (PACKAGE_MANAGERS.has(name)) return packageManagerHeavy(name, args, depth);
  const subs = HEAVY_SUBCOMMANDS[name];
  if (subs !== undefined) {
    const sub = afterFlags(args)[0];
    return sub !== undefined && subs.has(sub) ? `${name} ${sub}` : undefined;
  }
  return undefined;
}

function scriptHeavy(script: string, depth: number): string | undefined {
  for (const tokens of segments(script)) {
    const match = simpleHeavy(tokens, depth);
    if (match !== undefined) return match;
  }
  return undefined;
}

/**
 * 一致した表の名前の一覧（固定。packages/models の SANDBOX_RULE_MATCHES と同じ。heavy-command.test.ts が突き合わせる）。
 * 規則で昇格したときに usage.sandbox_promotions[].rule_match へ残す。argv の文字列そのものは残さない。
 */
export const HEAVY_MATCH_LABELS: readonly string[] = [
  ...HEAVY_PROGRAMS,
  ...Object.entries(HEAVY_SUBCOMMANDS).flatMap(([prog, subs]) =>
    [...subs].map((sub) => `${prog} ${sub}`),
  ),
  "make",
  "mise run",
  "node --test",
  ...[...PYTHON_MODULES].map((m) => `python -m ${m}`),
  ...[...PACKAGE_MANAGERS].flatMap((pm) => [`${pm} test`, `${pm} run`]),
];

/**
 * argv が重いコマンド（テスト・型検査・ビルド）なら、一致した表の名前（HEAVY_MATCH_LABELS のどれか）。そうでなければ undefined。
 * シェル（`bash -lc "..."` など）は中身も見る。配列でない・文字列でない要素を含む入力は、例外にせず undefined。
 */
export function heavyCommandMatch(argv: readonly string[]): SandboxRuleMatch | undefined {
  if (!Array.isArray(argv) || argv.length === 0 || argv.some((a) => typeof a !== "string")) {
    return undefined;
  }
  return simpleHeavy([...argv], 0) as SandboxRuleMatch | undefined;
}

/** argv が重いコマンド（テスト・型検査・ビルド）か。 */
export function isHeavyCommand(argv: readonly string[]): boolean {
  return heavyCommandMatch(argv) !== undefined;
}
