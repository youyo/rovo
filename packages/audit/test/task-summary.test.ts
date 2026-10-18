import { describe, expect, it } from "vitest";
import { AUDIT_EVENTS, audit, TASK_SUMMARY_METRICS } from "../src/index";

const run = (fields: Record<string, unknown>) => {
  const lines: string[] = [];
  const record = audit("task_summary", fields, { now: 1, log: (l) => lines.push(l) });
  return { lines, record };
};

describe("task_summary（Phase 6 M3）", () => {
  it("閉じたイベント名の一覧に入っている", () => {
    expect(AUDIT_EVENTS).toContain("task_summary");
  });

  it("metrics は、固定のキーの非負の有限数だけを通す。未知のキー・文字列・負数・NaN は落とす", () => {
    const { record } = run({
      taskId: "t1",
      kind: "completed",
      metrics: {
        duration_ms: 1500,
        sandbox_usd_estimate: 0.0123,
        title: 5,
        secret: 1,
        input_tokens: "10",
        output_tokens: -1,
        web_search: Number.NaN,
        web_fetch: Number.POSITIVE_INFINITY,
        web_browse: 2,
      },
    });
    expect(record).toMatchObject({
      event: "task_summary",
      kind: "completed",
      metrics: { duration_ms: 1500, sandbox_usd_estimate: 0.0123, web_browse: 2 },
    });
    expect(Object.keys((record as { metrics: object }).metrics).sort()).toEqual(
      ["duration_ms", "sandbox_usd_estimate", "web_browse"].sort(),
    );
  });

  it("metrics が配列・文字列・null・プロトタイプ経由のときは出さない", () => {
    for (const metrics of [[1, 2], "x", null, 5]) {
      expect(run({ metrics }).record).not.toHaveProperty("metrics");
    }
    const inherited = Object.create({ duration_ms: 1 });
    expect(run({ metrics: inherited }).record).not.toHaveProperty("metrics");
  });

  it("metrics は task_summary 以外のイベントでは出ない", () => {
    const lines: string[] = [];
    const r = audit(
      "task_cancelled",
      { taskId: "t1", metrics: { duration_ms: 1 } },
      { now: 1, log: (l) => lines.push(l) },
    );
    expect(r).not.toHaveProperty("metrics");
    expect(lines[0]).not.toContain("metrics");
  });

  it("許可するキーの一覧は固定で、title や自由な文のキーを含まない", () => {
    expect(TASK_SUMMARY_METRICS).toContain("duration_ms");
    for (const k of TASK_SUMMARY_METRICS) expect(k).toMatch(/^[a-z0-9_]+$/);
    expect(TASK_SUMMARY_METRICS).not.toContain("title" as never);
  });
});
