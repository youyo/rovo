import { describe, expect, it } from "vitest";
import { createToolContext } from "../../src/tools/context";

describe("createToolContext", () => {
  it("deadlineAt は読むたびに評価される（start 前にツールを作っても永続化後の値が見える）", () => {
    let deadline = Number.MAX_SAFE_INTEGER;
    const ctx = createToolContext("/workspace", () => deadline);
    expect(ctx.deadlineAt).toBe(Number.MAX_SAFE_INTEGER);
    deadline = 1234;
    expect(ctx.deadlineAt).toBe(1234);
    expect(ctx.workspaceRoot).toBe("/workspace");
    expect(ctx.commitAuthor.name).toBe("rovo-agent");
  });

  it("branch と onPush を渡せる", () => {
    const onPush = async () => {};
    const ctx = createToolContext("/workspace", () => 1, { branch: "agent/task-t", onPush });
    expect(ctx.branch).toBe("agent/task-t");
    expect(ctx.onPush).toBe(onPush);
  });
});
