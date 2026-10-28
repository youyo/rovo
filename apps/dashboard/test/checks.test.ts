import type { ChecksDto } from "@rovo/dashboard-contract";
import {
  checksFailingFixture,
  checksFixture,
  checksNoneFixture,
  checksUnreadableFixture,
} from "@rovo/dashboard-contract/fixtures";
import { describe, expect, it } from "vitest";
import {
  CHECKS_POLL_ACTIVE_MS,
  CHECKS_POLL_IDLE_MS,
  checkClass,
  checkDurationMs,
  checksPollMs,
  shortSha,
  sortChecks,
  summarizeChecks,
} from "../src/checks";
import { isAllowedCheckUrl } from "../src/format";

type Check = ChecksDto["checks"][number];
const c = (over: Partial<Check> = {}): Check => ({
  name: "n",
  kind: "check_run",
  status: "completed",
  conclusion: "success",
  started_at: null,
  completed_at: null,
  url: null,
  ...over,
});

describe("checkClass（表示上の 5 分類）", () => {
  it("完了して success は ok、skipped / neutral は skip", () => {
    expect(checkClass(c())).toBe("ok");
    expect(checkClass(c({ conclusion: "skipped" }))).toBe("skip");
    expect(checkClass(c({ conclusion: "neutral" }))).toBe("skip");
  });
  it("完了して success / skipped / neutral 以外はすべて fail（未知の値も）", () => {
    for (const conclusion of [
      "failure",
      "cancelled",
      "timed_out",
      "action_required",
      "stale",
      "x",
      null,
    ]) {
      expect(checkClass(c({ conclusion })), String(conclusion)).toBe("fail");
    }
    expect(checkClass(c({ kind: "status", conclusion: "failure" }))).toBe("fail");
    expect(checkClass(c({ kind: "status", conclusion: "error" }))).toBe("fail");
    expect(checkClass(c({ kind: "status", conclusion: "success" }))).toBe("ok");
  });
  it("in_progress は run、queued は queued", () => {
    expect(checkClass(c({ status: "in_progress", conclusion: null }))).toBe("run");
    expect(checkClass(c({ status: "queued", conclusion: null }))).toBe("queued");
  });
});

describe("sortChecks（失敗 → 実行中 → 待ち → 成功 → skipped / neutral。同じ分類は元の順）", () => {
  it("並べ替える。元の配列は変えない", () => {
    const list = [
      c({ name: "ok1" }),
      c({ name: "skip", conclusion: "skipped" }),
      c({ name: "q", status: "queued", conclusion: null }),
      c({ name: "bad1", conclusion: "failure" }),
      c({ name: "run", status: "in_progress", conclusion: null }),
      c({ name: "ok2" }),
      c({ name: "bad2", conclusion: "cancelled" }),
    ];
    const before = list.map((x) => x.name);
    expect(sortChecks(list).map((x) => x.name)).toEqual([
      "bad1",
      "bad2",
      "run",
      "q",
      "ok1",
      "ok2",
      "skip",
    ]);
    expect(list.map((x) => x.name)).toEqual(before);
  });
});

describe("summarizeChecks（見出しのチップ）", () => {
  it("成功（skipped / neutral を含む）・失敗・未了（実行中と待ち）を数える", () => {
    expect(summarizeChecks(checksFixture.checks)).toEqual({ ok: 3, fail: 0, pending: 1 });
    expect(summarizeChecks(checksFailingFixture.checks)).toEqual({ ok: 1, fail: 1, pending: 1 });
    expect(
      summarizeChecks([c({ conclusion: "skipped" }), c({ status: "queued", conclusion: null })]),
    ).toEqual({ ok: 1, fail: 0, pending: 1 });
    expect(summarizeChecks([])).toEqual({ ok: 0, fail: 0, pending: 0 });
  });
});

describe("checkDurationMs（check run で開始と終了があるときだけ。実行中は経過）", () => {
  const T0 = "2026-10-21T05:00:00Z";
  const T1 = "2026-10-21T05:01:30Z";
  it("完了した check run は completed_at - started_at", () => {
    expect(checkDurationMs(c({ started_at: T0, completed_at: T1 }), Date.parse(T1) + 5_000)).toBe(
      90_000,
    );
  });
  it("実行中は now - started_at", () => {
    expect(
      checkDurationMs(
        c({ status: "in_progress", conclusion: null, started_at: T0 }),
        Date.parse(T0) + 7_000,
      ),
    ).toBe(7_000);
  });
  it("時刻が足りない・待ち・commit status・負の差は null", () => {
    expect(checkDurationMs(c({ started_at: T0 }), 0)).toBeNull();
    expect(checkDurationMs(c({ completed_at: T1 }), 0)).toBeNull();
    expect(
      checkDurationMs(c({ status: "queued", conclusion: null, started_at: T0 }), Date.parse(T0)),
    ).toBeNull();
    expect(checkDurationMs(c({ kind: "status", started_at: T0, completed_at: T1 }), 0)).toBeNull();
    expect(checkDurationMs(c({ started_at: T1, completed_at: T0 }), 0)).toBeNull();
  });
});

describe("checksPollMs（更新の間隔）", () => {
  it("queued / in_progress が 1 つでもあれば 10 秒、全部終わっていれば 60 秒", () => {
    expect(CHECKS_POLL_ACTIVE_MS).toBe(10_000);
    expect(CHECKS_POLL_IDLE_MS).toBe(60_000);
    expect(checksPollMs(checksFixture)).toBe(10_000);
    expect(checksPollMs(checksFailingFixture)).toBe(10_000);
    expect(
      checksPollMs({ ...checksFixture, checks: [c(), c({ status: "queued", conclusion: null })] }),
    ).toBe(10_000);
    expect(checksPollMs({ ...checksFixture, checks: [c(), c({ conclusion: "failure" })] })).toBe(
      60_000,
    );
  });
  it("CI が無い・読めない・まだ取れていない（null）は 60 秒（後からの push を拾う）", () => {
    expect(checksPollMs(checksNoneFixture)).toBe(60_000);
    expect(checksPollMs(checksUnreadableFixture)).toBe(60_000);
    expect(checksPollMs(null)).toBe(60_000);
  });
});

describe("shortSha", () => {
  it("先頭 7 桁。null は空", () => {
    expect(shortSha("0123456789abcdef0123456789abcdef01234567")).toBe("0123456");
    expect(shortSha(null)).toBe("");
  });
});

describe("isAllowedCheckUrl（https://github.com/ だけをリンクにする）", () => {
  it("github.com の https は通す", () => {
    expect(isAllowedCheckUrl("https://github.com/o/r/actions/runs/1")).toBe(true);
    expect(isAllowedCheckUrl("https://github.com/o/r/runs/1?check_suite_focus=true")).toBe(true);
  });
  it("それ以外は通さない", () => {
    for (const u of [
      "http://github.com/o/r",
      "https://evil.example/o/r",
      "https://github.com.evil.example/o",
      "https://github.com@evil.example/o",
      "https://github.com:444/o",
      "javascript:alert(1)",
      "data:text/html,x",
      "//github.com/o",
      "https://github.com/o r",
      "https://github.com/o\\r",
      "https://github.com/o\nx",
      "",
      null,
      undefined,
      5,
    ]) {
      expect(isAllowedCheckUrl(u), String(u)).toBe(false);
    }
  });
});
