import type { TaskEventDto, VisibleTaskDto } from "@rovo/dashboard-contract";
import {
  cloudflareSummaryWithEstimateFixture,
  overviewFixture,
  taskDetailRunningFixture,
  taskEventsFixture,
} from "@rovo/dashboard-contract/fixtures";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { cloudflareRows } from "../src/cloudflare";
import { loginErrorMessage } from "../src/login-error";
import { LoginView } from "../src/login-view";
import { TaskRail } from "../src/rail-view";
import { type MarkKind, markDescription, markLabel } from "../src/status";
import { StatusBar } from "../src/status-bar";
import { buildSteps, describeEvent, nowSentence, phaseBand } from "../src/steps";
import { TaskView } from "../src/task-view";
import { inEn, tEn } from "./lang";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CJK = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u;
const roots: { unmount: () => void }[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) act(() => r.unmount());
  document.body.innerHTML = "";
});
function mount(el: ReturnType<typeof createElement>) {
  const c = document.createElement("div");
  document.body.append(c);
  const root = createRoot(c);
  roots.push(root);
  act(() => root.render(inEn(el)));
  return c;
}

const at = "2026-10-21T05:50:00Z";
const ev = (seq: number, rest: Record<string, unknown>) =>
  ({ seq, at, ...rest }) as unknown as TaskEventDto;
const task = (over: Partial<VisibleTaskDto> = {}): VisibleTaskDto => ({
  ...(overviewFixture.tasks[0] as VisibleTaskDto),
  ...over,
});

describe("英語の表示: 部品", () => {
  it("TaskView: 日本語の文字が 1 つも出ない（子やユーザーのデータ以外はすべて訳されている）", () => {
    const c = mount(
      createElement(TaskView, {
        detail: taskDetailRunningFixture,
        events: taskEventsFixture.events,
        hasOlder: false,
        stale: false,
        loadingOlder: false,
        olderError: false,
        autoRefresh: true,
        onAutoRefreshChange: () => {},
        onRefresh: () => {},
        onLoadOlder: () => {},
      }),
    );
    const own = new Set<string>();
    // 子やユーザーが書いたデータ（題名・コマンド・出力など）は訳さないので、そこに日本語があれば除く
    for (const e of c.querySelectorAll(".con-title, .step-target, .output, .step-detail")) {
      own.add(e.textContent ?? "");
    }
    let text = c.textContent ?? "";
    for (const o of own) text = text.split(o).join("");
    expect(CJK.test(text), text).toBe(false);
    expect(c.textContent).toContain("Progress");
    expect(c.textContent).toContain("Auto-refresh");
    expect(c.querySelector("[data-band]")?.getAttribute("aria-label")).toMatch(/^Stages: /);
  });

  it("StatusBar: 英語の見出しと金額", () => {
    const c = mount(
      createElement(StatusBar, {
        data: overviewFixture,
        nowMs: Date.parse(overviewFixture.generated_at),
        cloudflare: { phase: "ready", data: cloudflareSummaryWithEstimateFixture },
        autoRefresh: true,
        onAutoRefreshChange: () => {},
        onRefresh: () => {},
      }),
    );
    const bar = c.querySelector(".statusbar");
    expect(bar?.getAttribute("aria-label")).toBe("Cost and limits");
    expect(bar?.textContent).toContain("This month");
    expect(bar?.textContent).toContain("Everyone");
    expect(c.textContent).not.toMatch(CJK);
  });

  it("TaskRail: 空の文言も英語", () => {
    const c = mount(createElement(TaskRail, { tasks: [], selectedId: null }));
    expect(c.querySelector("nav")?.getAttribute("aria-label")).toBe("Tasks");
    expect(c.textContent).toBe("No tasks today yet.");
    const d = mount(createElement(TaskRail, { tasks: [], selectedId: null, isToday: false }));
    expect(d.textContent).toBe("No tasks on this day.");
  });

  it("LoginView と login_error の 3 種", () => {
    const html = renderToStaticMarkup(
      inEn(
        createElement(LoginView, {
          variant: "error",
          taskDetail: false,
          loginHref: "/dashboard/auth/login",
          message: loginErrorMessage("denied", tEn),
        }),
      ),
    );
    expect(html).toContain("Rovo Dashboard");
    expect(html).toContain("Sign in with GitHub");
    expect(html).toContain("Couldn&#x27;t check your sign-in status.");
    expect(html).toContain("This account isn&#x27;t allowed to sign in.");
    expect(html).not.toMatch(CJK);
    for (const code of ["denied", "invalid", "unavailable"]) {
      const m = loginErrorMessage(code, tEn);
      expect(m, code).not.toBeNull();
      expect(m, code).not.toMatch(CJK);
    }
    expect(loginErrorMessage("x", tEn)).toBeNull();
  });
});

describe("英語の表示: 純関数", () => {
  it("状態の印: すべての印に英語の名前があり、どれも違う。閉じたは説明がつく", () => {
    const kinds = [
      "preparing",
      "running",
      "input",
      "verifying",
      "recovering",
      "merged",
      "review",
      "closed",
      "pr",
      "done",
      "failed",
      "budget",
      "cancelled",
    ] as MarkKind[];
    const labels = kinds.map((k) => markLabel(k, tEn));
    expect(new Set(labels).size).toBe(kinds.length);
    expect(labels).toContain("In progress");
    expect(labels).toContain("Succeeded");
    expect(labels).toContain("Cancelled");
    expect(markDescription("closed", tEn)).toBe("Closed (not merged)");
    expect(markDescription("closed", tEn).startsWith(markLabel("closed", tEn))).toBe(true);
  });

  it("手順の動詞", () => {
    const cmd = { type: "command", command: "pnpm test", exit_code: 0, duration_ms: 125_000 };
    expect(describeEvent(ev(1, cmd), { current: false }, tEn)).toMatchObject({
      what: "Ran a command",
      target: "pnpm test",
      note: "2m 5s",
    });
    expect(describeEvent(ev(1, { ...cmd, exit_code: 2 }), { current: false }, tEn)).toMatchObject({
      what: "Command failed",
      note: "Exit code 2, 2m 5s",
      tone: "fail",
    });
    expect(
      describeEvent(
        ev(2, { type: "edit", path: "a.ts", op: "modify", added: 1, removed: 3 }),
        { current: false },
        tEn,
      ),
    ).toMatchObject({ what: "Edited a file", note: "1 line added, 3 lines removed" });
    expect(
      describeEvent(
        ev(3, { type: "commit", message: "fix", sha: "a".repeat(40), files: 1 }),
        { current: false },
        tEn,
      ),
    ).toMatchObject({ what: "Committed", note: "1 file, aaaaaaa" });
    expect(
      describeEvent(
        ev(4, { type: "status_changed", to: "FAILED", reason: "boom" }),
        { current: false },
        tEn,
      ),
    ).toMatchObject({ what: "Failed", note: "Reason: boom", tone: "fail" });
    expect(
      describeEvent(ev(5, { type: "agent_event", agent_type: "x" }), { current: false }, tEn)?.what,
    ).toBe("Other activity");
    expect(buildSteps([], false, tEn)).toEqual([]);
  });

  it("段階の帯", () => {
    const band = phaseBand(task({ status: "RUNNING" }), "run", tEn);
    expect(band.map((b) => b.name)).toEqual(["Prepare", "Run", "Verify", "Complete"]);
    expect(band.map((b) => b.label)).toEqual(["Done", "Now", "Upcoming", "Upcoming"]);
    const stopped = phaseBand(task({ status: "BUDGET_EXCEEDED" }), "run", tEn);
    expect(stopped.find((b) => b.state === "stopped")?.label).toBe("Over budget");
  });

  it("「いまは X」の文: X の前後に分かれ、場所は X の後ろに付く", () => {
    const run = nowSentence({ kind: "command", text: "$ pnpm test" }, "RUNNING", tEn);
    expect(run).toEqual({
      before: "Now running ",
      prompt: "$ ",
      target: "pnpm test",
      after: ".",
    });
    const where = nowSentence(
      { kind: "command", text: "$ cd /workspace/apps/web && pnpm test" },
      "RUNNING",
      tEn,
    );
    expect(where).toEqual({
      before: "Now running ",
      prompt: "$ ",
      target: "pnpm test",
      after: " in apps/web.",
    });
    expect(nowSentence(null, "CREATING", tEn).before).toBe(
      "Preparing the repository and the environment.",
    );
    expect(
      nowSentence({ kind: "waiting", text: "waiting for budget approval" }, "INPUT_REQUIRED", tEn)
        .before,
    ).toBe("Waiting for budget approval (waiting for input).");
  });

  it("Cloudflare の行: 英語の名前・値・注記", () => {
    const rows = cloudflareRows(cloudflareSummaryWithEstimateFixture, tEn);
    for (const r of rows) {
      for (const s of [r.name, r.text, r.ariaLabel, r.cost ?? "", r.note ?? ""]) {
        expect(s, `${r.key}: ${s}`).not.toMatch(CJK);
      }
    }
    expect(rows.find((r) => r.key === "workers")?.name).toBe("Workers requests");
    expect(rows.find((r) => r.key === "workers")?.ariaLabel).toBe("Open Workers in Cloudflare");
  });
});
