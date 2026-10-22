import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createTask, type TaskStub } from "./pr-helpers";

// 実行中のコマンドの途中の出力（command_progress）。events（履歴）には積まず、最新の 1 件だけを上書きで持つ。
// task_wait / task_status / dashboardEvents には絶対に出ない。command・終端・cancel・ended で消える。
const OWNER = 811;
const REPO_ID = 4242;
const GHP = `ghp_${"a1B2".repeat(9)}`;
const STARTED = Date.UTC(2026, 9, 22, 1, 0, 0);

function sqlRows<T>(stub: TaskStub, sql: string, ...b: unknown[]): Promise<T[]> {
  return runInDurableObject(
    stub,
    (_i, state) => state.storage.sql.exec(sql, ...b).toArray() as T[],
  );
}

async function started() {
  const t = await createTask({}, OWNER);
  await t.stub.advance();
  return t;
}
type Started = Awaited<ReturnType<typeof started>>;

const ingest = (t: Started) => t.stub.advance();
const progressOf = async (t: Started) => {
  const r = await t.stub.dashboardLatest(REPO_ID);
  if (!r.ok) throw new Error("not ok");
  return r.progress;
};
const emitProgress = (t: Started, over: Record<string, unknown> = {}) =>
  t.agent.emit("command_progress", {
    command: "pnpm test",
    startedAt: STARTED,
    outputTail: "step 1\n",
    ...over,
  });

describe("取り込み: command_progress は履歴に積まず、最新の 1 件だけを上書きで持つ", () => {
  it("events テーブルには入らない（汎用の agent_event の行にも落ちない）。dashboardLatest は最新の 1 件を返す", async () => {
    const t = await started();
    const before = await sqlRows<{ n: number }>(t.stub, "SELECT COUNT(*) AS n FROM events");
    await emitProgress(t, { outputTail: "step 1\n" });
    await emitProgress(t, { outputTail: "step 1\nstep 2\n", cwd: "apps/gateway" });
    await ingest(t);
    const after = await sqlRows<{ n: number }>(t.stub, "SELECT COUNT(*) AS n FROM events");
    expect(after[0]?.n).toBe(before[0]?.n);
    const rows = await sqlRows<{ type: string; payload: string }>(
      t.stub,
      "SELECT type, payload FROM events",
    );
    expect(JSON.stringify(rows)).not.toContain("command_progress");
    expect(JSON.stringify(rows)).not.toContain("step 2");
    expect(rows.some((r) => r.type === "agent_event" && r.payload.includes("progress"))).toBe(
      false,
    );

    expect(await progressOf(t)).toMatchObject({
      command: "pnpm test",
      cwd: "apps/gateway",
      started_at: STARTED,
      output_tail: "step 1\nstep 2\n",
    });
    // 取り込みカーソルは進んでいる（再取り込みしても増えない）
    await ingest(t);
    expect(await progressOf(t)).toMatchObject({ output_tail: "step 1\nstep 2\n" });
  });

  it("agent がマスクし忘れた秘密は、保存（どのテーブル）にも平文で残らない", async () => {
    const t = await started();
    await emitProgress(t, {
      command: `curl -H "${["Authorization:", "Bearer", "abcdef0123456789xyz"].join(" ")}" ${GHP}`,
      outputTail: `token ${GHP}\nGITHUB_TOKEN=plain123value\n`,
    });
    await ingest(t);
    const tables = await sqlRows<{ name: string }>(
      t.stub,
      "SELECT name FROM sqlite_master WHERE type = 'table'",
    );
    let whole = "";
    for (const { name } of tables) {
      if (name.startsWith("_cf_") || name.startsWith("sqlite_")) continue;
      whole += JSON.stringify(await sqlRows(t.stub, `SELECT * FROM "${name}"`));
    }
    for (const s of [GHP, "abcdef0123456789xyz", "plain123value"]) {
      expect(whole, s).not.toContain(s);
    }
    expect(JSON.stringify(await progressOf(t))).not.toContain(GHP);
  });
});

describe("command_progress は task_wait・task_status・dashboardEvents に絶対に出ない", () => {
  it("出ない。進捗しか増えなければ待っている task_wait を起こさず、カーソルも動かない", async () => {
    const t = await started();
    await ingest(t);
    const w0 = await t.stub.wait(OWNER, undefined, 0);
    if (!w0.ok) throw new Error("wait failed");
    await emitProgress(t, { outputTail: "SECRET-LOOKING-PROGRESS\n" });
    await ingest(t);
    const w1 = await t.stub.wait(OWNER, w0.cursor, 0);
    if (!w1.ok) throw new Error("wait failed");
    expect(w1.events).toEqual([]);
    expect(w1.cursor).toBe(w0.cursor);

    const all = await t.stub.wait(OWNER, "0", 0);
    const status = await t.stub.getStatus(OWNER);
    const dash = await t.stub.dashboardEvents(REPO_ID, { limit: 200 });
    const result = await t.stub.result(OWNER);
    for (const [name, v] of Object.entries({ all, status, dash, result })) {
      const json = JSON.stringify(v);
      expect(json, name).not.toContain("command_progress");
      expect(json, name).not.toContain("SECRET-LOOKING-PROGRESS");
      expect(json, name).not.toContain("pnpm test");
    }
  });
});

describe("後始末: 進捗は消える", () => {
  it("最後の command イベントで消える", async () => {
    const t = await started();
    await emitProgress(t);
    await ingest(t);
    expect(await progressOf(t)).not.toBeNull();
    await t.agent.emit("command", { command: "pnpm test", exitCode: 0 });
    await ingest(t);
    expect(await progressOf(t)).toBeNull();
  });

  it("ended: true（command を出せずに終わった）で消える", async () => {
    const t = await started();
    await emitProgress(t);
    await ingest(t);
    await emitProgress(t, { ended: true });
    await ingest(t);
    expect(await progressOf(t)).toBeNull();
  });

  it("タスクの終端（COMPLETED）で消える。終端の後に届いた進捗は取り込まない", async () => {
    const t = await started();
    await emitProgress(t);
    await ingest(t);
    expect(await progressOf(t)).not.toBeNull();
    t.agent.setPhase("completed");
    await ingest(t);
    expect((await t.stub.getStatus(OWNER)).ok).toBe(true);
    expect(await progressOf(t)).toBeNull();
    await emitProgress(t, { outputTail: "late\n" });
    await ingest(t);
    expect(await progressOf(t)).toBeNull();
  });

  it("FAILED でも消える", async () => {
    const t = await started();
    await emitProgress(t);
    await ingest(t);
    t.agent.setPhase("failed", "boom");
    await ingest(t);
    expect(await progressOf(t)).toBeNull();
  });

  it("cancel で消える（取り消したタスクが永遠に実行中に見えない）", async () => {
    const t = await started();
    await emitProgress(t);
    await ingest(t);
    expect(await progressOf(t)).not.toBeNull();
    const r = await t.stub.cancel(OWNER);
    expect(r.ok).toBe(true);
    expect(await progressOf(t)).toBeNull();
    // cancel の後に agent から進捗が届いても出ない
    await emitProgress(t, { outputTail: "late\n" });
    await ingest(t);
    expect(await progressOf(t)).toBeNull();
  });
});
