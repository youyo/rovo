import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { clearAgentTestOverrides, setAgentTestOverrides } from "../../src/agent/deps";
import type { WebPort } from "../../src/tools/web";
import { FakeSandbox } from "../support/fake-sandbox";
import {
  allEvents,
  call,
  type Fixture,
  makeSpec,
  report,
  waitForTerminal,
} from "./support/agent-fixture";

afterEach(() => clearAgentTestOverrides());

const asFx = (stub: Fixture["stub"]) => ({ stub }) as Fixture;

// 秘密の検出に反応しないよう、明らかな偽物を組み立てる
const GHP = `ghp_${"a1B2".repeat(9)}`;
const GHS = `ghs_${"c3D4".repeat(9)}`;
const PAT = `github_pat_${"E5f6".repeat(8)}`;
const SHA = "0123456789abcdef0123456789abcdef01234567";
const SECRETS = [GHP, GHS, PAT, "abcdef0123456789xyz", "s3cretPass", "plainvalue123"];

const web: WebPort = {
  async search() {
    return {
      results: [],
      metadata: { requestId: "r", latencyMs: 1, provider: "linkup", dropped_urls: 0 },
    } as never;
  },
  async fetchUrl(req) {
    return {
      source: { url: req.url, final_url: req.url, retrieved_at: "t", via: "direct" },
      content: "x",
      safety: { verdict: "allow" },
      status: "ok",
    } as never;
  },
  async browse() {
    throw new Error("unused");
  },
};

// toolsFactory を差し替えず、本番の配線（createSandboxTools → AgentDO.emit）で動かす
describe("AgentDO: 構造化イベント（D14）", () => {
  it("bash / write_file / edit_file / git_commit / web_fetch が command / edit / commit / web を積み、どこにも秘密が平文で残らない", async () => {
    const sandbox = new FakeSandbox((argv) => {
      if (argv[0] === "git" && argv[1] === "diff") return { exitCode: 1 };
      if (argv[0] === "git" && argv[1] === "rev-parse") return { stdout: `${SHA}\n` };
      if (argv[0] === "git" && argv[1] === "diff-tree") return { stdout: "a.txt\nb.txt\n" };
      if (argv[0] === "git" && argv[1] === "ls-remote") return { stdout: `${SHA}\t${argv[3]}\n` };
      if (argv[0] === "git" && argv[1] === "format-patch") return { stdout: "PATCH" };
      if (argv[0] === "bash") {
        return {
          exitCode: 3,
          stdout: `log \u001b[31mred\u001b[0m ${GHS}\nAPI_KEY=plainvalue123\n`,
          stderr: `fatal: https://user:s3cretPass@h.example/x ${PAT}\n`,
        };
      }
      return {};
    });
    sandbox.files.set("/workspace/a.txt", "alpha\nbeta\n");
    setAgentTestOverrides("structured-1", {
      sandbox,
      web,
      script: [
        call("bash", {
          command: `echo start; wget --header "Authorization: Bearer ${"abcdef0123456789xyz"}" -u x:${GHP} h`,
          cwd: "sub",
        }),
        call("write_file", { path: "sub/new.txt", content: "one\ntwo\nthree\n" }),
        call("edit_file", { path: "a.txt", old_string: "beta", new_string: "BETA\nGAMMA" }),
        call("git_commit", { message: `feat: add ${GHP}\n\nbody ${GHS}` }),
        call("web_fetch", { url: "https://User:pw@docs.example.com:8443/secret/path?token=zzz#f" }),
        report("done"),
      ],
    });
    const stub = env.AGENT_DO.getByName("structured-1");
    await stub.start(
      makeSpec("structured-1", {
        deadlineAt: Date.now() + 60 * 60 * 1000,
        verificationCommands: [],
      }),
    );
    expect(await waitForTerminal(asFx(stub))).toBe("completed");
    const events = await allEvents(asFx(stub));
    const structured = events.filter((e) => ["command", "edit", "commit", "web"].includes(e.type));

    const byType = (t: string) => structured.filter((e) => e.type === t).map((e) => e.data);
    expect(byType("command")).toHaveLength(1);
    expect(byType("command")[0]).toMatchObject({ cwd: "sub", exitCode: 3 });
    expect(String(byType("command")[0]?.command)).toContain("echo start");
    expect(String(byType("command")[0]?.outputTail)).toContain("log red");
    expect(byType("edit")).toEqual([
      { path: "sub/new.txt", op: "create", added: 3, removed: 0 },
      { path: "a.txt", op: "modify", added: 2, removed: 1 },
    ]);
    expect(byType("commit")).toEqual([{ message: "feat: add [REDACTED]", sha: SHA, files: 2 }]);
    // URL のパス・クエリ・資格・ポートは出ない。host だけ
    expect(byType("web")).toEqual([{ kind: "fetch", host: "docs.example.com" }]);

    // agent が出すイベント全体（既存の tool_start / tool_end も含む）に、平文の秘密が無い
    const whole = JSON.stringify(events);
    for (const s of SECRETS) expect(whole, s).not.toContain(s);
    // 構造化イベントには URL のパス・クエリ・ANSI が無い（既存の tool_start の要約は D14 では変えない）
    const structuredJson = JSON.stringify(structured);
    expect(structuredJson).not.toContain("/secret/path");
    expect(structuredJson).not.toContain("token=zzz");
    expect(whole).not.toContain("\u001b");
  });

  it("bash の実行中の途中の出力は command_progress として積まれ（既定の間隔 4 秒）、秘密は平文で残らない。command より前", async () => {
    const sandbox = new FakeSandbox(async (argv) => {
      if (argv[0] === "git" && argv[1] === "diff") return { exitCode: 1 };
      if (argv[0] === "git" && argv[1] === "rev-parse") return { stdout: `${SHA}\n` };
      if (argv[0] === "git" && argv[1] === "diff-tree") return { stdout: "a.txt\n" };
      if (argv[0] === "git" && argv[1] === "ls-remote") return { stdout: `${SHA}\t${argv[3]}\n` };
      if (argv[0] === "git" && argv[1] === "format-patch") return { stdout: "PATCH" };
      if (argv[0] === "bash") {
        sandbox.live.stdout = `building ${GHS}\nAPI_KEY=plainvalue123\nhalf-line`;
        await new Promise((r) => setTimeout(r, 4_800));
        return { stdout: "built\n" };
      }
      return {};
    });
    setAgentTestOverrides("structured-progress", {
      sandbox,
      script: [call("bash", { command: "pnpm build" }), report("done")],
    });
    const stub = env.AGENT_DO.getByName("structured-progress");
    await stub.start(
      makeSpec("structured-progress", {
        deadlineAt: Date.now() + 60 * 60 * 1000,
        verificationCommands: [],
      }),
    );
    expect(await waitForTerminal(asFx(stub))).toBe("completed");
    const events = await allEvents(asFx(stub));
    const progress = events.filter((e) => e.type === "command_progress");
    expect(progress.length).toBeGreaterThanOrEqual(1);
    expect(progress[0]?.data).toMatchObject({ command: "pnpm build" });
    expect(String(progress[0]?.data.outputTail)).toContain("building");
    expect(String(progress[0]?.data.outputTail)).not.toContain("half-line");
    const types = events.map((e) => e.type);
    expect(types.indexOf("command_progress")).toBeLessThan(types.indexOf("command"));
    const whole = JSON.stringify(progress);
    for (const s of SECRETS) expect(whole, s).not.toContain(s);
  }, 30_000);

  it("web イベントの送出が失敗しても、web ツールは失敗しない", async () => {
    setAgentTestOverrides("structured-3", {
      sandbox: new FakeSandbox(),
      web,
      script: [call("web_fetch", { url: "https://docs.example.com/x" }), report("done")],
    });
    const stub = env.AGENT_DO.getByName("structured-3");
    // private メンバー（emit）の差し替え
    await runInDurableObject(stub, (inst) => {
      const o = inst as unknown as { emit: (t: string, d: unknown) => void };
      const orig = o.emit.bind(o);
      o.emit = (type, data) => {
        if (type === "web") throw new Error("emit failed");
        orig(type, data);
      };
    });
    await stub.start(
      makeSpec("structured-3", {
        deadlineAt: Date.now() + 60 * 60 * 1000,
        verificationCommands: [],
      }),
    );
    expect(await waitForTerminal(asFx(stub))).toBe("completed");
    const events = await allEvents(asFx(stub));
    const end = events.find((e) => e.type === "tool_end" && e.data.name === "web_fetch");
    expect(end?.data.isError).toBe(false);
    expect(events.some((e) => e.type === "web")).toBe(false);
  });

  it("古い型（tool_start / tool_end）は変わらず積まれる", async () => {
    const sandbox = new FakeSandbox();
    setAgentTestOverrides("structured-2", {
      sandbox,
      script: [call("bash", { command: "true" }), report("done")],
    });
    const stub = env.AGENT_DO.getByName("structured-2");
    await stub.start(
      makeSpec("structured-2", {
        deadlineAt: Date.now() + 60 * 60 * 1000,
        verificationCommands: [],
      }),
    );
    await waitForTerminal(asFx(stub));
    const types = (await allEvents(asFx(stub))).map((e) => e.type);
    expect(types).toContain("tool_start");
    expect(types).toContain("tool_end");
    expect(types).toContain("command");
  });
});
