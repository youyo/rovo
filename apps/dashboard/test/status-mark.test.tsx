import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { MARKS, type MarkKind } from "../src/status";
import { MarkSymbol } from "../src/status-mark";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: { unmount: () => void }[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) act(() => r.unmount());
  document.body.innerHTML = "";
});

function symbol(kind: MarkKind, decorative = false): SVGSVGElement {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => {
    root.render(createElement(MarkSymbol, { kind, decorative }));
  });
  return container.querySelector("svg") as SVGSVGElement;
}

const KINDS = Object.keys(MARKS) as MarkKind[];

/** 形だけ（title と色の指定を除いた、図形の並び）。これが同じなら、白黒にしても区別できない。 */
function geometry(svg: SVGSVGElement): string {
  const copy = svg.cloneNode(true) as SVGSVGElement;
  for (const t of copy.querySelectorAll("title")) t.remove();
  return copy.innerHTML;
}

describe("MarkSymbol（レール・見出し・凡例で共通の状態の印）", () => {
  it("全ての状態に印がある（図形を持つ）", () => {
    for (const k of KINDS) {
      const svg = symbol(k);
      expect(svg.querySelector("path, circle, rect"), k).not.toBeNull();
      expect(svg.getAttribute("data-mark"), k).toBe(k);
      expect(svg.getAttribute("data-shape"), k).toBe(MARKS[k].shape);
      expect(svg.getAttribute("viewBox"), k).toBe("0 0 16 16");
    }
  });

  it("形（図形の並び）が全ての状態で互いに違う。色を取り除いても区別できる", () => {
    const shapes = KINDS.map((k) => geometry(symbol(k)));
    expect(new Set(shapes).size).toBe(KINDS.length);
  });

  it("同じ色の状態どうしでも、形が違う（実行中 / マージ済み / レビュー待ち）", () => {
    const blue = KINDS.filter((k) => MARKS[k].tone === "blue");
    expect(blue.length).toBeGreaterThanOrEqual(3);
    expect(new Set(blue.map((k) => geometry(symbol(k)))).size).toBe(blue.length);
  });

  it("ラベル付き: role=img と aria-label と <title>（マウスを乗せると状態の名前が出る）に label", () => {
    for (const k of KINDS) {
      const svg = symbol(k);
      expect(svg.getAttribute("role"), k).toBe("img");
      expect(svg.getAttribute("aria-label"), k).toBe(MARKS[k].label);
      expect(svg.querySelector("title")?.textContent, k).toBe(MARKS[k].label);
      expect(svg.getAttribute("aria-hidden"), k).toBeNull();
    }
  });

  it("隣に文字があるところ用の装飾: aria-hidden で、読み上げに二重に出さない", () => {
    for (const k of KINDS) {
      const svg = symbol(k, true);
      expect(svg.getAttribute("aria-hidden"), k).toBe("true");
      expect(svg.getAttribute("aria-label"), k).toBeNull();
      expect(svg.getAttribute("role"), k).toBeNull();
      expect(svg.querySelector("title"), k).toBeNull();
    }
  });

  it("色は tone のクラスで決まる（色の直書きをしない）。動いている状態だけ pulse", () => {
    for (const k of KINDS) {
      const svg = symbol(k);
      expect(svg.classList.contains(`mark-sym--${MARKS[k].tone}`), k).toBe(true);
      expect(svg.classList.contains("pulse"), k).toBe(MARKS[k].live);
      expect(svg.outerHTML, k).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgb\(|style=/);
    }
  });

  it("図形は currentColor（CSS の color）で描く。属性に色の値を持たない", () => {
    for (const k of KINDS) {
      const svg = symbol(k);
      for (const el of svg.querySelectorAll("[fill], [stroke]")) {
        expect(["none", "currentColor"], k).toContain(el.getAttribute("fill") ?? "none");
        expect(["none", "currentColor"], k).toContain(el.getAttribute("stroke") ?? "none");
      }
    }
  });
});
