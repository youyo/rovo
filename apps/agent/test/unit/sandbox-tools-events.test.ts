import { describe, expect, it } from "vitest";
import { createSandboxTools } from "../../src/tools";
import type { ToolContext } from "../../src/tools/types";
import { type ExecHandler, FakeSandbox } from "../support/fake-sandbox";

// 構造化イベント（D14）。ツールの成功に合わせて onEvent に型付きで渡る。秘密・制御文字・差分の本文は入らない
const GHP = `ghp_${"a1B2".repeat(9)}`;

function setup(handler?: ExecHandler, over: Partial<ToolContext> = {}) {
  const sandbox = new FakeSandbox(handler);
  const events: { type: string; data: Record<string, unknown> }[] = [];
  const tools = createSandboxTools(sandbox, {
    workspaceRoot: "/workspace",
    deadlineAt: Date.now() + 3_600_000,
    commitAuthor: { name: "rovo-bot", email: "bot@example.com" },
    onEvent: (type, data) => events.push({ type, data: data as Record<string, unknown> }),
    ...over,
  });
  const run = async (name: string, args: Record<string, unknown>) => {
    const tool = tools.find((t) => t.name === name);
    if (!tool) throw new Error(`no tool ${name}`);
    const res = await (
      tool.execute as (a: unknown, b: unknown, c: unknown) => Promise<{ isError?: boolean }>
    )(args, {}, {});
    return { isError: res.isError === true };
  };
  return { sandbox, events, run };
}

describe("bash の command イベント", () => {
  it("command・cwd（相対）・exit_code・所要時間・出力の末尾が出る。秘密は伏せ、ANSI は除く", async () => {
    const { events, run } = setup(() => ({
      exitCode: 2,
      stdout: `ok \u001b[31mred\u001b[0m ${GHP}\n`,
      stderr: "boom\n",
    }));
    await run("bash", { command: `GITHUB_TOKEN=${GHP} pnpm test`, cwd: "apps/gateway" });
    expect(events).toHaveLength(1);
    const e = events[0];
    expect(e?.type).toBe("command");
    expect(e?.data).toMatchObject({ cwd: "apps/gateway", exitCode: 2 });
    expect(typeof e?.data.durationMs).toBe("number");
    expect(String(e?.data.outputTail)).toContain("ok red");
    expect(String(e?.data.outputTail)).toContain("boom");
    expect(JSON.stringify(e)).not.toContain(GHP);
    expect(JSON.stringify(e)).not.toContain("\u001b");
  });

  it("タイムアウトは exit_code が null。ワークスペース直下の cwd は付かない", async () => {
    const { events, run } = setup(() => ({ exitCode: 124, timedOut: true }));
    await run("bash", { command: "sleep 999" });
    expect(events[0]?.data).toMatchObject({ command: "sleep 999", exitCode: null });
    expect(events[0]?.data).not.toHaveProperty("cwd");
  });

  it("失敗（cwd がワークスペースの外）では出さない", async () => {
    const { events, run } = setup();
    await run("bash", { command: "ls", cwd: "/etc" });
    expect(events).toEqual([]);
  });
});

describe("write_file / edit_file の edit イベント", () => {
  it("write_file: 新規は create、既存は modify。行数だけで本文は出ない", async () => {
    const { sandbox, events, run } = setup();
    await run("write_file", { path: "src/new.ts", content: "a\nb\nc\n" });
    expect(events[0]).toEqual({
      type: "edit",
      data: { path: "src/new.ts", op: "create", added: 3, removed: 0 },
    });
    expect(sandbox.files.get("/workspace/src/new.ts")).toBe("a\nb\nc\n");
    await run("write_file", { path: "src/new.ts", content: "x\ny\n" });
    expect(events[1]).toEqual({
      type: "edit",
      data: { path: "src/new.ts", op: "modify", added: 2, removed: 3 },
    });
    expect(JSON.stringify(events)).not.toContain("a\\nb");
  });

  it("write_file: 外のパスは書かず、イベントも出さない", async () => {
    const { events, run } = setup();
    await run("write_file", { path: "../x", content: "x" });
    await run("write_file", { path: "/etc/x", content: "x" });
    expect(events).toEqual([]);
  });

  it("edit_file: modify。added / removed は new_string / old_string の行数", async () => {
    const { sandbox, events, run } = setup();
    sandbox.files.set("/workspace/a.ts", "one\ntwo\nthree\n");
    await run("edit_file", { path: "a.ts", old_string: "two", new_string: "2a\n2b" });
    expect(events).toEqual([
      { type: "edit", data: { path: "a.ts", op: "modify", added: 2, removed: 1 } },
    ]);
  });

  it("edit_file: 失敗（一致なし）では出さない", async () => {
    const { sandbox, events, run } = setup();
    sandbox.files.set("/workspace/a.ts", "one\n");
    await run("edit_file", { path: "a.ts", old_string: "zzz", new_string: "y" });
    expect(events).toEqual([]);
  });
});

describe("git_commit の commit イベント", () => {
  const sha = "0123456789abcdef0123456789abcdef01234567";

  it("メッセージの 1 行目（マスク済み）・sha・ファイル数", async () => {
    const { events, run } = setup((argv) => {
      if (argv.includes("--quiet")) return { exitCode: 1 };
      if (argv.includes("rev-parse")) return { stdout: `${sha}\n` };
      if (argv.includes("diff-tree")) return { stdout: "a.ts\nb/c.ts\n" };
      return {};
    });
    await run("git_commit", { message: `feat: x ${GHP}\n\nbody line` });
    expect(events).toEqual([
      { type: "commit", data: { message: "feat: x [REDACTED]", sha, files: 2 } },
    ]);
  });

  it("変更なしでは出さない", async () => {
    const { events, run } = setup((argv) => (argv.includes("--quiet") ? { exitCode: 0 } : {}));
    await run("git_commit", { message: "m" });
    expect(events).toEqual([]);
  });

  it("files の取得に失敗しても commit イベントは出る（files は 0）", async () => {
    const { events, run } = setup((argv) => {
      if (argv.includes("--quiet")) return { exitCode: 1 };
      if (argv.includes("rev-parse")) return { stdout: `${sha}\n` };
      if (argv.includes("diff-tree")) return { exitCode: 128 };
      return {};
    });
    await run("git_commit", { message: "m" });
    expect(events[0]).toEqual({ type: "commit", data: { message: "m", sha, files: 0 } });
  });
});

describe("git_commit: diff-tree が失敗してもツールは成功し、push は必ず走る", () => {
  const sha = "0123456789abcdef0123456789abcdef01234567";
  it("exec が reject しても commit イベントは出て（files は 0）、isError にならず、push する", async () => {
    const { sandbox, events, run } = setup(
      (argv) => {
        if (argv.includes("--quiet")) return { exitCode: 1 };
        if (argv.includes("rev-parse")) return { stdout: `${sha}\n` };
        if (argv.includes("diff-tree")) throw new Error("exec rejected");
        return {};
      },
      { branch: "agent/task-x", onPush: async () => {} },
    );
    const r = await run("git_commit", { message: "m" });
    expect(r.isError).toBe(false);
    expect(events).toEqual([{ type: "commit", data: { message: "m", sha, files: 0 } }]);
    expect(sandbox.calls.some((c) => c.argv[0] === "git" && c.argv.includes("push"))).toBe(true);
  });
});

describe("onEvent の失敗", () => {
  it("onEvent が例外を投げても、ツールは失敗にならない", async () => {
    const { run } = setup(undefined, {
      onEvent: () => {
        throw new Error("boom");
      },
    });
    expect((await run("bash", { command: "true" })).isError).toBe(false);
  });
});
