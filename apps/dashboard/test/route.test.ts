import { describe, expect, it } from "vitest";
import { parseRoute } from "../src/route";

const ID = "01K8ZF00000000000000000004";

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
