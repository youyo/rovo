import { describe, expect, it } from "vitest";
import { decideTerminal } from "../../src/agent/terminal";

describe("decideTerminal: cancel > deadline > budget_exceeded > failed > completed", () => {
  const completed = { phase: "completed" } as const;
  const failed = { phase: "failed", reason: "verification_failed" } as const;

  it("意図が無ければ要求のうち最も優先度の高いもの", () => {
    expect(decideTerminal([], [completed])).toEqual({ phase: "completed" });
    expect(decideTerminal([], [completed, failed])).toEqual(failed);
    expect(decideTerminal([], [failed, completed])).toEqual(failed);
  });

  it("意図は要求より優先し、cancel > deadline > budget_exceeded", () => {
    expect(decideTerminal(["budget_exceeded"], [completed])).toMatchObject({
      phase: "budget_exceeded",
    });
    expect(decideTerminal(["budget_exceeded"], [failed])).toMatchObject({
      phase: "budget_exceeded",
    });
    expect(decideTerminal(["deadline", "budget_exceeded"], [completed])).toEqual({
      phase: "failed",
      reason: "deadline",
    });
    expect(decideTerminal(["budget_exceeded", "deadline", "cancel"], [completed])).toMatchObject({
      phase: "cancelled",
    });
    expect(decideTerminal(["cancel"], [failed, completed])).toMatchObject({ phase: "cancelled" });
  });

  it("要求が無く意図だけでも決まる", () => {
    expect(decideTerminal(["deadline"], [])).toEqual({ phase: "failed", reason: "deadline" });
  });

  it("input_timeout は deadline の下、budget_exceeded / failed / completed の上", () => {
    expect(decideTerminal(["input_timeout"], [completed])).toEqual({
      phase: "failed",
      reason: "input_timeout",
    });
    expect(decideTerminal(["input_timeout"], [failed])).toEqual({
      phase: "failed",
      reason: "input_timeout",
    });
    expect(decideTerminal(["budget_exceeded", "input_timeout"], [completed])).toEqual({
      phase: "failed",
      reason: "input_timeout",
    });
    expect(decideTerminal(["input_timeout", "deadline"], [completed])).toEqual({
      phase: "failed",
      reason: "deadline",
    });
    expect(decideTerminal(["input_timeout", "cancel"], [completed])).toMatchObject({
      phase: "cancelled",
    });
  });

  it("budget_extension_timeout（予算の延長の質問に答えが無かった）は budget_exceeded で、reason は区別できる。優先順位は input_timeout の下、budget_exceeded の上", () => {
    const timeout = { phase: "budget_exceeded", reason: "budget_extension_timeout" } as const;
    expect(decideTerminal(["budget_extension_timeout"], [completed])).toEqual(timeout);
    expect(decideTerminal(["budget_extension_timeout"], [failed])).toEqual(timeout);
    expect(decideTerminal(["budget_exceeded", "budget_extension_timeout"], [completed])).toEqual(
      timeout,
    );
    expect(decideTerminal(["budget_extension_timeout", "input_timeout"], [completed])).toEqual({
      phase: "failed",
      reason: "input_timeout",
    });
    expect(decideTerminal(["budget_extension_timeout", "deadline"], [completed])).toEqual({
      phase: "failed",
      reason: "deadline",
    });
    expect(decideTerminal(["budget_extension_timeout", "cancel"], [completed])).toMatchObject({
      phase: "cancelled",
    });
  });
});
