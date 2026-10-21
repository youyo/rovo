import { describe, expect, it } from "vitest";
import { isHeavyCommand } from "../../src/heavy-command";

// 重いコマンド（テスト・ビルドなど）の判定。昇格（小さい Sandbox → 大きい Sandbox）の引き金になる。
// 誤検知は「数十秒早く昇格する」、見逃しは「小さいまま遅く動く」だけで、どちらも結果は変わらない（fail-soft）。
// 判定は argv のパターンだけ（実行しない・ファイルを読まない）。

describe("isHeavyCommand: 重いコマンド", () => {
  const heavy: string[][] = [
    // テストランナーを直接
    ["vitest"],
    ["vitest", "run", "--config", "vitest.config.ts"],
    ["jest", "--ci"],
    ["mocha", "test/**/*.js"],
    ["pytest", "-x", "tests/"],
    ["py.test"],
    ["tox"],
    ["rspec"],
    ["playwright", "test"],
    ["cypress", "run"],
    ["tsc", "--noEmit"],
    ["tsc", "-p", "apps/agent"],
    ["/usr/local/bin/vitest", "run"],
    // 言語ごとのテスト・ビルド
    ["go", "test", "./..."],
    ["go", "build", "./..."],
    ["go", "vet", "./..."],
    ["cargo", "test"],
    ["cargo", "build", "--release"],
    ["cargo", "check"],
    ["cargo", "clippy"],
    ["node", "--test"],
    ["node", "--test", "test/"],
    ["deno", "test"],
    ["bun", "test"],
    ["dotnet", "test"],
    ["mvn", "test"],
    ["gradle", "build"],
    ["./gradlew", "test"],
    ["swift", "test"],
    ["rake", "test"],
    ["make", "test"],
    ["make", "build"],
    ["make", "check"],
    // パッケージマネージャ
    ["npm", "test"],
    ["npm", "t"],
    ["npm", "run", "test"],
    ["npm", "run", "build"],
    ["npm", "run", "typecheck"],
    ["npm", "run", "test:unit"],
    ["npm", "run-script", "build"],
    ["npm", "run", "--silent", "test"],
    ["pnpm", "test"],
    ["pnpm", "run", "build"],
    ["pnpm", "-r", "run", "build"],
    ["pnpm", "--filter", "web", "test"],
    ["pnpm", "build"],
    ["pnpm", "typecheck"],
    ["pnpm", "test:e2e"],
    ["yarn", "test"],
    ["yarn", "build"],
    ["yarn", "run", "typecheck"],
    ["bun", "run", "build"],
    ["mise", "run", "test"],
    ["mise", "run", "test:unit"],
    ["mise", "r", "build"],
    // ラッパー越し
    ["npx", "vitest", "run"],
    ["npx", "-y", "jest"],
    ["pnpm", "exec", "vitest", "run"],
    ["pnpm", "dlx", "tsc", "--noEmit"],
    ["yarn", "dlx", "jest"],
    ["bunx", "vitest"],
    ["npm", "exec", "--", "vitest"],
    ["python", "-m", "pytest"],
    ["python3", "-m", "pytest", "-q"],
    ["python3", "-m", "unittest", "discover"],
    ["uv", "run", "pytest"],
    ["poetry", "run", "pytest"],
    ["bundle", "exec", "rspec"],
    ["env", "CI=1", "vitest", "run"],
    ["time", "pnpm", "test"],
    ["timeout", "600", "pnpm", "test"],
    ["CI=1", "pnpm", "test"],
    // シェルの中身（bash ツールは ["bash", "-lc", command]）
    ["bash", "-lc", "pnpm test"],
    ["bash", "-c", "cd apps/agent && pnpm exec vitest run"],
    ["bash", "-lc", "CI=1 npm run build 2>&1 | tail -50"],
    ["sh", "-c", "git status; npm test"],
    ["bash", "-lc", "npm ci && npm test"],
    ["bash", "-c", "cd web\npnpm build"],
    ["zsh", "-c", "(cd x && vitest run)"],
    ["bash", "-c", "echo start || pytest"],
    ["bash", "-lc", "sh -c 'cd x && go test ./...'"],
    ["bash", "-lc", "FOO=bar BAZ=1 cargo test --workspace"],
    ["make"],
  ];
  for (const argv of heavy) {
    it(JSON.stringify(argv), () => expect(isHeavyCommand(argv)).toBe(true));
  }
});

describe("isHeavyCommand: 重くないコマンド", () => {
  const light: string[][] = [
    [],
    ["ls", "-la"],
    ["cat", "test.ts"],
    ["cat", "package.json"],
    ["grep", "-rn", "vitest", "src"],
    ["rg", "pnpm test"],
    ["echo", "pnpm test"],
    ["sed", "-n", "1,20p", "build.ts"],
    ["git", "status", "--porcelain"],
    ["git", "diff", "--stat"],
    ["git", "log", "--oneline", "-5"],
    ["git", "commit", "-m", "test: add build"],
    ["git", "add", "-A"],
    ["git", "push", "origin", "HEAD"],
    ["find", ".", "-name", "*.test.ts"],
    ["true"],
    ["node", "script.mjs"],
    ["node", "-e", "console.log(1)"],
    ["node", "--version"],
    ["python3", "script.py"],
    ["python3", "-m", "http.server"],
    // インストールや情報の表示は重いコマンドとはみなさない（依存キャッシュが担う）
    ["npm", "ci"],
    ["npm", "install"],
    ["pnpm", "install", "--frozen-lockfile"],
    ["yarn", "install"],
    ["pnpm", "--version"],
    ["pnpm", "list"],
    ["npm", "run", "dev"],
    ["npm", "run", "lint"],
    ["pnpm", "run", "format"],
    ["pnpm", "exec", "biome", "format", "src"],
    ["tsc", "--version"],
    ["tsc", "-v"],
    ["go", "fmt", "./..."],
    ["go", "mod", "tidy"],
    ["cargo", "fmt"],
    ["cargo", "add", "serde"],
    ["make", "clean"],
    ["mise", "run", "lint"],
    ["mise", "run", "fmt"],
    ["mise", "install"],
    // シェルの中身にも重いコマンドが無い
    ["bash", "-lc", "ls && git status"],
    ["bash", "-lc", "cat src/test.ts | head"],
    ["bash", "-c", "grep -rn 'npm test' docs"],
    ["bash", "-lc", "echo hello"],
    ["bash", "-lc", ""],
    ["bash", "script.sh"],
    ["bash", "-c"],
  ];
  for (const argv of light) {
    it(JSON.stringify(argv), () => expect(isHeavyCommand(argv)).toBe(false));
  }

  it("引数が文字列でない・配列でない入力でも例外にしない", () => {
    expect(isHeavyCommand(undefined as unknown as string[])).toBe(false);
    expect(isHeavyCommand([1, 2] as unknown as string[])).toBe(false);
  });
});
