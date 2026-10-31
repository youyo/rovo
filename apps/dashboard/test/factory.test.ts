import type { VisibleTaskDto } from "@rovo/dashboard-contract";
import { overviewFixture } from "@rovo/dashboard-contract/fixtures";
import { describe, expect, it } from "vitest";
import {
  BOT_GAP,
  BOT_H,
  BOT_W,
  expandsByDefault,
  FACTORY_ROOMS,
  floorMap,
  floorOf,
  groupFactory,
  initialOf,
  layoutRoom,
  moveOf,
  PERSON_COLORS,
  perRow,
  personIndex,
  roomCapacity,
  roomOf,
  SCENE,
  stageHeight,
} from "../src/factory";

const task = (over: Partial<VisibleTaskDto>): VisibleTaskDto => ({
  ...(overviewFixture.tasks[3] as VisibleTaskDto),
  ...over,
});
const id = (n: number) => `01JZ0000000000000000000${String(n).padStart(3, "0")}`;
const noStage = (over: Partial<VisibleTaskDto>): VisibleTaskDto => {
  const { stage: _s, ...rest } = task(over);
  return rest;
};
const openPr = { number: 1, url: "https://github.com/o/r/pull/1", draft: false, merged: false };

describe("roomOf（stage → 部屋）", () => {
  it("stage をそのまま部屋にする（merged は出荷口、done は出さない）", () => {
    expect(roomOf(task({ stage: "prep" }))).toBe("prep");
    expect(roomOf(task({ stage: "code" }))).toBe("code");
    expect(roomOf(task({ stage: "research" }))).toBe("research");
    expect(roomOf(task({ stage: "verify" }))).toBe("verify");
    expect(roomOf(task({ stage: "review" }))).toBe("review");
    expect(roomOf(task({ stage: "wait" }))).toBe("wait");
    expect(roomOf(task({ stage: "ready" }))).toBe("ready");
    expect(roomOf(task({ stage: "merged" }))).toBe("shipped");
    expect(roomOf(task({ stage: "done" }))).toBeNull();
  });

  it("stage が無いときは status から（CREATING → 準備、RUNNING / RECOVERING → コーディング、VERIFYING → 検証、INPUT_REQUIRED → 返事待ち）", () => {
    expect(roomOf(noStage({ status: "CREATING" }))).toBe("prep");
    expect(roomOf(noStage({ status: "RUNNING" }))).toBe("code");
    expect(roomOf(noStage({ status: "RECOVERING" }))).toBe("code");
    expect(roomOf(noStage({ status: "VERIFYING" }))).toBe("verify");
    expect(roomOf(noStage({ status: "INPUT_REQUIRED" }))).toBe("wait");
    expect(roomOf(noStage({ status: "FAILED" }))).toBeNull();
    expect(roomOf(noStage({ status: "CANCELLED" }))).toBeNull();
    expect(roomOf(noStage({ status: "BUDGET_EXCEEDED" }))).toBeNull();
  });

  it("stage が無い COMPLETED は PR の状態で（開いている・不明 → Ready、マージ → 出荷口、閉じた・PR 無し → 出さない）", () => {
    const done = (pr: VisibleTaskDto["pr"]) => noStage({ status: "COMPLETED", pr });
    expect(roomOf(done({ ...openPr, state: "open" }))).toBe("ready");
    expect(roomOf(done({ ...openPr, state: "unknown" }))).toBe("ready");
    expect(roomOf(done({ ...openPr, state: "merged" }))).toBe("shipped");
    expect(roomOf(done({ ...openPr, merged: true, state: "unknown" }))).toBe("shipped");
    expect(roomOf(done({ ...openPr, state: "closed" }))).toBeNull();
    expect(roomOf(done(null))).toBeNull();
  });

  it("kind = review のタスクは stage の有無によらず出さない", () => {
    expect(roomOf(task({ kind: "review", stage: "review" }))).toBeNull();
    expect(roomOf(task({ kind: "review", stage: "code" }))).toBeNull();
    expect(roomOf(noStage({ kind: "review", status: "RUNNING" }))).toBeNull();
  });
});

describe("部屋と階", () => {
  it("1 階 = 準備・コーディング・検証・レビュー・Ready、2 階 = 返事待ち・調査室。出荷口は外（1 階の高さ）", () => {
    expect(FACTORY_ROOMS.filter((r) => r.floor === 1).map((r) => r.id)).toEqual([
      "prep",
      "code",
      "verify",
      "review",
      "ready",
    ]);
    expect(FACTORY_ROOMS.filter((r) => r.floor === 2).map((r) => r.id)).toEqual([
      "wait",
      "research",
    ]);
    expect(floorOf("shipped")).toBe(1);
    expect(floorOf("wait")).toBe(2);
  });

  it("Rovo は各部屋 1 段。定員は横に並ぶ数で、部屋の幅で決まる", () => {
    for (const r of FACTORY_ROOMS) {
      expect(roomCapacity(r.id)).toBe(perRow(r.id));
      expect(roomCapacity(r.id)).toBeGreaterThanOrEqual(3);
      // 並べた Rovo が部屋の幅に収まる
      expect(perRow(r.id) * BOT_W + (perRow(r.id) - 1) * BOT_GAP).toBeLessThanOrEqual(r.w);
    }
    expect(roomCapacity("code")).toBeGreaterThan(roomCapacity("review"));
  });

  it("断面図は横長（縦横比 5:1 前後）。1 階と 2 階は重ならず、部屋は建物の中に収まる", () => {
    expect(SCENE.w / SCENE.h).toBeGreaterThan(4.5);
    expect(SCENE.w / SCENE.h).toBeLessThan(6);
    for (const r of FACTORY_ROOMS) {
      expect(r.x).toBeGreaterThanOrEqual(0);
      expect(r.x + r.w).toBeLessThanOrEqual(SCENE.w);
      expect(r.y + r.h).toBeLessThanOrEqual(SCENE.h);
      expect(r.h).toBeGreaterThanOrEqual(BOT_H + 20);
    }
    const top = Math.max(...FACTORY_ROOMS.filter((r) => r.floor === 2).map((r) => r.y + r.h));
    const bottom = Math.min(...FACTORY_ROOMS.filter((r) => r.floor === 1).map((r) => r.y));
    expect(top).toBeLessThanOrEqual(bottom);
  });
});

describe("layoutRoom（定員を超えたら 定員 − 1 体 + 「+n」）", () => {
  const people = (logins: string[]) =>
    logins.map((login, i) => task({ task_id: id(i), owner_login: login }));

  it("定員以下ならすべて出す", () => {
    const l = layoutRoom(people(["a", "b", "c"]), 4);
    expect(l.shown).toHaveLength(3);
    expect(l.more).toBe(0);
    expect(l.moreShares).toEqual([]);
  });

  it("ちょうど定員なら +n を出さない", () => {
    const l = layoutRoom(people(["a", "b", "c", "d"]), 4);
    expect(l.shown).toHaveLength(4);
    expect(l.more).toBe(0);
  });

  it("定員を超えたら 定員 − 1 体を出し、残りを +n にまとめる。残りの人ごとの件数（割合の帯）", () => {
    const l = layoutRoom(people(["a", "a", "b", "b", "b", "c", "a"]), 4);
    expect(l.shown).toHaveLength(3);
    expect(l.more).toBe(4);
    const total = l.moreShares.reduce((n, s) => n + s.n, 0);
    expect(total).toBe(4);
    for (const s of l.moreShares) {
      expect(s.person).toBe(personIndex(s.login));
      expect(s.n).toBeGreaterThan(0);
    }
  });
});

describe("personIndex（人の色。ログイン名から決め、ポーリングをまたいで変わらない）", () => {
  it("同じログイン名なら常に同じ番号。0〜5", () => {
    for (const login of ["alice-example", "bob-example", "youyo", "x"]) {
      const n = personIndex(login);
      expect(n).toBe(personIndex(login));
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThan(PERSON_COLORS);
    }
    expect(PERSON_COLORS).toBe(6);
  });

  it("見えた順に依存しない（関数の引数はログイン名だけ）", () => {
    const a = personIndex("carol-example");
    personIndex("zed");
    personIndex("aaa");
    expect(personIndex("carol-example")).toBe(a);
  });

  it("多くの名前が 6 色に散らばる", () => {
    const seen = new Set(Array.from({ length: 60 }, (_, i) => personIndex(`user-${i}`)));
    expect(seen.size).toBe(6);
  });

  it("頭文字は大文字 1 字", () => {
    expect(initialOf("alice-example")).toBe("A");
    expect(initialOf("9lives")).toBe("9");
  });
});

describe("groupFactory / floorMap（管制室のフロアマップ）", () => {
  const list = [
    task({ task_id: id(1), stage: "code", owner_login: "b" }),
    task({ task_id: id(2), stage: "code", owner_login: "a" }),
    task({ task_id: id(3), stage: "wait" }),
    task({ task_id: id(4), stage: "merged" }),
    task({ task_id: id(5), stage: "done" }),
    task({ task_id: id(6), stage: "review", kind: "review" }),
    task({ task_id: id(7), stage: "ready" }),
  ];

  it("部屋ごとに分け、出荷口は別。出さないものは入らない", () => {
    const g = groupFactory(list);
    expect(g.rooms.code.map((t) => t.task_id)).toEqual([id(2), id(1)]);
    expect(g.rooms.wait).toHaveLength(1);
    expect(g.rooms.review).toHaveLength(0);
    expect(g.shipped.map((t) => t.task_id)).toEqual([id(4)]);
  });

  it("部屋の並びは人 → 作成時刻 → ID で安定（ポーリングで入れ替わらない）", () => {
    const g1 = groupFactory(list);
    const g2 = groupFactory([...list].reverse());
    expect(g2.rooms.code.map((t) => t.task_id)).toEqual(g1.rooms.code.map((t) => t.task_id));
  });

  it("フロアマップの件数（部屋ごと + 出荷）", () => {
    expect(floorMap(list)).toEqual({
      prep: 0,
      code: 2,
      verify: 0,
      review: 0,
      ready: 1,
      wait: 1,
      research: 0,
      shipped: 1,
    });
  });
});

describe("moveOf（工程が変わった Rovo の移動。前回の部屋 → 今回の部屋）", () => {
  it("前回が無い・同じ部屋なら動かない", () => {
    expect(moveOf(undefined, "code")).toBeNull();
    expect(moveOf("code", "code")).toBeNull();
    expect(moveOf("code", null)).toBeNull();
  });

  it("同じ階の移動は歩くだけ", () => {
    expect(moveOf("code", "verify")).toEqual({ from: "code", to: "verify", crossFloor: false });
    expect(moveOf("ready", "shipped")).toEqual({ from: "ready", to: "shipped", crossFloor: false });
  });

  it("階をまたぐ移動はエレベーター", () => {
    expect(moveOf("code", "research")).toEqual({ from: "code", to: "research", crossFloor: true });
    expect(moveOf("wait", "code")).toEqual({ from: "wait", to: "code", crossFloor: true });
  });
});

describe("背の低い画面では最初はたたむ（広げてもコンソールに高さが残る画面だけ広げる）", () => {
  it("断面図の高さは幅に合わせて縮み、拡大しない（上限は最大幅のとき）", () => {
    expect(stageHeight(SCENE.w)).toBeCloseTo(SCENE.h, 0);
    expect(stageHeight(SCENE.w / 2)).toBeCloseTo(SCENE.h / 2, 0);
    expect(stageHeight(4000)).toBe(stageHeight(10000));
    expect(stageHeight(4000)).toBeLessThanOrEqual(310);
  });

  it("広げてもコンソールの画面（.screen）に 700px 前後が残る高さ（.main ≥ 1110）のときだけ、既定で広げる", () => {
    expect(expandsByDefault(1280, 720)).toBe(false);
    expect(expandsByDefault(1440, 900)).toBe(false);
    expect(expandsByDefault(1280, 1000)).toBe(false);
    expect(expandsByDefault(1440, 1200)).toBe(false);
    expect(expandsByDefault(1920, 1200)).toBe(false);
    // layout (23) の 1280 × 1400 は .screen に 700px 超が要るので、たたむ
    expect(expandsByDefault(1280, 1400)).toBe(false);
    expect(expandsByDefault(1440, 1600)).toBe(true);
    expect(expandsByDefault(2560, 1600)).toBe(true);
    for (const [w, h] of [
      [1280, 1600],
      [1440, 1600],
      [2560, 1600],
    ] as const) {
      if (expandsByDefault(w, h)) expect(h - stageHeight(w)).toBeGreaterThanOrEqual(1238);
    }
  });
});
