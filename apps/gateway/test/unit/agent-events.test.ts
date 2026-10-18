import { describe, expect, it } from "vitest";
import { mapAgentEvent } from "../../src/agent/agent-events";

const payloadOf = (m: ReturnType<typeof mapAgentEvent>): Record<string, unknown> =>
  "payload" in m ? m.payload : {};
const ev = (type: string, data: unknown) => ({ seq: 1, ts: 1, type, data: JSON.stringify(data) });

describe("push のイベント", () => {
  it("pushed は sha と final を公開する", () => {
    expect(mapAgentEvent(ev("pushed", { sha: "a".repeat(40), final: true }))).toEqual({
      kind: "event",
      type: "pushed",
      payload: { sha: "a".repeat(40), final: true },
    });
    expect(mapAgentEvent(ev("pushed", { sha: "b".repeat(40) }))).toMatchObject({
      type: "pushed",
      payload: { sha: "b".repeat(40), final: false },
    });
  });

  it("push_failed は sha とメッセージ（切り詰め）を公開する", () => {
    const m = mapAgentEvent(ev("push_failed", { sha: "c".repeat(40), message: "x".repeat(900) }));
    expect(m).toMatchObject({ kind: "event", type: "push_failed" });
    const p = (m as { payload: Record<string, unknown> }).payload;
    expect(p.sha).toBe("c".repeat(40));
    expect(String(p.message).length).toBeLessThanOrEqual(501);
    expect(p.final).toBe(false);
  });

  it("壊れた data でも落ちない", () => {
    expect(mapAgentEvent({ seq: 1, ts: 1, type: "pushed", data: "not json" })).toMatchObject({
      type: "pushed",
      payload: { sha: null, final: false },
    });
  });
});

describe("Phase 4 の対話イベント", () => {
  it("phase input_required は INPUT_REQUIRED に写る", () => {
    expect(mapAgentEvent(ev("phase", { phase: "input_required" }))).toEqual({
      kind: "phase",
      status: "INPUT_REQUIRED",
    });
  });

  it("question は question_id・message・options（JSON 文字列のまま）を公開する", () => {
    const options = JSON.stringify(["a", "b"]);
    expect(mapAgentEvent(ev("question", { question_id: "q1", message: "hi", options }))).toEqual({
      kind: "question",
      payload: { question_id: "q1", message: "hi", options },
    });
  });

  it("question の本文は 4,000 文字まで。それより長い分は切り、10 個の options は欠けない", () => {
    const options = JSON.stringify(Array.from({ length: 10 }, (_, i) => `${i}${"x".repeat(499)}`));
    const m = mapAgentEvent(
      ev("question", { question_id: "q", message: "m".repeat(5_000), options }),
    );
    if (m.kind !== "question") throw new Error("not a question");
    expect(String(m.payload.message)).toHaveLength(4_000);
    expect(m.payload.options).toBe(options);
    const exact = mapAgentEvent(
      ev("question", { question_id: "q", message: "m".repeat(4_000), options }),
    );
    expect(payloadOf(exact).message).toHaveLength(4_000);
  });

  it("question の options が壊れている・配列でないときは空配列にする。question_id が無ければ空文字", () => {
    for (const options of ["not json", '{"a":1}', 5, null]) {
      const m = mapAgentEvent(ev("question", { question_id: "q", message: "m", options }));
      expect(payloadOf(m).options).toBe("[]");
    }
    const m = mapAgentEvent(ev("question", { message: "m" }));
    expect(payloadOf(m).question_id).toBe("");
  });

  it("answered / steer_accepted は ID だけを公開する", () => {
    expect(mapAgentEvent(ev("answered", { question_id: "q1", secret: "x" }))).toEqual({
      kind: "event",
      type: "answered",
      payload: { question_id: "q1" },
    });
    expect(mapAgentEvent(ev("steer_accepted", { steer_id: "s1", secret: "x" }))).toEqual({
      kind: "event",
      type: "steer_accepted",
      payload: { steer_id: "s1" },
    });
  });
});

describe("usage の web の回数（Phase 5）", () => {
  it("usage は web の回数を公開する（task_wait の usage イベント）", () => {
    const m = mapAgentEvent(
      ev("usage", {
        costUsd: 1.5,
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 1,
        cacheWriteTokens: 2,
        web: { search: 3, fetch: 4, browse: 1 },
      }),
    );
    expect(m).toEqual({
      kind: "usage",
      costMicroUsd: 1_500_000,
      payload: {
        cost_usd: 1.5,
        input_tokens: 10,
        output_tokens: 5,
        cache_read_tokens: 1,
        cache_write_tokens: 2,
        web_search: 3,
        web_fetch: 4,
        web_browse: 1,
      },
    });
  });

  it("web が無い・壊れている usage は 0 回として扱う", () => {
    for (const data of [
      { costUsd: 1 },
      { costUsd: 1, web: "x" },
      { costUsd: 1, web: { search: -1, fetch: "a" } },
    ]) {
      expect(payloadOf(mapAgentEvent(ev("usage", data)))).toMatchObject({
        web_search: 0,
        web_fetch: 0,
        web_browse: 0,
      });
    }
  });
});
