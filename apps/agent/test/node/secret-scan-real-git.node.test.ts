import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  blockedMessage,
  type ScanVerdict,
  scanRangeForSecrets,
  scanUnpushedForSecrets,
} from "../../src/secret-scan";
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

const scanRemote = (r: RealRepo, last: string | undefined, baseSha?: string, url?: string) =>
  scanUnpushedForSecrets(r.scanGit(), "HEAD", last, {
    remote: { url: url ?? r.git("remote", "get-url", "origin").trim(), baseSha },
  });

describe("本物の git: リモートに実在する SHA（ls-remote）を除外の基準に足す", () => {
  /** base（A）を作業ブランチの出発点にして、main 側に秘密のダミーを含む公開済みの commit を積む。作業ブランチに main を merge する前の状態で返す */
  function mainHasDummy() {
    const { r, base } = withBase();
    r.addOrigin();
    r.git("push", "-q", "origin", "main");
    r.git("switch", "-q", "-c", "work");
    r.write("src/w.ts", "export const w = 1;\n");
    r.commitAll("work");
    r.git("switch", "-q", "main");
    r.write("test/dummy.test.ts", `const t = "${GHP}";\n`);
    const pub = r.commitAll("main: dummy token in a test");
    r.git("push", "-q", "origin", "main");
    r.git("switch", "-q", "work");
    return { r, base, pub };
  }

  it("(a) main 側にダミーの秘密がある公開済みの commit を merge しても、main がリモートにあれば clean", async () => {
    const { r, base, pub } = mainHasDummy();
    r.git("merge", "-q", "--no-ff", "-m", "merge main", pub);
    // 前提: 従来の基準（last_pushed だけ）では main 側の commit が入って止まる
    expect(await scan(r, base)).toMatchObject({ status: "secret", path: "test/dummy.test.ts" });
    expect(await scanRemote(r, base)).toEqual({ status: "clean" });
  });

  it("(a) main の上に rebase しても clean。last_pushed が無い初回でも main 側は見ない", async () => {
    const { r, base } = mainHasDummy();
    r.git("rebase", "-q", "main");
    expect(await scan(r, base)).toMatchObject({ status: "secret" });
    expect(await scanRemote(r, base)).toEqual({ status: "clean" });
    expect(await scanRemote(r, undefined)).toEqual({ status: "clean" });
  });

  it("(a) リモートのタグの先の commit も除外する", async () => {
    const { r, base } = withBase();
    r.addOrigin();
    r.write("old.env", `T=${GHP}\n`);
    const pub = r.commitAll("public via tag");
    r.git("tag", "-a", "-m", "v", "v1", pub);
    r.git("push", "-q", "origin", "refs/tags/v1");
    r.git("tag", "-d", "v1");
    r.write("src/n.ts", "export const n = 1;\n");
    r.commitAll("new");
    expect(await scan(r, base)).toMatchObject({ status: "secret" });
    expect(await scanRemote(r, base)).toEqual({ status: "clean" });
  });

  it("(a) spec の base_sha も除外に足す。ローカルに無い SHA がリモートにあっても失敗しない", async () => {
    const { r, base } = withBase();
    r.addOrigin();
    r.write("old.env", `T=${GHP}\n`);
    const b = r.commitAll("base of the task");
    r.write("src/c.ts", "export const c = 1;\n");
    r.commitAll("remote head (descendant of the base)");
    r.git("push", "-q", "origin", "HEAD:refs/heads/main");
    r.write("src/n.ts", "export const n = 1;\n");
    r.commitAll("new");
    expect(await scan(r, base)).toMatchObject({ status: "secret" });
    expect(await scan(r, base)).toMatchObject({ commit: b });
    expect(await scanRemote(r, base, b)).toEqual({ status: "clean" });
    // リモートだけにある commit（ローカルに無い）
    const other = repo();
    other.write("x.txt", "x\n");
    other.commitAll("x");
    const bare = r.git("remote", "get-url", "origin").trim();
    other.git("push", "-q", bare, "HEAD:refs/heads/elsewhere");
    expect(await scanRemote(r, base, b)).toEqual({ status: "clean" });
  });

  it("(b) evil merge（merge commit の中だけにある秘密）は、main を merge していても止まる", async () => {
    const { r, base, pub } = mainHasDummy();
    r.git("merge", "-q", "--no-ff", "--no-commit", pub);
    r.write("merged.env", `X=1\nK=${GHP}\n`);
    const merge = r.commitAll("evil merge");
    expect(await scanRemote(r, base)).toMatchObject({
      status: "secret",
      path: "merged.env",
      line: 2,
      commit: merge,
    });
  });

  it("(c) ローカルの refs/remotes/origin/x を秘密の commit に向けても、除外されない（偽造が効かない）", async () => {
    const { r, base } = withBase();
    r.addOrigin();
    r.git("push", "-q", "origin", "main");
    r.write("leak.env", `T=${GHP}\n`);
    const leak = r.commitAll("leak");
    r.git("update-ref", "refs/remotes/origin/x", leak);
    r.git("update-ref", "refs/remotes/origin/main", leak);
    r.write("src/n.ts", "export const n = 1;\n");
    r.commitAll("after");
    expect(await scanRemote(r, base)).toMatchObject({
      status: "secret",
      path: "leak.env",
      commit: leak,
    });
  });

  it("(d) ls-remote が失敗したら last_pushed だけで判定する（誤検知は増えても素通りしない）", async () => {
    const { r, base, pub } = mainHasDummy();
    r.git("merge", "-q", "--no-ff", "-m", "merge main", pub);
    r.git("remote", "set-url", "origin", "/nonexistent/rovo-no-such-remote");
    expect(await scanRemote(r, base)).toMatchObject({
      status: "secret",
      path: "test/dummy.test.ts",
    });
    // 秘密が無ければ、失敗していても clean
    const c = withBase();
    c.r.addOrigin();
    c.r.git("remote", "set-url", "origin", "/nonexistent/rovo-no-such-remote");
    c.r.write("src/n.ts", "export const n = 1;\n");
    c.r.commitAll("new");
    expect(await scanRemote(c.r, c.base)).toEqual({ status: "clean" });
  });
});

describe("本物の git: 子が書き換えられる git の状態に左右されない", () => {
  const range = (r: RealRepo, base: string) =>
    scanRangeForSecrets(r.scanGit(), [`${base}..HEAD`], "push");

  it("バイナリ扱いのファイル（NUL・-diff・info/attributes の binary）の中身も検査する", async () => {
    // NUL バイトで始まるファイル
    const a = withBase();
    a.r.write("blob.dat", Buffer.concat([Buffer.from([0, 1, 2, 0]), Buffer.from(`\n${GHP}\n`)]));
    a.r.commitAll("nul");
    expect(await scan(a.r, a.base)).toMatchObject({ status: "secret", category: "github-token" });
    expect(await range(a.r, a.base)).toMatchObject({ status: "secret" });
    // .gitattributes の -diff
    const b = withBase();
    b.r.write(".gitattributes", "* -diff\n");
    b.r.write("s.txt", `${GHP}\n`);
    b.r.commitAll("attr");
    expect(await scan(b.r, b.base)).toMatchObject({ status: "secret", path: "s.txt" });
    expect(await range(b.r, b.base)).toMatchObject({ status: "secret" });
    // .git/info/attributes の binary（commit されない設定）
    const c = withBase();
    writeFileSync(join(c.r.dir, ".git", "info", "attributes"), "* binary\n");
    c.r.write("s.txt", `${GHP}\n`);
    c.r.commitAll("info attr");
    expect(await scan(c.r, c.base)).toMatchObject({ status: "secret", path: "s.txt" });
    expect(await range(c.r, c.base)).toMatchObject({ status: "secret" });
  });

  it("鍵らしい拡張子のバイナリは、diff 属性で本文扱いにされても止める。画像は通す", async () => {
    const { r, base } = withBase();
    r.write(".gitattributes", "*.pem diff\n");
    r.write("k.pem", Buffer.from([0, 1, 2, 0, 255]));
    r.commitAll("pem");
    expect(await scan(r, base)).toMatchObject({ status: "binary", path: "k.pem" });
    const c = withBase();
    c.r.write("a.png", Buffer.from([0, 1, 2, 0, 255]));
    c.r.commitAll("png");
    expect(await scan(c.r, c.base)).toEqual({ status: "clean" });
  });

  it("(2a) git replace で秘密の commit を無害な commit に見せかけても、本物の中身を検査する", async () => {
    const { r, base } = withBase();
    r.write("ok.txt", "ok\n");
    const harmless = r.commitAll("harmless");
    r.git("reset", "-q", "--hard", base);
    r.write("leak.env", `T=${GHP}\n`);
    const leak = r.commitAll("leak");
    r.git("replace", leak, harmless);
    expect(await scan(r, base)).toMatchObject({ status: "secret", path: "leak.env", commit: leak });
    expect(await range(r, base)).toMatchObject({ status: "secret" });
  });

  it("(2b) origin の URL を偽の bare に向けても、渡した URL の ls-remote の答えで判定する", async () => {
    const { r, base } = withBase();
    const real = r.addOrigin();
    r.git("push", "-q", "origin", "main");
    r.write("leak.env", `T=${GHP}\n`);
    const leak = r.commitAll("leak");
    // 偽のリモート: 秘密の commit を持つ
    const fake = repo();
    const fakeBare = fake.addOrigin();
    r.git("push", "-q", fakeBare, "HEAD:refs/heads/main");
    r.git("remote", "set-url", "origin", fakeBare);
    r.git("config", "remote.origin.pushurl", real);
    r.git("config", `url.${fakeBare}.insteadOf`, real);
    r.write("src/n.ts", "export const n = 1;\n");
    r.commitAll("after");
    expect(await scanRemote(r, base, undefined, real)).toMatchObject({
      status: "secret",
      path: "leak.env",
      commit: leak,
    });
  });

  it("(2c) diff.noprefix・diff.mnemonicPrefix・color.ui・log.showSignature・diff.external を設定しても検査できる", async () => {
    const { r, base } = withBase();
    r.git("config", "diff.noprefix", "true");
    r.git("config", "diff.mnemonicPrefix", "true");
    r.git("config", "color.ui", "always");
    r.git("config", "color.diff", "always");
    r.git("config", "log.showSignature", "true");
    r.git("config", "diff.external", "true");
    r.git("config", "diff.context", "0");
    r.git("config", "diff.relative", "true");
    r.write("src/leak.env", `a\nT=${GHP}\n`);
    r.commitAll("leak");
    expect(await scan(r, base)).toMatchObject({ status: "secret", path: "src/leak.env", line: 2 });
    expect(await range(r, base)).toMatchObject({ status: "secret", path: "src/leak.env", line: 2 });
  });

  it("(3) base_sha は、ls-remote の SHA から辿れるときだけ除外に入れる（ローカルだけの commit は入れない）", async () => {
    const { r, base } = withBase();
    r.addOrigin();
    r.git("push", "-q", "origin", "main");
    r.write("leak.env", `T=${GHP}\n`);
    const localOnly = r.commitAll("local only");
    r.write("src/n.ts", "export const n = 1;\n");
    r.commitAll("after");
    expect(await scanRemote(r, base, localOnly)).toMatchObject({
      status: "secret",
      path: "leak.env",
      commit: localOnly,
    });
    // リモートの先頭の祖先なら除外される
    r.git("push", "-q", "origin", "main");
    expect(await scanRemote(r, base, localOnly)).toEqual({ status: "clean" });
  });
});
