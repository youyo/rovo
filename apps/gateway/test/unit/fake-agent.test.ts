import { describe, expect, it } from "vitest";
import { fakeAgent, newTaskId } from "./helpers";

// AGENT_DO が台本付きの偽 AgentDO に差し替わっていることの確認（Unit の土台）
describe("偽の AgentDO（Unit の AGENT_DO）", () => {
  it("start を受理し、phase イベントを積み、同じ spec の再送は alreadyAccepted", async () => {
    const id = newTaskId();
    const agent = fakeAgent(id);
    const spec = {
      taskId: id,
      userId: "1",
      repository: "acme/widgets",
      baseSha: "abc1234",
      instructions: "x",
      budgetUsd: 10,
      deadlineAt: Date.now() + 1000,
    };
    const first = await agent.start(spec);
    expect(first).toMatchObject({ status: "accepted", alreadyAccepted: false });
    expect(await agent.start(spec)).toMatchObject({ status: "accepted", alreadyAccepted: true });
    const page = await agent.getEvents(0, 100);
    expect(page.events.map((e) => e.type)).toEqual(["phase", "phase"]);
    expect(page.phase).toBe("running");
  });
});
