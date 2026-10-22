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
    expect(failed?.data.message).toBe("blocked: possible secret (github-token) in src/a.ts:2");
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
    expect(diffs[0]).toContain(`${INITIAL}..HEAD`);
    const events = await allEvents(asFx(stub));
    const pushed = events.filter((e) => e.type === "pushed" && e.data.final !== true);
    expect(pushed.length).toBeGreaterThanOrEqual(2);
    expect(diffs[1]).toContain(`${String(pushed[0]?.data.sha)}..HEAD`);
  });
});
