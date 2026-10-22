import { runInDurableObject } from "cloudflare:test";
import { TaskEventDtoSchema } from "@rovo/dashboard-contract";
import { describe, expect, it } from "vitest";
import { toEventDto } from "../../src/dashboard/events";
import { createTask, type TaskStub } from "./pr-helpers";

// TaskDO の構造化イベントの保存と、ダッシュボード専用の読み取り（dashboardEvents）。
// MCP の task_wait にはこの型を出さない（既存のスナップショットが変わらない）。
const OWNER = 801;
const REPO_ID = 4242;
const GHP = `ghp_${"a1B2".repeat(9)}`;
const GHS = `ghs_${"c3D4".repeat(9)}`;
const SHA = "0123456789abcdef0123456789abcdef01234567";

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

async function ingest(t: Awaited<ReturnType<typeof started>>) {
  await t.stub.advance();
}

describe("取り込み: 構造化イベントは再マスクして保存する", () => {
  it("agent がマスクし忘れた秘密は、TaskDO の保存（events テーブル）に平文で残らない", async () => {
    const t = await started();
    await t.agent.emit("command", {
      command: `wget --header "Authorization: Bearer ${"abcdef0123456789xyz"}" https://u:s3cretPass@h.example ${GHP}`,
      cwd: "apps/x",
      exitCode: 1,
      durationMs: 5,
      outputTail: `a\nGITHUB_TOKEN=plain123\n${GHS}`,
      secretField: GHP,
    });
    await t.agent.emit("commit", { message: `feat ${GHP}\nbody`, sha: SHA, files: 2 });
    await ingest(t);
    const stored = await sqlRows<{ type: string; payload: string }>(
      t.stub,
      "SELECT type, payload FROM events WHERE type IN ('command','commit') ORDER BY seq",
    );
    expect(stored.map((r) => r.type)).toEqual(["command", "commit"]);
    const whole = JSON.stringify(stored);
    for (const s of [GHP, GHS, "abcdef0123456789xyz", "s3cretPass", "plain123", "secretField"]) {
      expect(whole, s).not.toContain(s);
    }
  });
});

describe("task_wait（MCP）に新しい型を出さない", () => {
  it("command / edit / commit / web は wait の events に出ず、既存の型はそのまま出る。カーソルは進む", async () => {
    const t = await started();
    await t.agent.emit("tool_start", { callId: "c1", name: "bash", summary: "ls" });
    await t.agent.emit("command", { command: "ls", exitCode: 0 });
    await t.agent.emit("edit", { path: "a.ts", op: "modify", added: 1, removed: 0 });
    await t.agent.emit("commit", { message: "m", sha: SHA, files: 1 });
    await t.agent.emit("web", { kind: "search" });
    await t.agent.emit("tool_end", { callId: "c1", name: "bash", isError: false, summary: "ok" });
    await ingest(t);
    const w = await t.stub.wait(OWNER, "0", 0);
    if (!w.ok) throw new Error("wait failed");
    const types = w.events.map((e) => e.type);
    expect(types).toContain("tool_start");
    expect(types).toContain("tool_end");
    for (const hidden of ["command", "edit", "commit", "web"]) {
      expect(types, hidden).not.toContain(hidden);
    }
    expect(JSON.stringify(w)).not.toContain("a.ts");
    // 構造化イベントの後ろの tool_end まで届き、カーソルがそこまで進む
    const next = await t.stub.wait(OWNER, w.cursor, 0);
    if (!next.ok) throw new Error("wait failed");
    expect(next.events).toEqual([]);
  });

  it("構造化イベントだけが増えたときは、待っている task_wait を起こさない（空の応答を返さない）", async () => {
    const t = await started();
    await ingest(t);
    const w0 = await t.stub.wait(OWNER, undefined, 0);
    if (!w0.ok) throw new Error("wait failed");
    await t.agent.emit("command", { command: "ls", exitCode: 0 });
    await ingest(t);
    const w1 = await t.stub.wait(OWNER, w0.cursor, 0);
    if (!w1.ok) throw new Error("wait failed");
    expect(w1.events).toEqual([]);
    expect(w1.cursor).toBe(w0.cursor);
  });
});

describe("dashboardEvents", () => {
  async function seeded(n: number) {
    const t = await started();
    for (let i = 1; i <= n; i++) {
      await t.agent.emit("command", { command: `cmd-${i}`, exitCode: 0 });
    }
    await ingest(t);
    return t;
  }
  const seqs = (r: { ok: true; events: { seq: number }[] }) => r.events.map((e) => e.seq);

  it("既定は末尾（新しい側）から limit 件。seq の昇順で返し、古い側があれば has_older", async () => {
    const t = await seeded(5);
    const r = await t.stub.dashboardEvents(REPO_ID, { limit: 3 });
    if (!r.ok) throw new Error("not ok");
    expect(r.events.map((e) => e.type)).toEqual(["command", "command", "command"]);
    expect(r.events.map((e) => e.payload.command)).toEqual(["cmd-3", "cmd-4", "cmd-5"]);
    expect(r.has_older).toBe(true);
    const all = await t.stub.dashboardEvents(REPO_ID, { limit: 200 });
    if (!all.ok) throw new Error("not ok");
    expect(all.has_older).toBe(false);
    expect(all.events.length).toBeGreaterThanOrEqual(5);
    // seq は昇順
    expect(seqs(all)).toEqual([...seqs(all)].sort((a, b) => a - b));
  });

  it("before: それより古い側を末尾から limit 件。cursor: それより新しいものを古い順に limit 件", async () => {
    const t = await seeded(6);
    const latest = await t.stub.dashboardEvents(REPO_ID, { limit: 2 });
    if (!latest.ok) throw new Error("not ok");
    const oldest = Math.min(...seqs(latest));
    const older = await t.stub.dashboardEvents(REPO_ID, { before: oldest, limit: 2 });
    if (!older.ok) throw new Error("not ok");
    expect(older.events.map((e) => e.payload.command)).toEqual(["cmd-3", "cmd-4"]);
    expect(Math.max(...seqs(older))).toBeLessThan(oldest);

    const first = older.events[0]?.seq ?? 0;
    const newer = await t.stub.dashboardEvents(REPO_ID, { cursor: first, limit: 2 });
    if (!newer.ok) throw new Error("not ok");
    expect(newer.events.map((e) => e.payload.command)).toEqual(["cmd-4", "cmd-5"]);
    const none = await t.stub.dashboardEvents(REPO_ID, {
      cursor: Math.max(...seqs(latest)),
      limit: 2,
    });
    if (!none.ok) throw new Error("not ok");
    expect(none.events).toEqual([]);
  });

  it("返すのは対象の型だけ（question・audit・created などは含まない）", async () => {
    const t = await started();
    await t.agent.emit("tool_start", { callId: "c", name: "bash", summary: "x" });
    await t.agent.emit("completion_report", { summary: "done" });
    await ingest(t);
    const r = await t.stub.dashboardEvents(REPO_ID, { limit: 200 });
    if (!r.ok) throw new Error("not ok");
    const types = new Set(r.events.map((e) => e.type));
    expect(types.has("tool_start")).toBe(true);
    expect(types.has("status_changed")).toBe(true);
    for (const hidden of ["completion_report", "created", "audit", "question"]) {
      expect(types.has(hidden), hidden).toBe(false);
    }
  });

  it("expectedRepositoryId が今の repository_id と違えば not_found（権限の再確認）。タスクが無くても not_found", async () => {
    const t = await seeded(1);
    expect(await t.stub.dashboardEvents(REPO_ID + 1, { limit: 10 })).toEqual({
      ok: false,
      code: "not_found",
    });
    const nul = await createTask({ repository_id: null }, OWNER);
    expect(await nul.stub.dashboardEvents(REPO_ID, { limit: 10 })).toEqual({
      ok: false,
      code: "not_found",
    });
  });

  it("利用者の cancel（cancelled イベント）も含まれ、DTO では CANCELLED への status_changed になる", async () => {
    const t = await started();
    await t.stub.cancel(OWNER);
    const r = await t.stub.dashboardEvents(REPO_ID, { limit: 200 });
    if (!r.ok) throw new Error("not ok");
    const last = r.events.at(-1);
    expect(last?.type).toBe("cancelled");
    expect(last && toEventDto(last)).toMatchObject({ type: "status_changed", to: "CANCELLED" });
  });

  it("limit は 1〜200 に収める", async () => {
    const t = await seeded(3);
    const zero = await t.stub.dashboardEvents(REPO_ID, { limit: 0 });
    if (!zero.ok) throw new Error("not ok");
    expect(zero.events.length).toBe(1);
    const huge = await t.stub.dashboardEvents(REPO_ID, { limit: 100_000 });
    if (!huge.ok) throw new Error("not ok");
    expect(huge.events.length).toBeLessThanOrEqual(200);
  });

  it("古い agent（構造化イベントが無い）の履歴は、tool_start / tool_end と状態の変化に縮退して契約に合う", async () => {
    const t = await started();
    await t.agent.emit("tool_start", { callId: "c1", name: "bash", summary: '{"command":"ls"}' });
    await t.agent.emit("tool_end", { callId: "c1", name: "bash", isError: false, summary: "ok" });
    await ingest(t);
    const r = await t.stub.dashboardEvents(REPO_ID, { limit: 200 });
    if (!r.ok) throw new Error("not ok");
    // テストの偽 GitHub の PR の URL は github.com ではないので、契約に合わず落ちる（draft_pr_created だけ）
    const rows = r.events.filter((e) => e.type !== "draft_pr_created");
    const dtos = rows.map((e) => toEventDto(e));
    for (const d of dtos) expect(d).not.toBeNull();
    const types = dtos.map((d) => d?.type);
    expect(types).toContain("tool_start");
    expect(types).toContain("tool_end");
    expect(types).not.toContain("command");
    for (const d of dtos) TaskEventDtoSchema.parse(d);
  });
});

describe("dashboardLatest", () => {
  it("直近 30 件だけ（昇順）と最新の command 1 件を返す。対象外の型は含まない", async () => {
    const t = await started();
    await t.agent.emit("command", { command: "first", exitCode: 0, outputTail: "old out" });
    for (let i = 1; i <= 40; i++) {
      await t.agent.emit("edit", { path: `f${i}.ts`, op: "modify", added: 1, removed: 0 });
    }
    await t.agent.emit("completion_report", { summary: "done" });
    await ingest(t);
    const r = await t.stub.dashboardLatest(REPO_ID);
    if (!r.ok) throw new Error("not ok");
    expect(r.recent).toHaveLength(30);
    expect(r.recent.every((e) => e.type === "edit")).toBe(true);
    const seqs = r.recent.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(r.latest_command?.payload.command).toBe("first");
  });

  it("expectedRepositoryId が違う・repository_id が NULL は not_found", async () => {
    const t = await started();
    expect(await t.stub.dashboardLatest(REPO_ID + 1)).toEqual({ ok: false, code: "not_found" });
    const nul = await createTask({ repository_id: null }, OWNER);
    expect(await nul.stub.dashboardLatest(REPO_ID)).toEqual({ ok: false, code: "not_found" });
  });
});
