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
