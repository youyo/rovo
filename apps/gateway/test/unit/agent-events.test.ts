import { describe, expect, it } from "vitest";
import { mapAgentEvent } from "../../src/agent/agent-events";

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
