import { describe, expect, it } from "vitest";
import { createSandboxTools } from "../../src/tools";
import type { PushResult, ToolContext } from "../../src/tools/types";
import { type FakeFile, fakeGitRange } from "../support/fake-git-range";
import { FakeSandbox } from "../support/fake-sandbox";

// 秘密の検出に反応しないよう、明らかな偽物を組み立てる
const GHP = `ghp_${"a1B2".repeat(9)}`;
const BRANCH = "agent/task-t1";

const file = (path: string, ...lines: string[]): FakeFile => ({ path, lines });

function setup(opts: { base?: string; withBase?: boolean } = {}) {
  const git = fakeGitRange({ base: opts.base });
  const sandbox = new FakeSandbox(git.handler);
  const results: PushResult[] = [];
  const events: { type: string; data: Record<string, unknown> }[] = [];
  // AgentDO と同じ: 最後に push できた SHA を覚え、ツールへ返す
  let last: string | undefined = git.base;
  const context: ToolContext = {
    workspaceRoot: "/workspace",
    deadlineAt: Date.now() + 3_600_000,
    commitAuthor: { name: "rovo-bot", email: "bot@example.com" },
    branch: BRANCH,
    onPush: async (r) => {
      results.push(r);
      if (r.ok) last = r.sha;
    },
    onEvent: (type, data) => void events.push({ type, data }),
    ...(opts.withBase === false ? {} : { lastPushedSha: () => last }),
  };
  const tools = createSandboxTools(sandbox, context);
  const commit = async (message = "m") => {
    const tool = tools.find((t) => t.name === "git_commit");
    if (!tool) throw new Error("no git_commit");
    const res = await (
      tool.execute as (
        a: unknown,
        b: unknown,
        c: unknown,
      ) => Promise<{ output?: { type: string; text?: string }[]; isError?: boolean }>
    )({ message }, {}, {});
    return {
      text: (res.output ?? []).map((c) => c.text ?? "").join(""),
      isError: res.isError === true,
    };
  };
  const diffArgs = () => git.state.rangeArgs.filter((a) => !a.includes("--numstat"));
  /** 検査の git log の基準（--not の次の引数）。基準が無いとき（初回）は undefined */
  const notOf = (argv: string[] | undefined) => {
    const i = argv?.indexOf("--not") ?? -1;
    return i >= 0 ? argv?.[i + 1] : undefined;
  };
  return { git, sandbox, results, events, commit, diffArgs, notOf };
}

describe("git_commit の push 前の秘密の検査", () => {
  it("追加行にトークンがあれば push しない。onPush は固定文の失敗で、値を含まない", async () => {
    const t = setup();
    t.git.stage(file("src/a.ts", "const a = 1;", `const t = "${GHP}";`));
    const r = await t.commit();
    expect(t.git.state.pushes).toHaveLength(0);
    expect(t.results).toEqual([
      {
        ok: false,
        sha: t.git.head(),
        error: `blocked: possible secret (github-token) in src/a.ts:2 (commit ${t.git.head().slice(0, 7)})`,
      },
    ]);
    // commit は成功のまま（ローカルに残る）。子に返る文は file:line・category・やり直しの案内。値は出ない
    expect(r.isError).toBe(false);
    expect(r.text).toContain(`committed ${t.git.head()}`);
    expect(r.text).toMatch(/not pushed/i);
    expect(r.text).toContain("src/a.ts:2");
    expect(r.text).toContain("github-token");
    expect(r.text).toContain("git reset --soft");
    expect(r.text).not.toContain(GHP);
    expect(JSON.stringify(t.results)).not.toContain(GHP);
    expect(JSON.stringify(t.events)).not.toContain(GHP);
  });

  it("秘密が無ければ今までどおり push し、次の検査の範囲は push した SHA から始まる", async () => {
    const t = setup();
    t.git.stage(file("src/a.ts", "const a = 1;"));
    const first = await t.commit();
    expect(first.text).toMatch(/pushed to the task branch/);
    expect(t.git.state.pushes).toEqual([
      [
        "git",
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "credential.helper=",
        "push",
        "origin",
        `${t.git.head()}:refs/heads/${BRANCH}`,
      ],
    ]);
    expect(t.sandbox.calls.find((c) => c.argv.includes("push"))?.options.pushPermit).toEqual({
      ref: `refs/heads/${BRANCH}`,
      newSha: t.git.head(),
    });
    expect(t.results).toEqual([{ ok: true, sha: t.git.head() }]);
    const pushedSha = t.git.head();
    t.git.stage(file("src/b.ts", "const b = 2;"));
    await t.commit();
    // 2 回目は、1 回目の push の SHA から HEAD まで
    expect(t.notOf(t.diffArgs().at(-1))).toBe(pushedSha);
    expect(t.git.state.pushes).toHaveLength(2);
  });

  it("最初の範囲は、タスク開始時の作業ブランチの先頭（initialSha）から", async () => {
    const t = setup({ base: "e".repeat(40) });
    t.git.stage(file("src/a.ts", "x"));
    await t.commit();
    expect(t.notOf(t.diffArgs()[0])).toBe("e".repeat(40));
  });

  it("bash で作った commit の中の秘密も、範囲（HEAD --not last_pushed）なので止まる", async () => {
    const t = setup();
    t.git.commitDirect(file("secrets.env", "A=1", `T=${GHP}`));
    t.git.stage(file("src/clean.ts", "const ok = true;"));
    const r = await t.commit();
    expect(t.git.state.pushes).toHaveLength(0);
    expect(t.results[0]).toMatchObject({
      ok: false,
      error: expect.stringMatching(
        /^blocked: possible secret \(github-token\) in secrets\.env:2 \(commit [0-9a-f]{7}\)$/,
      ),
    });
    expect(r.text).not.toContain(GHP);
  });

  it("秘密を消した commit を積んでも、前の commit に残っていれば止まる。git reset --soft でやり直せば通る", async () => {
    const t = setup();
    t.git.stage(file("src/a.ts", `const t = "${GHP}";`));
    await t.commit("leak");
    expect(t.git.state.pushes).toHaveLength(0);
    // 秘密を消した変更を積む（履歴には残っている）
    t.git.stage(file("src/a.ts", 'const t = process.env.T ?? "";'));
    const again = await t.commit("fix");
    expect(t.git.state.pushes).toHaveLength(0);
    expect(t.results).toHaveLength(2);
    expect(again.text).toContain("src/a.ts:1");
    // git reset --soft で出発点に戻し、秘密の無い状態で commit し直す
    t.git.resetSoft(2);
    t.git.state.pending = [file("src/a.ts", 'const t = process.env.T ?? "";')];
    const redo = await t.commit("redo");
    expect(t.git.state.pushes).toHaveLength(1);
    expect(redo.text).toMatch(/pushed to the task branch/);
    expect(t.results.at(-1)).toEqual({ ok: true, sha: t.git.head() });
  });

  it("途中の commit で足して、後の commit で消した秘密も止まる（2 つの木の差分は空でも、push は両方の commit を送る）", async () => {
    const t = setup();
    t.git.stage(file("src/a.ts", "const a = 1;", `const t = "${GHP}";`));
    await t.commit("leak");
    const leak = t.git.head();
    t.git.stage({ path: "src/a.ts", deleted: true });
    const r = await t.commit("remove");
    // 前提: last_pushed と HEAD の木の差分には、秘密が出ない
    expect(t.git.treeDiff()).not.toContain(GHP);
    expect(t.git.state.pushes).toHaveLength(0);
    expect(t.results).toHaveLength(2);
    expect(t.results[1]).toEqual({
      ok: false,
      sha: t.git.head(),
      error: `blocked: possible secret (github-token) in src/a.ts:2 (commit ${leak.slice(0, 7)})`,
    });
    expect(r.text).toMatch(/not pushed/i);
    expect(r.text).toContain("git reset --soft");
    // 消す commit を積むだけでは送られる、という案内と、秘密のある commit の短い SHA
    expect(r.text).toMatch(/only deletes it is NOT enough/);
    expect(r.text).toContain(`commit ${leak.slice(0, 7)}`);
    expect(r.text).not.toContain(GHP);
  });

  it("子に返る文のパスにトークンが入っていても、値は出ない（イベント・onPush と同じく maskSecrets を通す）", async () => {
    const t = setup();
    t.git.stage(file(`src/${GHP}.ts`, `const t = "${GHP}";`));
    const r = await t.commit();
    expect(t.git.state.pushes).toHaveLength(0);
    expect(r.text).toMatch(/not pushed/i);
    expect(r.text).toContain("github-token");
    expect(r.text).not.toContain(GHP);
    expect(JSON.stringify(t.results)).not.toContain(GHP);
    expect(JSON.stringify(t.events)).not.toContain(GHP);
    // バイナリ（鍵らしい拡張子）のパスでも同じ
    const b = setup();
    b.git.stage({ path: `keys/${GHP}.pem`, binary: true });
    const rb = await b.commit();
    expect(rb.text).toContain("keys/");
    expect(rb.text).not.toContain(GHP);
    expect(JSON.stringify(b.results)).not.toContain(GHP);
  });

  it("推測系（Authorization・token= など）は止めない", async () => {
    const t = setup();
    t.git.stage(
      file(
        "docs/a.md",
        "Authorization: Bearer abc.DEF-123_xyz==",
        "curl 'https://e.com/?token=aaaaaaaa1111'",
        "FOO_TOKEN=bar",
      ),
    );
    await t.commit();
    expect(t.git.state.pushes).toHaveLength(1);
  });

  it("鍵らしい拡張子のバイナリ（.pem）は止め、画像（.png）は通す", async () => {
    const pem = setup();
    pem.git.stage({ path: "certs/server.PEM", binary: true });
    const r = await pem.commit();
    expect(pem.git.state.pushes).toHaveLength(0);
    const first = pem.results[0];
    expect(first?.ok).toBe(false);
    expect(first?.ok === false && first.error).toContain("certs/server.PEM");
    expect(r.text).toContain("certs/server.PEM");

    const png = setup();
    png.git.stage({ path: "img/logo.png", binary: true }, file("src/a.ts", "ok"));
    await png.commit();
    expect(png.git.state.pushes).toHaveLength(1);
  });

  it.each([".pem", ".key", ".p12", ".pfx", ".jks", ".keystore", ".der", ".p8", ".ppk"])(
    "鍵らしい拡張子 %s のバイナリは止まる",
    async (ext) => {
      const t = setup();
      t.git.stage({ path: `k/a${ext}`, binary: true });
      await t.commit();
      expect(t.git.state.pushes).toHaveLength(0);
    },
  );

  it("差分が大きすぎる（出力が切れた）ときは push しない", async () => {
    const t = setup();
    t.git.stage(file("src/a.ts", "ok"));
    t.git.state.rangeDiff = { truncated: true, stdout: "+x" };
    const r = await t.commit();
    expect(t.git.state.pushes).toHaveLength(0);
    expect(t.results[0]).toMatchObject({ ok: false });
    expect(r.isError).toBe(false);
    expect(r.text).toMatch(/not pushed/i);
  });

  it("numstat が切れたときも push しない", async () => {
    const t = setup();
    t.git.stage(file("src/a.ts", "ok"));
    t.git.state.rangeNumstat = { truncated: true, stdout: "1\t0\ta" };
    await t.commit();
    expect(t.git.state.pushes).toHaveLength(0);
  });

  it("検査の git が失敗（終了コード・時間切れ・例外）したら push しない", async () => {
    for (const bad of [
      { exitCode: 128, stderr: "fatal: bad object" },
      { exitCode: 124, timedOut: true },
    ]) {
      const t = setup();
      t.git.stage(file("src/a.ts", "ok"));
      t.git.state.rangeDiff = bad;
      await t.commit();
      expect(t.git.state.pushes).toHaveLength(0);
      expect(t.results[0]).toMatchObject({ ok: false });
    }
    const t = setup();
    t.git.stage(file("src/a.ts", "ok"));
    const inner = t.git.handler;
    t.sandbox.setHandler((argv, o) => {
      if (argv.includes("log") && argv.includes("--not")) {
        throw new Error("exec rejected");
      }
      return inner(argv, o);
    });
    const r = await t.commit();
    expect(r.isError).toBe(false);
    expect(t.git.state.pushes).toHaveLength(0);
    expect(t.results[0]).toMatchObject({ ok: false });
  });

  it("基準が渡されないとき（ToolContext に lastPushedSha が無い）は、空の木からの全体を検査する", async () => {
    const t = setup({ withBase: false });
    t.git.stage(file("src/a.ts", "ok"));
    await t.commit();
    expect(t.git.state.pushes).toHaveLength(1);
    // 基準が無いので --not を付けず、HEAD から辿れる全部の commit を見る
    expect(t.diffArgs()[0]).toContain("HEAD");
    expect(t.notOf(t.diffArgs()[0])).toBeUndefined();
  });

  it("push 自体が失敗した場合は、基準を進めない（次も同じ範囲）", async () => {
    const t = setup();
    t.git.state.pushOk = false;
    t.git.stage(file("src/a.ts", "one"));
    await t.commit();
    t.git.stage(file("src/b.ts", "two"));
    await t.commit();
    expect(t.notOf(t.diffArgs()[1])).toBe(t.git.base);
  });
});
