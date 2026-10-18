import { describe, expect, it } from "vitest";
import { canTransition, isTerminal, TASK_STATUSES, type TaskStatus } from "../../src/tasks/state";

// 期待する遷移の許可リスト（実装とは独立に書く）。これ以外はすべて禁止。
const ALLOWED: ReadonlyArray<readonly [TaskStatus, TaskStatus]> = [
  // Phase 1 で公開する遷移
  ["CREATING", "CANCELLED"],
  ["RUNNING", "CANCELLED"],
  ["INPUT_REQUIRED", "CANCELLED"],
  ["VERIFYING", "CANCELLED"],
  ["RECOVERING", "CANCELLED"],
  // Phase 2 以降の遷移（表には定義するが Phase 1 の公開 API からは使わない）
  ["CREATING", "RUNNING"],
  ["CREATING", "FAILED"],
  ["CREATING", "BUDGET_EXCEEDED"],
  ["RUNNING", "INPUT_REQUIRED"],
  ["RUNNING", "VERIFYING"],
  ["RUNNING", "RECOVERING"],
  ["RUNNING", "COMPLETED"],
  ["RUNNING", "FAILED"],
  ["RUNNING", "BUDGET_EXCEEDED"],
  ["INPUT_REQUIRED", "RUNNING"],
  ["INPUT_REQUIRED", "RECOVERING"],
  ["INPUT_REQUIRED", "FAILED"],
  ["INPUT_REQUIRED", "BUDGET_EXCEEDED"],
  ["VERIFYING", "RUNNING"],
  ["VERIFYING", "INPUT_REQUIRED"],
  ["VERIFYING", "RECOVERING"],
  ["VERIFYING", "COMPLETED"],
  ["VERIFYING", "FAILED"],
  ["VERIFYING", "BUDGET_EXCEEDED"],
  ["RECOVERING", "RUNNING"],
  ["RECOVERING", "INPUT_REQUIRED"],
  ["RECOVERING", "VERIFYING"],
  ["RECOVERING", "FAILED"],
  ["RECOVERING", "BUDGET_EXCEEDED"],
];

const TERMINAL: TaskStatus[] = ["COMPLETED", "FAILED", "BUDGET_EXCEEDED", "CANCELLED"];

describe("canTransition", () => {
  it("9状態の全組み合わせ（81通り）が許可リストと一致する", () => {
    expect(TASK_STATUSES).toHaveLength(9);
    for (const from of TASK_STATUSES) {
      for (const to of TASK_STATUSES) {
        const expected = ALLOWED.some(([f, t]) => f === from && t === to);
        expect(canTransition(from, to), `${from} -> ${to}`).toBe(expected);
      }
    }
  });

  it("終端状態からはどこへも遷移できない（自分自身も含む）", () => {
    for (const from of TERMINAL) {
      for (const to of TASK_STATUSES) {
        expect(canTransition(from, to), `${from} -> ${to}`).toBe(false);
      }
    }
  });

  it("終端以外から CANCELLED へは遷移できる", () => {
    for (const from of TASK_STATUSES.filter((s) => !TERMINAL.includes(s))) {
      expect(canTransition(from, "CANCELLED")).toBe(true);
    }
  });

  it("自己遷移は許されない", () => {
    for (const s of TASK_STATUSES) expect(canTransition(s, s)).toBe(false);
  });
});

describe("isTerminal", () => {
  it("終端状態だけ true", () => {
    for (const s of TASK_STATUSES) expect(isTerminal(s)).toBe(TERMINAL.includes(s));
  });
});
