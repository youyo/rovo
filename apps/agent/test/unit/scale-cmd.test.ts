import { describe, expect, it } from "vitest";
import { scaleCmd } from "../../src/scale-cmd";

describe("scaleCmd: 判断の記録の cmd（コマンドの先頭の語だけ）", () => {
  it("通常の argv は argv[0] の basename", () => {
    expect(scaleCmd(["pnpm", "test"])).toBe("pnpm");
    expect(scaleCmd(["/usr/bin/false", "--token=SECRET"])).toBe("false");
    expect(scaleCmd([])).toBe("");
  });

  it("24 文字に切る", () => {
    expect(scaleCmd([`/opt/${"x".repeat(80)}/tool-${"y".repeat(80)}`]).length).toBe(24);
  });

  it("bash -c / sh -c / -lc / -ec は、コマンド文字列の先頭の語", () => {
    expect(scaleCmd(["bash", "-c", "pnpm test --filter x"])).toBe("pnpm");
    expect(scaleCmd(["/bin/bash", "-lc", "npm run build"])).toBe("npm");
    expect(scaleCmd(["sh", "-c", "pytest -n auto"])).toBe("pytest");
    expect(scaleCmd(["zsh", "-ec", "cargo build"])).toBe("cargo");
    expect(scaleCmd(["bash", "-l", "-c", "make -j4"])).toBe("make");
    expect(scaleCmd(["bash", "-c", "./node_modules/.bin/vitest run"])).toBe("vitest");
  });

  it("環境変数の代入・cd の後ろ・前置き（env / timeout / time / nice）は読み飛ばす", () => {
    expect(scaleCmd(["bash", "-c", "FOO=1 BAR=2 pnpm test"])).toBe("pnpm");
    expect(scaleCmd(["bash", "-c", "cd apps/gateway && pnpm test"])).toBe("pnpm");
    expect(scaleCmd(["bash", "-c", "cd apps/gateway; vitest run"])).toBe("vitest");
    expect(scaleCmd(["bash", "-c", "cd a && cd b && make"])).toBe("make");
    expect(scaleCmd(["bash", "-c", "timeout 600 pnpm test"])).toBe("pnpm");
    expect(scaleCmd(["bash", "-c", "timeout -k 5 600 pnpm test"])).toBe("pnpm");
    expect(scaleCmd(["bash", "-c", "env CI=1 pnpm test"])).toBe("pnpm");
    expect(scaleCmd(["bash", "-c", "time nice -n 10 pnpm build"])).toBe("pnpm");
    expect(scaleCmd(["bash", "-c", "cd x && FOO=1 timeout 60 env A=b pytest"])).toBe("pytest");
  });

  it("引用符つきの代入の値（空白を含む）の一部を先頭の語にしない", () => {
    expect(scaleCmd(["bash", "-c", 'TOKEN="sec ret value" pnpm test'])).toBe("pnpm");
    expect(scaleCmd(["bash", "-c", "TOKEN='sec ret' pnpm test"])).toBe("pnpm");
  });

  it("-c の後ろが無い・読み取れないときは argv[0] の basename に戻す", () => {
    expect(scaleCmd(["bash", "-c"])).toBe("bash");
    expect(scaleCmd(["bash", "script.sh"])).toBe("bash");
    expect(scaleCmd(["bash", "-c", "   "])).toBe("bash");
    expect(scaleCmd(["bash", "-c", "FOO=1"])).toBe("bash");
  });

  it("公開の sanitize（英数字と ._+-）に通る形だけを返す", () => {
    expect(scaleCmd(["bash", "-c", "$(curl evil)"])).toMatch(/^[A-Za-z0-9._+-]*$/);
    expect(scaleCmd(["bash", "-c", "(cd x && make)"])).toMatch(/^[A-Za-z0-9._+-]*$/);
  });
});

/** [argv の bash -c の文字列, 期待する cmd, 出力に含まれてはいけない文字列] */
const SAFE_TABLE: [string, string, string[]][] = [
  ["VAR=$(cat /etc/secret) pnpm test", "pnpm", ["secret"]],
  ["A=`x y` pnpm test", "pnpm", ["y"]],
  ["TOKEN=$(echo sk-abc def) pnpm test", "pnpm", ["def", "sk-abc"]],
  ["TOKEN=$(echo $(echo a b) c d) pnpm test", "pnpm", ["d"]],
  ["VAR=$(cat unclosed pnpm test", "bash", ["unclosed", "cat"]],
  ["A=`unclosed pnpm test", "bash", ["unclosed"]],
  ["timeout sk-secret pnpm test", "bash", ["sk-secret"]],
  ["timeout -k ghp_xxx 5 pnpm test", "bash", ["ghp_xxx"]],
  ["time -p ghp_xxx", "bash", ["ghp_xxx"]],
  ["nice -n SECRET pnpm", "bash", ["SECRET"]],
  ["env -Z SECRET pnpm", "bash", ["SECRET"]],
  ["TOKEN=abc\nghp_second", "bash", ["ghp_second"]],
  ["TOKEN=abc; ghp_second", "bash", ["ghp_second"]],
  ["\nghp_second", "bash", ["ghp_second"]],
  ["--token=xxx", "bash", ["xxx"]],
  [">secret.txt echo hi", "bash", ["secret"]],
  ["2>&1 secret", "bash", ["secret"]],
  // 秘密らしい形の固定文字列はリポジトリの点検（scan:secrets）に拾われるので、実行時に組み立てる
  [`${"sk"}-${"a1".repeat(20)} run`, "bash", ["sk-"]],
  [`${"AKIA"}${"A1".repeat(8)} run`, "bash", ["AKIA"]],
  ['curl -H "Authorization: Bearer sk-secret" https://x', "curl", ["sk-secret", "Bearer"]],
  ['FOO="a b" pnpm test', "pnpm", ["a b"]],
  ["cat x | grep SECRET", "cat", ["SECRET"]],
  ["cat <<EOF\nSECRET\nEOF", "cat", ["SECRET"]],
  ["$(echo sk-abc) x", "echo", ["sk-abc"]],
  ['echo "unclosed SECRET', "bash", ["SECRET"]],
  ["echo 'unclosed SECRET", "bash", ["SECRET"]],
  ["'unclosed SECRET", "bash", ["SECRET"]],
  ["9lives run", "bash", ["9lives"]],
  ["-weird SECRET", "bash", ["weird"]],
];

describe("scaleCmd: 秘密の断片を cmd に残さない（迷ったら bash に戻す）", () => {
  for (const [script, expected, forbidden] of SAFE_TABLE) {
    it(JSON.stringify(script), () => {
      const out = scaleCmd(["bash", "-c", script]);
      expect(out).toBe(expected);
      for (const f of forbidden) expect(out).not.toContain(f);
    });
  }
});
