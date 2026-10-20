import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { newTaskId, sampleInput, taskStub } from "./helpers";
import { createTask, REPO, runToCompleted, type TaskStub } from "./pr-helpers";

// TaskDO.dashboardRead(): ダッシュボード用の読み取り専用の view（docs/specs/dashboard.md D5）。
// repository_id を含めて 1 回返し、判定は gateway が閲覧者の集合で行う。ここでは「索引ではなく TaskDO の今の値」を返すこと、
// 入力の指示文・トークン・PR の本文を返さないこと、書き込まないことを固定する。

const OWNER = 905;

const link = (stub: TaskStub) =>
  runInDurableObject(
    stub,
    (_i, s) =>
      s.storage.sql.exec<{ index_revision: number }>("SELECT index_revision FROM agent_link").one()
        .index_revision,
  );

describe("TaskDO.dashboardRead", () => {
  it("所有者でない呼び出し側にも、repository_id を含む view を 1 回で返す", async () => {
    const t = await createTask({ title: "my title", repository_id: 4242 }, OWNER);
    const r = await t.stub.dashboardRead();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.view).toMatchObject({
      task_id: t.id,
      owner_id: OWNER,
      owner_login: "alice",
      repository: REPO,
      repository_id: 4242,
      title: "my title",
    });
  });

  it("入力の指示文・受け入れ条件・制約・トークン・暗号文を返さない", async () => {
    const t = await createTask(
      {
        instructions: "SECRET-INSTRUCTIONS-BODY",
        acceptance_criteria: ["SECRET-CRITERIA"],
        constraints: ["SECRET-CONSTRAINT"],
      },
      OWNER,
    );
    await t.stub.advance();
    const raw = JSON.stringify(await t.stub.dashboardRead());
    for (const s of ["SECRET-INSTRUCTIONS-BODY", "SECRET-CRITERIA", "SECRET-CONSTRAINT"]) {
      expect(raw).not.toContain(s);
    }
    expect(raw).not.toMatch(/instructions|git_token|_enc|ghs_|ghu_|credential|fingerprint/i);
  });

  it("存在しない・未作成のタスクは not_found", async () => {
    expect(await taskStub(newTaskId()).dashboardRead()).toEqual({ ok: false, code: "not_found" });
  });

  it("repository_id が NULL のタスクは、view を返さず not_found（fail closed。存在しないと見分けがつかない）", async () => {
    const id = newTaskId();
    const stub = taskStub(id);
    const created = await stub.ensureCreated(sampleInput(id, OWNER, { repository_id: null }));
    expect(created.ok).toBe(true);
    expect(await stub.dashboardRead()).toEqual({ ok: false, code: "not_found" });
  });

  it("書き込まない（索引の revision を上げず、alarm も増やさない）", async () => {
    const t = await createTask({}, OWNER);
    await t.stub.advance();
    const before = await link(t.stub);
    const alarmBefore = await runInDurableObject(t.stub, (_i, s) => s.storage.getAlarm());
    await t.stub.dashboardRead();
    await t.stub.dashboardRead();
    expect(await link(t.stub)).toBe(before);
    expect(await runInDurableObject(t.stub, (_i, s) => s.storage.getAlarm())).toBe(alarmBefore);
  });

  it("repository_id は作成後に変わらない（状態遷移・キャンセル・PR の更新を経ても同じ値）", async () => {
    const t = await createTask({ repository_id: 4242 }, OWNER);
    const seen = new Set<number | null>();
    const read = async () => {
      const r = await t.stub.dashboardRead();
      if (r.ok) seen.add(r.view.repository_id);
    };
    await read();
    await t.stub.advance();
    await read();
    await t.stub.cancel(OWNER);
    await read();
    // 同じ ID で作り直そうとしても（冪等の再呼び出し）、別の repository_id では上書きできない
    await t.stub.ensureCreated(sampleInput(t.id, OWNER, { repository_id: 9999 }));
    await read();
    expect([...seen]).toEqual([4242]);
  });

  it("PR の URL と状態は載せるが、PR の本文は載せない", async () => {
    const t = await runToCompleted({}, OWNER);
    const r = await t.stub.dashboardRead();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.view.pr_url).toMatch(/^https?:\/\//);
    expect(r.view.status).toBe("COMPLETED");
    expect(Object.keys(r.view)).not.toContain("pr_body");
  });
});
