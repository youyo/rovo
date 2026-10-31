import type { OverviewDto, VisibleTaskDto } from "@rovo/dashboard-contract";
import { HIDDEN_TASK_SENTINELS, overviewFixture } from "@rovo/dashboard-contract/fixtures";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { personIndex, roomCapacity } from "../src/factory";
import FactoryScene, { walkPath } from "../src/factory-scene";
import { BROWSER_CLICKS, clickLink } from "./click-link";
import { inEn, inJa } from "./lang";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: { unmount: () => void }[] = [];
const restores: (() => void)[] = [];
const lastAnim: { current: Animation | null } = { current: null };
afterEach(() => {
  for (const r of restores.splice(0)) r();
  for (const r of roots.splice(0)) act(() => r.unmount());
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const base = overviewFixture.tasks[3] as VisibleTaskDto;
let seq = 0;
const task = (over: Partial<VisibleTaskDto>): VisibleTaskDto => {
  seq++;
  return {
    ...base,
    task_id: `01JZ00000000000000000${String(seq).padStart(5, "0")}`,
    created_at: `2026-10-21T01:${String(seq % 60).padStart(2, "0")}:00Z`,
    ...over,
  };
};
const withTasks = (tasks: VisibleTaskDto[]): OverviewDto => ({ ...overviewFixture, tasks });

function render(data: OverviewDto, onSelect?: (id: string) => void, lang: "ja" | "en" = "ja") {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const draw = (d: OverviewDto) =>
    act(() => {
      const el = createElement(FactoryScene, { data: d, onSelect });
      root.render(lang === "ja" ? inJa(el) : inEn(el));
    });
  draw(data);
  return { container, draw };
}

const rovo = (c: Element, id: string) => c.querySelector(`a[data-task="${id}"]`);

describe("FactoryScene（工場の断面図）", () => {
  const code = task({ stage: "code", owner_login: "alice-example" });
  const wait = task({ stage: "wait", owner_login: "bob-example" });
  const research = task({ stage: "research" });
  const ready = task({ stage: "ready", status: "COMPLETED" });
  const merged = task({ stage: "merged", status: "COMPLETED" });
  const done = task({ stage: "done", status: "FAILED" });
  const review = task({ stage: "review", kind: "review" });
  const data = withTasks([code, wait, research, ready, merged, done, review]);

  it("1 タスク = 1 体の Rovo。部屋は stage から。done と kind = review は出さない", () => {
    const { container } = render(data);
    expect(rovo(container, code.task_id)?.getAttribute("data-room")).toBe("code");
    expect(rovo(container, wait.task_id)?.getAttribute("data-room")).toBe("wait");
    expect(rovo(container, research.task_id)?.getAttribute("data-room")).toBe("research");
    expect(rovo(container, ready.task_id)?.getAttribute("data-room")).toBe("ready");
    expect(rovo(container, merged.task_id)?.getAttribute("data-room")).toBe("shipped");
    expect(rovo(container, done.task_id)).toBeNull();
    expect(rovo(container, review.task_id)).toBeNull();
    expect(container.querySelectorAll("a[data-task]")).toHaveLength(5);
  });

  it("Rovo はタスクへのリンク。名前に題名・人・部屋。修飾キー無しの左クリックだけ onSelect（ページを読み直さない）", () => {
    const onSelect = vi.fn();
    const { container } = render(data, onSelect);
    const a = rovo(container, code.task_id) as Element;
    expect(a.getAttribute("href")).toBe(`/dashboard/tasks/${code.task_id}`);
    expect(a.getAttribute("aria-label")).toContain(code.title);
    expect(a.getAttribute("aria-label")).toContain("alice-example");
    expect(a.getAttribute("aria-label")).toContain("コーディング");
    expect(clickLink(a)).toBe(true);
    expect(onSelect).toHaveBeenCalledWith(code.task_id);
    for (const c of BROWSER_CLICKS) {
      onSelect.mockClear();
      expect(clickLink(a, c.init), c.name).toBe(false);
      expect(onSelect, c.name).not.toHaveBeenCalled();
    }
  });

  it("人の色はログイン名から決めたクラス（.p0〜.p5）。頭文字のバッジを添える（色だけに頼らない）", () => {
    const { container } = render(data);
    const a = rovo(container, code.task_id) as Element;
    expect(a.getAttribute("data-person")).toBe(String(personIndex("alice-example")));
    expect(a.querySelector(`.p${personIndex("alice-example")}`)).not.toBeNull();
    expect(a.querySelector(".fx-badge")?.textContent).toBe("A");
  });

  it("工程ごとの動作のクラス（コーディング = 打鍵、返事待ち = ?の札、調査 = 虫めがね、Ready = 箱に座る）", () => {
    const { container } = render(data);
    expect(rovo(container, code.task_id)?.querySelector(".fx-type")).not.toBeNull();
    expect(rovo(container, wait.task_id)?.querySelector(".fx-ask")).not.toBeNull();
    expect(rovo(container, research.task_id)?.querySelector(".fx-scan")).not.toBeNull();
    expect(rovo(container, ready.task_id)?.querySelector(".fx-rest")).not.toBeNull();
  });

  it("定員を超えた部屋は 定員 − 1 体 + 「+n」のタイル（残りの人ごとの割合の帯）", () => {
    const cap = roomCapacity("review");
    const many = Array.from({ length: cap + 3 }, (_, i) =>
      task({ stage: "review", owner_login: i % 2 ? "alice-example" : "bob-example" }),
    );
    const { container } = render(withTasks(many));
    expect(container.querySelectorAll('a[data-room="review"]')).toHaveLength(cap - 1);
    const tile = container.querySelector("[data-factory-more]");
    expect(tile?.getAttribute("data-factory-more")).toBe("4");
    expect(tile?.textContent).toContain("+4");
    expect(tile?.querySelectorAll(".fx-pc").length).toBeGreaterThanOrEqual(1);
  });

  it("管制室: フロアマップの件数、Sandbox の枠（running_slots / concurrency_limit）", () => {
    const { container } = render(data);
    const n = (p: string) => container.querySelector(`[data-map="${p}"]`)?.getAttribute("data-n");
    expect(n("code")).toBe("1");
    expect(n("wait")).toBe("1");
    expect(n("shipped")).toBe("1");
    expect(n("review")).toBe("0");
    expect(container.querySelector("[data-factory-slots]")?.textContent).toBe(
      `${data.budget.running_slots}/${data.budget.concurrency_limit}`,
    );
  });

  it("style 属性を作らない（CSP の style-src 'self'）。見えないタスクの値は DOM に出ない", () => {
    const { container } = render(overviewFixture);
    expect(container.querySelectorAll("[style]")).toHaveLength(0);
    const html = container.innerHTML;
    expect(html).not.toContain(HIDDEN_TASK_SENTINELS.task_id);
    expect(html).not.toContain(HIDDEN_TASK_SENTINELS.owner_login);
  });

  it("英語の表示では部屋の名前も英語", () => {
    const { container } = render(data, undefined, "en");
    expect(rovo(container, code.task_id)?.getAttribute("aria-label")).toContain("Coding");
  });
});

describe("工程が変わった Rovo の移動（FLIP。element.animate）", () => {
  const stubAnimate = () => {
    const calls: { el: Element; frames: Keyframe[] }[] = [];
    const anim = { onfinish: null, oncancel: null, cancel() {} } as unknown as Animation;
    lastAnim.current = anim;
    // jsdom は Web Animations API を持たないので、テストの間だけ足す
    const proto = Element.prototype as { animate?: unknown };
    const had = Object.hasOwn(proto, "animate");
    const before = proto.animate;
    proto.animate = function (this: Element, frames: Keyframe[]) {
      calls.push({ el: this, frames });
      return anim;
    };
    restores.push(() => {
      if (had) proto.animate = before;
      else delete proto.animate;
    });
    return calls;
  };

  it("初回は動かない。部屋が変わった Rovo だけ、前の部屋から歩いて今の場所に着く", () => {
    const calls = stubAnimate();
    const a = task({ stage: "code" });
    const b = task({ stage: "code" });
    const { draw } = render(withTasks([a, b]));
    expect(calls).toHaveLength(0);
    draw(withTasks([{ ...a, stage: "verify" }, b]));
    expect(calls).toHaveLength(1);
    const { el, frames } = calls[0] as { el: Element; frames: Keyframe[] };
    expect(el.closest("a")?.getAttribute("data-task")).toBe(a.task_id);
    expect(el.classList.contains("fx-walking")).toBe(true);
    expect(frames.at(-1)?.transform).toBe("translate(0px, 0px)");
    expect(frames).toHaveLength(4);
  });

  it("歩いている間は、ポーリングで並び順が変わっても歩く姿（fx-walking）のまま。歩き終えると戻る", () => {
    const calls = stubAnimate();
    const a = task({ stage: "code", owner_login: "m-user" });
    const { draw, container } = render(withTasks([a]));
    draw(withTasks([{ ...a, stage: "verify" }]));
    expect(calls).toHaveLength(1);
    const mover = () => container.querySelector(`a[data-task="${a.task_id}"] .fx-mover`) as Element;
    expect(mover().classList.contains("fx-walking")).toBe(true);
    // 同じ部屋の前に別の人の Rovo が入り、並びの番号（待機の動作のずらし）が変わる
    const before = task({ stage: "verify", owner_login: "a-user" });
    draw(withTasks([before, { ...a, stage: "verify" }]));
    expect(mover().classList.contains("fx-walking")).toBe(true);
    // 歩き終える
    act(() => (lastAnim.current?.onfinish as (() => void) | null)?.());
    expect(mover().classList.contains("fx-walking")).toBe(false);
  });

  it("階をまたぐときはエレベーター（横に歩く → かご → 横に歩く）", () => {
    const calls = stubAnimate();
    const a = task({ stage: "code" });
    const { draw } = render(withTasks([a]));
    draw(withTasks([{ ...a, stage: "research" }]));
    expect(calls[0]?.frames).toHaveLength(6);
  });

  it("prefers-reduced-motion では動かさない", () => {
    const calls = stubAnimate();
    vi.stubGlobal("matchMedia", (q: string) => ({
      matches: q.includes("reduce"),
      media: q,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    const a = task({ stage: "code" });
    const { draw } = render(withTasks([a]));
    draw(withTasks([{ ...a, stage: "verify" }]));
    expect(calls).toHaveLength(0);
  });

  it("prefers-reduced-motion は、描いている文書の window（PiP の窓）の matchMedia で決める", () => {
    // 元の window は動いてよい設定。PiP の窓（別の document を持つ iframe）だけ reduce
    vi.stubGlobal("matchMedia", (q: string) => ({
      matches: false,
      media: q,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    const one = (reduce: boolean) => {
      const frame = document.createElement("iframe");
      document.body.append(frame);
      const win = frame.contentWindow as Window & typeof globalThis;
      win.matchMedia = ((q: string) => ({
        matches: reduce && q.includes("reduce"),
        media: q,
        addEventListener: () => {},
        removeEventListener: () => {},
      })) as unknown as typeof win.matchMedia;
      const calls: Element[] = [];
      const proto = win.Element.prototype as { animate?: unknown };
      proto.animate = function (this: Element) {
        calls.push(this);
        return { onfinish: null, oncancel: null, cancel() {} };
      };
      const container = win.document.createElement("div");
      win.document.body.append(container);
      const root = createRoot(container);
      roots.push(root);
      const a = task({ stage: "code" });
      const draw = (d: OverviewDto) =>
        act(() => root.render(inJa(createElement(FactoryScene, { data: d }))));
      draw(withTasks([a]));
      draw(withTasks([{ ...a, stage: "verify" }]));
      return calls;
    };
    expect(one(true)).toHaveLength(0);
    // 対照: PiP の窓が reduce でなければ歩く
    expect(one(false)).toHaveLength(1);
  });

  it("作り直し（PiP の窓への付け替えなど）で外すときは、実行中の歩きを止める", () => {
    const cancel = vi.fn();
    const proto = Element.prototype as { animate?: unknown };
    const had = Object.hasOwn(proto, "animate");
    const before = proto.animate;
    proto.animate = () => ({ onfinish: null, oncancel: null, cancel });
    restores.push(() => {
      if (had) proto.animate = before;
      else delete proto.animate;
    });
    const a = task({ stage: "code" });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const draw = (d: OverviewDto) =>
      act(() => root.render(inJa(createElement(FactoryScene, { data: d }))));
    draw(withTasks([a]));
    draw(withTasks([{ ...a, stage: "verify" }]));
    expect(cancel).not.toHaveBeenCalled();
    act(() => root.unmount());
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("walkPath: 同じ階は 前 → 通路 → 横 → 今。階をまたぐと間にエレベーターの縦の移動", () => {
    const same = walkPath({ x: 300, y: 600 }, { x: 600, y: 600 }, "code", "verify");
    expect(same).toHaveLength(4);
    expect(same[1]?.y).toBe(same[2]?.y);
    const cross = walkPath({ x: 300, y: 600 }, { x: 500, y: 300 }, "code", "research");
    expect(cross).toHaveLength(6);
    expect(cross[2]?.x).toBe(cross[3]?.x);
    expect(cross[2]?.y).not.toBe(cross[3]?.y);
  });
});

describe("断面図の文言（factory-i18n.ts。チャンクに置く辞書）", () => {
  it("en と ja は同じキーで、空の文言が無い", async () => {
    const { FACTORY_DICTS } = await import("../src/factory-i18n");
    expect(Object.keys(FACTORY_DICTS.ja).sort()).toEqual(Object.keys(FACTORY_DICTS.en).sort());
    for (const lang of ["en", "ja"] as const)
      for (const [k, v] of Object.entries(FACTORY_DICTS[lang]))
        expect(v, `${lang} ${k}`).not.toBe("");
  });
});
