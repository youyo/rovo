import { describe, expect, it } from "vitest";
import type { ExecResult } from "../../src/sandbox-port";
import { scanRangeForSecrets } from "../../src/secret-scan";

const GHP = `ghp_${"a1B2".repeat(9)}`;
const res = (over: Partial<ExecResult> = {}): ExecResult => ({
  exitCode: 0,
  stdout: "",
  stderr: "",
  timedOut: false,
  truncated: false,
  ...over,
});

/** numstat と diff を台本で返す git */
function gitWith(
  numstat: string,
  diff: string,
  over: { numstat?: Partial<ExecResult>; diff?: Partial<ExecResult> } = {},
) {
  const calls: string[][] = [];
  const git = async (argv: string[]) => {
    calls.push(argv);
    return argv.includes("--numstat")
      ? res({ stdout: numstat, ...over.numstat })
      : res({ stdout: diff, ...over.diff });
  };
  return { git, calls };
}

const hunk = (path: string, start: number, ...body: string[]) => {
  const oldN = body.filter((l) => l[0] === " " || l[0] === "-").length;
  const newN = body.filter((l) => l[0] === " " || l[0] === "+").length;
  return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,${oldN} +${start},${newN} @@\n${body.join("\n")}\n`;
};

describe("scanRangeForSecrets（push モード）", () => {
  it("追加行の秘密を、新しいファイルでの行番号つきで返す。値は含まない", async () => {
    const { git } = gitWith(
      "3\t0\tsrc/a.ts",
      hunk("src/a.ts", 10, " ctx", "-old", `+const t = "${GHP}";`, " ctx"),
    );
    const v = await scanRangeForSecrets(git, ["abc..HEAD"], "push");
    expect(v).toEqual({ status: "secret", category: "github-token", path: "src/a.ts", line: 11 });
    expect(JSON.stringify(v)).not.toContain(GHP);
  });

  it("削除行・文脈行の秘密は見ない（追加行だけ）", async () => {
    const { git } = gitWith(
      "1\t1\tsrc/a.ts",
      hunk("src/a.ts", 1, `-const t = "${GHP}";`, '+const t = "";', ` // ${GHP}`),
    );
    expect((await scanRangeForSecrets(git, ["abc..HEAD"], "push")).status).toBe("clean");
  });

  it("内容が ++ で始まる行（+++ に見える）も追加行として見る", async () => {
    const { git } = gitWith("2\t0\ta.md", hunk("a.md", 1, "+++ not a header", `+++ ${GHP}`));
    const v = await scanRangeForSecrets(git, ["abc..HEAD"], "push");
    expect(v).toMatchObject({ status: "secret", path: "a.md", line: 2 });
  });

  it("複数のファイル・hunk をまたいでも、行番号とパスを取り違えない", async () => {
    const diff = `${hunk("a.ts", 1, "+one", "+two")}diff --git a/b.ts b/b.ts\n--- a/b.ts\n+++ b/b.ts\n@@ -1,2 +1,2 @@\n x\n+y\n@@ -20,1 +30,2 @@\n z\n+AKIA${"ABCD1234".repeat(2)}\n`;
    const { git } = gitWith("2\t0\ta.ts\n1\t0\tb.ts", diff);
    const v = await scanRangeForSecrets(git, ["abc..HEAD"], "push");
    expect(v).toEqual({ status: "secret", category: "aws-access-key", path: "b.ts", line: 31 });
  });

  it("バイナリは、鍵らしい拡張子だけ止める", async () => {
    for (const ext of ["pem", "KEY", "p12", "pfx", "jks", "keystore", "der", "p8", "ppk"]) {
      const { git } = gitWith(`-\t-\tcerts/a.${ext}`, "");
      expect(await scanRangeForSecrets(git, ["abc..HEAD"], "push")).toEqual({
        status: "binary",
        path: `certs/a.${ext}`,
      });
    }
    const { git } = gitWith("-\t-\timg/a.png\n1\t0\tsrc/a.ts", hunk("src/a.ts", 1, "+ok"));
    expect((await scanRangeForSecrets(git, ["abc..HEAD"], "push")).status).toBe("clean");
  });

  it("出力が切れた・git が失敗・例外・時間切れは unscannable", async () => {
    const cases = [
      gitWith("", "", { diff: { truncated: true } }),
      gitWith("", "", { numstat: { truncated: true } }),
      gitWith("", "", { diff: { exitCode: 128 } }),
      gitWith("", "", { numstat: { timedOut: true, exitCode: 124 } }),
    ];
    for (const c of cases) {
      expect((await scanRangeForSecrets(c.git, ["abc..HEAD"], "push")).status).toBe("unscannable");
    }
    const thrown = await scanRangeForSecrets(
      async () => {
        throw new Error("boom");
      },
      ["abc..HEAD"],
      "push",
    );
    expect(thrown.status).toBe("unscannable");
  });

  it("渡した範囲の引数で numstat と diff を取る", async () => {
    const { git, calls } = gitWith("", "");
    await scanRangeForSecrets(git, ["abc..HEAD"], "push");
    expect(calls).toHaveLength(2);
    for (const c of calls) {
      expect(c[0]).toBe("diff");
      expect(c).toContain("abc..HEAD");
    }
    expect(calls.some((c) => c.includes("--numstat"))).toBe(true);
  });
});

describe("scanRangeForSecrets（strict モード = WIP の commit 前）", () => {
  it("maskSecrets で変わる推測系も止める（位置は返さない）", async () => {
    const { git } = gitWith("1\t0\t.env", "diff --git a/.env b/.env\n+FOO_TOKEN=plainvalue123\n");
    expect(await scanRangeForSecrets(git, ["--cached"], "strict")).toEqual({ status: "secret" });
  });

  it("バイナリが 1 つでもあれば（拡張子を問わず）止め、diff は取らない", async () => {
    const { git, calls } = gitWith("-\t-\timg/a.png", "");
    expect(await scanRangeForSecrets(git, ["--cached"], "strict")).toEqual({
      status: "binary",
      path: "img/a.png",
    });
    expect(calls.some((c) => !c.includes("--numstat"))).toBe(false);
  });

  it("大きすぎる・失敗は unscannable。秘密が無ければ clean", async () => {
    const big = gitWith("", "", { diff: { truncated: true } });
    expect((await scanRangeForSecrets(big.git, ["--cached"], "strict")).status).toBe("unscannable");
    const ok = gitWith("1\t0\ta", "diff --git a/a b/a\n+x\n");
    expect((await scanRangeForSecrets(ok.git, ["--cached"], "strict")).status).toBe("clean");
  });

  it("途中で中断の印が立てば aborted を返し、diff を取らない", async () => {
    const { git, calls } = gitWith("1\t0\ta", "");
    const v = await scanRangeForSecrets(git, ["--cached"], "strict", { shouldAbort: () => true });
    expect(v.status).toBe("aborted");
    expect(calls).toHaveLength(1);
  });
});
