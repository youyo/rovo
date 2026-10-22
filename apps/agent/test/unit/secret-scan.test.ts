import { describe, expect, it } from "vitest";
import type { ExecResult } from "../../src/sandbox-port";
import { blockedMessage, scanRangeForSecrets, scanUnpushedForSecrets } from "../../src/secret-scan";

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

/** commit ごとの区切り（U+0001 と SHA の行）つきの log の出力を作る */
const section = (sha: string, ...body: string[]) => `\u0001${sha}\n\n${body.join("")}`;
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const BASE = "1".repeat(40);

describe("scanUnpushedForSecrets（commit ごと）", () => {
  it("git log で、HEAD から辿れて last_pushed から辿れない commit の numstat と差分を取る", async () => {
    const { git, calls } = gitWith("", "");
    expect(await scanUnpushedForSecrets(git, "HEAD", BASE)).toEqual({ status: "clean" });
    expect(calls).toHaveLength(2);
    for (const c of calls) {
      expect(c).toContain("log");
      expect(c).toContain("-m");
      expect(c).toContain("--no-renames");
      expect(c.slice(c.indexOf("HEAD"))).toEqual(["HEAD", "--not", BASE, "--"]);
    }
    expect(calls.some((c) => c.includes("--numstat"))).toBe(true);
    expect(calls.some((c) => c.includes("-p"))).toBe(true);
  });

  it("last_pushed が無いときは --not を付けない（HEAD から辿れる全部）", async () => {
    const { git, calls } = gitWith("", "");
    await scanUnpushedForSecrets(git, "HEAD", undefined);
    for (const c of calls) {
      expect(c).not.toContain("--not");
      expect(c.slice(c.indexOf("HEAD"))).toEqual(["HEAD", "--"]);
    }
  });

  it("基準・head が SHA（または HEAD）の形でなければ、git を呼ばずに止める（オプションの注入を防ぐ）", async () => {
    const { git, calls } = gitWith("", "");
    for (const [head, last] of [
      ["HEAD", "--output=x"],
      ["HEAD", "abc"],
      ["--all", BASE],
      ["main", BASE],
    ] as const) {
      expect(await scanUnpushedForSecrets(git, head, last)).toEqual({
        status: "unscannable",
        reason: "git_failed",
      });
    }
    expect(calls).toHaveLength(0);
  });

  it("commit ごとに行番号・パスを数え、見つかった commit の SHA を返す。値は含まない", async () => {
    const diff =
      section(SHA_A, hunk("a.ts", 1, "+one", "+two")) +
      section(SHA_B, hunk("b.ts", 5, " ctx", `+k = "${GHP}"`));
    const { git } = gitWith("", diff);
    const v = await scanUnpushedForSecrets(git, "HEAD", BASE);
    expect(v).toEqual({
      status: "secret",
      category: "github-token",
      path: "b.ts",
      line: 6,
      commit: SHA_B,
    });
    expect(JSON.stringify(v)).not.toContain(GHP);
  });

  it("numstat のバイナリは commit ごとに見る（鍵らしい拡張子だけ止める）", async () => {
    const numstat = section(SHA_A, "-\t-\timg/a.png\n") + section(SHA_B, "-\t-\tk/a.p12\n");
    const { git } = gitWith(numstat, "");
    expect(await scanUnpushedForSecrets(git, "HEAD", BASE)).toEqual({
      status: "binary",
      path: "k/a.p12",
      commit: SHA_B,
    });
  });

  it("クォートされたパス（日本語の 8 進・引用符）を元に戻して報告する", async () => {
    const quoted = '"\\346\\227\\245\\346\\234\\254 \\"q\\".txt"';
    const diff = section(
      SHA_A,
      `diff --git a/x b/x\n--- /dev/null\n+++ b/${quoted}\n@@ -0,0 +1,1 @@\n+${GHP}\n`,
    );
    const { git } = gitWith("", diff);
    expect(await scanUnpushedForSecrets(git, "HEAD", BASE)).toMatchObject({
      path: '日本 "q".txt',
      line: 1,
    });
  });

  it("出力が切れた・git が失敗・例外は unscannable", async () => {
    for (const c of [
      gitWith("", "", { diff: { truncated: true } }),
      gitWith("", "", { numstat: { truncated: true } }),
      gitWith("", "", { diff: { exitCode: 128 } }),
      gitWith("", "", { numstat: { timedOut: true, exitCode: 124 } }),
    ]) {
      expect((await scanUnpushedForSecrets(c.git, "HEAD", BASE)).status).toBe("unscannable");
    }
    const thrown = await scanUnpushedForSecrets(
      async () => {
        throw new Error("boom");
      },
      "HEAD",
      BASE,
    );
    expect(thrown.status).toBe("unscannable");
  });

  it("shouldAbort が立てば、diff を取る前にやめる", async () => {
    const { git, calls } = gitWith("", "");
    const v = await scanUnpushedForSecrets(git, "HEAD", BASE, { shouldAbort: () => true });
    expect(v).toEqual({ status: "aborted" });
    expect(calls).toHaveLength(1);
  });
});

describe("blockedMessage", () => {
  it("固定の文: カテゴリ・path:line・commit の短い SHA。値は含まない", () => {
    expect(
      blockedMessage({
        status: "secret",
        category: "github-token",
        path: "a.ts",
        line: 3,
        commit: SHA_A,
      }),
    ).toBe("blocked: possible secret (github-token) in a.ts:3 (commit aaaaaaa)");
    expect(blockedMessage({ status: "binary", path: "k.p12", commit: SHA_B })).toBe(
      "blocked: possible secret (key file) in k.p12 (commit bbbbbbb)",
    );
    expect(blockedMessage({ status: "secret", category: "x" })).toBe(
      "blocked: possible secret (x)",
    );
  });

  it("パスにトークンが入っていても出さない（maskSecrets を通す）", () => {
    for (const v of [
      { status: "secret", category: "aws-access-key", path: `src/${GHP}.ts`, line: 1 },
      { status: "binary", path: `keys/${GHP}.pem` },
    ] as const) {
      const msg = blockedMessage(v);
      expect(msg).not.toContain(GHP);
      expect(msg).toContain("[REDACTED]");
    }
  });
});
