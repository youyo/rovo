import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { clearAgentTestOverrides } from "../../src/agent/deps";
import {
  allEvents,
  call,
  type Fixture,
  makeSpec,
  newFixture,
  report,
  waitForTerminal,
} from "./support/agent-fixture";

afterEach(() => clearAgentTestOverrides());

// biome-ignore lint/suspicious/noExplicitAny: private メンバーの観測
type Inst = any;
const runInDO = runInDurableObject as unknown as <T>(
  stub: unknown,
  fn: (inst: Inst) => Promise<T> | T,
) => Promise<T>;

const TOKEN = makeSpec("x").gitCredential.token;

/** gateway（TaskDO）の代わり: github_read の依頼を待ち、届いたら応答を返す */
async function serveOnce(
  fx: Fixture,
  reply: (data: Record<string, unknown>) => { text: string; isError: boolean },
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const req = (await allEvents(fx)).find((e) => e.type === "github_read");
    if (req) {
      const r = await fx.stub.deliverGitHubRead(String(req.data.request_id), reply(req.data));
      expect(r.ok).toBe(true);
      return req.data;
    }
    if (Date.now() > deadline) throw new Error("no github_read request");
    await new Promise((r) => setTimeout(r, 25));
  }
}

const toolEnds = async (fx: Fixture) =>
  (await allEvents(fx)).filter((e) => e.type === "tool_end").map((e) => e.data);

describe("AgentDO: read_issue / read_pr（gateway が GitHub を読む）", () => {
  it("read_issue: 番号と取り込み方だけを github_read の依頼に積み、gateway の応答をそのままモデルに渡す（token は依頼に入らない）", async () => {
    const fx = newFixture("gh-read-1", [
      call("read_issue", { number: 12, include_comments: true }),
      report(),
    ]);
    await fx.stub.start(makeSpec("gh-read-1"));
    const data = await serveOnce(fx, () => ({
      text: "[read_issue result. wrapped]\n<<<BEGIN_UNTRUSTED_OUTPUT>>>\nIssue #12 body\n<<<END_UNTRUSTED_OUTPUT>>>",
      isError: false,
    }));
    expect(data).toEqual({
      request_id: expect.any(String),
      tool: "read_issue",
      number: 12,
      include_comments: true,
      include_files: false,
    });
    expect(await waitForTerminal(fx)).toBe("completed");
    const seen = fx.modelCalls.toolResults[1]?.join("\n") ?? "";
    expect(seen).toContain("Issue #12 body");
    expect(seen).toContain("<<<BEGIN_UNTRUSTED_OUTPUT>>>");
    const all = JSON.stringify(await allEvents(fx));
    expect(all).not.toContain(TOKEN);
    const ends = await toolEnds(fx);
    expect(ends.find((e) => e.name === "read_issue")).toMatchObject({ isError: false });
  });

  it("read_pr: include_files と include_comments を渡す。gateway のエラーはエラーとして渡す", async () => {
    const fx = newFixture("gh-read-2", [
      call("read_pr", { number: 7, include_files: true, include_comments: false }),
      report(),
    ]);
    await fx.stub.start(makeSpec("gh-read-2"));
    const data = await serveOnce(fx, () => ({
      text: "[read_pr] not_found: pull request #7 was not found",
      isError: true,
    }));
    expect(data).toMatchObject({
      tool: "read_pr",
      number: 7,
      include_files: true,
      include_comments: false,
    });
    expect(await waitForTerminal(fx)).toBe("completed");
    const ends = await toolEnds(fx);
    expect(ends.find((e) => e.name === "read_pr")).toMatchObject({ isError: true });
    expect(fx.modelCalls.toolResults[1]?.join("\n") ?? "").toContain("not_found");
  });

  it("number が正の整数でなければ、依頼を積まずにエラーを返す", async () => {
    const bad: unknown[] = [0, -3, 1.5, "12", "../../repos/other/x", 2 ** 53];
    const fx = newFixture("gh-read-3", [
      ...bad.map((number) => call("read_issue", { number })),
      call("read_pr", { number: 0 }),
      report(),
    ]);
    await fx.stub.start(makeSpec("gh-read-3"));
    expect(await waitForTerminal(fx)).toBe("completed");
    const events = await allEvents(fx);
    expect(events.filter((e) => e.type === "github_read")).toEqual([]);
    const ends = (await toolEnds(fx)).filter(
      (e) => e.name === "read_issue" || e.name === "read_pr",
    );
    expect(ends).toHaveLength(bad.length + 1);
    for (const e of ends) expect(e.isError).toBe(true);
  });

  it("gateway が時間内に答えなければ、固定のエラーを返してタスクは続く", async () => {
    const fx = newFixture("gh-read-4", [call("read_issue", { number: 3 }), report()], {
      githubReadWaitMs: 50,
    });
    await fx.stub.start(makeSpec("gh-read-4"));
    expect(await waitForTerminal(fx)).toBe("completed");
    const seen = fx.modelCalls.toolResults[1]?.join("\n") ?? "";
    expect(seen).toContain("gateway_timeout");
    // 待ちが終わった後に届いた応答は無視される
    const req = (await allEvents(fx)).find((e) => e.type === "github_read");
    const late = await fx.stub.deliverGitHubRead(String(req?.data.request_id), {
      text: "late",
      isError: false,
    });
    expect(late).toEqual({ ok: true, ignored: true });
  });

  it("gateway の応答は 60,000 文字までに切る", async () => {
    const fx = newFixture("gh-read-5", [call("read_issue", { number: 5 }), report()]);
    await fx.stub.start(makeSpec("gh-read-5"));
    await serveOnce(fx, () => ({ text: "x".repeat(200_000), isError: false }));
    expect(await waitForTerminal(fx)).toBe("completed");
    const seen = fx.modelCalls.toolResults[1]?.join("\n") ?? "";
    expect(seen.length).toBeLessThanOrEqual(60_000);
    expect(seen).toContain("truncated");
  });

  it("ツールの説明とシステムプロンプトで、対象リポジトリの issue・PR を読めることと非信頼であることを伝える", async () => {
    const fx = newFixture("gh-read-6", [report()]);
    await fx.stub.start(makeSpec("gh-read-6"));
    const sections = (await runInDO(fx.stub, (inst) => inst.promptSections())) as {
      key: string;
      text?: string;
    }[];
    await waitForTerminal(fx);
    const text = sections.find((s) => s.key === "github")?.text ?? "";
    expect(text).toContain("read_issue");
    expect(text).toContain("read_pr");
    expect(text).toContain("octo/repo");
    expect(text).toMatch(/untrusted/i);
    expect(text).toMatch(/paste/);
    const names = fx.modelCalls.toolNames[0] ?? [];
    expect(names).toContain("read_issue");
    expect(names).toContain("read_pr");
  });

  it("ツールの定義: number は 1 以上の整数で、replay は safe ではない", async () => {
    const { createAgentExtension } = await import("../../src/pi/extension");
    const ext = createAgentExtension([], {
      beforeTool: async () => undefined,
      afterTool: async () => {},
      afterTools: async () => {},
      onYield: async () => undefined,
      reportCompletion: async () => ({ text: "", isError: false, terminate: false }),
      askParent: async () => ({ text: "", isError: false, terminate: false }),
      webSearch: async () => ({ text: "", isError: false }),
      webFetch: async () => ({ text: "", isError: false }),
      webBrowse: async () => ({ text: "", isError: false }),
      webBrowseEnabled: () => false,
      githubRead: async () => ({ text: "", isError: false }),
      sections: () => [],
    });
    const tools = (
      ext as unknown as {
        tools: {
          name: string;
          replay: string;
          description: string;
          parameters: {
            properties: Record<string, { type?: string; minimum?: number }>;
            required?: string[];
          };
        }[];
      }
    ).tools;
    for (const name of ["read_issue", "read_pr"]) {
      const t = tools.find((x) => x.name === name);
      expect(t, name).toBeDefined();
      expect(t?.replay).not.toBe("safe");
      expect(t?.parameters.properties.number).toMatchObject({ type: "integer", minimum: 1 });
      expect(t?.parameters.required).toEqual(["number"]);
      expect(t?.description).toMatch(/untrusted/i);
    }
    const pr = tools.find((x) => x.name === "read_pr");
    expect(Object.keys(pr?.parameters.properties ?? {}).sort()).toEqual([
      "include_comments",
      "include_files",
      "number",
    ]);
    const issue = tools.find((x) => x.name === "read_issue");
    expect(Object.keys(issue?.parameters.properties ?? {}).sort()).toEqual([
      "include_comments",
      "number",
    ]);
  });
});
