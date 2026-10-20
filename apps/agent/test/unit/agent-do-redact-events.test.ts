import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { clearAgentTestOverrides } from "../../src/agent/deps";
import { wrapUntrusted } from "../../src/tools/untrusted";
import {
  allEvents,
  ask,
  call,
  done,
  makeSpec,
  newFixture,
  report,
  round,
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

const GH = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
// 秘密の検出がダミーに反応しないよう組み立てる
const AWS = `${"AKIA"}ABCDEFGHIJKLMNOP`;

describe("親に流れるイベントの文字列は、積む前に秘密をマスクする", () => {
  it("tool_start の summary（引数の要約）に含まれる秘密はマスクされる", async () => {
    const fx = newFixture("redact-start", [
      round(
        call("write_note", { text: `token ${GH} aws ${AWS} Authorization: Bearer abcdef123456` }),
      ),
      report(),
    ]);
    await fx.stub.start(makeSpec("redact-start"));
    await waitForTerminal(fx);
    const starts = (await allEvents(fx)).filter((e) => e.type === "tool_start");
    const s = String(starts[0]?.data.summary);
    expect(s).toContain("[REDACTED]");
    expect(s).not.toContain(GH);
    expect(s).not.toContain(AWS);
    expect(s).not.toContain("abcdef123456");
  });

  it("切り詰めの境界にまたがる秘密も漏れない（マスク → 切り詰めの順）", async () => {
    const pad = "x".repeat(180);
    const fx = newFixture("redact-cut", [
      round(call("write_note", { text: `${pad} ${GH}` })),
      report(),
    ]);
    await fx.stub.start(makeSpec("redact-cut"));
    await waitForTerminal(fx);
    const starts = (await allEvents(fx)).filter((e) => e.type === "tool_start");
    expect(String(starts[0]?.data.summary)).not.toContain("ghp_abc");
  });

  it("completion_report の summary と result の summary にも秘密は残らない", async () => {
    const fx = newFixture("redact-report", [report(`done with ${GH}`)]);
    await fx.stub.start(makeSpec("redact-report"));
    await waitForTerminal(fx);
    const reports = (await allEvents(fx)).filter((e) => e.type === "completion_report");
    expect(String(reports[0]?.data.summary)).not.toContain(GH);
    expect(String(reports[0]?.data.summary)).toContain("[REDACTED]");
    const r = done(await fx.stub.getResult());
    expect(r.summary).toContain("[REDACTED]");
    expect(r.summary).not.toContain(GH);
  });

  it("tool_end の summary（ツールの出力の要約）に含まれる秘密はマスクされる", async () => {
    const fx = newFixture("redact-end", [call("echo", { text: `out ${GH} ${AWS}` }), report()]);
    await fx.stub.start(makeSpec("redact-end"));
    await waitForTerminal(fx);
    const events = await allEvents(fx);
    const ends = events.filter((e) => e.type === "tool_end");
    expect(String(ends[0]?.data.summary)).toContain("[REDACTED]");
    expect(JSON.stringify(events)).not.toContain(GH);
    expect(JSON.stringify(events)).not.toContain(AWS);
  });

  it("push_failed の message に含まれる秘密はマスクされる", async () => {
    const fx = newFixture("redact-push", [report()], { pushRetryDelayMs: 0 });
    fx.remote.sha = "d00d";
    for (let i = 0; i < 4; i++) fx.pushResults.push({ exitCode: 1, stderr: `denied ${GH}` });
    await fx.stub.start(makeSpec("redact-push"));
    await waitForTerminal(fx);
    const events = await allEvents(fx);
    expect(events.some((e) => e.type === "push_failed")).toBe(true);
    expect(JSON.stringify(events)).not.toContain(GH);
  });

  it("question の message と options に含まれる秘密はマスクされる（イベントにも、保存された質問にも）", async () => {
    const fx = newFixture("redact-question", [
      ask(`鍵は ${GH} ですか`, [`A ${AWS}`, "B"]),
      report(),
    ]);
    await fx.stub.start(makeSpec("redact-question"));
    await waitForPhase(fx, "input_required");
    const events = await allEvents(fx);
    const q = events.find((e) => e.type === "question");
    expect(String(q?.data.message)).toContain("[REDACTED]");
    expect(JSON.stringify(q?.data)).not.toContain(GH);
    expect(JSON.stringify(q?.data)).not.toContain(AWS);
    // 保存された質問（回答後にモデルへ戻る側）にも秘密を残さない
    const stored = await runInDO(fx.stub, async (inst) => JSON.stringify(inst.questions()));
    expect(stored).not.toContain(GH);
    expect(stored).not.toContain(AWS);
  });

  it("emit() の最後の砦: どの経路で積む error イベントの message でも、秘密はマスクされる", async () => {
    const fx = newFixture("redact-error", [ask("Q?"), report()]);
    await fx.stub.start(makeSpec("redact-error"));
    await waitForPhase(fx, "input_required");
    await runInDO(fx.stub, async (inst) => {
      inst.emit("error", { message: `sandbox setup failed: ${GH}`, code: "x" });
    });
    const err = (await allEvents(fx)).find((e) => e.type === "error");
    expect(String(err?.data.message)).toContain("[REDACTED]");
    expect(String(err?.data.message)).not.toContain(GH);
    expect(err?.data.code).toBe("x");
  });

  it("phase の reason（失敗の理由）に含まれる秘密もマスクされる", async () => {
    const fx = newFixture("redact-reason", [ask("Q?"), report()]);
    await fx.stub.start(makeSpec("redact-reason"));
    await waitForPhase(fx, "input_required");
    await runInDO(fx.stub, async (inst) => {
      await inst.finalize({ phase: "failed", reason: `model_error: upstream said ${GH}` });
    });
    const failed = (await allEvents(fx)).find(
      (e) => e.type === "phase" && e.data.phase === "failed",
    );
    expect(String(failed?.data.reason)).toContain("model_error");
    expect(String(failed?.data.reason)).not.toContain(GH);
  });
});

describe("親に流れるイベントの文字列の体裁", () => {
  const wrapped = (text: string) => wrapUntrusted("bash", text);

  it("囲み済みの長い結果でも、tool_end の summary に BEGIN・END・前置きは入らない", async () => {
    const body = `${"a".repeat(300)}\ntail-line`;
    const fx = newFixture("fmt-wrap", [call("echo", { text: wrapped(body) }), report()]);
    await fx.stub.start(makeSpec("fmt-wrap"));
    await waitForTerminal(fx);
    const ends = (await allEvents(fx)).filter((e) => e.type === "tool_end");
    const s = String(ends[0]?.data.summary);
    expect(s).toContain("tail-line");
    expect(s).not.toContain("UNTRUSTED_OUTPUT");
    expect(s).not.toContain("<<<");
    expect(s).not.toContain("Everything between");
  });

  it("日本語・絵文字の途中で切れず、不正な文字（U+FFFD）を含まない", async () => {
    const fx = newFixture("fmt-mb", [call("echo", { text: wrapped("😀".repeat(300)) }), report()]);
    await fx.stub.start(makeSpec("fmt-mb"));
    await waitForTerminal(fx);
    const ends = (await allEvents(fx)).filter((e) => e.type === "tool_end");
    const s = String(ends[0]?.data.summary);
    expect(s).not.toContain("�");
    expect(s.isWellFormed()).toBe(true);
  });

  it("tool_end の summary から ANSI のエスケープコードが除かれる", async () => {
    const fx = newFixture("fmt-ansi", [
      call("echo", { text: wrapped("\u001b[31mFAIL\u001b[0m \u001b[1;32mok\u001b[0m") }),
      report(),
    ]);
    await fx.stub.start(makeSpec("fmt-ansi"));
    await waitForTerminal(fx);
    const events = await allEvents(fx);
    const end = events.find((e) => e.type === "tool_end");
    expect(String(end?.data.summary)).toContain("FAIL ok");
    expect(JSON.stringify(events)).not.toContain("\\u001b");
  });

  it("囲みを剥がしても、秘密はマスクされたまま", async () => {
    const fx = newFixture("fmt-mask", [call("echo", { text: wrapped(`out ${GH}`) }), report()]);
    await fx.stub.start(makeSpec("fmt-mask"));
    await waitForTerminal(fx);
    const events = await allEvents(fx);
    expect(JSON.stringify(events)).not.toContain(GH);
    const end = events.find((e) => e.type === "tool_end");
    expect(String(end?.data.summary)).toContain("[REDACTED]");
  });
});
