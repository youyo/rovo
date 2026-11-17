import { expect, test } from "claude-code/testing";
import type { RovoTask } from "../types";
import {
  coerceTasks,
  displayWidth,
  headingText,
  isWaiting,
  labelRow,
  laneCells,
  matchRovoTool,
  mergeListed,
  padWidth,
  parseTaskList,
  pruneTasks,
  rightText,
  stageIndex,
  truncateWidth,
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

const textOfCells = (cells: { text: string }[]): string => cells.map((c) => c.text).join("");

test("stageIndex maps task_list stages and the old console phases to a station", () => {
  expect(stageIndex("task", "setup")).toBe(0);
  expect(stageIndex("task", "work")).toBe(1);
  expect(stageIndex("task", "verify")).toBe(2);
  expect(stageIndex("task", "pr")).toBe(3);
  expect(stageIndex("task", "done")).toBe(4);
  expect(stageIndex("review", "fetch")).toBe(0);
  expect(stageIndex("review", "investigate")).toBe(1);
  expect(stageIndex("review", "post")).toBe(2);
  expect(stageIndex("review", "done")).toBe(3);
  // console の phase（task_list が無いサーバー）
  expect(stageIndex("task", "prepare")).toBe(0);
  expect(stageIndex("task", "run")).toBe(1);
  // 他の kind の stage、未知、null
  expect(stageIndex("review", "setup")).toBeNull();
  expect(stageIndex("task", "bogus")).toBeNull();
  expect(stageIndex("task", null)).toBeNull();
});

test("labelRow pads each station name to its column", () => {
  expect(labelRow("task")).toBe("準備 実行 検証 PR   ");
  expect(labelRow("review")).toBe("取出 調査 投稿 ");
});

test("laneCells: done stations are green dots joined by bars, the current one spins, the rest are open", () => {
  const cells = laneCells({ kind: "task", at: 1, state: "active", frame: 0, arrived: false });
  const text = textOfCells(cells);
  expect(text.startsWith("●━━━━")).toBe(true);
  expect(text).toContain("○");
  expect(cells[0]).toMatchObject({ text: "●", color: "success" });
  const spinner = cells.find((c) => "◐◓◑◒".includes(c.text) && c.text !== "");
  expect(spinner?.color).toBe("suggestion");
});

test("laneCells: the spinner and the ▶ light move one step per frame", () => {
  const at = (frame: number) =>
    textOfCells(laneCells({ kind: "task", at: 0, state: "active", frame, arrived: false }));
  const frames = Array.from({ length: 12 }, (_, f) => at(f));
  expect(at(0)).not.toBe(at(1));
  expect(at(1)).not.toBe(at(2));
  for (const t of frames) expect(t.match(/▶/g)?.length ?? 0).toBeLessThanOrEqual(1);
  expect(frames.some((t) => t.includes("▶"))).toBe(true);
  // 全フレームで同じ幅（描き直しで行が伸び縮みしない）
  expect(new Set(frames.map((t) => displayWidth(t))).size).toBe(1);
});

test("laneCells: just arrived shows a bright ◉ instead of the spinner", () => {
  const cells = laneCells({ kind: "task", at: 2, state: "active", frame: 3, arrived: true });
  const bright = cells.find((c) => c.text === "◉");
  expect(bright).toBeDefined();
  expect(bright?.color).toBe("text");
  expect(bright?.bold).toBe(true);
});

test("laneCells: waiting stops the flow and blinks ?", () => {
  const frames = Array.from({ length: 6 }, (_, f) =>
    textOfCells(laneCells({ kind: "task", at: 1, state: "waiting", frame: f, arrived: false })),
  );
  for (const t of frames) {
    expect(t).not.toContain("▶");
    expect(t).not.toMatch(/[◐◓◑◒]/);
  }
  expect(frames.some((t) => t.includes("?"))).toBe(true);
  expect(frames.some((t) => !t.includes("?"))).toBe(true);
  expect(new Set(frames.map((t) => displayWidth(t))).size).toBe(1);
  const marked = laneCells({ kind: "task", at: 1, state: "waiting", frame: 0, arrived: false });
  expect(marked.find((c) => c.text === "?")?.color).toBe("warning");
});

test("laneCells: done is all dots, failed marks the stopped station with ✕", () => {
  const done = textOfCells(
    laneCells({ kind: "task", at: 4, state: "done", frame: 0, arrived: false }),
  );
  expect(done).toBe("●━━━━●━━━━●━━━━●");
  const review = textOfCells(
    laneCells({ kind: "review", at: 3, state: "done", frame: 0, arrived: false }),
  );
  expect(review).toBe("●━━━━●━━━━●");
  const failed = laneCells({ kind: "task", at: 2, state: "failed", frame: 0, arrived: false });
  expect(textOfCells(failed)).toContain("✕");
  expect(failed.find((c) => c.text === "✕")?.color).toBe("error");
  expect(textOfCells(failed)).not.toContain("▶");
});

test("laneCells: an unknown stage is plain open stations", () => {
  const t = textOfCells(
    laneCells({ kind: "task", at: null, state: "active", frame: 0, arrived: false }),
  );
  expect(t).toBe("○┈┈┈┈○┈┈┈┈○┈┈┈┈○");
});

test("displayWidth counts wide characters as two columns; padWidth and truncateWidth follow it", () => {
  expect(displayWidth("abc")).toBe(3);
  expect(displayWidth("準備")).toBe(4);
  expect(padWidth("準備", 6)).toBe("準備  ");
  expect(padWidth("abcdef", 3)).toBe("abcdef");
  expect(truncateWidth("abcdef", 4)).toBe("abc…");
  expect(truncateWidth("日本語のタイトル", 7)).toBe("日本語…");
  expect(displayWidth(truncateWidth("日本語のタイトル", 7))).toBeLessThanOrEqual(7);
  expect(truncateWidth("abc", 4)).toBe("abc");
});

test("isWaiting is true for INPUT_REQUIRED, or the waiting flag while not terminal", () => {
  expect(isWaiting({ status: "INPUT_REQUIRED" })).toBe(true);
  expect(isWaiting({ status: "RUNNING", waiting: true })).toBe(true);
  expect(isWaiting({ status: "RUNNING" })).toBe(false);
  expect(isWaiting({ status: "COMPLETED", waiting: true })).toBe(false);
});

test("headingText gives parts: working, completed, and waiting first only when there is one; no cost", () => {
  const list = [
    task(1),
    task(2),
    task(3, { status: "INPUT_REQUIRED" }),
    task(4, { status: "COMPLETED" }),
    task(5, { status: "FAILED" }),
  ];
  expect(headingText(list)).toEqual([
    { label: "質問待ち", n: 1, tone: "warning" },
    { label: "作業中", n: 2, tone: "suggestion" },
    { label: "完了", n: 1, tone: "success" },
  ]);
  // 質問待ちが 0 のときは出さない（位置も取らない）。0 の項目は残す。
  expect(headingText([])).toEqual([
    { label: "作業中", n: 0, tone: "suggestion" },
    { label: "完了", n: 0, tone: "success" },
  ]);
  const flat = JSON.stringify(headingText(list));
  expect(flat).not.toMatch(/\$|USD|費用|·|rovo/);
});

test("rightText: tool and target while running, a result when done, a label when waiting", () => {
  expect(rightText(task(1), "$ pnpm test")).toEqual({ text: "$ pnpm test" });
  expect(rightText(task(1), null)).toEqual({ text: "" });
  expect(
    rightText(task(1, { status: "COMPLETED", pr: { number: 7, url: "https://x/pull/7" } }), null),
  ).toEqual({ text: "✓ PR #7", color: "success" });
  expect(rightText(task(1, { status: "COMPLETED", kind: "review" }), null)).toEqual({
    text: "✓ 完了",
    color: "success",
  });
  expect(rightText(task(1, { status: "FAILED" }), null)).toEqual({
    text: "✕ 失敗",
    color: "error",
  });
  expect(rightText(task(1, { status: "INPUT_REQUIRED" }), "ignored")).toEqual({
    text: "入力待ち",
    color: "warning",
  });
  expect(
    rightText(task(1, { status: "INPUT_REQUIRED", awaiting: "budget_extension" }), null).text,
  ).toBe("予算の承認待ち");
  expect(
    rightText(task(1, { stage: "verify", verifyAttempt: 2, verifyMax: 3 }), "$ pnpm test").text,
  ).toBe("[2/3] $ pnpm test");
  // 長い対象は切る
  expect(displayWidth(rightText(task(1), "x".repeat(200)).text)).toBeLessThanOrEqual(40);
});

// --- task_list ----------------------------------------------------------------

const listItem = (n: number, over: Record<string, unknown> = {}) => ({
  task_id: `L${n}`,
  kind: "task",
  title: `listed ${n}`,
  repository: "o/repo",
  status: "RUNNING",
  stage: "work",
  waiting_for_answer: false,
  model: "sonnet",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:01:00Z",
  ...over,
});

test("parseTaskList reads tasks and truncated; anything else is null", () => {
  const ok = parseTaskList(JSON.stringify({ tasks: [listItem(1)], truncated: true }));
  expect(ok?.truncated).toBe(true);
  expect(ok?.tasks).toHaveLength(1);
  expect(ok?.tasks[0]).toMatchObject({
    taskId: "L1",
    kind: "task",
    title: "listed 1",
    repository: "o/repo",
    status: "RUNNING",
    stage: "work",
    waiting: false,
    model: "sonnet",
    createdAt: Date.parse("2026-01-01T00:00:00Z"),
  });
  expect(parseTaskList("not json")).toBeNull();
  expect(parseTaskList(JSON.stringify({ task_id: "t1", status: "RUNNING" }))).toBeNull();
  expect(parseTaskList(JSON.stringify({ tasks: "x" }))).toBeNull();
  expect(parseTaskList(JSON.stringify({ tasks: [] }))?.tasks).toEqual([]);
});

test("parseTaskList drops bad rows, normalizes kind and stage, keeps only https links", () => {
  const out = parseTaskList(
    JSON.stringify({
      tasks: [
        listItem(1, { kind: "review", stage: "post", verify_attempt: 2, verify_max: 3 }),
        listItem(2, { kind: "bogus", stage: "bogus" }),
        listItem(3, { task_id: "" }),
        { title: "no id" },
        listItem(4, {
          pr: { number: 9, url: "https://github.com/o/r/pull/9" },
          dashboard_url: "http://insecure/x",
          ended_at: "2026-01-01T00:02:00Z",
          status: "COMPLETED",
        }),
        listItem(5, {
          pr: { number: 9, url: "javascript:alert(1)" },
          dashboard_url: "https://d/5",
        }),
      ],
    }),
  );
  const tasks = out?.tasks ?? [];
  expect(tasks.map((t) => t.taskId)).toEqual(["L1", "L2", "L4", "L5"]);
  expect(tasks[0]).toMatchObject({ kind: "review", stage: "post", verifyAttempt: 2, verifyMax: 3 });
  expect(tasks[1]?.kind).toBe("task");
  expect(tasks[1]?.stage).toBeUndefined();
  expect(tasks[2]?.pr).toEqual({ number: 9, url: "https://github.com/o/r/pull/9" });
  expect(tasks[2]?.dashboardUrl).toBeUndefined();
  expect(tasks[2]?.endedAt).toBe(Date.parse("2026-01-01T00:02:00Z"));
  expect(tasks[3]?.pr).toBeUndefined();
  expect(tasks[3]?.dashboardUrl).toBe("https://d/5");
});

test("parseTaskList strips fences and control characters from worker-written strings", () => {
  const out = parseTaskList(
    JSON.stringify({
      tasks: [
        listItem(1, {
          title:
            "<<<UNTRUSTED_CHILD_QUESTION id=x>>>\nhi\u001b[31m\n<<<END_UNTRUSTED_CHILD_QUESTION>>>",
          model: "m\u001b]0;x\u0007",
        }),
      ],
    }),
  );
  expect(out?.tasks[0]?.title).toBe("hi");
  expect(out?.tasks[0]?.model).toBe("m");
});

const parsedTasks = (items: unknown[]) =>
  parseTaskList(JSON.stringify({ tasks: items }))?.tasks ?? [];

test("mergeListed adds new listed tasks, updates known ones, and never announces an already-terminal one", () => {
  const now = 5_000_000;
  const listed = parsedTasks([
    listItem(1),
    listItem(2, {
      status: "COMPLETED",
      stage: "done",
      ended_at: "2026-01-01T00:02:00Z",
      pr: { number: 3, url: "https://g/pull/3" },
    }),
    listItem(3, { status: "INPUT_REQUIRED", waiting_for_answer: true }),
  ]);
  const merged = mergeListed([], listed, { server: "s", prefix: "p_" }, now);
  expect(merged.map((t) => t.taskId)).toEqual(["L1", "L2", "L3"]);
  const l2 = merged[1];
  expect(l2).toMatchObject({
    server: "s",
    prefix: "p_",
    status: "COMPLETED",
    notified: true,
    listed: true,
  });
  expect(l2?.terminalAt).toBe(Date.parse("2026-01-01T00:02:00Z"));
  expect(l2?.pr).toEqual({ number: 3, url: "https://g/pull/3" });
  expect(merged[2]?.waiting).toBe(true);

  // 既知のタスク（task_start で拾ったもの）は startedAt を保ち、list の値で状態を更新する
  const known = task(1, { taskId: "L1", server: "s", prefix: "p_", startedAt: 4_000_000 });
  const again = mergeListed([known], listed.slice(0, 1), { server: "s", prefix: "p_" }, now);
  expect(again).toHaveLength(1);
  expect(again[0]?.startedAt).toBe(4_000_000);
  expect(again[0]).toMatchObject({
    stage: "work",
    model: "sonnet",
    repository: "o/repo",
    listed: true,
  });
});

test("mergeListed orders by start time, oldest first", () => {
  const listed = parsedTasks([
    listItem(1, { created_at: "2026-01-03T00:00:00Z" }),
    listItem(2, { created_at: "2026-01-01T00:00:00Z" }),
  ]);
  const merged = mergeListed([], listed, { server: "s", prefix: "" }, 9_999_999_999_999);
  expect(merged.map((t) => t.taskId)).toEqual(["L2", "L1"]);
});

test("mergeListed marks a task that turned terminal now with terminalAt and leaves notified to the toast", () => {
  const now = 7_000_000;
  const known = task(1, { taskId: "L1", server: "s", prefix: "" });
  const listed = parsedTasks([listItem(1, { status: "FAILED" })]);
  const merged = mergeListed([known], listed, { server: "s", prefix: "" }, now);
  expect(merged[0]).toMatchObject({ status: "FAILED", terminalAt: now });
  expect(merged[0]?.notified).toBeUndefined();
});

test("pruneTasks keeps 10 locally tracked tasks and up to 50 listed ones", () => {
  const local = Array.from({ length: 12 }, (_, i) => task(i));
  expect(pruneTasks(local, 0)).toHaveLength(10);
  const listedMany = Array.from({ length: 60 }, (_, i) => task(i, { listed: true }));
  const out = pruneTasks(listedMany, 0);
  expect(out).toHaveLength(50);
  expect(out.at(-1)?.taskId).toBe("t59");
  const mixed = pruneTasks([...local, ...listedMany.slice(0, 3)], 0);
  expect(mixed.filter((t) => t.listed !== true)).toHaveLength(10);
  expect(mixed.filter((t) => t.listed === true)).toHaveLength(3);
});

test("coerceTasks keeps the listed fields only when well formed", () => {
  const [t] = coerceTasks([
    {
      ...task(1),
      kind: "review",
      repository: "o/r",
      model: "m",
      stage: "post",
      verifyAttempt: 1,
      verifyMax: 3,
      waiting: true,
      listed: true,
      pr: { number: 4, url: "https://g/pull/4" },
    },
  ]);
  expect(t).toMatchObject({
    kind: "review",
    repository: "o/r",
    model: "m",
    stage: "post",
    verifyAttempt: 1,
    verifyMax: 3,
    waiting: true,
    listed: true,
    pr: { number: 4, url: "https://g/pull/4" },
  });
  const [bad] = coerceTasks([
    {
      ...task(2),
      kind: "x",
      stage: 5,
      waiting: "yes",
      pr: { number: 1, url: "http://x" },
      verifyAttempt: "a",
    },
  ]);
  expect(bad?.kind).toBeUndefined();
  expect(bad?.stage).toBeUndefined();
  expect(bad?.waiting).toBeUndefined();
  expect(bad?.pr).toBeUndefined();
  expect(bad?.verifyAttempt).toBeUndefined();
});

test("matchRovoTool recognizes every rovo tool name in both shapes and reads server and prefix", () => {
  expect(matchRovoTool("mcp__rovo-direct__task_list")).toEqual({
    server: "rovo-direct",
    prefix: "",
  });
  expect(matchRovoTool("mcp__claude_ai_mcp_hubs_run__my-rovo_task_wait")).toEqual({
    server: "claude_ai_mcp_hubs_run",
    prefix: "my-rovo_",
  });
  for (const name of ["task_start", "task_status", "task_console", "task_result", "task_review"]) {
    expect(matchRovoTool(`mcp__s__${name}`)).toEqual({ server: "s", prefix: "" });
  }
  expect(matchRovoTool("mcp__s__other_tool")).toBeNull();
  expect(matchRovoTool("Bash")).toBeNull();
});
