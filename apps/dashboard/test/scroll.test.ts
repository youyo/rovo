import { describe, expect, it } from "vitest";
import { FOLLOW_THRESHOLD, isNearBottom } from "../src/scroll";

describe("isNearBottom（画面の末尾に追従するかの判定）", () => {
  const box = (scrollTop: number) => ({ scrollHeight: 1000, clientHeight: 400, scrollTop });

  it("一番下なら追従する", () => {
    expect(isNearBottom(box(600))).toBe(true);
  });

  it("しきい値以内のずれ（小数の丸め・数 px）は一番下とみなす", () => {
    expect(isNearBottom(box(600 - FOLLOW_THRESHOLD))).toBe(true);
    expect(isNearBottom(box(599.4))).toBe(true);
  });

  it("利用者が上にスクロールしていたら追従しない", () => {
    expect(isNearBottom(box(600 - FOLLOW_THRESHOLD - 1))).toBe(false);
    expect(isNearBottom(box(0))).toBe(false);
  });

  it("中身が枠に収まっていて動かせないときは追従する", () => {
    expect(isNearBottom({ scrollHeight: 300, clientHeight: 400, scrollTop: 0 })).toBe(true);
  });
});
