import { describe, expect, it } from "vitest";
import { isPlainLeftClick } from "../src/click";

const click = (o: Partial<Parameters<typeof isPlainLeftClick>[0]> = {}) => ({
  button: 0,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  defaultPrevented: false,
  ...o,
});

describe("isPlainLeftClick（画面の中で切り替えてよいクリックか）", () => {
  it("修飾キーの無い左クリックだけ true", () => {
    expect(isPlainLeftClick(click())).toBe(true);
  });

  it("Ctrl・Cmd・Shift・Alt のどれかが押されていたら false（新しいタブ・ウィンドウ・ダウンロードはブラウザに任せる）", () => {
    for (const key of ["ctrlKey", "metaKey", "shiftKey", "altKey"] as const) {
      expect(isPlainLeftClick(click({ [key]: true })), key).toBe(false);
    }
  });

  it("中クリック・右クリックなど左以外のボタンは false", () => {
    for (const button of [1, 2, 3, 4]) {
      expect(isPlainLeftClick(click({ button })), String(button)).toBe(false);
    }
  });

  it("すでに preventDefault されたクリックは false（二重に処理しない）", () => {
    expect(isPlainLeftClick(click({ defaultPrevented: true }))).toBe(false);
  });
});
