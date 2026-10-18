import { describe, expect, it } from "vitest";
import type { SandboxPort } from "../../src/sandbox-port";
import { FakeSandbox } from "../support/fake-sandbox";

describe("FakeSandbox（SandboxPort の Unit 用 fake）", () => {
  it("SandboxPort として使え、exec の呼び出しを記録してハンドラの結果を返す", async () => {
    const sandbox: SandboxPort = new FakeSandbox((argv) =>
      argv[0] === "false" ? { exitCode: 1, stderr: "boom" } : { stdout: "ok" },
    );
    expect(await sandbox.exec(["echo"])).toMatchObject({
      exitCode: 0,
      stdout: "ok",
      timedOut: false,
    });
    expect(await sandbox.exec(["false"])).toMatchObject({ exitCode: 1, stderr: "boom" });
    expect((sandbox as FakeSandbox).calls.map((c) => c.argv[0])).toEqual(["echo", "false"]);
  });

  it("ファイルを書いて読める。無いファイルは ENOENT", async () => {
    const sandbox = new FakeSandbox();
    await sandbox.writeFile("/workspace/a.txt", "hi");
    expect(await sandbox.readFile("/workspace/a.txt")).toBe("hi");
    await expect(sandbox.readFile("/workspace/none")).rejects.toThrow("ENOENT");
  });
});
