import { describe, expect, it } from "vitest";
import { AUDIT_EVENTS, audit } from "../src/index";

const run = (event: string, fields: Record<string, unknown>) => {
  const lines: string[] = [];
  const record = audit(event, fields, { now: 1, log: (l) => lines.push(l) });
  return { lines, record };
};

describe("archive_*（Phase 6 M4）", () => {
  it("閉じたイベント名の一覧に入っている", () => {
    expect(AUDIT_EVENTS).toEqual(
      expect.arrayContaining(["archive_skipped", "archive_failed", "archive_completed"]),
    );
  });

  it("archive_completed は、キーの接頭辞とサイズ（バイト数）だけを通す", () => {
    const { record } = run("archive_completed", {
      taskId: "01HXYZ",
      caller: "system",
      prefix: "tasks/2026/10/01HXYZ/",
      bytes: 1234,
      body: "leak",
      key: "tasks/2026/10/01HXYZ/events.jsonl",
    });
    expect(record).toMatchObject({
      event: "archive_completed",
      taskId: "01HXYZ",
      prefix: "tasks/2026/10/01HXYZ/",
      bytes: 1234,
    });
    expect(record).not.toHaveProperty("body");
    expect(record).not.toHaveProperty("key");
  });

  it("prefix は tasks/<yyyy>/<mm>/<task_id>/ の形だけ。bytes は非負の有限な整数だけ", () => {
    for (const prefix of [
      "tasks/2026/10/../x/",
      "https://x/tasks/2026/10/a/",
      "tasks/2026/10/a",
      "tasks/26/10/a/",
      "other/2026/10/a/",
      "tasks/2026/10/ghs_abc def/",
      42,
    ]) {
      expect(run("archive_completed", { prefix }).record).not.toHaveProperty("prefix");
    }
    for (const bytes of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "10", null]) {
      expect(run("archive_completed", { bytes }).record).not.toHaveProperty("bytes");
    }
    expect(run("archive_completed", { bytes: 0 }).record).toMatchObject({ bytes: 0 });
  });

  it("prefix と bytes は archive_completed 以外では出ない", () => {
    for (const event of ["archive_skipped", "archive_failed", "task_summary"]) {
      const { record } = run(event, { prefix: "tasks/2026/10/a/", bytes: 1 });
      expect(record).not.toHaveProperty("prefix");
      expect(record).not.toHaveProperty("bytes");
    }
  });

  it("archive_failed / archive_skipped は固定コードの reason を持てる", () => {
    expect(run("archive_failed", { taskId: "a", reason: "put_failed" }).record).toMatchObject({
      reason: "put_failed",
    });
    expect(run("archive_skipped", { taskId: "a", reason: "no_binding" }).record).toMatchObject({
      reason: "no_binding",
    });
  });
});
