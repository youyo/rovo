import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { MAX_REPO_IDS, type TaskIndexSnapshot } from "../../src/directory/types";

/** テストごとに別の Directory（名前を変える）を使う。本番はシングルトン。 */
let seq = 0;
const dir = () => env.DIRECTORY_DO.getByName(`unit-${Date.now()}-${seq++}`);

const T0 = Date.UTC(2026, 9, 1, 0, 0, 0);
const HOUR = 3_600_000;

function snap(id: string, over: Partial<TaskIndexSnapshot> = {}): TaskIndexSnapshot {
  return {
    task_id: id,
    owner_id: 1,
    owner_login: "alice",
    repository: "acme/widgets",
    repository_id: 100,
    title: "t",
    status: "RUNNING",
    model: "anthropic/claude-sonnet-5-5",
    effort: "medium",
    created_at: T0,
    updated_at: T0,
    started_at: T0,
    ended_at: null,
    cost_micro: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    pr_number: null,
    pr_url: null,
    pr_draft: null,
    pr_merged: false,
    reason: null,
    failure_phase: null,
    deps_cache: null,
    sandbox_runtime_ms: null,
    ...over,
  };
}

const range = { from: T0 - HOUR, to: T0 + 24 * HOUR };

describe("DirectoryDO.upsertTask（revision）", () => {
  it("新しい revision は反映し、古い・同じ revision は無視する（順序の逆転・重複で逆戻りしない）", async () => {
    const d = dir();
    expect(await d.upsertTask(snap("A", { status: "RUNNING", cost_micro: 5 }), 2)).toEqual({
      ok: true,
      applied: true,
      revision: 2,
    });
    // 古い revision（遅れて届いた）
    expect(await d.upsertTask(snap("A", { status: "CREATING", cost_micro: 1 }), 1)).toEqual({
      ok: true,
      applied: false,
      revision: 2,
    });
    // 同じ revision（重複）。中身が違っても上書きしない
    expect(await d.upsertTask(snap("A", { status: "FAILED", cost_micro: 99 }), 2)).toMatchObject({
      applied: false,
    });
    let list = await d.listTasks({ repoIds: [100], ...range, limit: 10, offset: 0 });
    if (!list.ok) throw new Error("list failed");
    expect(list.rows).toHaveLength(1);
    expect(list.rows[0]).toMatchObject({ status: "RUNNING", cost_micro: 5, revision: 2 });
    // 新しい revision は反映
    expect(await d.upsertTask(snap("A", { status: "COMPLETED", cost_micro: 7 }), 3)).toMatchObject({
      applied: true,
    });
    list = await d.listTasks({ repoIds: [100], ...range, limit: 10, offset: 0 });
    if (!list.ok) throw new Error("list failed");
    expect(list.rows[0]).toMatchObject({ status: "COMPLETED", cost_micro: 7, revision: 3 });
  });

  it("revision はタスクごと。別のタスクは互いに影響しない", async () => {
    const d = dir();
    await d.upsertTask(snap("A"), 10);
    expect(await d.upsertTask(snap("B"), 1)).toMatchObject({ applied: true });
  });

  it("不正な入力は保存しない（revision が整数でない・0 以下、余計な項目、型違い）", async () => {
    const d = dir();
    expect(await d.upsertTask(snap("A"), 0)).toEqual({ ok: false, code: "invalid_input" });
    expect(await d.upsertTask(snap("A"), 1.5)).toEqual({ ok: false, code: "invalid_input" });
    expect(await d.upsertTask({ ...snap("A"), instructions: "secret" } as never, 1)).toEqual({
      ok: false,
      code: "invalid_input",
    });
    expect(await d.upsertTask({ ...snap("A"), cost_micro: "1" } as never, 1)).toEqual({
      ok: false,
      code: "invalid_input",
    });
    const list = await d.listTasks({ repoIds: [100], ...range, limit: 10, offset: 0 });
    expect(list).toMatchObject({ ok: true, total: 0 });
  });
});

describe("DirectoryDO.listTasks（repoIds で絞ってからページを切る）", () => {
  async function seed() {
    const d = dir();
    // repo 100: 5 件、repo 200: 5 件、repository_id が NULL: 3 件
    for (let i = 0; i < 5; i++) {
      await d.upsertTask(snap(`A${i}`, { repository_id: 100, created_at: T0 + i * 1000 }), 1);
      await d.upsertTask(snap(`B${i}`, { repository_id: 200, created_at: T0 + i * 1000 + 500 }), 1);
    }
    for (let i = 0; i < 3; i++) {
      await d.upsertTask(
        snap(`N${i}`, { repository_id: null, created_at: T0 + 10_000 + i, cost_micro: 1_000_000 }),
        1,
      );
    }
    return d;
  }

  it("件数・ページ・中身が同じ集合で揃う（絞る前に切らない）", async () => {
    const d = await seed();
    // 見えるのは repo 100 だけ。新しい順（created_at DESC, task_id）
    const page1 = await d.listTasks({ repoIds: [100], ...range, limit: 2, offset: 0 });
    const page3 = await d.listTasks({ repoIds: [100], ...range, limit: 2, offset: 4 });
    if (!page1.ok || !page3.ok) throw new Error("list failed");
    expect(page1.total).toBe(5);
    expect(page1.rows.map((r) => r.task_id)).toEqual(["A4", "A3"]);
    expect(page3.total).toBe(5);
    expect(page3.rows.map((r) => r.task_id)).toEqual(["A0"]);
  });

  it("repository_id が NULL の行は、どの repoIds にも現れない", async () => {
    const d = await seed();
    const all = await d.listTasks({ repoIds: [100, 200, 0, -1], ...range, limit: 100, offset: 0 });
    if (!all.ok) throw new Error("list failed");
    expect(all.total).toBe(10);
    expect(all.rows.some((r) => r.repository_id === null)).toBe(false);
    const none = await d.listTasks({ repoIds: [], ...range, limit: 100, offset: 0 });
    expect(none).toMatchObject({ ok: true, total: 0, rows: [] });
  });

  it("ownerId で自分のタスクに絞れる", async () => {
    const d = dir();
    await d.upsertTask(snap("A", { owner_id: 1 }), 1);
    await d.upsertTask(snap("B", { owner_id: 2 }), 1);
    const r = await d.listTasks({ repoIds: [100], ...range, ownerId: 2, limit: 10, offset: 0 });
    if (!r.ok) throw new Error("list failed");
    expect(r.rows.map((x) => x.task_id)).toEqual(["B"]);
  });

  it("範囲（from / to）と重なるタスクだけ。終了していないタスクは to より前に始まっていれば重なる", async () => {
    const d = dir();
    await d.upsertTask(
      snap("old", { created_at: T0 - 10 * HOUR, ended_at: T0 - 9 * HOUR, status: "COMPLETED" }),
      1,
    );
    await d.upsertTask(
      snap("straddle", { created_at: T0 - 2 * HOUR, ended_at: T0 + HOUR, status: "COMPLETED" }),
      1,
    );
    await d.upsertTask(snap("running", { created_at: T0 - 5 * HOUR, ended_at: null }), 1);
    await d.upsertTask(snap("future", { created_at: T0 + 5 * HOUR }), 1);
    const r = await d.listTasks({
      repoIds: [100],
      from: T0,
      to: T0 + 2 * HOUR,
      limit: 10,
      offset: 0,
    });
    if (!r.ok) throw new Error("list failed");
    expect(r.rows.map((x) => x.task_id).sort()).toEqual(["running", "straddle"]);
    expect(r.total).toBe(2);
  });

  it("limit は上限で丸め、不正な入力は invalid_input、repoIds が多すぎれば fail closed", async () => {
    const d = dir();
    expect(await d.listTasks({ repoIds: [1], ...range, limit: 0, offset: 0 })).toEqual({
      ok: false,
      code: "invalid_input",
    });
    expect(await d.listTasks({ repoIds: ["x"] as never, ...range, limit: 1, offset: 0 })).toEqual({
      ok: false,
      code: "invalid_input",
    });
    const many = Array.from({ length: MAX_REPO_IDS + 1 }, (_, i) => i + 1);
    expect(await d.listTasks({ repoIds: many, ...range, limit: 1, offset: 0 })).toEqual({
      ok: false,
      code: "too_many_repo_ids",
    });
    // 上限ちょうどは通る
    expect(
      await d.listTasks({ repoIds: many.slice(0, MAX_REPO_IDS), ...range, limit: 1, offset: 0 }),
    ).toMatchObject({ ok: true });
  });
});

describe("DirectoryDO.summarize（見える / 見えないの集計）", () => {
  it("見えるタスクと、権限の無いタスク（NULL を含む）の件数・費用を分け、モデル別は全員分", async () => {
    const d = dir();
    await d.upsertTask(snap("A", { repository_id: 100, cost_micro: 1_000_000, model: "m1" }), 1);
    await d.upsertTask(snap("B", { repository_id: 200, cost_micro: 2_000_000, model: "m1" }), 1);
    await d.upsertTask(snap("C", { repository_id: null, cost_micro: 4_000_000, model: "m2" }), 1);
    // 月の範囲外
    await d.upsertTask(snap("D", { created_at: T0 - 40 * 24 * HOUR, cost_micro: 8_000_000 }), 1);
    const s = await d.summarize({ repoIds: [100], from: T0 - HOUR, to: T0 + 31 * 24 * HOUR });
    expect(s).toEqual({
      ok: true,
      visible: { count: 1, cost_micro: 1_000_000 },
      hidden: { count: 2, cost_micro: 6_000_000 },
      models: [
        { model: "m1", cost_micro: 3_000_000 },
        { model: "m2", cost_micro: 4_000_000 },
      ],
    });
  });
});

describe("DirectoryDO.visibleModels（見えるタスクが使ったモデルの名前だけ）", () => {
  it("見えるタスクのモデルだけを重複なしで返す。見えない・NULL・範囲外のタスクのモデルは返さない", async () => {
    const d = dir();
    await d.upsertTask(snap("A", { repository_id: 100, model: "m1", cost_micro: 5 }), 1);
    await d.upsertTask(snap("B", { repository_id: 100, model: "m1" }), 1);
    await d.upsertTask(snap("C", { repository_id: 100, model: "m3" }), 1);
    await d.upsertTask(snap("D", { repository_id: 200, model: "m2" }), 1);
    await d.upsertTask(snap("E", { repository_id: null, model: "m4" }), 1);
    await d.upsertTask(
      snap("F", { repository_id: 100, model: "m5", created_at: T0 - 40 * 24 * HOUR }),
      1,
    );
    const r = await d.visibleModels({ repoIds: [100], from: T0 - HOUR, to: T0 + 31 * 24 * HOUR });
    expect(r).toEqual({ ok: true, models: ["m1", "m3"] });
    // 集合が空なら何も返さない（「制限なし」ではない）
    expect(await d.visibleModels({ repoIds: [], from: T0 - HOUR, to: T0 + HOUR })).toEqual({
      ok: true,
      models: [],
    });
  });

  it("不正な入力・大きすぎる集合は失敗（fail closed）", async () => {
    const d = dir();
    expect(
      await d.visibleModels({ repoIds: ["x"] as unknown as number[], from: 0, to: 1 }),
    ).toEqual({ ok: false, code: "invalid_input" });
    const big = Array.from({ length: MAX_REPO_IDS + 1 }, (_, i) => i);
    expect(await d.visibleModels({ repoIds: big, from: 0, to: 1 })).toEqual({
      ok: false,
      code: "too_many_repo_ids",
    });
  });
});

describe("DirectoryDO.listOwnerIds（月に動きのあった利用者。全員分の台帳を集める宛先）", () => {
  it("期間内のタスク・consult の所有者を重複なく返す。期間外だけの所有者は含めない", async () => {
    const d = dir();
    await d.upsertTask(snap("A", { owner_id: 11 }), 1);
    await d.upsertTask(snap("B", { owner_id: 11 }), 1);
    await d.upsertTask(snap("C", { owner_id: 12 }), 1);
    await d.upsertTask(snap("D", { owner_id: 13, created_at: T0 - 40 * 24 * HOUR }), 1);
    await d.upsertConsult(
      {
        consult_id: `consult-${"E".padStart(26, "0")}`,
        owner_id: 14,
        owner_login: "dave",
        at: T0,
        model: "m",
        cost_micro: 1,
        estimated: false,
      },
      1,
    );
    const r = await d.listOwnerIds({ from: T0 - HOUR, to: T0 + 31 * 24 * HOUR });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect([...r.ids].sort((a, b) => a - b)).toEqual([11, 12, 14]);
  });

  it("不正な期間は invalid_input", async () => {
    expect(await dir().listOwnerIds({ from: Number.NaN, to: 1 })).toEqual({
      ok: false,
      code: "invalid_input",
    });
  });
});
