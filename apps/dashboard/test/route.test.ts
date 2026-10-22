import { describe, expect, it } from "vitest";
import { parseDay, parseRoute, taskPath } from "../src/route";

const ID = "01K8ZF00000000000000000004";

describe("parseDay（?day=YYYY-MM-DD。不正な値は null = 今日）", () => {
  it("実在する日付だけ受け取る", () => {
    expect(parseDay("?day=2026-10-22")).toBe("2026-10-22");
    expect(parseDay("?scope=me&day=2026-02-28")).toBe("2026-02-28");
    expect(parseDay("?day=2024-02-29")).toBe("2024-02-29");
  });
  it("無い・不正・存在しない日付は null", () => {
    for (const s of [
      "",
      "?",
      "?day=",
      "?day=abc",
      "?day=2026-13-01",
      "?day=2026-02-30",
      "?day=2025-02-29",
      "?day=2026-1-5",
      "?day=2026-10-22x",
      "?day=20261022",
    ]) {
      expect(parseDay(s), s).toBeNull();
    }
  });
});

describe("parseRoute（/dashboard/tasks/<ULID> で詳細、それ以外は一覧）", () => {
  it("詳細", () => {
    expect(parseRoute(`/dashboard/tasks/${ID}`)).toEqual({ kind: "task", id: ID });
    expect(parseRoute(`/dashboard/tasks/${ID}/`)).toEqual({ kind: "task", id: ID });
  });
  it("一覧", () => {
    for (const p of ["/dashboard", "/dashboard/", "/", "/dashboard/tasks", "/dashboard/tasks/"]) {
      expect(parseRoute(p), p).toEqual({ kind: "overview" });
    }
  });
  it("ULID でないもの・余計な経路は一覧に倒す（詳細として扱わない）", () => {
    for (const p of [
      "/dashboard/tasks/abc",
      `/dashboard/tasks/${ID.toLowerCase()}`,
      `/dashboard/tasks/${ID}x`,
      `/dashboard/tasks/${ID}/events`,
      `/x/dashboard/tasks/${ID}`,
      `/dashboard/tasks/${ID.slice(0, 25)}U`,
    ]) {
      expect(parseRoute(p), p).toEqual({ kind: "overview" });
    }
  });
});

describe("taskPath（レール・タイムラインの行の href と pushState の行き先）", () => {
  it("/dashboard/tasks/<ID>。parseRoute で同じ ID に戻る", () => {
    expect(taskPath(ID)).toBe(`/dashboard/tasks/${ID}`);
    expect(parseRoute(taskPath(ID))).toEqual({ kind: "task", id: ID });
  });
});
