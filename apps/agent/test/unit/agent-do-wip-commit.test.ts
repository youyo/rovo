import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { clearAgentTestOverrides, setAgentTestOverrides } from "../../src/agent/deps";
import { FakeSandbox } from "../support/fake-sandbox";
import {
  allEvents,
  call,
  done,
  type Fixture,
  makeSpec,
  report,
  waitForPhase,
  waitForTerminal,
} from "./support/agent-fixture";

afterEach(() => clearAgentTestOverrides());

// biome-ignore lint/suspicious/noExplicitAny: private メンバーの観測
type Inst = any;
const runInDO = runInDurableObject as unknown as <T>(
  stub: unknown,
  fn: (inst: Inst) => Promise<T> | T,
) => Promise<T>;
const asFx = (stub: Fixture["stub"]) => ({ stub }) as Fixture;
const SHA = "d".repeat(40);
const WIP_MESSAGE = "wip: budget exceeded（rovo が自動で commit）";

interface Knobs {
  /** git status --porcelain の出力（"" は変更なし） */
  status: string;
  /** 取り込み予定（git diff --cached）の出力 */
  staged: string;
  commitExit: number;
  pushExit: number;
  /** bash の実行中にここが true の間は待つ（cancel の再現） */
  hold: boolean;
}

/** 本番のツール配線 + git の台本。calls に git の argv を記録する。 */
function wipSandbox(over: Partial<Knobs> = {}) {
  const knobs: Knobs = {
    status: " M src/a.ts\n",
    staged: "diff --git a/src/a.ts b/src/a.ts\n+const x = 1;\n",
    commitExit: 0,
    pushExit: 0,
    hold: false,
    ...over,
  };
  const git: string[][] = [];
  const sandbox = new FakeSandbox(async (argv) => {
    if (argv[0] === "bash") {
      while (knobs.hold) await new Promise((r) => setTimeout(r, 10));
      return {};
    }
    if (argv[0] !== "git") return {};
    git.push(argv);
    const sub = argv.find((a) => !a.startsWith("-") && a !== "git" && !a.includes("="));
    if (sub === "status") return { stdout: knobs.status };
    if (sub === "diff" && argv.includes("--cached")) return { stdout: knobs.staged };
    if (sub === "commit") return { exitCode: knobs.commitExit, stderr: "commit failed" };
    if (sub === "rev-parse") return { stdout: `${SHA}\n` };
    if (sub === "push") return { exitCode: knobs.pushExit, stderr: "remote: denied" };
    if (sub === "format-patch") return { stdout: "PATCH" };
    return {};
  });
  const ran = (sub: string) => git.filter((a) => a.includes(sub));
  return { sandbox, git, knobs, ran };
}

/** 1 回目の bash で予算をほぼ使い切り（実測の出力 999,999 トークン = 約 $1）、2 回目の前に budget_exceeded で止まる。 */
async function runToBudgetStop(name: string, knobs: Partial<Knobs> = {}) {
  const made = wipSandbox(knobs);
  setAgentTestOverrides(name, {
    sandbox: made.sandbox,
    pushRetryDelayMs: 0,
    script: [{ ...call("bash", { command: "echo hi" }), usage: { output: 999_999 } }, report()],
  });
  const stub = env.AGENT_DO.getByName(name);
  await stub.start(
    makeSpec(name, {
      verificationCommands: [],
      budgetUsd: 1.0,
      deadlineAt: Date.now() + 3_600_000,
    }),
  );
  expect(await waitForTerminal(asFx(stub))).toBe("budget_exceeded");
  return { ...made, stub };
}

describe("予算超過で止まるとき、未 commit の変更を WIP として commit・push する", () => {
  it("変更があれば、固定メッセージで commit して作業ブランチへ push し、pushed イベント・pushedSha・patch・警告に出る", async () => {
    const t = await runToBudgetStop("wip-ok");
    const commit = t.ran("commit")[0];
    expect(commit).toBeDefined();
    // メッセージは固定文。子の自由文は入れない
    expect(commit?.[commit.indexOf("-m") + 1]).toBe(WIP_MESSAGE);
    expect(commit).toContain("--no-verify");
    expect(t.ran("push")[0]).toEqual([
      "git",
      "push",
      "origin",
      "HEAD:refs/heads/agent/task-wip-ok",
    ]);
    // 順序: add → 秘密の確認（staged の diff）→ commit → push → patch の取得
    const subs = t.git.map((a) =>
      a.find((x) => ["add", "commit", "push", "format-patch"].includes(x)),
    );
    expect(subs.filter(Boolean)).toEqual(["add", "commit", "push", "format-patch"]);
    const events = await allEvents(asFx(t.stub));
    expect(events.filter((e) => e.type === "pushed").map((e) => e.data.sha)).toContain(SHA);
    const r = done(await t.stub.getResult());
    expect(r.pushedSha).toBe(SHA);
    expect(r.patch).toBe("PATCH");
    expect(r.warnings.join("\n")).toContain("WIP");
    expect(r.summary).toContain(SHA);
  });

  it("変更が無ければ何もしない（add・commit・push を呼ばない）", async () => {
    const t = await runToBudgetStop("wip-clean", { status: "" });
    expect(t.ran("add")).toHaveLength(0);
    expect(t.ran("commit")).toHaveLength(0);
    expect(t.ran("push")).toHaveLength(0);
    const r = done(await t.stub.getResult());
    expect(r.warnings.join("\n")).not.toContain("WIP");
  });

  it("git commit が失敗しても、止まる処理は完了し、警告に残る。push はしない", async () => {
    const t = await runToBudgetStop("wip-commit-fail", { commitExit: 1 });
    expect(t.ran("push")).toHaveLength(0);
    const r = done(await t.stub.getResult());
    expect(r.status).toBe("budget_exceeded");
    expect(r.warnings.join("\n")).toContain("WIP");
  });

  it("push が失敗しても、止まる処理は完了する。commit は残り、警告で push できなかったと分かる", async () => {
    const t = await runToBudgetStop("wip-push-fail", { pushExit: 1 });
    expect(t.ran("commit")).toHaveLength(1);
    const r = done(await t.stub.getResult());
    expect(r.status).toBe("budget_exceeded");
    expect(r.pushedSha).toBeUndefined();
    expect(r.warnings.join("\n")).toMatch(/WIP.*push/);
    const events = await allEvents(asFx(t.stub));
    expect(events.some((e) => e.type === "push_failed")).toBe(true);
  });

  it("取り込む差分に秘密らしき文字列があれば commit せず、add を戻して止まる", async () => {
    const t = await runToBudgetStop("wip-secret", {
      staged: `diff --git a/.env b/.env\n+GITHUB_TOKEN=ghp_${"a".repeat(36)}\n`,
    });
    expect(t.ran("commit")).toHaveLength(0);
    expect(t.ran("push")).toHaveLength(0);
    expect(t.ran("reset")).toHaveLength(1);
    const r = done(await t.stub.getResult());
    expect(r.status).toBe("budget_exceeded");
    expect(r.warnings.join("\n")).toContain("秘密");
    // 秘密の値そのものは結果に出ない
    expect(JSON.stringify(r)).not.toContain("ghp_aaaa");
  });

  it("git が時間内に終わらなくても（上限）、止まる処理は完了する", async () => {
    const made = wipSandbox();
    const inner = made.sandbox;
    // status が返らない Sandbox
    inner.setHandler(async (argv) => {
      if (argv[0] === "git" && argv.includes("status")) {
        await new Promise((r) => setTimeout(r, 5_000));
      }
      return {};
    });
    setAgentTestOverrides("wip-timeout", {
      sandbox: inner,
      wipCommitWaitMs: 100,
      script: [{ ...call("bash", { command: "echo hi" }), usage: { output: 999_999 } }, report()],
    });
    const stub = env.AGENT_DO.getByName("wip-timeout");
    await stub.start(
      makeSpec("wip-timeout", {
        verificationCommands: [],
        budgetUsd: 1.0,
        deadlineAt: Date.now() + 3_600_000,
      }),
    );
    expect(await waitForTerminal(asFx(stub))).toBe("budget_exceeded");
    const r = done(await stub.getResult());
    expect(r.warnings.join("\n")).toContain("WIP");
  });
});

describe("予算超過以外の停止では commit しない", () => {
  it("cancel（利用者の明示の停止）では commit しない", async () => {
    const made = wipSandbox({ hold: true });
    setAgentTestOverrides("wip-cancel", {
      sandbox: made.sandbox,
      cancelWaitMs: 200,
      script: [call("bash", { command: "sleep 100" }), report()],
    });
    const stub = env.AGENT_DO.getByName("wip-cancel");
    await stub.start(makeSpec("wip-cancel", { verificationCommands: [] }));
    while (made.sandbox.calls.length === 0) await new Promise((r) => setTimeout(r, 10));
    await stub.cancel();
    made.knobs.hold = false;
    await waitForPhase(asFx(stub), "cancelled");
    expect(made.ran("commit")).toHaveLength(0);
    expect(made.ran("push")).toHaveLength(0);
    expect(made.ran("add")).toHaveLength(0);
  });

  it("期限切れ（deadline）・回答待ちの期限（input_timeout）でも commit しない（Sandbox は停止時に破棄され、時間の上限を守る）", async () => {
    for (const reason of ["deadline", "input_timeout"] as const) {
      const name = `wip-${reason}`;
      const made = wipSandbox({ hold: true });
      setAgentTestOverrides(name, {
        sandbox: made.sandbox,
        cancelWaitMs: 200,
        script: [call("bash", { command: "sleep 100" }), report()],
      });
      const stub = env.AGENT_DO.getByName(name);
      await stub.start(makeSpec(name, { verificationCommands: [] }));
      while (made.sandbox.calls.length === 0) await new Promise((r) => setTimeout(r, 10));
      await runInDO(stub, (inst) => inst.requestStop(reason));
      made.knobs.hold = false;
      await waitForTerminal(asFx(stub));
      expect(made.ran("add"), reason).toHaveLength(0);
      expect(made.ran("commit"), reason).toHaveLength(0);
      expect(made.ran("push"), reason).toHaveLength(0);
    }
  });
});
