import type { OverviewDto, VisibleTaskDto } from "@rovo/dashboard-contract";
import { overviewFixture } from "@rovo/dashboard-contract/fixtures";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { personIndex } from "../src/factory";
import { FactoryBand } from "../src/factory-band";
import FactoryPanel from "../src/factory-panel";
import { FACTORY_PREF_KEY, loadFactoryPref, saveFactoryPref } from "../src/factory-prefs";
import { inJa } from "./lang";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: { unmount: () => void }[] = [];
beforeEach(() => {
  localStorage.clear();
  screenSize(1440, 1600);
});
afterEach(() => {
  for (const r of roots.splice(0)) act(() => r.unmount());
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  localStorage.clear();
});

/** 画面の大きさ（既定でたたむかの判定に使う） */
function screenSize(w: number, h: number) {
  vi.stubGlobal("innerWidth", w);
  vi.stubGlobal("innerHeight", h);
}

function stubNarrow(narrow: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: narrow && query.includes("max-width: 720px"),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

function mount(data: OverviewDto = overviewFixture, el: "panel" | "band" = "panel") {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() =>
    root.render(inJa(createElement(el === "panel" ? FactoryPanel : FactoryBand, { data }))),
  );
  return container;
}

const settle = async () => {
  for (let i = 0; i < 20; i++) await act(async () => await new Promise((r) => setTimeout(r, 0)));
};

const toggle = (c: Element) => c.querySelector("button[data-factory-toggle]") as HTMLButtonElement;
const summary = (c: Element) => c.querySelector("[data-factory-summary]");

describe("FactoryBand（本体の枠。中身は遅延読み込み）", () => {
  it("帯は「Rovo の工場」の section。中身はチャンクから読み、読み込み中は枠だけ", async () => {
    const c = mount(overviewFixture, "band");
    const band = c.querySelector("section[data-factory]");
    expect(band?.getAttribute("aria-label")).toBe("Rovo の工場");
    expect(c.querySelector(".fxband-wait") ?? c.querySelector(".fxband-bar")).not.toBeNull();
    await settle();
    expect(c.querySelector(".fxband-bar")).not.toBeNull();
    expect(c.querySelector(".fx-stage svg.fx-svg")).not.toBeNull();
    expect(c.querySelector(".fxband-wait")).toBeNull();
  });
});

describe("FactoryBand の読み込み中の枠（帯の下を動かさない）", () => {
  it("一覧がまだ（data が null）でも枠を出す。高さは既定の状態に合わせる（たたむ既定は 1 行、広げる既定は断面図の分も）", () => {
    const one = (w: number, h: number) => {
      document.body.innerHTML = "";
      screenSize(w, h);
      const container = document.createElement("div");
      document.body.append(container);
      const root = createRoot(container);
      roots.push(root);
      act(() => root.render(inJa(createElement(FactoryBand, { data: null }))));
      return container.querySelector("section[data-factory] .fxband-wait");
    };
    expect(one(1280, 720)?.classList.contains("fxband-wait--open")).toBe(false);
    expect(one(1440, 1600)?.classList.contains("fxband-wait--open")).toBe(true);
    saveFactoryPref("collapsed");
    expect(one(1440, 1600)?.classList.contains("fxband-wait--open")).toBe(false);
    stubNarrow(true);
    saveFactoryPref("expanded");
    expect(one(1440, 1600)?.classList.contains("fxband-wait--open")).toBe(false);
  });
});

describe("FactoryPanel（帯の中身）", () => {
  it("背の高い画面（広げても .main に高さが残る）では、既定で断面図を広げる", () => {
    const c = mount();
    expect(toggle(c).getAttribute("aria-expanded")).toBe("true");
    expect(summary(c)).toBeNull();
    expect(c.querySelector(".fx-stage svg.fx-svg")).not.toBeNull();
  });

  it("背の低い画面（1280×720・1440×1000）では、既定はたたんだ人数の 1 行。ボタンで広げられる", () => {
    for (const [w, h] of [
      [1280, 720],
      [1440, 1000],
    ] as const) {
      document.body.innerHTML = "";
      screenSize(w, h);
      const c = mount();
      expect(toggle(c).getAttribute("aria-expanded"), `${w}x${h}`).toBe("false");
      expect(summary(c)).not.toBeNull();
      expect(c.querySelector(".fx-stage")).toBeNull();
      act(() => toggle(c).click());
      expect(c.querySelector(".fx-stage svg.fx-svg")).not.toBeNull();
      expect(localStorage.getItem(FACTORY_PREF_KEY)).toBe("0");
      localStorage.clear();
    }
  });

  it("保存した好み（たたむ / 広げる）は画面の高さより優先", () => {
    screenSize(1280, 720);
    saveFactoryPref("expanded");
    expect(toggle(mount()).getAttribute("aria-expanded")).toBe("true");
    document.body.innerHTML = "";
    screenSize(1440, 1600);
    saveFactoryPref("collapsed");
    expect(toggle(mount()).getAttribute("aria-expanded")).toBe("false");
  });

  it("たたむと「部屋ごとの人数」の 1 行。状態はブラウザに覚え、描き直しても保たれる", () => {
    const c = mount();
    act(() => toggle(c).click());
    expect(toggle(c).getAttribute("aria-expanded")).toBe("false");
    const s = summary(c);
    expect(s).not.toBeNull();
    expect(c.querySelector(".fx-stage")).toBeNull();
    expect(localStorage.getItem(FACTORY_PREF_KEY)).toBe("1");
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
    expect(localStorage.getItem(FACTORY_PREF_KEY)).toBe("0");
  });

  it("人数の 1 行はタスクへのリンクや data-task を持たない（人数と人の色だけ）", () => {
    saveFactoryPref("collapsed");
    const c = mount();
    expect(summary(c)?.querySelector("[data-task]")).toBeNull();
    expect(summary(c)?.querySelector("a")).toBeNull();
  });

  it("狭い幅（720px 以下）は断面図を出さず、たたんだときと同じ簡略版。たたむボタンも出さない", () => {
    stubNarrow(true);
    saveFactoryPref("expanded");
    const c = mount();
    expect(summary(c)).not.toBeNull();
    expect(toggle(c)).toBeNull();
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
    saveFactoryPref("collapsed");
    const none: OverviewDto = {
      ...overviewFixture,
      tasks: [{ ...(overviewFixture.tasks[2] as VisibleTaskDto) }],
    };
    const c = mount(none);
    expect(c.querySelector(".fxband-bar")).not.toBeNull();
    expect(summary(c)?.querySelector('[data-room="code"]')?.getAttribute("data-n")).toBe("0");
  });
});

describe("factory-prefs: 工場の帯の好み（たたむ / 広げる / 未設定）", () => {
  it("'1' はたたむ、'0' は広げる、それ以外・読めないときは未設定（画面の高さで決める）。保存できなくても動く", () => {
    const mem = new Map<string, string>();
    const s = {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v),
    };
    expect(loadFactoryPref(s)).toBeNull();
    saveFactoryPref("collapsed", s);
    expect(loadFactoryPref(s)).toBe("collapsed");
    saveFactoryPref("expanded", s);
    expect(loadFactoryPref(s)).toBe("expanded");
    mem.set(FACTORY_PREF_KEY, "x");
    expect(loadFactoryPref(s)).toBeNull();
    const broken = {
      getItem: () => {
        throw new Error("x");
      },
      setItem: () => {
        throw new Error("x");
      },
    };
    expect(loadFactoryPref(broken)).toBeNull();
    expect(() => saveFactoryPref("collapsed", broken)).not.toThrow();
  });
});
