import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { AuditRecord } from "@rovo/audit";
import { describe, expect, it } from "vitest";
import type { ResultDto } from "../../src/agent/contract";
import { getFakeApp, type UnitGitHubEnv } from "../support/unit-github";
import { fakeAgent, newTaskId, sampleInput, taskStub } from "./helpers";

const OWNER = 921;
const REPO = "acme/widgets";
const app = () => getFakeApp(env as unknown as UnitGitHubEnv);

type TaskStub = ReturnType<typeof taskStub>;

/** R2 の fake。put の順序と中身を記録し、失敗を差し込める。 */
class FakeR2 {
  readonly puts: { key: string; body: string; contentType?: string }[] = [];
  readonly attempted: string[] = [];
  /** true を返したキーの put は失敗する */
  failWhen: (key: string, n: number) => boolean = () => false;
  async put(
    key: string,
    value: string,
    options?: { httpMetadata?: { contentType?: string } },
  ): Promise<null> {
    this.attempted.push(key);
    if (this.failWhen(key, this.attempted.length)) throw new Error("r2 unavailable ghs_leak");
    this.puts.push({ key, body: value, contentType: options?.httpMetadata?.contentType });
    return null;
  }
  get keys() {
    return this.puts.map((p) => p.key);
  }
  body(suffix: string): string {
    const hit = this.puts.filter((p) => p.key.endsWith(suffix)).at(-1);
    if (!hit) throw new Error(`no put for ${suffix}`);
    return hit.body;
  }
  all(): string {
    return this.puts.map((p) => p.body).join("\n");
  }
}

function rows<T>(stub: TaskStub, sql: string, ...b: unknown[]): Promise<T[]> {
  return runInDurableObject(
    stub,
    (_i, state) => state.storage.sql.exec(sql, ...b).toArray() as T[],
  );
}

async function setEnv(stub: TaskStub, patch: Record<string, unknown>) {
  await runInDurableObject(stub, (i) => {
    const o = i as unknown as { env: Record<string, unknown> };
    o.env = { ...o.env, ...patch };
  });
}

async function createTask(r2: FakeR2 | null) {
  const id = newTaskId();
  const stub = taskStub(id);
  const r = await stub.ensureCreated(
    sampleInput(id, OWNER, {
      title: "SECRET-TITLE-xyz",
      instructions: "SECRET-INSTRUCTIONS-abc",
      acceptance_criteria: ["SECRET-CRITERIA-def"],
      constraints: ["SECRET-CONSTRAINT-ghi"],
    }),
  );
  if (!r.ok) throw new Error(`ensureCreated failed: ${r.code}`);
  await setEnv(stub, { ENVIRONMENT: "test", ...(r2 ? { LOGS: r2 } : { LOGS: undefined }) });
  return { id, stub, agent: fakeAgent(id), branch: `agent/task-${id}` };
}

type T = Awaited<ReturnType<typeof createTask>>;

const sink = (stub: TaskStub): Promise<AuditRecord[]> =>
  runInDurableObject(stub, (i) => (i as unknown as { testAudit(): AuditRecord[] }).testAudit());
const audits = async (stub: TaskStub, event: string) =>
  (await sink(stub)).filter((r) => r.event === event);
const alarmOf = (stub: TaskStub) => runInDurableObject(stub, (_i, s) => s.storage.getAlarm());

async function setClock(stub: TaskStub, clock: () => number) {
  await runInDurableObject(stub, (i) => {
    (i as unknown as { now: () => number }).now = clock;
  });
  app().now = clock;
}

function completedResult(commitSha: string): ResultDto {
  return {
    status: "completed",
    summary: "ok",
    verification: {
      commands: [{ argv: ["npm", "test"] }],
      results: [{ argv: ["npm", "test"], exitCode: 0, timedOut: false, output: "tests ok" }],
      verified: true,
      attempts: 1,
      commitSha,
    },
    warnings: [],
    patchTooLarge: false,
    pushedSha: commitSha,
    usage: {
      costUsd: 1,
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
  } as unknown as ResultDto;
}

async function complete(t: T) {
  await t.agent.setProgram({ result: completedResult(app().branch(REPO, t.branch) as string) });
  await t.agent.setPhase("completed");
  await t.stub.advance();
}

async function prefixOf(t: T): Promise<string> {
  const [row] = await rows<{ created_at: number }>(
    t.stub,
    "SELECT created_at FROM task WHERE id = ?",
    t.id,
  );
  const d = new Date(row?.created_at ?? 0);
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `tasks/${d.getUTCFullYear()}/${mm}/${t.id}/`;
}

const archiveState = async (stub: TaskStub) =>
  (
    await rows<{ archive_done: number; archive_attempts: number; finished: number }>(
      stub,
      "SELECT archive_done, archive_attempts, finished FROM agent_link",
    )
  )[0];

describe("R2 アーカイブ（書き込みの条件と順序）", () => {
  it("finished && finalize_done の前には書かない。成立後に events → result → summary の順で書く", async () => {
    const r2 = new FakeR2();
    const t = await createTask(r2);
    await t.stub.advance();
    // 失効が 1 回失敗する → finalize_done = 0 のまま終端
    app().setFault({ pattern: "^DELETE /installation/token$", status: 500, count: 1 });
    await complete(t);
    const [gl] = await rows<{ finalize_done: number }>(
      t.stub,
      "SELECT finalize_done FROM github_link",
    );
    expect(gl?.finalize_done).toBe(0);
    expect(r2.attempted).toEqual([]);
    expect((await archiveState(t.stub))?.archive_done).toBe(0);
    // alarm は止まらない
    expect(await alarmOf(t.stub)).not.toBeNull();

    const clock = () => Date.now() + 10 * 60_000;
    await setClock(t.stub, clock);
    await t.stub.advance();

    const prefix = await prefixOf(t);
    expect(r2.keys).toEqual([
      `${prefix}events.jsonl`,
      `${prefix}result.json`,
      `${prefix}summary.json`,
    ]);
    expect((await archiveState(t.stub))?.archive_done).toBe(1);
    const done = await audits(t.stub, "archive_completed");
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({
      taskId: t.id,
      caller: "system",
      prefix,
      bytes: r2.puts.reduce((n, p) => n + new TextEncoder().encode(p.body).length, 0),
    });
    expect(JSON.stringify(done[0])).not.toContain("events.jsonl");
    // 済んだら alarm は止まる
    expect(await alarmOf(t.stub)).toBeNull();
  });

  it("GitHub と紐付かないタスク（github_link なし）は finalize_done 済み扱い。finished が先なら書かない", async () => {
    const r2 = new FakeR2();
    const t = await createTask(r2);
    await t.stub.advance();
    await runInDurableObject(t.stub, (_i, s) => {
      s.storage.sql.exec("DELETE FROM github_link");
    });
    await t.agent.setPhase("running");
    await t.stub.advance();
    expect(r2.attempted).toEqual([]);
    await t.agent.setProgram({ result: completedResult("a".repeat(40)) });
    await t.agent.setPhase("completed");
    await t.stub.advance();
    await t.stub.advance();
    expect(r2.keys.length).toBe(3);
  });

  it("キャンセルしたタスクも同じ 3 つを書く", async () => {
    const r2 = new FakeR2();
    const t = await createTask(r2);
    await t.stub.advance();
    await t.stub.cancel(OWNER);
    await t.stub.advance();
    await t.stub.advance();
    expect(r2.keys.map((k) => k.split("/").pop())).toEqual([
      "events.jsonl",
      "result.json",
      "summary.json",
    ]);
    expect(JSON.parse(r2.body("summary.json")).status).toBe("CANCELLED");
  });

  it("冪等: 状態を戻して書き直させても、キーは増えず内容も変わらない", async () => {
    const r2 = new FakeR2();
    const t = await createTask(r2);
    await t.stub.advance();
    await complete(t);
    await t.stub.advance();
    expect(r2.puts).toHaveLength(3);
    const first = r2.puts.map((p) => ({ ...p }));
    // 完了後に advance を重ねても書かない
    await t.stub.advance();
    expect(r2.puts).toHaveLength(3);
    // alarm の再実行相当: 印を戻して書き直させる
    await runInDurableObject(t.stub, (_i, s) => {
      s.storage.sql.exec("UPDATE agent_link SET archive_done = 0, archive_attempts = 0");
    });
    await t.stub.advance();
    expect(r2.puts).toHaveLength(6);
    expect(r2.puts.slice(3)).toEqual(first);
    expect(new Set(r2.keys).size).toBe(3);
  });
});

describe("R2 アーカイブ（再試行と打ち切り）", () => {
  it("途中の put が失敗したら summary.json は書かず、バックオフ後に 3 つとも書き直して完了する", async () => {
    const r2 = new FakeR2();
    r2.failWhen = (key, n) => key.endsWith("result.json") && n <= 2;
    const t = await createTask(r2);
    await t.stub.advance();
    await complete(t);
    expect(r2.keys).toEqual([expect.stringMatching(/events\.jsonl$/)]);
    expect(r2.keys.some((k) => k.endsWith("summary.json"))).toBe(false);
    expect(await archiveState(t.stub)).toMatchObject({ archive_done: 0, archive_attempts: 1 });
    expect(await alarmOf(t.stub)).not.toBeNull();
    // バックオフの間は呼ばない
    const calls = r2.attempted.length;
    await t.stub.advance();
    expect(r2.attempted.length).toBe(calls);

    await setClock(t.stub, () => Date.now() + 60_000);
    await t.stub.advance();
    expect(await archiveState(t.stub)).toMatchObject({ archive_done: 1 });
    expect(r2.keys.filter((k) => k.endsWith("summary.json"))).toHaveLength(1);
    expect(await audits(t.stub, "archive_completed")).toHaveLength(1);
    expect(await audits(t.stub, "archive_failed")).toEqual([]);
    expect(await alarmOf(t.stub)).toBeNull();
  });

  it("ARCHIVE_MAX_ATTEMPTS（6）回失敗したら archive_failed を監査ログにだけ出して打ち切る。タスクと精算には影響しない", async () => {
    const r2 = new FakeR2();
    r2.failWhen = () => true;
    const t = await createTask(r2);
    await t.stub.advance();
    await complete(t);
    let at = Date.now();
    for (let i = 0; i < 8; i++) {
      at += 10 * 60_000;
      const clock = () => at;
      await setClock(t.stub, clock);
      await t.stub.advance();
    }
    expect(r2.attempted.length).toBe(6); // 1 回の試行は最初の put で失敗する
    expect(await archiveState(t.stub)).toMatchObject({
      archive_done: 1,
      archive_attempts: 6,
      finished: 1,
    });
    const failed = await audits(t.stub, "archive_failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ taskId: t.id, caller: "system", reason: "put_failed" });
    expect(JSON.stringify(failed[0])).not.toContain("ghs_leak");
    expect(await audits(t.stub, "archive_completed")).toEqual([]);
    // events には入らない
    const evs = await rows<{ payload: string }>(t.stub, "SELECT payload FROM events");
    expect(evs.map((e) => e.payload).join("\n")).not.toContain("archive_");
    // 結果は変わらない
    const res = await t.stub.result(OWNER);
    expect(res.ok).toBe(true);
    expect((await t.stub.getStatus(OWNER)).ok).toBe(true);
    expect(await alarmOf(t.stub)).toBeNull();
  });
});

describe("R2 アーカイブ（結果を作れない: result_unavailable）", () => {
  it("結果を作れないまま 6 回で打ち切ったら archive_failed(reason: result_unavailable) を出し、archive_done = 1 にする。R2 には何も書かない。結果と精算は変わらない", async () => {
    const r2 = new FakeR2();
    const t = await createTask(r2);
    await t.stub.advance();
    // composeResult が失敗する（メッセージにはデータが入りうる）
    await runInDurableObject(t.stub, (i) => {
      (i as unknown as { composeResult: () => Promise<never> }).composeResult = async () => {
        throw new Error("compose failed ghs_leak");
      };
    });
    await complete(t);
    // 1 回目は再試行待ち（まだ打ち切らない）
    expect(await archiveState(t.stub)).toMatchObject({ archive_done: 0, archive_attempts: 1 });
    expect(await audits(t.stub, "archive_failed")).toEqual([]);
    let at = Date.now();
    for (let i = 0; i < 8; i++) {
      at += 10 * 60_000;
      const clock = () => at;
      await setClock(t.stub, clock);
      await t.stub.advance();
    }
    expect(r2.attempted).toEqual([]); // put の段階に進んでいない
    expect(await archiveState(t.stub)).toMatchObject({
      archive_done: 1,
      archive_attempts: 6,
      finished: 1,
    });
    const failed = await audits(t.stub, "archive_failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({
      taskId: t.id,
      caller: "system",
      reason: "result_unavailable",
    });
    expect(JSON.stringify(failed[0])).not.toContain("ghs_leak");
    expect(await audits(t.stub, "archive_completed")).toEqual([]);
    expect(await alarmOf(t.stub)).toBeNull();
    // 結果と精算は変わらない（composeResult の差し替えを戻して確かめる）
    await runInDurableObject(t.stub, (i) => {
      delete (i as unknown as { composeResult?: unknown }).composeResult;
    });
    const res = await t.stub.result(OWNER);
    expect(res.ok && res.result.status).toBe("COMPLETED");
    expect(await archiveState(t.stub)).toMatchObject({ finished: 1 });
  });
});

describe("R2 アーカイブ（LOGS が無い構成は fail-open）", () => {
  it("archive_skipped だけ出し、archive_done = 1 にして alarm を止める。結果は変わらない", async () => {
    const t = await createTask(null);
    await t.stub.advance();
    await complete(t);
    await t.stub.advance();
    const skipped = await audits(t.stub, "archive_skipped");
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toMatchObject({ taskId: t.id, caller: "system", reason: "no_binding" });
    expect(await audits(t.stub, "archive_failed")).toEqual([]);
    expect(await archiveState(t.stub)).toMatchObject({ archive_done: 1, archive_attempts: 0 });
    expect(await alarmOf(t.stub)).toBeNull();
    const res = await t.stub.result(OWNER);
    expect(res.ok && res.result.status).toBe("COMPLETED");
  });
});

describe("R2 アーカイブ（中身）", () => {
  it("保存しない項目（title・入力・answer / steer の本文）とトークン形式が、3 つのどこにも無い", async () => {
    const r2 = new FakeR2();
    const t = await createTask(r2);
    await t.stub.advance();
    await t.agent.ask("q1", "which db?", ["a", "b"]);
    await t.stub.advance();
    expect((await t.stub.answer(OWNER, "q1", "SECRET-ANSWER-jkl")).ok).toBe(true);
    await t.agent.setPhase("running");
    await t.stub.advance();
    expect((await t.stub.steer(OWNER, "SECRET-STEER-mno")).ok).toBe(true);
    await t.stub.advance();
    await complete(t);
    await t.stub.advance();
    expect(r2.puts).toHaveLength(3);

    // トークンが実際に発行されている（空振りのテストにしない）
    const tokens = await rows<{ id: number }>(t.stub, "SELECT id FROM git_token");
    expect(tokens.length).toBeGreaterThan(0);

    const all = r2.all();
    for (const needle of [
      "SECRET-TITLE",
      "SECRET-INSTRUCTIONS",
      "SECRET-CRITERIA",
      "SECRET-CONSTRAINT",
      "SECRET-ANSWER",
      "SECRET-STEER",
    ]) {
      expect(all).not.toContain(needle);
    }
    expect(all).not.toMatch(/gh[a-z]_[A-Za-z0-9_]+|github_pat_|sk-ant-|Bearer |-----BEGIN/);
    // 暗号文の列も出さない
    const [tok] = await rows<{ ciphertext?: string; token_enc?: string }>(
      t.stub,
      "SELECT * FROM git_token LIMIT 1",
    );
    for (const v of Object.values(tok ?? {})) {
      if (typeof v === "string" && v.length > 16) expect(all).not.toContain(v);
    }
  });

  it("events.jsonl は 1 行 1 イベントで全件。summary.json は M3 の要約（title なし）、result.json は task_result と同じ", async () => {
    const r2 = new FakeR2();
    const t = await createTask(r2);
    await t.stub.advance();
    await complete(t);
    await t.stub.advance();

    const lines = r2.body("events.jsonl").trimEnd().split("\n");
    const parsed = lines.map((l) => JSON.parse(l) as { seq: number; type: string });
    const stored = await rows<{ seq: number }>(t.stub, "SELECT seq FROM events ORDER BY seq");
    expect(parsed.map((e) => e.seq)).toEqual(stored.map((e) => e.seq));
    expect(parsed.some((e) => e.type === "audit")).toBe(true); // 二重化したイベントを含む

    const summary = JSON.parse(r2.body("summary.json"));
    expect(summary).toMatchObject({
      version: 1,
      task_id: t.id,
      user_id: OWNER,
      repository: REPO,
      status: "COMPLETED",
    });
    expect(summary).not.toHaveProperty("title");

    const res = await t.stub.result(OWNER);
    if (!res.ok) throw new Error("result not ok");
    expect(JSON.parse(r2.body("result.json"))).toEqual(res.result);

    expect(r2.puts.every((p) => p.contentType !== undefined)).toBe(true);
  });
});
