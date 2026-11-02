import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { mapAgentEvent } from "../../src/agent/agent-events";
import { ISSUES_PERMISSION_MESSAGE } from "../../src/github/worker-read";
import { app, clearTaskAlarms, createTask, REPO } from "./pr-helpers";

// ワーカーの read_issue / read_pr: AgentDO が github_read の依頼をイベントに積み、TaskDO が取り込みのときに
// タスクのリポジトリだけを Installation Token で読み、整形した文を AgentDO.deliverGitHubRead で返す。token は渡さない。

afterEach(() => clearTaskAlarms());

const ev = (type: string, data: unknown) => ({
  seq: 1,
  ts: 0,
  type,
  data: JSON.stringify(data),
});

describe("mapAgentEvent: github_read", () => {
  it("検査済みの依頼に写し、公開イベントにはしない。不正な依頼は捨てる", () => {
    expect(
      mapAgentEvent(
        ev("github_read", {
          request_id: "req-1",
          tool: "read_issue",
          number: 3,
          include_comments: true,
          include_files: false,
          repository: "other/repo",
        }),
      ),
    ).toEqual({
      kind: "github_read",
      read: {
        requestId: "req-1",
        request: { tool: "read_issue", number: 3, includeComments: true, includeFiles: false },
      },
    });
    expect(
      mapAgentEvent(ev("github_read", { request_id: "req-1", tool: "read_issue", number: -1 })),
    ).toEqual({ kind: "github_read", read: undefined });
  });
});

describe("TaskDO: github_read の依頼に答える", () => {
  it("read_pr: タスクのリポジトリの PR を token で読み、囲んだ文を AgentDO に渡す。token はどこにも入らない", async () => {
    const t = await createTask();
    await t.stub.advance();
    const pr = app()
      .pulls(REPO)
      .find((p) => p.head === t.branch);
    expect(pr).toBeDefined();
    await t.agent.emit("github_read", {
      request_id: "rq-pr-1",
      tool: "read_pr",
      number: pr?.number,
      include_comments: false,
      include_files: false,
    });
    await t.stub.advance();
    const reads = (await t.agent.calls()).githubReads ?? [];
    expect(reads).toHaveLength(1);
    expect(reads[0]?.requestId).toBe("rq-pr-1");
    expect(reads[0]?.result.isError).toBe(false);
    const text = reads[0]?.result.text ?? "";
    expect(text).toContain("<<<BEGIN_UNTRUSTED_OUTPUT>>>");
    expect(text).toContain(`#${pr?.number}`);
    expect(text).toContain(t.branch);
    for (const tok of app().tokenList()) expect(text).not.toContain(tok.token);
    // 依頼は公開イベントにならない
    const events = await runInDurableObject(t.stub, (_i, s) =>
      s.storage.sql.exec("SELECT type FROM events").toArray(),
    );
    expect(events.map((e) => e.type)).not.toContain("github_read");
    // GitHub への呼び出しは GET の PR だけ
    const gets = app()
      .requests()
      .filter((r) => r.path.includes(`/pulls/${pr?.number}`));
    expect(gets.every((r) => r.method === "GET")).toBe(true);
  });

  it("read_issue: installation が issues を承認していなければ、GitHub を呼ばずに固定のエラーを返す（タスクは続く）", async () => {
    const t = await createTask();
    await t.stub.advance();
    const before = app().requests().length;
    await t.agent.emit("github_read", {
      request_id: "rq-issue-1",
      tool: "read_issue",
      number: 1,
    });
    await t.stub.advance();
    const reads = (await t.agent.calls()).githubReads ?? [];
    expect(reads).toEqual([
      {
        requestId: "rq-issue-1",
        result: { isError: true, text: expect.stringContaining(ISSUES_PERMISSION_MESSAGE) },
      },
    ]);
    expect(
      app()
        .requests()
        .slice(before)
        .filter((r) => r.path.includes("/issues/")),
    ).toEqual([]);
    const st = await t.stub.getStatus(801);
    expect(st.ok && st.task.status).not.toBe("FAILED");
  });

  it("read_issue: installation が issues を承認していれば、issues: read を含めた token で読む（token は文に入らない）", async () => {
    app().setInstallationPermissions({
      contents: "write",
      pull_requests: "write",
      metadata: "read",
      issues: "read",
    });
    try {
      const t = await createTask();
      await t.stub.advance();
      const pr = app()
        .pulls(REPO)
        .find((p) => p.head === t.branch);
      expect(pr).toBeDefined();
      await t.agent.emit("github_read", {
        request_id: "rq-issue-ok",
        tool: "read_issue",
        number: pr?.number,
        include_comments: false,
      });
      await t.stub.advance();
      const reads = (await t.agent.calls()).githubReads ?? [];
      expect(reads.map((r) => r.requestId)).toEqual(["rq-issue-ok"]);
      const text = reads[0]?.result.text ?? "";
      expect(reads[0]?.result.isError).toBe(false);
      expect(text.startsWith("[read_issue result.")).toBe(true);
      expect(text).toContain(`Issue #${pr?.number}`);
      expect(text).not.toContain(ISSUES_PERMISSION_MESSAGE);
      for (const tok of app().tokenList()) expect(text).not.toContain(tok.token);
      // GitHub への呼び出しは GET だけ
      const issueCalls = app()
        .requests()
        .filter((r) => r.path.includes(`/issues/${pr?.number}`));
      expect(issueCalls.length).toBeGreaterThan(0);
      expect(issueCalls.every((r) => r.method === "GET")).toBe(true);
    } finally {
      app().setInstallationPermissions(null);
    }
  });

  it("同じ依頼を 2 回取り込まない（取り込みのカーソルの後ろだけ）", async () => {
    const t = await createTask();
    await t.stub.advance();
    await t.agent.emit("github_read", { request_id: "rq-once", tool: "read_issue", number: 2 });
    await t.stub.advance();
    await t.stub.advance();
    const reads = (await t.agent.calls()).githubReads ?? [];
    expect(reads.map((r) => r.requestId)).toEqual(["rq-once"]);
  });
});
