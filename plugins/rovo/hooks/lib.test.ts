import { expect, test } from "claude-code/testing";
import type { RovoTask } from "../types";
import {
  coerceTasks,
  formatElapsed,
  glyph,
  httpsOnly,
  isTerminal,
  matchTaskStart,
  parseConsole,
  parseStartResult,
  parseStatus,
  pruneTasks,
  slideShift,
  statusColor,
  statusLabel,
  stripFence,
  tailLines,
  toastText,
} from "./lib";

const task = (n: number, over: Partial<RovoTask> = {}): RovoTask => ({
  taskId: `t${n}`,
  title: `task ${n}`,
  server: "s",
  prefix: "",
  startedAt: 0,
  status: "RUNNING",
  ...over,
});

test("matchTaskStart reads server and prefix from both name shapes", () => {
  expect(matchTaskStart("mcp__rovo-direct__task_start")).toEqual({
    server: "rovo-direct",
    prefix: "",
  });
  expect(matchTaskStart("mcp__claude_ai_mcp_hubs_run__my-rovo_task_start")).toEqual({
    server: "claude_ai_mcp_hubs_run",
    prefix: "my-rovo_",
  });
  expect(matchTaskStart("mcp__rovo-direct__task_status")).toBeNull();
  expect(matchTaskStart("mcp__rovo-direct__task_start_extra")).toBeNull();
  expect(matchTaskStart("Bash")).toBeNull();
  expect(matchTaskStart("mcp__x__notask_start")).toBeNull();
});

test("parseStartResult takes task_id, status and an https dashboard_url only", () => {
  expect(
    parseStartResult(
      JSON.stringify({
        task_id: "abc",
        status: "RUNNING",
        dashboard_url: "https://d.example/t/abc",
      }),
    ),
  ).toEqual({ taskId: "abc", status: "RUNNING", dashboardUrl: "https://d.example/t/abc" });
  expect(
    parseStartResult(JSON.stringify({ task_id: "abc", dashboard_url: "javascript:alert(1)" }))
      ?.dashboardUrl,
  ).toBeUndefined();
  expect(parseStartResult("not json")).toBeNull();
  expect(parseStartResult(JSON.stringify({ nope: 1 }))).toBeNull();
});

test("stripFence removes the untrusted-child wrapper lines and control characters", () => {
  const wrapped =
    "<<<UNTRUSTED_CHILD_QUESTION id=abc>>>\nhello **world**\n<<<END_UNTRUSTED_CHILD_QUESTION>>>";
  expect(stripFence(wrapped)).toBe("hello **world**");
  expect(stripFence("<<<UNTRUSTED_CHILD_QUESTION\nx\n<<<END_UNTRUSTED_CHILD_QUESTION>>>")).toBe(
    "x",
  );
  expect(stripFence("plain")).toBe("plain");
  expect(stripFence("a\u001b[31mred\u001b[0m\u0007b")).toBe("ared" + "b");
  expect(stripFence("a\tb\nc")).toBe("a\tb\nc");
});

test("parseConsole strips fences from child strings and keeps the shape", () => {
  const wrap = (s: string) =>
    `<<<UNTRUSTED_CHILD_QUESTION n=1>>>\n${s}\n<<<END_UNTRUSTED_CHILD_QUESTION>>>`;
  const parsed = parseConsole(
    JSON.stringify({
      task_id: "t",
      status: "RUNNING",
      phase: "run",
      stopped_phase: null,
      now: { text: wrap("editing a.ts"), at: "2026-01-01T00:00:00Z" },
      output: { command: wrap("pnpm test"), tail: wrap("l1\nl2"), running: true, redacted: true },
      dashboard_url: "https://d.example/t",
      generated_at: "2026-01-01T00:00:00Z",
    }),
  );
  expect(parsed).toEqual({
    status: "RUNNING",
    phase: "run",
    stoppedPhase: null,
    nowText: "editing a.ts",
    command: "pnpm test",
    tail: "l1\nl2",
    isRunning: true,
    dashboardUrl: "https://d.example/t",
  });
  expect(
    parseConsole(JSON.stringify({ status: "DONE", phase: null, now: null, output: null }))?.nowText,
  ).toBeNull();
  expect(parseConsole("unknown tool")).toBeNull();
  expect(parseConsole(JSON.stringify({ error: "x" }))).toBeNull();
});

test("parseStatus reads status only", () => {
  expect(parseStatus(JSON.stringify({ task_id: "t", status: "COMPLETED" }))?.status).toBe(
    "COMPLETED",
  );
  expect(parseStatus("oops")).toBeNull();
});

test("tailLines keeps the last 30 lines and trims long lines", () => {
  const text = Array.from({ length: 100 }, (_, i) => `line${i}`).join("\n");
  const out = tailLines(text).split("\n");
  expect(out).toHaveLength(30);
  expect(out[0]).toBe("line70");
  expect(out.at(-1)).toBe("line99");
  expect(tailLines("x".repeat(1000)).length).toBeLessThan(400);
});

test("formatElapsed, isTerminal, glyph", () => {
  expect(formatElapsed(45_000)).toBe("45秒");
  expect(formatElapsed(192_000)).toBe("3分12秒");
  expect(formatElapsed(3_720_000)).toBe("1時間2分");
  expect(isTerminal("COMPLETED")).toBe(true);
  expect(isTerminal("FAILED")).toBe(true);
  expect(isTerminal("BUDGET_EXCEEDED")).toBe(true);
  expect(isTerminal("CANCELLED")).toBe(true);
  expect(isTerminal("RUNNING")).toBe(false);
  expect(isTerminal("INPUT_REQUIRED")).toBe(false);
  expect([
    glyph("RUNNING"),
    glyph("COMPLETED"),
    glyph("FAILED"),
    glyph("BUDGET_EXCEEDED"),
    glyph("CANCELLED"),
    glyph("INPUT_REQUIRED"),
  ]).toEqual(["●", "✓", "✕", "✕", "–", "?"]);
});

test("pruneTasks drops terminal tasks after one hour and caps at 10 newest", () => {
  const now = 10_000_000;
  const hour = 3_600_000;
  const list = [
    task(1, { status: "COMPLETED", terminalAt: now - hour }),
    task(2, { status: "COMPLETED", terminalAt: now - hour + 1 }),
    task(3),
  ];
  expect(pruneTasks(list, now).map((t) => t.taskId)).toEqual(["t2", "t3"]);
  const many = Array.from({ length: 13 }, (_, i) => task(i));
  expect(pruneTasks(many, now).map((t) => t.taskId)).toEqual(many.slice(3).map((t) => t.taskId));
});

test("httpsOnly", () => {
  expect(httpsOnly("https://a.example/x")).toBe("https://a.example/x");
  expect(httpsOnly("http://a.example")).toBeUndefined();
  expect(httpsOnly("javascript:alert(1)")).toBeUndefined();
  expect(httpsOnly(undefined)).toBeUndefined();
});

test("coerceTasks keeps consoleRetryAt", () => {
  expect(coerceTasks([task(1, { noConsole: true, consoleRetryAt: 5 })])[0]?.consoleRetryAt).toBe(5);
});

test("coerceTasks rebuilds tasks from the store and drops malformed ones", () => {
  const good = task(1, { dashboardUrl: "https://d.example/t1" });
  const out = coerceTasks([
    good,
    { taskId: 5 },
    null,
    "x",
    { ...good, taskId: "t2", dashboardUrl: "javascript:x", title: 7 },
  ]);
  expect(out.map((t) => t.taskId)).toEqual(["t1", "t2"]);
  expect(out[1]?.dashboardUrl).toBeUndefined();
  expect(out[1]?.title).toBe("t2");
  expect(coerceTasks("nope")).toEqual([]);
});

test("toastText has words per state", () => {
  expect(toastText("X", "COMPLETED")).toBe("X が完了");
  expect(toastText("X", "FAILED")).toBe("X が失敗");
});

test("slideShift counts how many lines the tail slid forward", () => {
  expect(slideShift(["a", "b", "c"], ["a", "b", "c"])).toBe(0);
  expect(slideShift(["a", "b", "c"], ["a", "b", "c", "d"])).toBe(0);
  expect(slideShift(["a", "b", "c"], ["b", "c", "d"])).toBe(1);
  expect(slideShift(["a", "b", "c"], ["c", "d", "e"])).toBe(2);
  // no overlap (or no tail before): unknown, so no shift
  expect(slideShift(["a", "b"], ["x", "y"])).toBe(0);
  expect(slideShift([], ["x"])).toBe(0);
});

test("statusLabel translates CREATING and VERIFYING", () => {
  expect(statusLabel("CREATING")).toBe("準備中");
  expect(statusLabel("VERIFYING")).toBe("検証中");
});

test("pr: parseConsole keeps only { number, https url }", () => {
  const pr = (v: unknown) => parseConsole(JSON.stringify({ status: "RUNNING", pr: v }))?.pr;
  expect(pr({ number: 3, url: "https://github.com/o/r/pull/3" })).toEqual({
    number: 3,
    url: "https://github.com/o/r/pull/3",
  });
  for (const bad of [
    null,
    "x",
    {},
    { number: 3 },
    { number: "3", url: "https://a/b" },
    { number: 3, url: "http://a/b" },
  ]) {
    expect(pr(bad)).toBeUndefined();
  }
});

test("pr: parseStatus reads draft_pr_url and the number from /pull/<n>", () => {
  const pr = (u: unknown) =>
    parseStatus(JSON.stringify({ status: "RUNNING", draft_pr_url: u }))?.pr;
  expect(pr("https://github.com/o/r/pull/12")).toEqual({
    number: 12,
    url: "https://github.com/o/r/pull/12",
  });
  expect(pr("https://example.com/x")).toEqual({ number: null, url: "https://example.com/x" });
  expect(pr("http://github.com/o/r/pull/12")).toBeUndefined();
  expect(pr(null)).toBeUndefined();
});

test("statusColor maps each state to a theme key", () => {
  expect(statusColor("RUNNING")).toBe("suggestion");
  expect(statusColor("CREATING")).toBe("suggestion");
  expect(statusColor("VERIFYING")).toBe("suggestion");
  expect(statusColor("COMPLETED")).toBe("success");
  expect(statusColor("FAILED")).toBe("error");
  expect(statusColor("INPUT_REQUIRED")).toBe("warning");
  expect(statusColor("CANCELLED")).toBe("inactive");
  expect(statusColor("BUDGET_EXCEEDED")).toBe("inactive");
  expect(statusColor("SOMETHING")).toBeUndefined();
});
