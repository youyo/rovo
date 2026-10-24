import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { clearAgentTestOverrides, setAgentTestOverrides } from "../../src/agent/deps";
import { FakeSandbox } from "../support/fake-sandbox";
import {
  allEvents,
  boot,
  call,
  done,
  type Fixture,
  makeSpec,
  newFixture,
  report,
  T0,
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

const EXP = T0 + 60 * 60 * 1000;
const cred = (token: string, expiresAt: number) => ({ token, expiresAt });

describe("start: 契約の検証", () => {
  it("branch が agent/task-<taskId> と違う、initialSha が SHA でない、gitCredential が無い・不正なら拒否し、何も始めない", async () => {
    const bads = [
      { branch: "agent/task-other" },
      { branch: "main" },
      { initialSha: "xyz" },
      { initialSha: "" },
      { gitCredential: undefined },
      { gitCredential: cred("", EXP) },
      { gitCredential: cred("a b", EXP) },
      { gitCredential: { token: "ok", expiresAt: Number.NaN } },
    ];
    for (const [i, over] of bads.entries()) {
      const name = `bad-contract-${i}`;
      const fx = newFixture(name, [report()]);
      // biome-ignore lint/suspicious/noExplicitAny: 不正な入力を渡す
      const res = await fx.stub.start(makeSpec(name, over as any));
      expect(res, JSON.stringify(over)).toMatchObject({ status: "rejected" });
      expect(fx.sandbox.readySpecs).toHaveLength(0);
      expect(fx.sandbox.credentials).toHaveLength(0);
    }
  });

  it("WorkspaceSpec に branch と initialSha を渡し、ensureReady の前にトークンを預ける", async () => {
    const fx = newFixture("order-1", [report()]);
    await fx.stub.start(makeSpec("order-1", { gitCredential: cred("ghs_first", EXP) }));
    await waitForTerminal(fx);
    expect(fx.sandbox.order.slice(0, 2)).toEqual(["credential", "ready"]);
    expect(fx.sandbox.credentials[0]).toEqual(cred("ghs_first", EXP));
    expect(fx.sandbox.readySpecs[0]).toMatchObject({
      branch: "agent/task-order-1",
      initialSha: "1".repeat(40),
    });
  });

  it("トークンを AgentDO の storage に残さない（spec・fingerprint・イベントのいずれにも）", async () => {
    const fx = newFixture("no-token-at-rest", [report()]);
    await fx.stub.start(
      makeSpec("no-token-at-rest", { gitCredential: cred("ghs_must_not_persist", EXP) }),
    );
    await waitForTerminal(fx);
    const dump = await runInDO(fx.stub, (inst) => {
      const sql = inst.ctx.storage.sql;
      const rows = [
        ...sql.exec("SELECT value FROM agent_meta").toArray(),
        ...sql.exec("SELECT data FROM agent_events").toArray(),
      ];
      return JSON.stringify(rows) + JSON.stringify([...inst.ctx.storage.kv.list()]);
    });
    expect(dump).not.toContain("ghs_must_not_persist");
  });

  it("トークンを更新した start の再送は conflict にならない（受理済み）。新しい期限のものだけ預け直す", async () => {
    const fx = newFixture("restart-token", [call("gate")]);
    const spec = makeSpec("restart-token", { gitCredential: cred("t1", EXP) });
    expect(await fx.stub.start(spec)).toMatchObject({ status: "accepted", alreadyAccepted: false });
    const refreshed = await fx.stub.start({ ...spec, gitCredential: cred("t2", EXP + 1000) });
    expect(refreshed).toMatchObject({ status: "accepted", alreadyAccepted: true });
    const stale = await fx.stub.start({ ...spec, gitCredential: cred("t0", EXP - 1000) });
    expect(stale).toMatchObject({ status: "accepted", alreadyAccepted: true });
    expect(fx.sandbox.credentials.map((c) => c.token)).toEqual(["t1", "t2"]);
    // 中身が違う spec は従来どおり conflict
    expect(await fx.stub.start({ ...spec, instructions: "別" })).toEqual({ status: "conflict" });
    fx.gate.release();
    await waitForTerminal(fx);
  });

  it("預けるのに失敗したら start は失敗し（TaskDO が再送する）、再送で受理される", async () => {
    const fx = newFixture("cred-fail", [report()]);
    fx.sandbox.credentialError = new Error("sandbox down");
    // DO の中で呼ぶ（RPC 越しに例外を投げると、workerd が呼び出され側の例外を Uncaught として報告し、
    // vitest が unhandled rejection でテスト実行全体を失敗にする）
    await expect(
      runInDurableObject(fx.stub, (inst: { start(spec: unknown): Promise<unknown> }) =>
        inst.start(makeSpec("cred-fail")),
      ),
    ).rejects.toThrow(/sandbox down/);
    expect(fx.sandbox.readySpecs).toHaveLength(0);
    fx.sandbox.credentialError = undefined;
    expect(await fx.stub.start(makeSpec("cred-fail"))).toMatchObject({ status: "accepted" });
    await waitForTerminal(fx);
    expect(fx.sandbox.credentials).toHaveLength(1);
  });
});

describe("setGitCredential（RPC）", () => {
  it("start 前は ok:false（預け先がまだ無い）", async () => {
    const fx = newFixture("sgc-prestart", []);
    expect(await fx.stub.setGitCredential(cred("t", EXP))).toEqual({ ok: false });
    expect(fx.sandbox.credentials).toHaveLength(0);
  });

  it("新しい expiresAt のものだけ SandboxDO に預ける。同じ・古いものは ok:true で何もしない（冪等）", async () => {
    const fx = newFixture("sgc-idem", [call("gate")]);
    await fx.stub.start(makeSpec("sgc-idem", { gitCredential: cred("t1", EXP) }));
    expect(await fx.stub.setGitCredential(cred("t2", EXP + 10))).toEqual({ ok: true });
    expect(await fx.stub.setGitCredential(cred("t2", EXP + 10))).toEqual({ ok: true });
    expect(await fx.stub.setGitCredential(cred("t1", EXP))).toEqual({ ok: true });
    expect(await fx.stub.setGitCredential(cred("older", EXP - 5))).toEqual({ ok: true });
    expect(fx.sandbox.credentials.map((c) => c.token)).toEqual(["t1", "t2"]);
    fx.gate.release();
    await waitForTerminal(fx);
  });

  it("預けるのに失敗したら ok:false で、期限は進めない（再送で預けられる）", async () => {
    const fx = newFixture("sgc-fail", [call("gate")]);
    await fx.stub.start(makeSpec("sgc-fail", { gitCredential: cred("t1", EXP) }));
    fx.sandbox.credentialError = new Error("down");
    expect(await fx.stub.setGitCredential(cred("t2", EXP + 10))).toEqual({ ok: false });
    fx.sandbox.credentialError = undefined;
    expect(await fx.stub.setGitCredential(cred("t2", EXP + 10))).toEqual({ ok: true });
    expect(fx.sandbox.credentials.map((c) => c.token)).toEqual(["t1", "t2"]);
    fx.gate.release();
    await waitForTerminal(fx);
  });

  it("不正な値は ok:false。預けない", async () => {
    const fx = newFixture("sgc-invalid", [call("gate")]);
    await fx.stub.start(makeSpec("sgc-invalid"));
    for (const bad of [
      cred("", EXP + 1),
      cred("a b", EXP + 1),
      { token: "t", expiresAt: Number.NaN },
      null,
    ]) {
      // biome-ignore lint/suspicious/noExplicitAny: 不正な入力を渡す
      expect(await fx.stub.setGitCredential(bad as any)).toEqual({ ok: false });
    }
    expect(fx.sandbox.credentials).toHaveLength(1);
    fx.gate.release();
    await waitForTerminal(fx);
  });

  it("終端（完了・キャンセル）後は ok:false。預けない", async () => {
    const fx = newFixture("sgc-terminal", [report()]);
    await fx.stub.start(makeSpec("sgc-terminal"));
    await waitForTerminal(fx);
    expect(await fx.stub.setGitCredential(cred("late", EXP + 99))).toEqual({ ok: false });
    expect(fx.sandbox.credentials.map((c) => c.token)).toEqual(["ghs_unit_token"]);

    const c = newFixture("sgc-cancelled", [call("gate")], { cancelWaitMs: 200 });
    await c.stub.start(makeSpec("sgc-cancelled"));
    await c.gate.waitEntered();
    await c.stub.cancel();
    expect(await c.stub.setGitCredential(cred("late", EXP + 99))).toEqual({ ok: false });
    c.gate.release();
    await waitForPhase(c, "cancelled");
  });

  it("cancel 済みで start 前（tombstone）でも ok:false", async () => {
    const fx = newFixture("sgc-tombstone", []);
    await fx.stub.cancel();
    expect(await fx.stub.setGitCredential(cred("late", EXP))).toEqual({ ok: false });
    expect(fx.sandbox.credentials).toHaveLength(0);
  });
});

describe("完了時の作業ブランチの同期（検証済みの SHA に揃える）", () => {
  const REF = (n: string) => `refs/heads/agent/task-${n}`;
  const D = "d".repeat(40);

  it("ls-remote → force-with-lease で push → ls-remote で一致を確認してから completed。pushedSha が入る", async () => {
    const fx = newFixture("sync-ok", [report()], { pushRetryDelayMs: 0 });
    fx.remote.sha = D; // モデルが履歴を書き換えて、リモートの先頭が別の commit になっている
    await fx.stub.start(makeSpec("sync-ok"));
    expect(await waitForTerminal(fx)).toBe("completed");
    const git = fx.sandbox.calls
      .map((c) => c.argv)
      .filter(
        (a) =>
          a[0] === "git" && (a[1] === "push" || (a[1] === "ls-remote" && !a.includes("--heads"))),
      );
    expect(git).toEqual([
      ["git", "ls-remote", "origin", REF("sync-ok")],
      [
        "git",
        "push",
        `--force-with-lease=${REF("sync-ok")}:${D}`,
        "origin",
        `c0ffee:${REF("sync-ok")}`,
      ],
      ["git", "ls-remote", "origin", REF("sync-ok")],
    ]);
    expect(fx.remote.sha).toBe("c0ffee");
    const r = done(await fx.stub.getResult());
    expect(r.status).toBe("completed");
    expect("pushedSha" in r && r.pushedSha).toBe("c0ffee");
    expect(r.warnings.filter((w) => /push/i.test(w))).toEqual([]);
    const events = await allEvents(asFx(fx.stub));
    const pushed = events.find((e) => e.type === "pushed" && e.data.final === true);
    expect(pushed?.data).toMatchObject({ sha: "c0ffee" });
    // completed の phase イベントより前に同期が終わっている
    expect(events.findIndex((e) => e.type === "pushed")).toBeLessThan(
      events.findIndex((e) => e.type === "phase" && e.data.phase === "completed"),
    );
  });

  it("リモートにブランチが無ければ、lease の期待値は空（存在しないこと）", async () => {
    const fx = newFixture("sync-absent", [report()], { pushRetryDelayMs: 0 });
    fx.remote.sha = undefined;
    await fx.stub.start(makeSpec("sync-absent"));
    expect(await waitForTerminal(fx)).toBe("completed");
    expect(fx.pushCalls[0]).toContain(`--force-with-lease=${REF("sync-absent")}:`);
    expect(done(await fx.stub.getResult())).toMatchObject({ pushedSha: "c0ffee" });
  });

  it("検証コマンドが無い完了でも同期する", async () => {
    const fx = newFixture("sync-noverify", [boot(), report()], { pushRetryDelayMs: 0 });
    await fx.stub.start(makeSpec("sync-noverify", { verificationCommands: [] }));
    expect(await waitForTerminal(fx)).toBe("completed");
    expect(fx.pushCalls).toHaveLength(1);
    expect(done(await fx.stub.getResult())).toMatchObject({ pushedSha: "c0ffee" });
  });

  it("push が失敗したら再試行し、毎回 ls-remote で先頭を読み直す。成功すれば警告なし", async () => {
    const fx = newFixture("sync-retry", [report()], { pushRetryDelayMs: 0 });
    fx.remote.sha = D;
    fx.pushResults.push({ exitCode: 1, stderr: "stale info" }, { exitCode: 1, stderr: "network" });
    await fx.stub.start(makeSpec("sync-retry"));
    expect(await waitForTerminal(fx)).toBe("completed");
    expect(fx.pushCalls).toHaveLength(3);
    const lsRemotes = fx.sandbox.calls.filter(
      (c) => c.argv[1] === "ls-remote" && !c.argv.includes("--heads"),
    );
    expect(lsRemotes.length).toBeGreaterThanOrEqual(4); // 試行ごとに読み直し + 最後の確認
    const r = done(await fx.stub.getResult());
    expect(r).toMatchObject({ status: "completed", pushedSha: "c0ffee" });
    expect(r.warnings.filter((w) => /push/i.test(w))).toEqual([]);
  });

  it("3 回失敗しても completed。警告（push_failed）を付け、pushedSha は付けない", async () => {
    const fx = newFixture("sync-fail", [report()], { pushRetryDelayMs: 0 });
    fx.remote.sha = D;
    fx.pushResults.push(
      { exitCode: 1, stderr: "denied 1" },
      { exitCode: 1, stderr: "denied 2" },
      { exitCode: 1, stderr: "denied 3" },
      { exitCode: 1, stderr: "denied 4" },
    );
    await fx.stub.start(makeSpec("sync-fail"));
    expect(await waitForTerminal(fx)).toBe("completed");
    expect(fx.pushCalls).toHaveLength(3);
    const r = done(await fx.stub.getResult());
    expect(r.status).toBe("completed");
    expect("pushedSha" in r ? r.pushedSha : undefined).toBeUndefined();
    expect(r.warnings.some((w) => /push_failed/.test(w))).toBe(true);
    const events = await allEvents(asFx(fx.stub));
    const failed = events.filter((e) => e.type === "push_failed" && e.data.final === true);
    expect(failed).toHaveLength(1);
    expect(String(failed[0]?.data.message)).toContain("denied 3");
  });

  it("push の失敗理由に資格情報が混ざっても、push_failed のイベントにも警告にも出さない", async () => {
    const fx = newFixture("sync-mask", [report()], { pushRetryDelayMs: 0 });
    fx.remote.sha = D;
    const secret = `ghs_${"A".repeat(36)}`;
    for (let i = 0; i < 4; i++) {
      fx.pushResults.push({
        exitCode: 1,
        stderr: `fatal: https://x-access-token:${secret}@github.com/o/r.git denied`,
      });
    }
    await fx.stub.start(makeSpec("sync-mask"));
    expect(await waitForTerminal(fx)).toBe("completed");
    const r = done(await fx.stub.getResult());
    const events = await allEvents(asFx(fx.stub));
    expect(JSON.stringify([r, events])).not.toContain(secret);
    expect(r.warnings.some((w) => /push_failed/.test(w))).toBe(true);
  });

  it("push が成功しても ls-remote で先頭が一致しなければ失敗として扱う（検証済みと言わない）", async () => {
    const fx = newFixture("sync-mismatch", [report()], { pushRetryDelayMs: 0 });
    const other = `${"e".repeat(40)}\t${REF("sync-mismatch")}\n`;
    // 各試行: 1 回目の ls-remote（読み取り）は本物、2 回目（確認）は一致しない
    for (let i = 0; i < 3; i++) {
      fx.lsRemoteResults.push({ stdout: `${D}\t${REF("sync-mismatch")}\n` }, { stdout: other });
    }
    await fx.stub.start(makeSpec("sync-mismatch"));
    expect(await waitForTerminal(fx)).toBe("completed");
    const r = done(await fx.stub.getResult());
    expect("pushedSha" in r ? r.pushedSha : undefined).toBeUndefined();
    expect(r.warnings.some((w) => /push_failed/.test(w))).toBe(true);
  });

  it("ls-remote が失敗したら push せずに再試行する", async () => {
    const fx = newFixture("sync-ls-fail", [report()], { pushRetryDelayMs: 0 });
    fx.lsRemoteResults.push({ exitCode: 128, stderr: "fatal: unable to access" });
    await fx.stub.start(makeSpec("sync-ls-fail"));
    expect(await waitForTerminal(fx)).toBe("completed");
    expect(fx.pushCalls).toHaveLength(1);
    expect(done(await fx.stub.getResult())).toMatchObject({ pushedSha: "c0ffee" });
  });

  it("ls-remote の出力が SHA でなければ（コンテナの出力は信用できない）lease に使わず失敗として扱う", async () => {
    const fx = newFixture("sync-garbage", [report()], { pushRetryDelayMs: 0 });
    for (let i = 0; i < 3; i++)
      fx.lsRemoteResults.push({ stdout: `--upload-pack=x\t${REF("sync-garbage")}\n` });
    await fx.stub.start(makeSpec("sync-garbage"));
    expect(await waitForTerminal(fx)).toBe("completed");
    expect(fx.pushCalls).toHaveLength(0);
    expect(done(await fx.stub.getResult()).warnings.some((w) => /push_failed/.test(w))).toBe(true);
  });

  it("検証に失敗した終端では、ブランチを揃える push はしない", async () => {
    const fx = newFixture("sync-vfail", [report(), report(), report(), report()], {
      pushRetryDelayMs: 0,
    });
    for (let i = 0; i < 4; i++) fx.verifyResults.push({ exitCode: 1, stdout: "FAIL" });
    await fx.stub.start(makeSpec("sync-vfail"));
    expect(await waitForTerminal(fx)).toBe("failed");
    expect(fx.pushCalls).toHaveLength(0);
    expect(fx.sandbox.calls.some((c) => c.argv[1] === "ls-remote")).toBe(false);
    const r = done(await fx.stub.getResult());
    expect("pushedSha" in r ? r.pushedSha : undefined).toBeUndefined();
  });

  it("キャンセルでは push しない", async () => {
    const fx = newFixture("sync-cancel", [call("gate")], {
      pushRetryDelayMs: 0,
      cancelWaitMs: 200,
    });
    await fx.stub.start(makeSpec("sync-cancel"));
    await fx.gate.waitEntered();
    await fx.stub.cancel();
    fx.gate.release();
    await waitForPhase(fx, "cancelled");
    expect(fx.pushCalls).toHaveLength(0);
  });

  it("キャンセルでは patch を取らない（予算・期限の停止と違い、結果に残さない）", async () => {
    const fx = newFixture("sync-cancel-patch", [call("gate")], {
      pushRetryDelayMs: 0,
      cancelWaitMs: 200,
    });
    await fx.stub.start(makeSpec("sync-cancel-patch"));
    await fx.gate.waitEntered();
    await fx.stub.cancel();
    fx.gate.release();
    await waitForPhase(fx, "cancelled");
    expect(fx.sandbox.calls.some((c) => c.argv[1] === "format-patch")).toBe(false);
    const r = done(await fx.stub.getResult());
    expect(r.patch).toBeUndefined();
    expect(r.diffstat).toBeUndefined();
  });
});

describe("git_commit のたびの push（本番のツール配線）", () => {
  const SHA = "c".repeat(40);
  function prodSandbox(push: () => { exitCode?: number; stderr?: string }, onPatch?: () => void) {
    const pushes: string[][] = [];
    const sandbox = new FakeSandbox((argv) => {
      const [a, b] = argv;
      if (a !== "git") return {};
      if (b === "diff" && argv.includes("--cached")) return { exitCode: 1 };
      if (b === "rev-parse") return { stdout: `${SHA}\n` };
      if (b === "status") return { stdout: "" };
      if (b === "push") {
        pushes.push(argv);
        return push();
      }
      if (b === "ls-remote") return { stdout: `${SHA}\t${argv[3]}\n` };
      if (b === "format-patch") {
        onPatch?.();
        return { stdout: "PATCH" };
      }
      return {};
    });
    return { sandbox, pushes };
  }

  it("commit が成功するたびに HEAD を作業ブランチへ push し、pushed イベントを出す", async () => {
    const { sandbox, pushes } = prodSandbox(() => ({}));
    setAgentTestOverrides("ck-push", {
      sandbox,
      script: [
        call("git_commit", { message: "one" }),
        call("git_commit", { message: "two" }),
        report("done"),
      ],
    });
    const stub = env.AGENT_DO.getByName("ck-push");
    await stub.start(
      makeSpec("ck-push", { verificationCommands: [], deadlineAt: Date.now() + 3_600_000 }),
    );
    expect(await waitForTerminal(asFx(stub))).toBe("completed");
    expect(pushes.slice(0, 2)).toEqual([
      ["git", "push", "origin", "HEAD:refs/heads/agent/task-ck-push"],
      ["git", "push", "origin", "HEAD:refs/heads/agent/task-ck-push"],
    ]);
    const events = await allEvents(asFx(stub));
    const pushed = events.filter((e) => e.type === "pushed" && e.data.final !== true);
    expect(pushed.map((e) => e.data.sha)).toEqual([SHA, SHA]);
  });

  it("push 済みで budget_exceeded になっても、pushedSha・停止理由つきの summary・patch を返す。patch は Sandbox を止める前に取る", async () => {
    let terminatedAtPatch: number | undefined;
    let sb: FakeSandbox | undefined;
    const made = prodSandbox(
      () => ({}),
      () => {
        terminatedAtPatch = sb?.terminateCount;
      },
    );
    sb = made.sandbox;
    setAgentTestOverrides("ck-budget", {
      sandbox: made.sandbox,
      // 1 回目の commit で予算をほぼ使い切る（実測の出力 999,999 トークン = 約 $1）。2 回目の前に止まる
      script: [{ ...call("git_commit", { message: "one" }), usage: { output: 999_999 } }, report()],
    });
    const stub = env.AGENT_DO.getByName("ck-budget");
    await stub.start(
      makeSpec("ck-budget", {
        verificationCommands: [],
        budgetUsd: 1.0,
        deadlineAt: Date.now() + 3_600_000,
      }),
    );
    expect(await waitForTerminal(asFx(stub))).toBe("budget_exceeded");
    const r = done(await stub.getResult());
    expect(r.pushedSha).toBe(SHA);
    expect(r.summary).toContain("budget_exceeded");
    expect(r.summary).toContain(SHA);
    expect(r.patch).toBe("PATCH");
    expect(terminatedAtPatch).toBe(0);
  });

  it("push が失敗しても git_commit は失敗にならず、タスクは続く。push_failed イベントが出る", async () => {
    const { sandbox } = prodSandbox(() => ({ exitCode: 1, stderr: "remote: Permission denied" }));
    setAgentTestOverrides("ck-push-fail", {
      sandbox,
      pushRetryDelayMs: 0,
      script: [call("git_commit", { message: "one" }), report("done")],
    });
    const stub = env.AGENT_DO.getByName("ck-push-fail");
    await stub.start(
      makeSpec("ck-push-fail", { verificationCommands: [], deadlineAt: Date.now() + 3_600_000 }),
    );
    expect(await waitForTerminal(asFx(stub))).toBe("completed");
    const events = await allEvents(asFx(stub));
    const end = events.find((e) => e.type === "tool_end" && e.data.name === "git_commit");
    expect(end?.data.isError).toBe(false);
    const failed = events.find((e) => e.type === "push_failed" && e.data.final !== true);
    expect(String(failed?.data.message)).toContain("Permission denied");
    expect(failed?.data.sha).toBe(SHA);
  });
});

describe("システムプロンプト", () => {
  it("no_push の節は「push は commit のたびに自動で行われる。手で push しない」", async () => {
    const fx = newFixture("prompt-push", [call("gate")]);
    await fx.stub.start(makeSpec("prompt-push"));
    const section = await runInDO(fx.stub, (inst) =>
      inst.promptSections().find((s: { key: string }) => s.key === "no_push"),
    );
    expect(section.text).toMatch(/pushed automatically|automatically/i);
    expect(section.text).toMatch(/do not (run )?git push|never run git push|do not push/i);
    expect(section.text).not.toMatch(
      /Credentials are not available\. Delivery happens through the committed patch only/,
    );
    fx.gate.release();
    await waitForTerminal(fx);
  });

  it("no_push の節は、bash の cd ではなく cwd 引数を使うよう指示する", async () => {
    const fx = newFixture("prompt-cwd", [call("gate")]);
    await fx.stub.start(makeSpec("prompt-cwd"));
    const section = await runInDO(fx.stub, (inst) =>
      inst.promptSections().find((s: { key: string }) => s.key === "no_push"),
    );
    expect(section.text).toContain(
      "Each bash call starts at the workspace root. Do not prefix commands with `cd <dir> &&`; pass the directory as the cwd argument instead.",
    );
    fx.gate.release();
    await waitForTerminal(fx);
  });

  it("no_push の節は「Draft PR は gateway が作る（子は作らない）」と書き、summary で「PR を作っていない」と誤解させない", async () => {
    const fx = newFixture("prompt-pr", [call("gate")]);
    await fx.stub.start(makeSpec("prompt-pr"));
    const section = await runInDO(fx.stub, (inst) =>
      inst.promptSections().find((s: { key: string }) => s.key === "no_push"),
    );
    // 子は PR を作らない。作るのは gateway で、Draft PR がすでにある（または後から作られる）
    expect(section.text).toMatch(/do not create pull requests/i);
    expect(section.text).toMatch(/gateway creates the draft pull request/i);
    expect(section.text).toMatch(/not your job|do not mention|do not say/i);
    fx.gate.release();
    await waitForTerminal(fx);
  });
});
