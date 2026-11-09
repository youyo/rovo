import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { clearAgentTestOverrides } from "../../src/agent/deps";
import type { TaskSpec } from "../../src/agent/types";
import { stripGitIsolation } from "../support/fake-sandbox";
import {
  allEvents,
  call,
  clearAgentFixtures,
  done,
  type Fixture,
  makeSpec,
  newFixture,
  report,
  waitForTerminal,
} from "./support/agent-fixture";

// 同じ PR への積み足し（docs/specs/continue-task.md の「agent 側の変更」）。
// TaskSpec の continuation があるときだけ、根のブランチ agent/task-<root> を作業ブランチにでき、
// 完了時の push は initialSha（以降は最後に push できた SHA）を lease の期待値にする。

afterEach(async () => {
  await clearAgentFixtures();
  clearAgentTestOverrides();
});

// biome-ignore lint/suspicious/noExplicitAny: private メンバーの観測
type Inst = any;
const runInDO = runInDurableObject as unknown as <T>(
  stub: unknown,
  fn: (inst: Inst) => Promise<T> | T,
) => Promise<T>;
const asFx = (stub: Fixture["stub"]) => ({ stub }) as Fixture;

/** 積み足しの土台（元の PR の head）。積み足しでは initialSha = baseSha */
const HEAD0 = "9".repeat(40);
const ROOT = "root01";
const REF = `refs/heads/agent/task-${ROOT}`;
const D = "d".repeat(40);

/** 積み足しタスクの spec。branch は根のブランチ、initialSha = baseSha */
function contSpec(taskId: string, over: Partial<TaskSpec> = {}): TaskSpec {
  return makeSpec(taskId, {
    baseSha: HEAD0,
    initialSha: HEAD0,
    branch: `agent/task-${ROOT}`,
    continuation: { of: "prev01", root: ROOT },
    ...over,
  });
}

const lsRemoteCalls = (fx: Fixture) =>
  fx.sandbox.calls.filter((c) => {
    const a = stripGitIsolation(c.argv);
    return a[0] === "git" && a[1] === "ls-remote" && !a.includes("--heads");
  });

describe("start: continuation の検証（門番 1）", () => {
  it("continuation があれば agent/task-<root> を作業ブランチとして受け付け、WorkspaceSpec に continuation を渡す", async () => {
    const fx = newFixture("cont-ok", [report()]);
    fx.remote.sha = HEAD0;
    expect(await fx.stub.start(contSpec("cont-ok"))).toMatchObject({ status: "accepted" });
    await waitForTerminal(fx);
    expect(fx.sandbox.readySpecs[0]).toMatchObject({
      branch: `agent/task-${ROOT}`,
      initialSha: HEAD0,
      baseSha: HEAD0,
      continuation: { of: "prev01", root: ROOT },
    });
  });

  it("continuation が無ければ、根のブランチ（agent/task-<他の id>）は今までどおり拒否する", async () => {
    const fx = newFixture("cont-none", [report()]);
    const res = await fx.stub.start(
      makeSpec("cont-none", { branch: `agent/task-${ROOT}`, baseSha: HEAD0, initialSha: HEAD0 }),
    );
    expect(res).toEqual({ status: "rejected", reason: "invalid_spec: branch" });
    expect(fx.sandbox.readySpecs).toHaveLength(0);
  });

  it("branch と root の不一致・root が自分の id・id の形が不正・initialSha !== baseSha・kind との併用は拒否し、何も始めない", async () => {
    const cases: [string, Partial<TaskSpec>, string][] = [
      // branch が根ではなく自分の id
      ["self-branch", { branch: "agent/task-cont-bad-0" }, "invalid_spec: branch"],
      // branch が根と別の agent/task-*
      ["other-branch", { branch: "agent/task-someone" }, "invalid_spec: branch"],
      ["main", { branch: "main" }, "invalid_spec: branch"],
      // root が自分の id（branch もそれに合わせる）
      [
        "root-self",
        {
          branch: "agent/task-cont-bad-3",
          continuation: { of: "prev01", root: "cont-bad-3" },
        },
        "invalid_spec: branch",
      ],
      // root / of の形が不正
      [
        "root-shape",
        { branch: "agent/task-a/b", continuation: { of: "prev01", root: "a/b" } },
        "invalid_spec: branch",
      ],
      [
        "root-empty",
        { branch: "agent/task-", continuation: { of: "prev01", root: "" } },
        "invalid_spec: branch",
      ],
      ["of-shape", { continuation: { of: "../x", root: ROOT } }, "invalid_spec: branch"],
      // 積み足しは空コミットを持たない
      ["initial", { initialSha: "1".repeat(40) }, "invalid_spec: initialSha"],
      // continuation の形が不正
      // biome-ignore lint/suspicious/noExplicitAny: 不正な入力を渡す
      ["null", { continuation: null as any }, "invalid_spec: continuation"],
      // task_review とは併用しない
      [
        "kind",
        {
          kind: "review",
          branch: "",
          review: {
            pullNumber: 1,
            headSha: HEAD0,
            baseSha: HEAD0,
            model: "anthropic/claude-sonnet-5-5",
            commands: [],
            title: "t",
            body: "b",
            diff: "",
            diffTruncated: false,
          },
        },
        "invalid_spec: continuation",
      ],
    ];
    for (const [i, [label, over, reason]] of cases.entries()) {
      const name = `cont-bad-${i}`;
      const fx = newFixture(name, [report()]);
      const res = await fx.stub.start(contSpec(name, over));
      expect(res, label).toEqual({ status: "rejected", reason });
      expect(fx.sandbox.readySpecs, label).toHaveLength(0);
      expect(fx.sandbox.credentials, label).toHaveLength(0);
    }
  });
});

describe("完了時の push（積み足し）: lease は initialSha / 最後に push できた SHA", () => {
  it("lease の期待値は initialSha（ls-remote の値ではない）。initialSha が祖先であることを確かめてから push する", async () => {
    const fx = newFixture("cont-sync-ok", [report()]);
    fx.remote.sha = HEAD0;
    await fx.stub.start(contSpec("cont-sync-ok"));
    expect(await waitForTerminal(fx)).toBe("completed");
    expect(fx.mergeBaseCalls).toEqual([["git", "merge-base", "--is-ancestor", HEAD0, "c0ffee"]]);
    expect(fx.pushCalls).toHaveLength(1);
    const push = stripGitIsolation(fx.pushCalls[0] ?? []);
    expect(push).toEqual([
      "git",
      "push",
      `--force-with-lease=${REF}:${HEAD0}`,
      "https://github.com/octo/repo.git",
      `c0ffee:${REF}`,
    ]);
    const permitted = fx.sandbox.calls.find((c) => c.options.pushPermit !== undefined);
    expect(permitted?.options.pushPermit).toEqual({ ref: REF, newSha: "c0ffee" });
    expect(fx.remote.sha).toBe("c0ffee");
    const r = done(await fx.stub.getResult());
    expect(r).toMatchObject({ status: "completed", pushedSha: "c0ffee" });
    expect(r.warnings.filter((w) => /push/i.test(w))).toEqual([]);
  });

  it("リモートが動いていたら（人や他の push）push せず branch_moved_externally。再試行しない。上書きしない", async () => {
    const fx = newFixture("cont-sync-moved", [report()]);
    fx.remote.sha = D;
    await fx.stub.start(contSpec("cont-sync-moved"));
    expect(await waitForTerminal(fx)).toBe("completed");
    expect(fx.pushCalls).toHaveLength(0);
    expect(fx.remote.sha).toBe(D);
    // 再試行しない: 読み取りの ls-remote は 1 回だけ
    expect(lsRemoteCalls(fx)).toHaveLength(1);
    const events = await allEvents(asFx(fx.stub));
    const failed = events.filter((e) => e.type === "push_failed" && e.data.final === true);
    expect(failed).toHaveLength(1);
    expect(String(failed[0]?.data.message)).toMatch(/^branch_moved_externally:/);
    const r = done(await fx.stub.getResult());
    expect(r.status).toBe("completed");
    expect("pushedSha" in r ? r.pushedSha : undefined).toBeUndefined();
    expect(r.warnings.some((w) => /push_failed/.test(w))).toBe(true);
  });

  it("リモートのブランチが消えていても branch_moved_externally（作り直さない）", async () => {
    const fx = newFixture("cont-sync-gone", [report()]);
    fx.remote.sha = undefined;
    await fx.stub.start(contSpec("cont-sync-gone"));
    expect(await waitForTerminal(fx)).toBe("completed");
    expect(fx.pushCalls).toHaveLength(0);
    const events = await allEvents(asFx(fx.stub));
    const failed = events.find((e) => e.type === "push_failed" && e.data.final === true);
    expect(String(failed?.data.message)).toMatch(/^branch_moved_externally:/);
  });

  it("initialSha が送る SHA の祖先でなければ（履歴の書き換え）push せず history_rewritten。再試行しない", async () => {
    const fx = newFixture("cont-sync-rewrite", [report()]);
    fx.remote.sha = HEAD0;
    fx.mergeBaseResults.push({ exitCode: 1 });
    await fx.stub.start(contSpec("cont-sync-rewrite"));
    expect(await waitForTerminal(fx)).toBe("completed");
    expect(fx.pushCalls).toHaveLength(0);
    expect(fx.mergeBaseCalls).toHaveLength(1);
    expect(fx.remote.sha).toBe(HEAD0);
    const events = await allEvents(asFx(fx.stub));
    const failed = events.filter((e) => e.type === "push_failed" && e.data.final === true);
    expect(failed).toHaveLength(1);
    expect(String(failed[0]?.data.message)).toMatch(/^history_rewritten:/);
    const r = done(await fx.stub.getResult());
    expect("pushedSha" in r ? r.pushedSha : undefined).toBeUndefined();
    expect(r.warnings.some((w) => /push_failed/.test(w))).toBe(true);
  });

  it("祖先の判定そのものが失敗（exit 128 など）したら再試行し、判定できれば push する", async () => {
    const fx = newFixture("cont-sync-mb-retry", [report()]);
    fx.remote.sha = HEAD0;
    fx.mergeBaseResults.push({ exitCode: 128, stderr: "fatal: bad object" });
    await fx.stub.start(contSpec("cont-sync-mb-retry"));
    expect(await waitForTerminal(fx)).toBe("completed");
    expect(fx.mergeBaseCalls).toHaveLength(2);
    expect(fx.pushCalls).toHaveLength(1);
    expect(done(await fx.stub.getResult())).toMatchObject({ pushedSha: "c0ffee" });
  });

  it("リモートがすでに送る SHA なら（前の試行が通っていた）push せずに成功として扱う", async () => {
    const fx = newFixture("cont-sync-already", [report()]);
    fx.remote.sha = "c0ffee";
    await fx.stub.start(contSpec("cont-sync-already"));
    expect(await waitForTerminal(fx)).toBe("completed");
    expect(fx.pushCalls).toHaveLength(0);
    const r = done(await fx.stub.getResult());
    expect(r).toMatchObject({ status: "completed", pushedSha: "c0ffee" });
    expect(r.warnings.filter((w) => /push/i.test(w))).toEqual([]);
    const events = await allEvents(asFx(fx.stub));
    expect(events.some((e) => e.type === "pushed" && e.data.final === true)).toBe(true);
  });

  it("push の失敗のあとの再試行で、リモートが動いていたら branch_moved_externally で止まる（上書きしない）", async () => {
    const fx = newFixture("cont-sync-retry-moved", [report()]);
    fx.remote.sha = HEAD0;
    fx.pushResults.push({ exitCode: 1, stderr: "rejected: stale info" });
    // 1 回目の読み取りは HEAD0、2 回目（再試行）は他の push で D に動いている
    fx.lsRemoteResults.push({ stdout: `${HEAD0}\t${REF}\n` }, { stdout: `${D}\t${REF}\n` });
    await fx.stub.start(contSpec("cont-sync-retry-moved"));
    expect(await waitForTerminal(fx)).toBe("completed");
    expect(fx.pushCalls).toHaveLength(1);
    const events = await allEvents(asFx(fx.stub));
    const failed = events.find((e) => e.type === "push_failed" && e.data.final === true);
    expect(String(failed?.data.message)).toMatch(/^branch_moved_externally:/);
  });

  it("チェックポイントの push が通ったあとは、lastPushedSha（最後に push できた SHA）が lease の期待値", async () => {
    const P = "e".repeat(40);
    const fx = newFixture("cont-sync-checkpoint", [call("gate"), report()]);
    await fx.stub.start(contSpec("cont-sync-checkpoint"));
    await fx.gate.waitEntered();
    // git_commit の push が P で通った（onCheckpointPush が branch_sync に残す値）
    await runInDO(fx.stub, (inst) => inst.store.setMeta("branch_sync", { pushedSha: P }));
    fx.remote.sha = P;
    fx.gate.release();
    expect(await waitForTerminal(fx)).toBe("completed");
    expect(fx.mergeBaseCalls).toEqual([["git", "merge-base", "--is-ancestor", HEAD0, "c0ffee"]]);
    expect(fx.pushCalls).toHaveLength(1);
    expect(fx.pushCalls[0]).toContain(`--force-with-lease=${REF}:${P}`);
    expect(done(await fx.stub.getResult())).toMatchObject({ pushedSha: "c0ffee" });
  });

  it("チェックポイントの push のあとにリモートが initialSha に戻されていても（他の操作）上書きしない", async () => {
    const P = "e".repeat(40);
    const fx = newFixture("cont-sync-reset", [call("gate"), report()]);
    await fx.stub.start(contSpec("cont-sync-reset"));
    await fx.gate.waitEntered();
    await runInDO(fx.stub, (inst) => inst.store.setMeta("branch_sync", { pushedSha: P }));
    fx.remote.sha = HEAD0;
    fx.gate.release();
    expect(await waitForTerminal(fx)).toBe("completed");
    expect(fx.pushCalls).toHaveLength(0);
    expect(fx.remote.sha).toBe(HEAD0);
  });

  it("検証のあと、作業ブランチを戻す switch は spec.branch（根のブランチ）に対して行う", async () => {
    const fx = newFixture("cont-switch", [report()]);
    fx.remote.sha = HEAD0;
    await fx.stub.start(contSpec("cont-switch"));
    expect(await waitForTerminal(fx)).toBe("completed");
    const switches = fx.sandbox.calls
      .map((c) => stripGitIsolation(c.argv))
      .filter((a) => a[0] === "git" && a.includes("switch"));
    expect(switches.length).toBeGreaterThan(0);
    expect(switches.every((a) => a.includes(`agent/task-${ROOT}`))).toBe(true);
    expect(switches.some((a) => a.includes("agent/task-cont-switch"))).toBe(false);
  });

  it("continuation の無いタスクは今のまま（祖先の判定をせず、ls-remote の値を lease にする）", async () => {
    const fx = newFixture("cont-legacy", [report()]);
    fx.remote.sha = D;
    await fx.stub.start(makeSpec("cont-legacy"));
    expect(await waitForTerminal(fx)).toBe("completed");
    expect(fx.mergeBaseCalls).toHaveLength(0);
    expect(fx.pushCalls).toHaveLength(1);
    expect(fx.pushCalls[0]).toContain(`--force-with-lease=refs/heads/agent/task-cont-legacy:${D}`);
    expect(done(await fx.stub.getResult())).toMatchObject({ pushedSha: "c0ffee" });
  });
});

describe("ワーカーへのプロンプト（積み足し）", () => {
  it("role の節は spec.branch（根のブランチ）を書き、前のタスクの commit を書き換えないよう注意する", async () => {
    const fx = newFixture("cont-prompt", [call("gate")]);
    await fx.stub.start(contSpec("cont-prompt"));
    const role = await runInDO(fx.stub, (inst) =>
      inst.promptSections().find((s: { key: string }) => s.key === "role"),
    );
    expect(role.text).toContain(`on branch agent/task-${ROOT}.`);
    expect(role.text).not.toContain("agent/task-cont-prompt");
    expect(role.text).toContain(
      "The branch already has the commits of earlier tasks of the same pull request; the branch tip is the starting point. Do not rewrite or drop earlier commits (no rebase, reset, amend of existing commits)",
    );
    expect(role.text).not.toContain("an empty commit on top of");
    fx.gate.release();
    await waitForTerminal(fx);
  });

  it("continuation の無いタスクの role の節は今のまま", async () => {
    const fx = newFixture("cont-prompt-legacy", [call("gate")]);
    await fx.stub.start(makeSpec("cont-prompt-legacy"));
    const role = await runInDO(fx.stub, (inst) =>
      inst.promptSections().find((s: { key: string }) => s.key === "role"),
    );
    expect(role.text).toBe(
      "You are an autonomous coding agent. Your workspace is /workspace, a git checkout of octo/repo, on branch agent/task-cont-prompt-legacy. The branch tip is the starting point (an empty commit on top of base000). Complete the task given in the user message.",
    );
    fx.gate.release();
    await waitForTerminal(fx);
  });

  it("worker_review のレビューの文も spec.branch（根のブランチ）を書く", async () => {
    const fx = newFixture("cont-review-header", [call("gate")]);
    await fx.stub.start(contSpec("cont-review-header"));
    const header = await runInDO(fx.stub, (inst) =>
      inst.workerReviewHeader(inst.spec(), { headSha: "c0ffee" }),
    );
    expect(header).toContain(`work branch agent/task-${ROOT},`);
    expect(header).not.toContain("agent/task-cont-review-header");
    fx.gate.release();
    await waitForTerminal(fx);
  });
});
