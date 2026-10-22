import { describe, expect, it } from "vitest";
import { createSandboxTools } from "../../src/tools";
import type { ToolContext } from "../../src/tools/types";
import { FakeSandbox } from "../support/fake-sandbox";

// bash の実行中に流す途中の出力（command_progress）。子の LLM に返る tool result には入らず、onEvent の側路だけで流れる。
const GHP = `ghp_${"a1B2".repeat(9)}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Ev = { type: string; data: Record<string, unknown> };

function setup(over: Partial<ToolContext> = {}) {
  const sandbox = new FakeSandbox();
  const events: Ev[] = [];
  const tools = createSandboxTools(sandbox, {
    workspaceRoot: "/workspace",
    deadlineAt: Date.now() + 3_600_000,
    commitAuthor: { name: "rovo-bot", email: "bot@example.com" },
    progressIntervalMs: 15,
    onEvent: (type, data) => events.push({ type, data: data as Record<string, unknown> }),
    ...over,
  });
  const bash = async (args: Record<string, unknown>) => {
    const tool = tools.find((t) => t.name === "bash");
    if (!tool) throw new Error("no bash");
    return await (
      tool.execute as (
        a: unknown,
        b: unknown,
        c: unknown,
      ) => Promise<{
        isError?: boolean;
        output: { type: string; text?: string }[];
      }>
    )(args, {}, {});
  };
  return { sandbox, events, bash };
}

const progress = (events: Ev[]) => events.filter((e) => e.type === "command_progress");

describe("bash の command_progress（実行中の途中の出力）", () => {
  it("実行中は一定間隔で peek して流し、前回と同じ内容なら積まない。終わったら command を 1 件出す。進捗は command より前", async () => {
    const { sandbox, events, bash } = setup();
    sandbox.setHandler(async () => {
      sandbox.live.stdout = "step 1\n";
      await sleep(60);
      sandbox.live.stdout = "step 1\nstep 2\n";
      await sleep(60);
      return { stdout: "step 1\nstep 2\ndone\n" };
    });
    await bash({ command: "pnpm build", cwd: "." });
    const p = progress(events);
    expect(p.map((e) => e.data.outputTail)).toEqual(["step 1\n", "step 1\nstep 2\n"]);
    expect(p[0]?.data).toMatchObject({ command: "pnpm build" });
    expect(typeof p[0]?.data.startedAt).toBe("number");
    const commands = events.filter((e) => e.type === "command");
    expect(commands).toHaveLength(1);
    expect(events.at(-1)?.type).toBe("command");
    // 終わった後は進捗を出さない
    const n = events.length;
    await sleep(60);
    expect(events).toHaveLength(n);
  });

  it("子の LLM に返る tool result には、進捗の中身が入らない（onEvent の側路だけ）", async () => {
    const { sandbox, events, bash } = setup();
    sandbox.setHandler(async () => {
      sandbox.live.stdout = "only-in-progress\n";
      await sleep(50);
      return { stdout: "final-output\n" };
    });
    const res = await bash({ command: "run" });
    expect(progress(events).length).toBeGreaterThan(0);
    const text = res.output.map((c) => c.text ?? "").join("\n");
    expect(text).toContain("final-output");
    expect(text).not.toContain("only-in-progress");
    expect(text).not.toContain("command_progress");
  });

  it("未完の行は出さず、2,000 字に切る前の窓全体をマスクする（境目で割れた秘密が残らない）", async () => {
    const { sandbox, events, bash } = setup();
    const secretLine = `${"a".repeat(500)} ${GHP} ${"z".repeat(1990)}\n`;
    sandbox.setHandler(async () => {
      sandbox.live.stdout = `${secretLine}half-written-line`;
      await sleep(50);
      return {};
    });
    await bash({ command: "run" });
    const tails = progress(events).map((e) => String(e.data.outputTail ?? ""));
    expect(tails.length).toBeGreaterThan(0);
    for (const t of tails) {
      expect(t).not.toContain("half-written-line");
      expect(t).not.toContain(GHP.slice(-20));
      expect(t).not.toContain(GHP.slice(10));
      expect(t.length).toBeLessThanOrEqual(2_000);
    }
    expect(JSON.stringify(events)).not.toContain(GHP.slice(10));
  });

  it("出力がまだ無くても、実行中であることを 1 回は流す（開始時刻つき）。同じ内容は繰り返さない", async () => {
    const { sandbox, events, bash } = setup();
    sandbox.setHandler(async () => {
      await sleep(80);
      return {};
    });
    await bash({ command: "sleep 1" });
    const p = progress(events);
    expect(p).toHaveLength(1);
    expect(p[0]?.data).not.toHaveProperty("outputTail");
    expect(typeof p[0]?.data.startedAt).toBe("number");
  });

  it("間隔より短いコマンドでは進捗を出さない", async () => {
    const { sandbox, events, bash } = setup({ progressIntervalMs: 1_000 });
    sandbox.setHandler(() => ({ stdout: "quick\n" }));
    await bash({ command: "echo quick" });
    expect(progress(events)).toEqual([]);
    expect(events.map((e) => e.type)).toEqual(["command"]);
  });

  it("exec が例外で終わったら（command を出せないので）ended: true で進捗を消す合図を出す", async () => {
    const { sandbox, events, bash } = setup();
    sandbox.setHandler(async () => {
      sandbox.live.stdout = "partial\n";
      await sleep(50);
      throw new Error("container died");
    });
    const res = await bash({ command: "run" });
    expect(res.isError).toBe(true);
    const p = progress(events);
    expect(p.length).toBeGreaterThanOrEqual(2);
    expect(p.at(-1)?.data).toMatchObject({ ended: true, command: "run" });
    expect(events.some((e) => e.type === "command")).toBe(false);
  });

  it("peekOutput が例外でも、無くても、コマンドの結果には影響しない", async () => {
    const a = setup();
    a.sandbox.peekError = new Error("rpc failed");
    a.sandbox.setHandler(async () => {
      await sleep(50);
      return { stdout: "ok\n" };
    });
    expect((await a.bash({ command: "run" })).isError).toBeFalsy();
    expect(progress(a.events)).toEqual([]);

    const b = setup();
    Object.defineProperty(b.sandbox, "peekOutput", { value: undefined });
    b.sandbox.setHandler(async () => {
      await sleep(50);
      return { stdout: "ok\n" };
    });
    expect((await b.bash({ command: "run" })).isError).toBeFalsy();
    expect(progress(b.events)).toEqual([]);
  });
});
