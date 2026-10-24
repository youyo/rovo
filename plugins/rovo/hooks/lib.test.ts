import { expect, test } from "claude-code/testing";
import type { RovoTask } from "../types";
import {
  agoText,
  appendLines,
  bestWorker,
  budgetToastText,
  coerceLogs,
  coerceTasks,
  columnHeader,
  detailText,
  displayWidth,
  entryLines,
  formatElapsed,
  glyph,
  httpsOnly,
  isTerminal,
  MAX_LOG_LINES,
  matchTaskStart,
  moveTarget,
  orderTasks,
  paneColumns,
  parseConsole,
  parseLog,
  parseStartResult,
  parseStatus,
  planWorkers,
  pruneTasks,
  repoName,
  reviewHeader,
  shortModel,
  slideShift,
  splitCommand,
  statusColor,
  statusLabel,
  stripFence,
  TRACK_COL,
  tailLines,
  terminalCell,
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

test("statusLabel says 予算の承認待ち only for INPUT_REQUIRED with awaiting budget_extension", () => {
  expect(statusLabel("INPUT_REQUIRED")).toBe("入力待ち");
  expect(statusLabel("INPUT_REQUIRED", "budget_extension")).toBe("予算の承認待ち");
  expect(statusLabel("INPUT_REQUIRED", "other")).toBe("入力待ち");
  expect(statusLabel("RUNNING", "budget_extension")).toBe("実行中");
});

test("parseConsole keeps awaiting only for exactly budget_extension on INPUT_REQUIRED", () => {
  const aw = (status: string, v: unknown) =>
    parseConsole(JSON.stringify({ status, awaiting: v }))?.awaiting;
  expect(aw("INPUT_REQUIRED", "budget_extension")).toBe("budget_extension");
  expect(aw("INPUT_REQUIRED", "Budget_Extension")).toBeUndefined();
  expect(aw("INPUT_REQUIRED", "something_new")).toBeUndefined();
  expect(aw("INPUT_REQUIRED", 1)).toBeUndefined();
  expect(aw("RUNNING", "budget_extension")).toBeUndefined();
  expect(parseConsole(JSON.stringify({ status: "INPUT_REQUIRED" }))?.awaiting).toBeUndefined();
});

test("parseStatus reads pending_question.kind the same way", () => {
  const aw = (kind: unknown) =>
    parseStatus(JSON.stringify({ status: "INPUT_REQUIRED", pending_question: { kind } }))?.awaiting;
  expect(aw("budget_extension")).toBe("budget_extension");
  expect(aw("zzz")).toBeUndefined();
});

test("coerceTasks keeps awaiting only when it is budget_extension", () => {
  expect(coerceTasks([task(1, { awaiting: "budget_extension" })])[0]?.awaiting).toBe(
    "budget_extension",
  );
  expect(coerceTasks([{ ...task(1), awaiting: "x" }])[0]?.awaiting).toBeUndefined();
});

test("budgetToastText names the task and the next step", () => {
  const text = budgetToastText("T");
  expect(text).toContain("T");
  expect(text).toContain("予算の承認待ち");
  expect(text).toContain("task_answer");
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

test("splitCommand removes a leading cd and returns where", () => {
  const cases: [string, { command: string; where?: string }][] = [
    [
      "cd /workspace/apps/agent && npx vitest run",
      { command: "npx vitest run", where: "apps/agent" },
    ],
    ["cd apps/gateway && pnpm test", { command: "pnpm test", where: "apps/gateway" }],
    ["cd ./apps/gateway && pnpm test", { command: "pnpm test", where: "apps/gateway" }],
    ["cd /workspace && ls", { command: "ls" }],
    ["cd . && ls", { command: "ls" }],
    ["cd ../x && ls", { command: "cd ../x && ls" }],
    ["cd /workspace/../x && ls", { command: "cd /workspace/../x && ls" }],
    ["cd /tmp && ls", { command: "cd /tmp && ls" }],
    ["cd ~ && ls", { command: "cd ~ && ls" }],
    ['cd "$HOME" && ls', { command: 'cd "$HOME" && ls' }],
    ["cd $HOME && ls", { command: "cd $HOME && ls" }],
    ["cd - && ls", { command: "cd - && ls" }],
    ['cd "apps/agent" && ls', { command: 'cd "apps/agent" && ls' }],
    ["ls", { command: "ls" }],
  ];
  for (const [input, want] of cases) expect(splitCommand(input)).toEqual(want);
});

test("parseConsole splits the cd prefix of command and now.text", () => {
  const parsed = parseConsole(
    JSON.stringify({
      status: "RUNNING",
      now: { text: "$ cd apps/agent && pnpm test" },
      output: { command: "cd /workspace/apps/gateway && ls", tail: "", running: true },
    }),
  );
  expect(parsed?.command).toBe("ls");
  expect(parsed?.commandWhere).toBe("apps/gateway");
  expect(parsed?.nowText).toBe("$ pnpm test");
  expect(parsed?.nowWhere).toBe("apps/agent");
  const plain = parseConsole(
    JSON.stringify({ status: "RUNNING", now: { text: "editing a.ts" }, output: null }),
  );
  expect(plain?.nowText).toBe("editing a.ts");
  expect(plain?.nowWhere).toBeUndefined();
});

// --- model / repo short names ---------------------------------------------------

test("shortModel drops the provider and claude-, and turns a trailing -N-N into -N.N", () => {
  expect(shortModel("anthropic/claude-sonnet-5-5")).toBe("sonnet-5.5");
  expect(shortModel("anthropic/claude-haiku-5-5")).toBe("haiku-5.5");
  expect(shortModel("openai/gpt-6-sol")).toBe("gpt-6-sol");
  expect(shortModel("claude-opus-4-7")).toBe("opus-4.7");
  expect(shortModel("sonnet")).toBe("sonnet");
  expect(shortModel("workers-ai/@cf/openai/gpt-oss-120b")).toBe("gpt-oss-120b");
  expect(shortModel("anthropic/claude-sonnet-4-20250514")).toBe("sonnet-4-20250514");
  expect(shortModel("")).toBe("");
});

test("repoName keeps only the name after owner/", () => {
  expect(repoName("youyo/rovo")).toBe("rovo");
  expect(repoName("rovo")).toBe("rovo");
  expect(repoName(undefined)).toBe("");
});

// --- log entries -> lines -------------------------------------------------------

const at = "2026-01-01T00:00:00Z";
const fence = (s: string) =>
  `<<<UNTRUSTED_CHILD_QUESTION id=x>>>\n${s}\n<<<END_UNTRUSTED_CHILD_QUESTION>>>`;

test("a command entry is a $ line, its output tail, and an exit line when it failed", () => {
  const lines = entryLines({
    seq: 1,
    at,
    type: "command",
    command: fence("cd /workspace/apps/x && pnpm test"),
    exit_code: 1,
    output_tail: fence("ok 1\nnot ok 2"),
  });
  expect(lines).toEqual([
    { kind: "cmd", text: "$ pnpm test", where: "apps/x" },
    { kind: "out", text: "ok 1" },
    { kind: "out", text: "not ok 2" },
    { kind: "error", text: "✕ exit 1" },
  ]);
});

test("a successful command with no output is only the $ line", () => {
  expect(entryLines({ seq: 1, at, type: "command", command: fence("ls"), exit_code: 0 })).toEqual([
    { kind: "cmd", text: "$ ls" },
  ]);
  expect(entryLines({ seq: 1, at, type: "command", command: "ls", exit_code: null })).toEqual([
    { kind: "cmd", text: "$ ls" },
  ]);
});

test("edit, commit, web, status and PR entries are one line each", () => {
  expect(
    entryLines({
      seq: 2,
      at,
      type: "edit",
      path: fence("apps/x.ts"),
      op: "modify",
      added: 12,
      removed: 4,
    }),
  ).toEqual([{ kind: "edit", text: "✎ edit apps/x.ts (+12 -4)" }]);
  expect(
    entryLines({ seq: 2, at, type: "edit", path: "a.ts", op: "create", added: 3, removed: 0 }),
  ).toEqual([{ kind: "edit", text: "✎ create a.ts (+3 -0)" }]);
  expect(
    entryLines({ seq: 3, at, type: "commit", message: fence("fix: it"), sha: "abc1234", files: 2 }),
  ).toEqual([{ kind: "commit", text: "⎇ commit fix: it" }]);
  expect(entryLines({ seq: 4, at, type: "web", kind: "search", host: "example.com" })).toEqual([
    { kind: "web", text: "🔍 search example.com" },
  ]);
  expect(entryLines({ seq: 4, at, type: "web", kind: "fetch", host: "example.com" })).toEqual([
    { kind: "web", text: "🌐 fetch example.com" },
  ]);
  expect(
    entryLines({ seq: 5, at, type: "status_changed", from: "RUNNING", to: "VERIFYING" }),
  ).toEqual([{ kind: "status", text: "· 実行中 → 検証中" }]);
  expect(
    entryLines({
      seq: 6,
      at,
      type: "draft_pr_created",
      pr_number: 7,
      pr_url: "https://github.com/o/r/pull/7",
    }),
  ).toEqual([{ kind: "pr", text: "⎇ Draft PR #7" }]);
});

test("tool_start for tools that have their own entry is skipped; others are dim lines; only failed tool_end shows", () => {
  expect(
    entryLines({ seq: 1, at, type: "tool_start", call_id: "c", name: "bash", summary: "ls" }),
  ).toEqual([]);
  expect(
    entryLines({
      seq: 1,
      at,
      type: "tool_start",
      call_id: "c",
      name: "edit_file",
      summary: "a.ts",
    }),
  ).toEqual([]);
  expect(
    entryLines({
      seq: 1,
      at,
      type: "tool_start",
      call_id: "c",
      name: "read_file",
      summary: fence("a.ts"),
    }),
  ).toEqual([{ kind: "tool", text: "· read_file a.ts" }]);
  expect(
    entryLines({ seq: 2, at, type: "tool_end", call_id: "c", is_error: false, summary: "ok" }),
  ).toEqual([]);
  expect(
    entryLines({ seq: 2, at, type: "tool_end", call_id: "c", is_error: true, summary: "boom" }),
  ).toEqual([{ kind: "error", text: "✕ boom" }]);
});

test("entryLines ignores unknown or malformed entries and strips control characters from worker text", () => {
  expect(entryLines({ seq: 1, at, type: "usage", cost_usd: 1 })).toEqual([]);
  expect(entryLines({ seq: 1, at, type: "agent_event", agent_type: "x" })).toEqual([]);
  expect(entryLines(null)).toEqual([]);
  expect(entryLines("x")).toEqual([]);
  expect(entryLines({ type: "edit" })).toEqual([]);
  expect(entryLines({ type: "commit", message: 5 })).toEqual([]);
  expect(entryLines({ type: "web", kind: "search" })).toEqual([{ kind: "web", text: "🔍 search" }]);
  const [line] = entryLines({ type: "commit", message: "a\u001b[31mred\u001b[0m\nb" });
  expect(line?.text).toBe("⎇ commit ared b");
});

test("parseLog needs entries and a next_cursor; bad entries are dropped", () => {
  const page = parseLog({
    entries: [
      { seq: 1, at, type: "commit", message: "m", sha: "abc1234", files: 1 },
      { type: "nope" },
    ],
    next_cursor: "5",
    truncated: true,
  });
  expect(page).toEqual({
    lines: [{ kind: "commit", text: "⎇ commit m" }],
    nextCursor: "5",
    truncated: true,
  });
  expect(parseLog(undefined)).toBeNull();
  expect(parseLog({ entries: "x", next_cursor: "1" })).toBeNull();
  expect(parseLog({ entries: [] })).toBeNull();
  expect(parseLog({ entries: [], next_cursor: 5 })).toBeNull();
  expect(parseLog({ entries: [], next_cursor: "9" })).toEqual({
    lines: [],
    nextCursor: "9",
    truncated: false,
  });
});

test("parseConsole carries the log page and keeps working without one", () => {
  const base = { status: "RUNNING" };
  expect(parseConsole(JSON.stringify(base))?.log).toBeUndefined();
  const withLog = parseConsole(
    JSON.stringify({
      ...base,
      log: { entries: [{ type: "commit", message: "m" }], next_cursor: "1", truncated: false },
    }),
  );
  expect(withLog?.log?.nextCursor).toBe("1");
  expect(withLog?.log?.lines).toHaveLength(1);
  expect(parseConsole(JSON.stringify({ ...base, log: "x" }))?.log).toBeUndefined();
});

// --- the line buffer ------------------------------------------------------------

test("appendLines adds at the end and drops the oldest lines past the limit", () => {
  const mk = (n: number) => ({ kind: "out" as const, text: `l${n}` });
  const a = appendLines([mk(1), mk(2)], [mk(3)]);
  expect(a).toEqual({ lines: [mk(1), mk(2), mk(3)], dropped: 0 });
  const big = Array.from({ length: MAX_LOG_LINES }, (_, i) => mk(i));
  const b = appendLines(big, [mk(1000), mk(1001)]);
  expect(b.lines).toHaveLength(MAX_LOG_LINES);
  expect(b.dropped).toBe(2);
  expect(b.lines[0]).toEqual(mk(2));
  expect(b.lines.at(-1)).toEqual(mk(1001));
  expect(appendLines(big, []).dropped).toBe(0);
  expect(MAX_LOG_LINES).toBe(500);
});

test("coerceLogs rebuilds only well-formed stored logs", () => {
  const good = {
    cursor: "7",
    lines: [
      { kind: "cmd", text: "$ ls", where: "a" },
      { kind: "out", text: "x" },
    ],
  };
  const out = coerceLogs({
    "s/t1": good,
    "s/t2": { cursor: 5, lines: [] },
    "s/t3": { cursor: "1", lines: [{ kind: "weird", text: "x" }, { kind: "out", text: 3 }, null] },
    "s/t4": "x",
  });
  expect(out["s/t1"]).toEqual(good);
  expect(out["s/t2"]).toBeUndefined();
  expect(out["s/t3"]).toEqual({ cursor: "1", lines: [] });
  expect(out["s/t4"]).toBeUndefined();
  expect(coerceLogs(null)).toEqual({});
});

// --- 0.6.0: information design --------------------------------------------------

const fin = (n: number, over: Partial<RovoTask> = {}) =>
  task(n, { status: "COMPLETED", terminalAt: 1000 * n, ...over });

test("orderTasks: waiting first, then running (newest start first), then ended (newest end first)", () => {
  const list = [
    task(1, { startedAt: 10 }),
    task(2, { startedAt: 20 }),
    task(3, { startedAt: 5, status: "INPUT_REQUIRED" }),
    task(4, { startedAt: 7, waiting: true }),
    fin(5, { terminalAt: 100 }),
    fin(6, { terminalAt: 300 }),
    task(7, { status: "FAILED", terminalAt: 200 }),
  ];
  expect(orderTasks(list).map((t) => t.taskId)).toEqual(["t4", "t3", "t2", "t1", "t6", "t7", "t5"]);
});

test("bestWorker prefers waiting, then the newest running, then the newest", () => {
  expect(
    bestWorker([
      task(1, { startedAt: 1 }),
      task(2, { startedAt: 2 }),
      task(3, { startedAt: 0, status: "INPUT_REQUIRED" }),
    ])?.taskId,
  ).toBe("t3");
  expect(bestWorker([task(1, { startedAt: 1 }), task(2, { startedAt: 2 })])?.taskId).toBe("t2");
  expect(bestWorker([fin(1, { startedAt: 1 }), fin(2, { startedAt: 9 })])?.taskId).toBe("t2");
  expect(bestWorker([])).toBeUndefined();
});

test("moveTarget keeps a running or waiting worker, and moves off an ended or missing one", () => {
  const list = [task(1, { startedAt: 1 }), task(2, { startedAt: 2 }), fin(3, { startedAt: 0 })];
  expect(moveTarget(list, "s/t1")).toBe("s/t1"); // being watched while running: not taken away
  expect(moveTarget([...list, task(4, { status: "INPUT_REQUIRED" })], "s/t1")).toBe("s/t1");
  expect(moveTarget(list, "s/t3")).toBe("s/t2"); // ended: moves to the newest running
  expect(moveTarget([...list, task(4, { status: "INPUT_REQUIRED" })], "s/t3")).toBe("s/t4");
  expect(moveTarget(list, "s/gone")).toBe("s/t2");
  expect(moveTarget(list, null)).toBe("s/t2");
  expect(moveTarget([], null)).toBeNull();
});

test("agoText counts whole minutes since the end", () => {
  expect(agoText(0)).toBe("たった今");
  expect(agoText(59_000)).toBe("たった今");
  expect(agoText(60_000)).toBe("1分前");
  expect(agoText(31 * 60_000 + 5_000)).toBe("31分前");
  expect(agoText(60 * 60_000)).toBe("1時間前");
  expect(agoText(-5)).toBe("たった今");
});

test("paneColumns gives the title the rest, and drops the model column when narrow", () => {
  const w = paneColumns(74);
  expect(w).toEqual({ title: 33, model: 10, elapsed: 9 });
  expect(2 + w.title + 1 + TRACK_COL + w.model + 1 + w.elapsed).toBe(74);
  const n = paneColumns(44);
  expect(n.model).toBe(0);
  expect(n.title).toBeGreaterThanOrEqual(1);
  expect(paneColumns(10).title).toBeGreaterThanOrEqual(1);
});

test("columnHeader puts the station names once, over the track, and uses タイトル / モデル / 経過", () => {
  const w = paneColumns(74);
  const h = columnHeader(w, "task");
  expect(h).toContain("タイトル");
  expect(h).toContain("準備 実行 検証 PR");
  expect(h).toContain("モデル");
  expect(h.endsWith("経過")).toBe(true);
  expect(h).not.toContain("題名");
  expect(displayWidth(h.slice(0, h.indexOf("準備")))).toBe(2 + w.title + 1);
  expect(displayWidth(h)).toBe(74);
});

test("reviewHeader labels the review group and its own stations, nothing else", () => {
  const w = paneColumns(74);
  const h = reviewHeader(w);
  expect(h).toContain("レビュー");
  expect(h).toContain("取出 調査 投稿");
  expect(h).not.toContain("モデル");
  expect(displayWidth(h.slice(0, h.indexOf("取出")))).toBe(2 + w.title + 1);
});

test("terminalCell: PR number, 完了 without a PR, 失敗 and friends, with colors", () => {
  expect(terminalCell(fin(1, { pr: { number: 83, url: "https://x/pull/83" } }))).toEqual({
    text: "PR #83",
    color: "success",
  });
  expect(terminalCell(fin(1))).toEqual({ text: "完了", color: "success" });
  expect(terminalCell(fin(1), { number: null, url: "https://x/pull/1" })).toEqual({
    text: "PR",
    color: "success",
  });
  expect(terminalCell(task(1, { status: "FAILED" }))).toEqual({ text: "失敗", color: "error" });
  expect(terminalCell(task(1, { status: "CANCELLED" }))).toEqual({
    text: "取り消し",
    color: "inactive",
  });
  expect(terminalCell(task(1, { status: "BUDGET_EXCEEDED" }))).toEqual({
    text: "予算超過",
    color: "inactive",
  });
});

test("detailText: the question note when waiting, [n/m] before the doing while verifying", () => {
  expect(detailText(task(1, { status: "INPUT_REQUIRED" }), "$ ls")).toEqual({
    text: "? 質問に答えてください（会話で task_answer）",
    color: "warning",
  });
  expect(
    detailText(task(1, { status: "INPUT_REQUIRED", awaiting: "budget_extension" }), null).text,
  ).toContain("予算");
  expect(
    detailText(task(1, { stage: "verify", verifyAttempt: 2, verifyMax: 4 }), "$ pnpm test"),
  ).toEqual({
    text: "[2/4] $ pnpm test",
  });
  expect(detailText(task(1), "$ ls")).toEqual({ text: "$ ls" });
  expect(detailText(task(1), null)).toEqual({ text: "" });
});

const mkMany = (active: number, ended: number, extra: Partial<RovoTask> = {}) =>
  orderTasks([
    ...Array.from({ length: active }, (_, i) => task(100 + i, { startedAt: 1000 + i, ...extra })),
    ...Array.from({ length: ended }, (_, i) => fin(200 + i, { terminalAt: 5000 + i, ...extra })),
  ]);

test("planWorkers caps at 4 working and 5 ended, and notes the rest", () => {
  const p = planWorkers(mkMany(6, 8), null, 60);
  expect(p.shown.filter((t) => !t.status.startsWith("COMPLETED")).length).toBe(4);
  expect(p.shown.filter((t) => t.status === "COMPLETED").length).toBe(5);
  expect(p.hidden).toBe(5);
  expect(p.hiddenAllTerminal).toBe(false);
  const q = planWorkers(mkMany(2, 8), null, 60);
  expect(q.hidden).toBe(3);
  expect(q.hiddenAllTerminal).toBe(true);
  expect(q.rows).toBe(2 * 2 + 5 + 1);
});

test("planWorkers always keeps the shown worker, even past the caps", () => {
  const all = mkMany(6, 8);
  const sel = all.find((t) => t.taskId === "t105");
  const p = planWorkers(all, `s/${sel?.taskId}`, 60);
  expect(p.shown).toContain(sel);
  const ended = all.find((t) => t.taskId === "t207");
  expect(planWorkers(all, "s/t207", 60).shown).toContain(ended);
});

test("planWorkers drops ended rows first, then working ones, to leave 6 rows for the output", () => {
  const all = mkMany(4, 5);
  // budget = bodyRows - 11; 4 working (8) + 5 ended (5) = 13
  expect(planWorkers(all, null, 24).rows).toBe(13);
  const tight = planWorkers(all, null, 22); // budget 11
  expect(tight.rows).toBeLessThanOrEqual(11);
  expect(tight.shown.filter((t) => t.status === "COMPLETED").length).toBeLessThan(5);
  expect(tight.shown.filter((t) => t.status !== "COMPLETED").length).toBe(4); // working rows stay while ended rows can go
  const tiny = planWorkers(all, "s/t101", 12); // budget 1: still the shown one
  expect(tiny.shown.map((t) => t.taskId)).toEqual(["t101"]);
  expect(planWorkers(all, null, 12).shown.length).toBeLessThanOrEqual(1);
  expect(planWorkers([], null, 30)).toEqual({
    shown: [],
    hidden: 0,
    hiddenAllTerminal: false,
    rows: 0,
  });
});

test("planWorkers counts the review header as a row when a review worker is shown", () => {
  const r = planWorkers(mkMany(1, 0, { kind: "review" }), null, 30);
  expect(r.rows).toBe(2 + 1);
});
