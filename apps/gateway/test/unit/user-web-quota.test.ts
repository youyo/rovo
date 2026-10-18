import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { parseDailyLimit } from "../../src/tasks/user-do";
import { newUserId, userStub } from "./helpers";

type UserStub = ReturnType<typeof userStub>;
type Limits = { search?: number; fetch?: number; browse?: number };

async function setup(stub: UserStub, start = Date.UTC(2026, 9, 18, 12), limits: Limits = {}) {
  let t = start;
  await runInDurableObject(stub, (i) => {
    const u = i as unknown as {
      now: () => number;
      webDailyLimit: (kind: "search" | "fetch" | "browse") => number;
    };
    u.now = () => t;
    if (limits.search !== undefined || limits.fetch !== undefined || limits.browse !== undefined) {
      u.webDailyLimit = (kind) =>
        kind === "search"
          ? (limits.search ?? 200)
          : kind === "browse"
            ? (limits.browse ?? 50)
            : (limits.fetch ?? 500);
    }
  });
  return {
    set(ms: number) {
      t = ms;
    },
  };
}

describe("UserDO: web の1日あたりの回数（UTC）", () => {
  it("上限まで ok、超えたら ok:false（limit と used を返す）", async () => {
    const stub = userStub(newUserId());
    await setup(stub, undefined, { search: 3 });
    expect(await stub.consumeWebQuota("search")).toEqual({ ok: true, used: 1, limit: 3 });
    expect(await stub.consumeWebQuota("search")).toEqual({ ok: true, used: 2, limit: 3 });
    expect(await stub.consumeWebQuota("search")).toEqual({ ok: true, used: 3, limit: 3 });
    expect(await stub.consumeWebQuota("search")).toEqual({ ok: false, used: 3, limit: 3 });
    // 超えた呼び出しは数えない
    expect(await stub.consumeWebQuota("search")).toEqual({ ok: false, used: 3, limit: 3 });
  });

  it("search と fetch は別々に数える", async () => {
    const stub = userStub(newUserId());
    await setup(stub, undefined, { search: 1, fetch: 2 });
    expect((await stub.consumeWebQuota("search")).ok).toBe(true);
    expect((await stub.consumeWebQuota("search")).ok).toBe(false);
    expect((await stub.consumeWebQuota("fetch")).ok).toBe(true);
    expect((await stub.consumeWebQuota("fetch")).ok).toBe(true);
    expect((await stub.consumeWebQuota("fetch")).ok).toBe(false);
  });

  it("UTC の日付が変わると 0 から数え直す", async () => {
    const stub = userStub(newUserId());
    const clock = await setup(stub, Date.UTC(2026, 9, 18, 23, 59, 59), { search: 1 });
    expect((await stub.consumeWebQuota("search")).ok).toBe(true);
    expect((await stub.consumeWebQuota("search")).ok).toBe(false);
    clock.set(Date.UTC(2026, 9, 19, 0, 0, 0));
    expect(await stub.consumeWebQuota("search")).toEqual({ ok: true, used: 1, limit: 1 });
  });

  it("古い日の行は消える", async () => {
    const stub = userStub(newUserId());
    const clock = await setup(stub, Date.UTC(2026, 9, 1), { search: 5 });
    await stub.consumeWebQuota("search");
    clock.set(Date.UTC(2026, 9, 18));
    await stub.consumeWebQuota("search");
    const rows = await runInDurableObject(
      stub,
      (_i, s) => s.storage.sql.exec("SELECT day FROM web_usage").toArray() as { day: string }[],
    );
    expect(rows.map((r) => r.day)).toEqual(["2026-10-18"]);
  });

  it("既定の上限は search 200 / fetch 500", async () => {
    const stub = userStub(newUserId());
    await setup(stub);
    expect((await stub.consumeWebQuota("search")).limit).toBe(200);
    expect((await stub.consumeWebQuota("fetch")).limit).toBe(500);
  });
});

describe("parseDailyLimit", () => {
  it("env の値は 0 以上の整数だけ使い、不正な値は既定に戻す", () => {
    expect(parseDailyLimit("7", 200)).toBe(7);
    expect(parseDailyLimit("0", 200)).toBe(0);
    expect(parseDailyLimit("abc", 200)).toBe(200);
    expect(parseDailyLimit("-1", 500)).toBe(500);
    expect(parseDailyLimit("1.5", 500)).toBe(500);
    expect(parseDailyLimit("", 500)).toBe(500);
    expect(parseDailyLimit(undefined, 500)).toBe(500);
  });
});

describe("UserDO: web_browse の1日あたりの回数", () => {
  it("browse は search・fetch とは別の枠で数える", async () => {
    const stub = userStub(newUserId());
    await setup(stub, undefined, { search: 1, fetch: 1, browse: 2 });
    expect(await stub.consumeWebQuota("browse")).toEqual({ ok: true, used: 1, limit: 2 });
    expect(await stub.consumeWebQuota("browse")).toEqual({ ok: true, used: 2, limit: 2 });
    expect(await stub.consumeWebQuota("browse")).toEqual({ ok: false, used: 2, limit: 2 });
    expect((await stub.consumeWebQuota("search")).ok).toBe(true);
    expect((await stub.consumeWebQuota("fetch")).ok).toBe(true);
  });

  it("既定の上限は 50 回 / 日（WEB_BROWSE_DAILY_LIMIT で変える）", async () => {
    const { DEFAULT_WEB_BROWSE_DAILY_LIMIT } = await import("../../src/tasks/user-do");
    expect(DEFAULT_WEB_BROWSE_DAILY_LIMIT).toBe(50);
    const stub = userStub(newUserId());
    const r = await stub.consumeWebQuota("browse");
    expect(r).toMatchObject({ ok: true, used: 1 });
    expect(r.limit).toBeGreaterThan(0);
  });
});
