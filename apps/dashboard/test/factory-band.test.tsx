import type { OverviewDto, VisibleTaskDto } from "@rovo/dashboard-contract";
import { overviewFixture } from "@rovo/dashboard-contract/fixtures";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { personIndex } from "../src/factory";
import { FactoryBand } from "../src/factory-band";
import { FACTORY_COLLAPSED_KEY, loadFactoryCollapsed, saveFactoryCollapsed } from "../src/prefs";
import { inJa } from "./lang";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: { unmount: () => void }[] = [];
beforeEach(() => localStorage.clear());
afterEach(() => {
  for (const r of roots.splice(0)) act(() => r.unmount());
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  localStorage.clear();
});

function stubNarrow(narrow: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: narrow && query.includes("max-width: 720px"),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

function mount(data: OverviewDto = overviewFixture) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(inJa(createElement(FactoryBand, { data }))));
  return container;
}

const settle = async () => {
  for (let i = 0; i < 20; i++) await act(async () => await new Promise((r) => setTimeout(r, 0)));
};

const toggle = (c: Element) => c.querySelector("button[data-factory-toggle]") as HTMLButtonElement;
const summary = (c: Element) => c.querySelector("[data-factory-summary]");

describe("FactoryBand（工場の帯）", () => {
  it("帯は「Rovo の工場」。広げた状態が既定で、断面図は遅延読み込み（読み込み中は高さを確保した枠）", async () => {
    const c = mount();
    const band = c.querySelector("section[data-factory]");
    expect(band?.getAttribute("aria-label")).toBe("Rovo の工場");
    expect(toggle(c).getAttribute("aria-expanded")).toBe("true");
    expect(summary(c)).toBeNull();
    expect(c.querySelector(".fxband-wait") ?? c.querySelector(".fx-stage")).not.toBeNull();
    await settle();
    expect(c.querySelector(".fx-stage svg")).not.toBeNull();
    expect(c.querySelector(".fxband-wait")).toBeNull();
  });

  it("たたむと「部屋ごとの人数」の 1 行。状態はブラウザに覚え、描き直しても保たれる", () => {
    const c = mount();
    act(() => toggle(c).click());
    expect(toggle(c).getAttribute("aria-expanded")).toBe("false");
    const s = summary(c);
    expect(s).not.toBeNull();
    expect(c.querySelector(".fx-stage")).toBeNull();
    expect(localStorage.getItem(FACTORY_COLLAPSED_KEY)).toBe("1");
    // fixture: Ready 3（stage=ready）、コーディング 1（RUNNING）、失敗 1（出さない）
    expect(s?.querySelector('[data-room="ready"]')?.getAttribute("data-n")).toBe("3");
    expect(s?.querySelector('[data-room="code"]')?.getAttribute("data-n")).toBe("1");
    expect(s?.querySelector('[data-room="code"]')?.textContent).toContain("コーディング");
    const bob = s?.querySelector('[data-room="code"] .fxs-dot');
    expect(bob?.classList.contains(`p${personIndex("bob-example")}`)).toBe(true);
    document.body.innerHTML = "";
    const again = mount();
    expect(toggle(again).getAttribute("aria-expanded")).toBe("false");
    expect(summary(again)).not.toBeNull();
    act(() => toggle(again).click());
    expect(localStorage.getItem(FACTORY_COLLAPSED_KEY)).toBe("0");
  });

  it("人数の 1 行はタスクへのリンクや data-task を持たない（人数と人の色だけ）", () => {
    saveFactoryCollapsed(true);
    const c = mount();
    expect(summary(c)?.querySelector("[data-task]")).toBeNull();
    expect(summary(c)?.querySelector("a")).toBeNull();
  });

  it("狭い幅（720px 以下）は断面図を出さず、たたんだときと同じ簡略版。たたむボタンも出さない", async () => {
    stubNarrow(true);
    const c = mount();
    expect(summary(c)).not.toBeNull();
    expect(toggle(c)).toBeNull();
    await settle();
    expect(c.querySelector(".fx-stage")).toBeNull();
  });

  it("見えないタスクは件数だけ（0 件なら出さない）", () => {
    const c = mount();
    expect(c.querySelector("[data-factory-hidden]")?.textContent).toContain("1");
    document.body.innerHTML = "";
    const zero: OverviewDto = {
      ...overviewFixture,
      month: { ...overviewFixture.month, hidden_tasks: { count: 0, cost_usd: 0 } },
    };
    expect(mount(zero).querySelector("[data-factory-hidden]")).toBeNull();
  });

  it("工場に誰もいないときも帯は出し、人数は 0", () => {
    saveFactoryCollapsed(true);
    const none: OverviewDto = {
      ...overviewFixture,
      tasks: [{ ...(overviewFixture.tasks[2] as VisibleTaskDto) }],
    };
    const c = mount(none);
    expect(c.querySelector("section[data-factory]")).not.toBeNull();
    expect(summary(c)?.querySelector('[data-room="code"]')?.getAttribute("data-n")).toBe("0");
  });
});

describe("prefs: 工場の帯をたたんだか", () => {
  it("既定は広げる。'1' のときだけたたむ。読めない・保存できないときも動く", () => {
    const mem = new Map<string, string>();
    const s = {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v),
    };
    expect(loadFactoryCollapsed(s)).toBe(false);
    saveFactoryCollapsed(true, s);
    expect(loadFactoryCollapsed(s)).toBe(true);
    saveFactoryCollapsed(false, s);
    expect(loadFactoryCollapsed(s)).toBe(false);
    const broken = {
      getItem: () => {
        throw new Error("x");
      },
      setItem: () => {
        throw new Error("x");
      },
    };
    expect(loadFactoryCollapsed(broken)).toBe(false);
    expect(() => saveFactoryCollapsed(true, broken)).not.toThrow();
  });
});
