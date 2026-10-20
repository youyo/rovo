import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { ConsultIndexSnapshot } from "../../src/directory/types";

// DirectoryDO の consult_index（docs/specs/dashboard.md D9 / M3b）。

let seq = 0;
const dir = () => env.DIRECTORY_DO.getByName(`unit-consult-${Date.now()}-${seq++}`);

const T0 = Date.UTC(2026, 9, 1, 0, 0, 0);
const HOUR = 3_600_000;
const MODEL_L = "anthropic/claude-opus-5";
const MODEL_S = "anthropic/claude-sonnet-5-5";

const cid = (id: string) => `consult-${id.padStart(26, "0")}`;

function snap(id: string, over: Partial<ConsultIndexSnapshot> = {}): ConsultIndexSnapshot {
  return {
    consult_id: cid(id),
    owner_id: 1,
    owner_login: "alice",
    at: T0,
    model: MODEL_S,
    cost_micro: 1000,
    estimated: false,
    ...over,
  };
}

const range = { from: T0 - HOUR, to: T0 + 24 * HOUR };

describe("DirectoryDO.upsertConsult（revision）", () => {
  it("新しい revision は反映し、古い・同じ revision は無視する（冪等）", async () => {
    const d = dir();
    expect(await d.upsertConsult(snap("A", { cost_micro: 5 }), 2)).toEqual({
      ok: true,
      applied: true,
      revision: 2,
    });
    expect(await d.upsertConsult(snap("A", { cost_micro: 1 }), 1)).toEqual({
      ok: true,
      applied: false,
      revision: 2,
    });
    expect(await d.upsertConsult(snap("A", { cost_micro: 99 }), 2)).toMatchObject({
      applied: false,
    });
    const list = await d.listConsults({ ...range, limit: 10 });
    if (!list.ok) throw new Error("list failed");
    expect(list.rows).toHaveLength(1);
    expect(list.rows[0]).toMatchObject({ cost_micro: 5, revision: 2, estimated: false });
    expect(await d.upsertConsult(snap("A", { cost_micro: 7, estimated: true }), 3)).toMatchObject({
      applied: true,
    });
    const after = await d.listConsults({ ...range, limit: 10 });
    if (!after.ok) throw new Error("list failed");
    expect(after.rows[0]).toMatchObject({ cost_micro: 7, estimated: true, revision: 3 });
  });

  it("不正な入力は保存しない（revision・余計な項目・型違い）。本文を持つ項目は受け付けない", async () => {
    const d = dir();
    expect(await d.upsertConsult(snap("A"), 0)).toEqual({ ok: false, code: "invalid_input" });
    expect(await d.upsertConsult(snap("A"), 1.5)).toEqual({ ok: false, code: "invalid_input" });
    expect(await d.upsertConsult({ ...snap("A"), text: "secret" } as never, 1)).toEqual({
      ok: false,
      code: "invalid_input",
    });
    expect(await d.upsertConsult({ ...snap("A"), cost_micro: "1" } as never, 1)).toEqual({
      ok: false,
      code: "invalid_input",
    });
    expect(await d.upsertConsult({ ...snap("A"), consult_id: "task-1" }, 1)).toEqual({
      ok: false,
      code: "invalid_input",
    });
    expect(await d.listConsults({ ...range, limit: 10 })).toMatchObject({ ok: true, rows: [] });
  });
});

describe("DirectoryDO.listConsults（タイムラインの点）", () => {
  it("範囲 [from, to) で絞り、新しい順。ownerId で自分に絞れる。件数の上限を超えない", async () => {
    const d = dir();
    await d.upsertConsult(snap("A", { at: T0 }), 1);
    await d.upsertConsult(snap("B", { at: T0 + HOUR, owner_id: 2, owner_login: "bob" }), 1);
    await d.upsertConsult(snap("C", { at: T0 + 2 * HOUR }), 1);
    await d.upsertConsult(snap("D", { at: T0 + 100 * HOUR }), 1); // 範囲外
    const all = await d.listConsults({ ...range, limit: 10 });
    if (!all.ok) throw new Error("list failed");
    expect(all.rows.map((r) => r.consult_id)).toEqual([cid("C"), cid("B"), cid("A")]);
    const mine = await d.listConsults({ ...range, ownerId: 1, limit: 10 });
    if (!mine.ok) throw new Error("list failed");
    expect(mine.rows.map((r) => r.consult_id)).toEqual([cid("C"), cid("A")]);
    const one = await d.listConsults({ ...range, limit: 1 });
    if (!one.ok) throw new Error("list failed");
    expect(one.rows).toHaveLength(1);
    // to は含まない
    const edge = await d.listConsults({ from: T0, to: T0 + HOUR, limit: 10 });
    if (!edge.ok) throw new Error("list failed");
    expect(edge.rows.map((r) => r.consult_id)).toEqual([cid("A")]);
    expect(await d.listConsults({ ...range, limit: 0 })).toEqual({
      ok: false,
      code: "invalid_input",
    });
  });
});

describe("DirectoryDO.summarizeConsults（モデル別の費用）", () => {
  it("全員分の件数・費用・見積もりの分と、モデル別の費用を返す。リポジトリの権限とは無関係", async () => {
    const d = dir();
    await d.upsertConsult(snap("A", { model: MODEL_L, cost_micro: 300 }), 1);
    await d.upsertConsult(
      snap("B", { model: MODEL_L, cost_micro: 200, estimated: true, owner_id: 2 }),
      1,
    );
    await d.upsertConsult(snap("C", { model: MODEL_S, cost_micro: 50 }), 1);
    await d.upsertConsult(snap("D", { model: MODEL_S, cost_micro: 9999, at: T0 + 100 * HOUR }), 1);
    const s = await d.summarizeConsults({ from: T0, to: T0 + 24 * HOUR });
    expect(s).toEqual({
      ok: true,
      count: 3,
      cost_micro: 550,
      estimated_micro: 200,
      models: [
        { model: MODEL_L, cost_micro: 500 },
        { model: MODEL_S, cost_micro: 50 },
      ],
    });
  });

  it("revision の古い再送で集計が二重に増えない", async () => {
    const d = dir();
    await d.upsertConsult(snap("A", { cost_micro: 300 }), 1);
    await d.upsertConsult(snap("A", { cost_micro: 300 }), 1);
    const s = await d.summarizeConsults({ from: T0, to: T0 + HOUR });
    expect(s).toMatchObject({ ok: true, count: 1, cost_micro: 300 });
  });
});
