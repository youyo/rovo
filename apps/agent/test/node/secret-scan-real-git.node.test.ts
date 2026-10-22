import { afterEach, describe, expect, it } from "vitest";
import { blockedMessage, type ScanVerdict, scanUnpushedForSecrets } from "../../src/secret-scan";
import { makeRepo, type RealRepo } from "./support/real-git";

// 秘密の検出に反応しないよう、明らかな偽物を実行時に組み立てる
const GHP = `ghp_${"a1B2".repeat(9)}`;
const AKIA = `AKIA${"ABCD1234".repeat(2)}`;

const repos: RealRepo[] = [];
afterEach(() => {
  for (const r of repos.splice(0)) r.cleanup();
});
function repo(): RealRepo {
  const r = makeRepo();
  repos.push(r);
  return r;
}
/** 空 commit A を作って返す（リモートにある基準の役） */
function withBase() {
  const r = repo();
  const base = r.commitAll("A (empty)");
  return { r, base };
}
const scan = (r: RealRepo, last: string | undefined, head = "HEAD") =>
  scanUnpushedForSecrets(r.scanGit(), head, last);
const message = (v: ScanVerdict) =>
  blockedMessage(v as Exclude<ScanVerdict, { status: "clean" | "aborted" }>);

describe("本物の git: 送られる commit の集合（HEAD --not last_pushed）の追加行を検査する", () => {
  it("(a) 途中の commit で足して後の commit で消した秘密も止める（A..HEAD の差分は空なのに）", async () => {
    const { r, base } = withBase();
    r.write("src/a.ts", `const a = 1;\nconst t = "${GHP}";\n`);
    const c1 = r.commitAll("add");
    r.git("rm", "-q", "src/a.ts");
    r.commitAll("remove");
    // 前提: 2 つの木の差分では何も見えない。送られる commit は 2 つある
    expect(r.git("diff", `${base}..HEAD`)).toBe("");
    expect(r.git("log", "--format=%h", `${base}..HEAD`).trim().split("\n")).toHaveLength(2);
    const v = await scan(r, base);
    expect(v).toMatchObject({
      status: "secret",
      category: "github-token",
      path: "src/a.ts",
      line: 2,
      commit: c1,
    });
    expect(message(v)).toBe(
      `blocked: possible secret (github-token) in src/a.ts:2 (commit ${c1.slice(0, 7)})`,
    );
    expect(JSON.stringify(v)).not.toContain(GHP);
  });

  it("秘密が無ければ clean。last_pushed より前（リモートにある）の commit の秘密は見ない", async () => {
    const r = repo();
    r.write("old.env", `T=${GHP}\n`);
    r.commitAll("already public");
    const last = r.head();
    r.write("src/b.ts", "export const b = 2;\n");
    r.commitAll("clean");
    expect(await scan(r, last)).toEqual({ status: "clean" });
  });

  it("(b) reset で last_pushed が HEAD の祖先でなくなっても、リモートに無い commit を検査する", async () => {
    const { r, base } = withBase();
    r.write("src/p.ts", "export const p = 1;\n");
    const pushed = r.commitAll("pushed");
    // 書き換え: pushed を捨てて、秘密を含む commit と、消す commit を積む
    r.git("reset", "-q", "--hard", base);
    r.write("src/leak.ts", `export const t = "${GHP}";\n`);
    const leak = r.commitAll("leak");
    r.git("rm", "-q", "src/leak.ts");
    r.commitAll("fix");
    expect(() => r.git("merge-base", "--is-ancestor", pushed, "HEAD")).toThrow();
    const v = await scan(r, pushed);
    expect(v).toMatchObject({ status: "secret", path: "src/leak.ts", line: 1, commit: leak });
  });

  it("(b) reset --soft でまとめ直して秘密が無ければ通る", async () => {
    const { r, base } = withBase();
    r.write("src/a.ts", `const t = "${GHP}";\n`);
    r.commitAll("leak");
    r.write("src/a.ts", "const t = process.env.T;\n");
    r.commitAll("fix");
    expect((await scan(r, base)).status).toBe("secret");
    r.git("reset", "-q", "--soft", base);
    r.commitAll("squashed");
    expect(await scan(r, base)).toEqual({ status: "clean" });
  });

  it("(b) rebase で last_pushed が祖先でなくなっても検査する", async () => {
    const { r, base } = withBase();
    r.write("src/p.ts", "export const p = 1;\n");
    const pushed = r.commitAll("pushed");
    r.write("src/l.ts", `const k = "${AKIA}";\n`);
    r.commitAll("leak");
    r.write("src/after.ts", "export const z = 1;\n");
    r.commitAll("after");
    // pushed を落として、後ろの 2 つを base の上に載せ直す
    r.git("rebase", "-q", "--onto", base, pushed);
    expect(() => r.git("merge-base", "--is-ancestor", pushed, "HEAD")).toThrow();
    const v = await scan(r, pushed);
    expect(v).toMatchObject({ status: "secret", category: "aws-access-key", path: "src/l.ts" });
  });

  it("(b) amend で pushed の commit を書き換えた場合も検査する", async () => {
    const { r } = withBase();
    r.write("src/p.ts", "export const p = 1;\n");
    const pushed = r.commitAll("pushed");
    r.write("src/p.ts", `export const p = "${GHP}";\n`);
    r.git("add", "-A");
    r.git("commit", "-q", "--amend", "--no-edit");
    expect(r.head()).not.toBe(pushed);
    expect(await scan(r, pushed)).toMatchObject({ status: "secret", path: "src/p.ts", line: 1 });
  });

  it("(c) last_pushed が無い（空の木からの初回）: ルートの commit も検査する", async () => {
    const r = repo();
    r.write("root.env", `A=1\nT=${GHP}\n`);
    const root = r.commitAll("root");
    expect(await scan(r, undefined)).toMatchObject({
      status: "secret",
      path: "root.env",
      line: 2,
      commit: root,
    });
  });

  it("(c) ルートの commit で足した秘密を後で消しても止まる。秘密が無ければ clean", async () => {
    const r = repo();
    r.write("a.txt", `${GHP}\n`);
    r.commitAll("root");
    r.git("rm", "-q", "a.txt");
    r.commitAll("remove");
    expect((await scan(r, undefined)).status).toBe("secret");

    const c = repo();
    c.write("a.txt", "hello\n");
    c.commitAll("root");
    expect(await scan(c, undefined)).toEqual({ status: "clean" });
  });

  it("(d) 内容が ++ や +++ で始まる行も追加行として見る（行番号も合う）", async () => {
    const { r, base } = withBase();
    r.write("notes.md", `++ plus\n+++ b/fake.txt\n+++ ${GHP}\n--- a/x\n`);
    r.commitAll("tricky");
    expect(await scan(r, base)).toMatchObject({ status: "secret", path: "notes.md", line: 3 });
  });

  it("(d) 日本語や空白を含むパスも、そのままのパスで報告する", async () => {
    const { r, base } = withBase();
    r.write("日本語 dir/設定 ファイル.txt", `ok\n${GHP}\n`);
    r.commitAll("jp");
    const v = await scan(r, base);
    expect(v).toMatchObject({ status: "secret", path: "日本語 dir/設定 ファイル.txt", line: 2 });
    expect(message(v)).toContain("in 日本語 dir/設定 ファイル.txt:2 (commit ");
  });

  it("(d) 空白・引用符を含むパスのファイルが先にあっても、別のファイルの行番号と取り違えない", async () => {
    const { r, base } = withBase();
    r.write("a b.txt", "one\ntwo\n");
    r.write('q"uote.txt', "x\n");
    r.write("z.txt", `l1\nl2\nl3\n${GHP}\n`);
    r.commitAll("many");
    expect(await scan(r, base)).toMatchObject({ status: "secret", path: "z.txt", line: 4 });
  });

  it("(e) merge commit の中だけにある秘密（evil merge）も止める", async () => {
    const { r, base } = withBase();
    r.git("switch", "-q", "-c", "side");
    r.write("side.txt", "side\n");
    r.commitAll("side");
    r.git("switch", "-q", "main");
    r.write("main.txt", "main\n");
    r.commitAll("main");
    r.git("merge", "-q", "--no-ff", "--no-commit", "side");
    r.write("merged.env", `X=1\nK=${GHP}\n`);
    const merge = r.commitAll("merge");
    expect(r.git("rev-list", "--parents", "-n1", "HEAD").trim().split(" ")).toHaveLength(3);
    const v = await scan(r, base);
    expect(v).toMatchObject({ status: "secret", path: "merged.env", line: 2, commit: merge });
  });

  it("(e) merge される側の commit にある秘密も止める。秘密が無い merge は clean", async () => {
    const { r, base } = withBase();
    r.git("switch", "-q", "-c", "side");
    r.write("side.txt", `${GHP}\n`);
    const side = r.commitAll("side");
    r.git("switch", "-q", "main");
    r.write("main.txt", "main\n");
    r.commitAll("main");
    r.git("merge", "-q", "--no-ff", "-m", "merge", "side");
    expect(await scan(r, base)).toMatchObject({ status: "secret", path: "side.txt", commit: side });

    const c = withBase();
    c.r.git("switch", "-q", "-c", "side");
    c.r.write("side.txt", "side\n");
    c.r.commitAll("side");
    c.r.git("switch", "-q", "main");
    c.r.write("main.txt", "main\n");
    c.r.commitAll("main");
    c.r.git("merge", "-q", "--no-ff", "-m", "merge", "side");
    expect(await scan(c.r, c.base)).toEqual({ status: "clean" });
  });

  it("途中の commit のバイナリの鍵ファイル（.pem）は、後で消しても止める。画像は通す", async () => {
    const { r, base } = withBase();
    r.write("img/logo.png", Buffer.from([0, 1, 2, 0, 255]));
    r.commitAll("png");
    expect(await scan(r, base)).toEqual({ status: "clean" });
    r.write("certs/server.PEM", Buffer.from([0, 1, 2, 0, 255]));
    const pem = r.commitAll("pem");
    r.git("rm", "-q", "certs/server.PEM");
    r.commitAll("remove pem");
    expect(await scan(r, base)).toEqual({
      status: "binary",
      path: "certs/server.PEM",
      commit: pem,
    });
  });

  it("出力が上限を超えたら too_large。存在しない基準・壊れた HEAD は git_failed", async () => {
    const { r, base } = withBase();
    r.write("big.txt", `${"x".repeat(80)}\n`.repeat(50));
    r.commitAll("big");
    expect(await scanUnpushedForSecrets(r.scanGit(500), "HEAD", base)).toEqual({
      status: "unscannable",
      reason: "too_large",
    });
    expect(await scan(r, "1".repeat(40))).toEqual({ status: "unscannable", reason: "git_failed" });
    expect(await scan(r, base, "no-such-ref")).toEqual({
      status: "unscannable",
      reason: "git_failed",
    });
  });
});
