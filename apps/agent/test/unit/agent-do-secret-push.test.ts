import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { clearAgentTestOverrides, setAgentTestOverrides } from "../../src/agent/deps";
import { type FakeFile, fakeGitRange } from "../support/fake-git-range";
import { FakeSandbox } from "../support/fake-sandbox";
import {
  allEvents,
  call,
  done,
  type Fixture,
  makeSpec,
  report,
  waitForTerminal,
} from "./support/agent-fixture";

afterEach(() => clearAgentTestOverrides());

const asFx = (stub: Fixture["stub"]) => ({ stub }) as Fixture;
// 秘密の検出に反応しないよう、明らかな偽物を組み立てる
const GHP = `ghp_${"a1B2".repeat(9)}`;
const INITIAL = "1".repeat(40);
const file = (path: string, ...lines: string[]): FakeFile => ({ path, lines });

/** 本番のツール配線 + git のモデル。完了のための git（status / ls-remote / format-patch）も答える */
function prod(git: ReturnType<typeof fakeGitRange>, afterCommit?: (n: number) => void) {
  let commits = 0;
  return new FakeSandbox((argv, o) => {
    if (argv[0] !== "git") return {};
    if (argv.includes("commit")) {
      const r = git.handler(argv, o);
      commits += 1;
      afterCommit?.(commits);
      return r;
    }
    if (argv[1] === "status") return { stdout: "" };
    if (argv[1] === "ls-remote") return { stdout: `${git.head()}\t${argv[3]}\n` };
    if (argv[1] === "format-patch") return { stdout: "PATCH" };
    return git.handler(argv, o);
  });
}

describe("git_commit の push 前の検査（本番のツール配線）", () => {
  it("追加行に秘密があれば push せず、push_failed イベントは固定文で値を含まない。ツールの結果にも値が出ない", async () => {
    const git = fakeGitRange({ base: INITIAL });
    git.stage(file("src/a.ts", "const a = 1;", `const t = "${GHP}";`));
    setAgentTestOverrides("sp-block", {
      sandbox: prod(git),
      pushRetryDelayMs: 0,
      script: [call("git_commit", { message: "one" }), report("done")],
    });
    const stub = env.AGENT_DO.getByName("sp-block");
    await stub.start(
      makeSpec("sp-block", { verificationCommands: [], deadlineAt: Date.now() + 3_600_000 }),
    );
    await waitForTerminal(asFx(stub));
    expect(
      git.state.pushes.filter((p) => p.includes("HEAD:refs/heads/agent/task-sp-block")),
    ).toHaveLength(0);
    const events = await allEvents(asFx(stub));
    const failed = events.find((e) => e.type === "push_failed" && e.data.final !== true);
    expect(failed?.data.message).toBe(
      `blocked: possible secret (github-token) in src/a.ts:2 (commit ${git.head().slice(0, 7)})`,
    );
    expect(failed?.data.sha).toBe(git.head());
    const end = events.find((e) => e.type === "tool_end" && e.data.name === "git_commit");
    expect(end?.data.isError).toBe(false);
    expect(JSON.stringify(events)).not.toContain(GHP);
    expect(JSON.stringify(done(await stub.getResult()))).not.toContain(GHP);
  });

  it("範囲の始まりは initialSha。push に成功したあとは、その SHA（branch_sync）から", async () => {
    const git = fakeGitRange({ base: INITIAL });
    git.stage(file("src/a.ts", "one"));
    // 1 回目の commit の直後に、2 回目の commit の変更を積む
    const sandbox = prod(git, (n) => {
      if (n === 1) git.stage(file("src/b.ts", "two"));
    });
    setAgentTestOverrides("sp-base", {
      sandbox,
      script: [
        call("git_commit", { message: "one" }),
        call("git_commit", { message: "two" }),
        report("done"),
      ],
    });
    const stub = env.AGENT_DO.getByName("sp-base");
    await stub.start(
      makeSpec("sp-base", { verificationCommands: [], deadlineAt: Date.now() + 3_600_000 }),
    );
    expect(await waitForTerminal(asFx(stub))).toBe("completed");
    const diffs = git.state.rangeArgs.filter((a) => !a.includes("--numstat"));
    const notOf = (argv: string[] | undefined) => argv?.[(argv?.indexOf("--not") ?? -2) + 1];
    expect(notOf(diffs[0])).toBe(INITIAL);
    const events = await allEvents(asFx(stub));
    const pushed = events.filter((e) => e.type === "pushed" && e.data.final !== true);
    expect(pushed.length).toBeGreaterThanOrEqual(2);
    expect(notOf(diffs[1])).toBe(String(pushed[0]?.data.sha));
  });
});

describe("完了時の作業ブランチの同期（--force-with-lease の push）の前の検査", () => {
  const notOf = (argv: string[] | undefined) => argv?.[(argv?.indexOf("--not") ?? -2) + 1];

  it("送る commit に秘密があれば（足して消した commit でも）push せず、push_failed（final）と警告に出る。head_matches_verified が false になる側（pushedSha なし）", async () => {
    const git = fakeGitRange({ base: INITIAL });
    // 子が bash で積んだ commit: 途中で秘密を足し、次の commit で消している（HEAD の木には秘密が無い）
    const leak = git.commitDirect(file("src/leak.ts", "const a = 1;", `const t = "${GHP}";`));
    git.commitDirect({ path: "src/leak.ts", deleted: true });
    expect(git.treeDiff()).not.toContain(GHP);
    setAgentTestOverrides("sp-sync-block", {
      sandbox: prod(git),
      pushRetryDelayMs: 0,
      script: [report("done")],
    });
    const stub = env.AGENT_DO.getByName("sp-sync-block");
    await stub.start(
      makeSpec("sp-sync-block", { verificationCommands: [], deadlineAt: Date.now() + 3_600_000 }),
    );
    // 終端の扱いは、今の push 失敗のときと同じ（completed のまま、警告が付く）
    expect(await waitForTerminal(asFx(stub))).toBe("completed");
    expect(git.state.pushes).toHaveLength(0);
    const events = await allEvents(asFx(stub));
    const failed = events.filter((e) => e.type === "push_failed" && e.data.final === true);
    expect(failed).toHaveLength(1);
    expect(failed[0]?.data.message).toBe(
      `blocked: possible secret (github-token) in src/leak.ts:2 (commit ${leak.slice(0, 7)})`,
    );
    expect(events.some((e) => e.type === "pushed" && e.data.final === true)).toBe(false);
    const r = done(await stub.getResult());
    expect("pushedSha" in r ? r.pushedSha : undefined).toBeUndefined();
    expect(r.warnings.some((w) => /push_failed/.test(w))).toBe(true);
    expect(JSON.stringify([r, events])).not.toContain(GHP);
  });

  it("秘密が無ければ今までどおり push する。検査の範囲は、送る SHA から、リモートに無い commit（initialSha より後）", async () => {
    const git = fakeGitRange({ base: INITIAL });
    git.commitDirect(file("src/ok.ts", "const ok = true;"));
    setAgentTestOverrides("sp-sync-ok", {
      sandbox: prod(git),
      pushRetryDelayMs: 0,
      script: [report("done")],
    });
    const stub = env.AGENT_DO.getByName("sp-sync-ok");
    await stub.start(
      makeSpec("sp-sync-ok", { verificationCommands: [], deadlineAt: Date.now() + 3_600_000 }),
    );
    expect(await waitForTerminal(asFx(stub))).toBe("completed");
    expect(git.state.pushes).toHaveLength(1);
    expect(git.state.pushes[0]?.some((a) => a.startsWith("--force-with-lease="))).toBe(true);
    const scans = git.state.rangeArgs.filter((a) => !a.includes("--numstat"));
    expect(scans.length).toBeGreaterThan(0);
    expect(scans.every((a) => a.includes(git.head()) && notOf(a) === INITIAL)).toBe(true);
    expect(done(await stub.getResult())).toMatchObject({ pushedSha: git.head() });
  });

  it("検査が git の失敗で終わったときも push しない（push_failed は固定の文）", async () => {
    const git = fakeGitRange({ base: INITIAL });
    git.commitDirect(file("src/ok.ts", "ok"));
    git.state.rangeNumstat = { exitCode: 128, stderr: "fatal: bad object" };
    setAgentTestOverrides("sp-sync-gitfail", {
      sandbox: prod(git),
      pushRetryDelayMs: 0,
      script: [report("done")],
    });
    const stub = env.AGENT_DO.getByName("sp-sync-gitfail");
    await stub.start(
      makeSpec("sp-sync-gitfail", { verificationCommands: [], deadlineAt: Date.now() + 3_600_000 }),
    );
    expect(await waitForTerminal(asFx(stub))).toBe("completed");
    expect(git.state.pushes).toHaveLength(0);
    const events = await allEvents(asFx(stub));
    const failed = events.find((e) => e.type === "push_failed" && e.data.final === true);
    expect(failed?.data.message).toBe("blocked: could not scan the diff for secrets");
  });
});
