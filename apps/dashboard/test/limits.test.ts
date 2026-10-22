import { LIMITS } from "@rovo/dashboard-contract";
import { describe, expect, it } from "vitest";
import { EVENTS_PER_PAGE } from "../src/use-task-detail";

// 画面は契約のランタイムを import しない規則なので、画面側は同じ値を別に持つ。ずれたらここで気づく。
describe("契約との一致", () => {
  it("EVENTS_PER_PAGE は契約の LIMITS.eventsPerPage と同じ", () => {
    expect(EVENTS_PER_PAGE).toBe(LIMITS.eventsPerPage);
  });
});
