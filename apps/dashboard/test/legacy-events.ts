import { taskEventsFixture } from "@rovo/dashboard-contract/fixtures";

/** output_tail を持たない古い履歴（出力は手順の外の枠に出る） */
export const legacyTailEvents = {
  ...taskEventsFixture,
  events: taskEventsFixture.events.map((e) => {
    if (e.type !== "command") return e;
    const { output_tail: _omit, ...rest } = e;
    return rest;
  }),
};
