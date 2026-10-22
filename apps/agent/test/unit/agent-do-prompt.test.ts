import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { clearAgentTestOverrides } from "../../src/agent/deps";
import { makeSpec, newFixture, report, waitForTerminal } from "./support/agent-fixture";

afterEach(() => clearAgentTestOverrides());

// biome-ignore lint/suspicious/noExplicitAny: private メンバーの観測
type Inst = any;
const runInDO = runInDurableObject as unknown as <T>(
  stub: unknown,
  fn: (inst: Inst) => Promise<T> | T,
) => Promise<T>;

const procedureText = async (): Promise<string> => {
  const fx = newFixture("prompt-tdd", [report()]);
  await fx.stub.start(makeSpec("prompt-tdd"));
  await waitForTerminal(fx);
  const s = await runInDO(fx.stub, (inst) =>
    inst.promptSections().find((x: { key: string }) => x.key === "procedure"),
  );
  return (s as { text: string }).text;
};

describe("procedure セクションの TDD 手順", () => {
  it("実装の前にテストが落ちることを確かめる手順が入っている", async () => {
    const t = await procedureText();
    expect(t).toContain("FAILS for the expected reason before changing the implementation");
    expect(t).toContain("write or update a test");
    expect(t).toContain("Do not write the implementation before the test");
    expect(t).toMatch(/weaken assertions, skip or delete tests/);
    expect(t).toContain("Do not edit test configuration or delete tests");
  });

  it("例外と summary の要件が入っている", async () => {
    const t = await procedureText();
    expect(t).toMatch(/documentation, comments, config values only, or research/);
    expect(t).toContain("one sentence");
    expect(t).toContain("name of the test that failed before the implementation");
  });
});
