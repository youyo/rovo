import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { clearAgentTestOverrides, setAgentTestOverrides } from "../../src/agent/deps";
import type {
  ConsultRequest,
  ConsultResult,
  ConsultToolDef,
  ConsultTranscriptMessage,
} from "../../src/agent/types";

// consult の道具（#135）。AgentDO は往復の 1 歩（モデルを 1 回呼び、呼んだ道具を返す）だけを行い、道具は実行しない。
// 往復は UserDO（gateway）が回す。台本付き fake は「transcript 中の assistant の数」で何手目かを決める。

afterEach(() => clearAgentTestOverrides());

let seq = 0;
function newName(): string {
  return `consult-${String(9_000_000 + ++seq).padStart(26, "0")}`;
}

const TOOLS: ConsultToolDef[] = [
  {
    name: "web_search",
    description: "Search the public web.",
    parametersJson: JSON.stringify({
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    }),
  },
  {
    name: "web_fetch",
    description: "Fetch a page.",
    parametersJson: JSON.stringify({
      type: "object",
      properties: { url: { type: "string" } },
      required: ["url"],
    }),
  },
];

type Seen = {
  toolNames: (string[] | undefined)[];
  toolResults: string[][];
  systemTexts: (string | undefined)[];
  userTexts: string[][];
  maxTokens: (number | undefined)[];
};

function setup(over: Partial<ConsultRequest> = {}) {
  const name = newName();
  const seen: Seen = {
    toolNames: [],
    toolResults: [],
    systemTexts: [],
    userTexts: [],
    maxTokens: [],
  };
  setAgentTestOverrides(name, {
    onModelCall: (ctx) => {
      seen.toolNames.push(ctx?.toolNames);
      seen.toolResults.push(ctx?.toolResults ?? []);
      seen.systemTexts.push(ctx?.systemText);
      seen.userTexts.push(ctx?.userTexts ?? []);
      seen.maxTokens.push(ctx?.maxTokens);
    },
  });
  const question = `what is new in ${name}?`;
  const request: ConsultRequest = {
    consultId: name,
    userId: "42",
    model: "anthropic/claude-sonnet-5-5",
    system: "You are an architect.",
    messages: [{ role: "user", content: question }],
    budgetUsd: 0.9,
    ...over,
  };
  return { name, stub: env.AGENT_DO.getByName(name), seen, request, question };
}

const asOk = (r: ConsultResult) => {
  if (!r.ok) throw new Error(`consult failed: ${r.code}: ${r.message}`);
  return r;
};

describe("AgentDO.consult: 道具つきの 1 歩（#135）", () => {
  it("tools を渡すと、モデルに道具の定義を見せ、モデルが呼んだ道具を toolCalls（引数は JSON の文字列）で返す。実行はしない", async () => {
    const t = setup({ tools: TOOLS });
    await t.stub.setScript(t.question, [
      {
        text: "Let me look.",
        toolCalls: [
          { name: "web_search", arguments: { query: "rovo release" } },
          { name: "web_fetch", arguments: { url: "https://a.example.com/" } },
        ],
        usage: { input: 100, output: 20 },
      },
    ]);
    const r = asOk(await t.stub.consult(t.request));
    expect(t.seen.toolNames[0]).toEqual(["web_search", "web_fetch"]);
    expect(r.text).toBe("Let me look.");
    expect(r.toolCalls).toEqual([
      {
        id: "call_0_0",
        name: "web_search",
        argumentsJson: JSON.stringify({ query: "rovo release" }),
      },
      {
        id: "call_0_1",
        name: "web_fetch",
        argumentsJson: JSON.stringify({ url: "https://a.example.com/" }),
      },
    ]);
    expect(r.costUsd).toBeCloseTo(120 / 1e6, 12);
    expect(r.truncated).toBeUndefined();
  });

  it("transcript（道具の呼び出しと結果）をモデルに渡し、続きの歩を進める", async () => {
    const transcript: ConsultTranscriptMessage[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "call_0", name: "web_search", argumentsJson: JSON.stringify({ query: "q" }) },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "call_0",
        toolName: "web_search",
        content: "[web_search] verdict: allow.\nresult text",
        isError: false,
      },
    ];
    const t = setup({ tools: TOOLS, transcript });
    await t.stub.setScript(t.question, [
      { text: "unused first turn" },
      { text: "The answer is 42.", usage: { input: 10, output: 5 } },
    ]);
    const r = asOk(await t.stub.consult(t.request));
    expect(r.text).toBe("The answer is 42.");
    expect(r.toolCalls).toBeUndefined();
    expect(t.seen.toolResults[0]).toEqual(["[web_search] verdict: allow.\nresult text"]);
  });

  it("道具を渡すとき・途中の会話があるときは、rovo の固定の安全の節を利用者の system より前に付ける", async () => {
    const t = setup({ tools: TOOLS });
    await t.stub.setScript(t.question, [{ text: "ok" }]);
    asOk(await t.stub.consult(t.request));
    const system = t.seen.systemTexts[0] ?? "";
    const safety = system.indexOf("untrusted data");
    expect(safety).toBeGreaterThanOrEqual(0);
    expect(system.indexOf("You are an architect.")).toBeGreaterThan(safety);
    expect(system).toContain("verdict");

    // 道具を閉じた最後の歩（tools なし・たたんだ transcript だけ）でも同じ節を付ける（キャッシュの前置きも変えない）
    const last = setup({
      transcript: [
        { role: "assistant", content: "[called tool web_search]" },
        { role: "user", content: "Result of web_search:\nx\n\nThe tools are now closed." },
      ],
    });
    await last.stub.setScript(last.question, [{ text: "a" }, { text: "final" }]);
    asOk(await last.stub.consult(last.request));
    expect(last.seen.systemTexts[0]).toBe(system);
    expect(last.seen.toolNames[0]).toEqual([]);
  });

  it("古い gateway から来る道具なしの依頼は、従来どおり（安全の節を付けず、道具を見せず、toolCalls も truncated も返さない）", async () => {
    const t = setup();
    await t.stub.setScript(t.question, [
      // 道具を渡していないので、台本に呼び出しがあっても返さない
      { text: "plain", toolCalls: [{ name: "web_search", arguments: { query: "x" } }] },
    ]);
    const r = asOk(await t.stub.consult(t.request));
    expect(t.seen.systemTexts[0]).toBe("You are an architect.");
    expect(t.seen.toolNames[0]).toEqual([]);
    expect(r).not.toHaveProperty("toolCalls");
    expect(r).not.toHaveProperty("truncated");
    expect(r.text).toBe("plain");
  });

  it("壊れた道具・途中の会話は、モデルを呼ばずに invalid_request", async () => {
    const call = { id: "c1", name: "web_search", argumentsJson: "{}" };
    const bad: Partial<ConsultRequest>[] = [
      // 道具の定義の形
      { tools: [{ ...TOOLS[0], parametersJson: "not json" } as ConsultToolDef] },
      { tools: [{ ...TOOLS[0], parametersJson: "[]" } as ConsultToolDef] },
      { tools: [{ ...TOOLS[0], name: "Bad Name" } as ConsultToolDef] },
      { tools: [TOOLS[0] as ConsultToolDef, TOOLS[0] as ConsultToolDef] },
      // 道具のブロックがあるのに tools が無い（道具の定義の無い依頼に道具のブロックを含めるとプロバイダーが拒否する）
      {
        transcript: [
          { role: "assistant", content: "", toolCalls: [call] },
          {
            role: "toolResult",
            toolCallId: "c1",
            toolName: "web_search",
            content: "r",
            isError: false,
          },
        ],
      },
      // 最後が assistant（答える番がモデルに来ない）
      { tools: TOOLS, transcript: [{ role: "assistant", content: "x" }] },
      // 対になる呼び出しの無い結果
      {
        tools: TOOLS,
        transcript: [
          {
            role: "toolResult",
            toolCallId: "nope",
            toolName: "web_search",
            content: "r",
            isError: false,
          },
        ],
      },
      // 引数が JSON の object でない
      {
        tools: TOOLS,
        transcript: [
          { role: "assistant", content: "", toolCalls: [{ ...call, argumentsJson: "1" }] },
          {
            role: "toolResult",
            toolCallId: "c1",
            toolName: "web_search",
            content: "r",
            isError: false,
          },
        ],
      },
      { transcript: "x" as unknown as ConsultTranscriptMessage[] },
    ];
    for (const over of bad) {
      const t = setup(over);
      expect(await t.stub.consult(t.request), JSON.stringify(over)).toMatchObject({
        ok: false,
        code: "invalid_request",
        costUsd: 0,
      });
      expect(t.seen.userTexts).toHaveLength(0);
    }
  });

  it("出力の上限で切れたら truncated を立てる", async () => {
    const t = setup({ tools: TOOLS, maxOutputTokens: 5 });
    await t.stub.setScript(t.question, [{ text: "long", stopReason: "length" }]);
    const r = asOk(await t.stub.consult(t.request));
    expect(r.truncated).toBe(true);
  });

  it("入力の見積りに道具の定義と途中の会話を含める（残りの予算に収まらなければ input_too_large）", async () => {
    const big = "x".repeat(400_000);
    const t = setup({
      tools: TOOLS,
      budgetUsd: 0.5,
      transcript: [
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "c1", name: "web_fetch", argumentsJson: "{}" }],
        },
        {
          role: "toolResult",
          toolCallId: "c1",
          toolName: "web_fetch",
          content: big,
          isError: false,
        },
      ],
    });
    expect(await t.stub.consult(t.request)).toMatchObject({ ok: false, code: "input_too_large" });
    expect(t.seen.userTexts).toHaveLength(0);
  });
});
