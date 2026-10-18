import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { clearAgentTestOverrides, setAgentTestOverrides } from "../../src/agent/deps";
import { FakeSandbox } from "../support/fake-sandbox";
import {
  allEvents,
  call,
  done,
  type Fixture,
  makeSpec,
  report,
  waitForTerminal,
} from "./support/agent-fixture";

afterEach(() => clearAgentTestOverrides());

const asFx = (stub: Fixture["stub"]) => ({ stub }) as Fixture;

// toolsFactory を差し替えず、本番の配線（createSandboxTools）で動かす。時計も実時間。
describe("AgentDO の本番ツール配線", () => {
  it("createSandboxTools のツール（read_file / bash / git_commit）が SandboxPort 経由で動く", async () => {
    const sandbox = new FakeSandbox((argv) => {
      if (argv[0] === "git" && argv[1] === "rev-parse") return { stdout: "c0ffee\n" };
      if (argv[0] === "git" && argv[1] === "format-patch") return { stdout: "PATCH" };
      if (argv[0] === "bash") return { stdout: "built\n" };
      return {};
    });
    sandbox.files.set("/workspace/a.txt", "alpha\n");
    setAgentTestOverrides("prod-tools", {
      sandbox,
      script: [
        call("read_file", { path: "a.txt" }),
        call("bash", { command: "echo built" }),
        call("git_commit", { message: "feat: x" }),
        report("done"),
      ],
    });
    const stub = env.AGENT_DO.getByName("prod-tools");
    await stub.start(
      makeSpec("prod-tools", { deadlineAt: Date.now() + 60 * 60 * 1000, verificationCommands: [] }),
    );
    expect(await waitForTerminal(asFx(stub))).toBe("completed");
    const ends = (await allEvents(asFx(stub))).filter((e) => e.type === "tool_end");
    expect(ends.map((e) => [e.data.name, e.data.isError])).toEqual([
      ["read_file", false],
      ["bash", false],
      ["git_commit", false],
      // report_completion は終端の phase を積んだ後なので tool_end は残らない
    ]);
    expect(sandbox.calls.some((c) => c.argv[0] === "bash" && c.argv.includes("echo built"))).toBe(
      true,
    );
    expect(done(await stub.getResult()).status).toBe("completed");
  });

  it("echo ツールはもう無い（スパイクの残骸を持たない）", async () => {
    setAgentTestOverrides("no-echo", {
      sandbox: new FakeSandbox(),
      script: [call("echo", { text: "x" }), { text: "end" }],
    });
    const stub = env.AGENT_DO.getByName("no-echo");
    await stub.start(makeSpec("no-echo", { deadlineAt: Date.now() + 60 * 60 * 1000 }));
    await waitForTerminal(asFx(stub));
    const ends = (await allEvents(asFx(stub))).filter((e) => e.type === "tool_end");
    expect(ends.every((e) => e.data.isError === true)).toBe(true);
  });
});
