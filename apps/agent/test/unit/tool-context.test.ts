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
  });

  it("作者は gateway が spec で渡した値（呼び出し時に評価）。無ければ GitHub のアカウントに結び付かない代わりの作者", () => {
    let author: { name: string; email: string } | undefined;
    const ctx = createToolContext("/workspace", () => 1, { commitAuthor: () => author });
    expect(ctx.commitAuthor).toEqual({ name: "rovo", email: "rovo@noreply.invalid" });
    author = { name: "acme-rovo[bot]", email: "12345+acme-rovo[bot]@users.noreply.github.com" };
    expect(ctx.commitAuthor).toEqual(author);
    expect(createToolContext("/workspace", () => 1).commitAuthor.email).toBe(
      "rovo@noreply.invalid",
    );
  });

  it("branch と onPush を渡せる", () => {
    const onPush = async () => {};
    const ctx = createToolContext("/workspace", () => 1, { branch: "agent/task-t", onPush });
    expect(ctx.branch).toBe("agent/task-t");
    expect(ctx.onPush).toBe(onPush);
  });
});
