import { describe, expect, it } from "vitest";
import { type CollectEvent, collectUntil, maskTokens } from "../support/collect";

// full E2E の collect（task_wait を cursor でつないで終端まで集める）。判定は変えず、
// 失敗するとき（上限を超えたとき）に、原因を後から追える診断を添えることを確かめる。

const TERMINAL = new Set(["COMPLETED", "FAILED", "BUDGET_EXCEEDED", "CANCELLED"]);
const ev = (seq: number, type: string, payload: Record<string, unknown> = {}): CollectEvent => ({
  seq,
  type,
  payload,
});

/** 時刻を差し替えられる偽の時計。wait を呼ぶたびに advance だけ進む。 */
function clock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe("collectUntil", () => {
  it("終端になったら、集めたイベントと status を返す（診断は呼ばない）", async () => {
    const c = clock();
    let diagnosed = false;
    const pages = [
      { status: "RUNNING", events: [ev(1, "status_changed", { status: "RUNNING" })], cursor: "1" },
      {
        status: "COMPLETED",
        events: [ev(2, "status_changed", { status: "COMPLETED" })],
        cursor: "2",
      },
    ];
    const cursors: (string | undefined)[] = [];
    const r = await collectUntil({
      wait: async (cursor) => {
        cursors.push(cursor);
        c.advance(5_000);
        return pages.shift() as never;
      },
      until: (s) => TERMINAL.has(s),
      timeoutMs: 240_000,
      now: c.now,
      diagnose: async () => {
        diagnosed = true;
        return "";
      },
    });
    expect(r.status).toBe("COMPLETED");
    expect(r.events.map((e) => e.seq)).toEqual([1, 2]);
    expect(cursors).toEqual([undefined, "1"]);
    expect(diagnosed).toBe(false);
    expect(r.timing.totalMs).toBe(10_000);
    expect(r.timing.firstRunningMs).toBe(5_000);
  });

  it("上限を超えたら `timeout; status=…` で落ち、最後のイベントの seq・時刻・種別・件数と診断を含める", async () => {
    const c = clock();
    let n = 0;
    const error = await collectUntil({
      wait: async () => {
        n += 1;
        c.advance(100_000);
        return {
          status: "RUNNING",
          events:
            n === 1 ? [ev(1, "status_changed", { status: "RUNNING" }), ev(2, "tool_call")] : [],
          cursor: "2",
        };
      },
      until: (s) => TERMINAL.has(s),
      timeoutMs: 240_000,
      now: c.now,
      diagnose: async () => "sandbox: restarts=1 bootRetries=2",
    }).then(
      () => undefined,
      (e: Error) => e,
    );
    expect(error).toBeInstanceOf(Error);
    const m = error?.message ?? "";
    expect(m).toMatch(/^timeout; status=RUNNING/);
    expect(m).toContain("events=2");
    expect(m).toContain("last=seq 2 tool_call");
    expect(m).toContain("elapsed=300000ms");
    expect(m).toContain("sandbox: restarts=1 bootRetries=2");
  });

  it("診断が失敗しても、元の timeout のメッセージで落ちる", async () => {
    const c = clock();
    const error = await collectUntil({
      wait: async () => {
        c.advance(300_000);
        return { status: "RUNNING", events: [], cursor: "0" };
      },
      until: (s) => TERMINAL.has(s),
      timeoutMs: 240_000,
      now: c.now,
      diagnose: async () => {
        throw new Error("diag broke");
      },
    }).then(
      () => undefined,
      (e: Error) => e,
    );
    expect(error?.message).toMatch(/^timeout; status=RUNNING/);
    expect(error?.message).toContain("last=none");
    expect(error?.message).toContain("diag broke");
  });

  it("イベントが無いまま上限を超えても `last=none` と書く", async () => {
    const c = clock();
    const error = await collectUntil({
      wait: async () => {
        c.advance(300_000);
        return { status: "RUNNING", events: [], cursor: "0" };
      },
      until: (s) => TERMINAL.has(s),
      timeoutMs: 240_000,
      now: c.now,
    }).then(
      () => undefined,
      (e: Error) => e,
    );
    expect(error?.message).toContain("last=none");
  });

  it("診断が固まっても diagnoseTimeoutMs で切り、元の `timeout; status=…` のメッセージで落ちる", async () => {
    const c = clock();
    const started = Date.now();
    const error = await collectUntil({
      wait: async () => {
        c.advance(300_000);
        return { status: "RUNNING", events: [], cursor: "0" };
      },
      until: (s) => TERMINAL.has(s),
      timeoutMs: 240_000,
      now: c.now,
      diagnose: () => new Promise<string>(() => {}),
      diagnoseTimeoutMs: 50,
    }).then(
      () => undefined,
      (e: Error) => e,
    );
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(error?.message).toMatch(/^timeout; status=RUNNING/);
    expect(error?.message).toContain("diagnose timed out");
  });
});

describe("maskTokens / 診断の秘密のマスク", () => {
  it("トークンらしい文字列（ghs_ / ghp_ / github_pat_ / Bearer）を伏せる", () => {
    const text = [
      `token ghs_${"a".repeat(30)} x`,
      `pat ghp_${"B".repeat(36)}`,
      `github_pat_11ABCDEFG0_${"x".repeat(40)}`,
      "authorization: Bearer abc.def-123_456",
      "plain text stays",
    ].join("\n");
    const out = maskTokens(text);
    expect(out).not.toMatch(/ghs_a|ghp_B|github_pat_11|abc\.def/);
    expect(out).toContain("plain text stays");
    expect(out.match(/\[masked\]/g)?.length).toBe(4);
  });

  it("失敗メッセージに入る診断はマスクされる", async () => {
    const c = clock();
    const error = await collectUntil({
      wait: async () => {
        c.advance(300_000);
        return { status: "RUNNING", events: [], cursor: "0" };
      },
      until: (s) => TERMINAL.has(s),
      timeoutMs: 240_000,
      now: c.now,
      diagnose: async () => `leak ghs_${"z".repeat(30)}`,
    }).then(
      () => undefined,
      (e: Error) => e,
    );
    expect(error?.message).not.toContain("ghs_z");
    expect(error?.message).toContain("[masked]");
  });
});
