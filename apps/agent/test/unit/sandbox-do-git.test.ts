import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

// Git の認証トークンの保管と、作業ツリーの用意（prepareWorkspace）を、fake のコンテナで決定的に確かめる。
// 実コンテナでの検証は E2E。

const BASE = "a".repeat(40);
const INITIAL = "b".repeat(40);

// biome-ignore lint/suspicious/noExplicitAny: private メンバーを差し替えるテスト
type Inst = any;
const runInDO = runInDurableObject as unknown as <T>(
  stub: unknown,
  fn: (inst: Inst) => Promise<T>,
) => Promise<T>;
const sandbox = (name: string) => (env.SANDBOX_DO as DurableObjectNamespace).getByName(name);

interface Reply {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
}
/** exec の応答を台本で返す fake コンテナ。呼ばれた argv を記録する。 */
class GitContainer {
  running = true;
  images = { workspace: "fake" };
  calls: string[][] = [];
  constructor(private readonly handler: (argv: string[]) => Reply) {}
  async destroy() {
    this.running = false;
  }
  async exec(argv: string[]) {
    this.calls.push(argv);
    const r = this.handler(argv);
    const stream = (t = "") =>
      new ReadableStream<Uint8Array>({
        start(c) {
          if (t) c.enqueue(new TextEncoder().encode(t));
          c.close();
        },
      });
    return {
      stdout: stream(r.stdout),
      stderr: stream(r.stderr),
      exitCode: Promise.resolve(r.exitCode ?? 0),
    };
  }
}

const spec = (over: Record<string, unknown> = {}) => ({
  repository: "acme/hello",
  baseSha: BASE,
  branch: "agent/task-x",
  initialSha: INITIAL,
  deadlineAt: Date.now() + 3_600_000,
  ...over,
});
const gitArgs = (argv: string[]) => (argv[0] === "git" && argv[1] === "-C" ? argv.slice(3) : argv);

describe("SandboxDO: Git 認証トークンの保管", () => {
  it("暗号化して保存し、平文は storage に残らない。読み出すと元に戻る", async () => {
    await runInDO(sandbox("cred-basic"), async (inst) => {
      await inst.setGitCredential({ token: "ghs_secret_value", expiresAt: 5_000 });
      expect(await inst.readGitCredential()).toEqual({
        token: "ghs_secret_value",
        expiresAt: 5_000,
      });
      const raw = JSON.stringify(inst.ctx.storage.kv.get("git_credential"));
      expect(raw).not.toContain("ghs_secret_value");
      expect(raw).toContain("5000");
    });
  });

  it("保存済みより新しい expiresAt のものだけ採用する（冪等・古い再送は無視）", async () => {
    await runInDO(sandbox("cred-newer"), async (inst) => {
      await inst.setGitCredential({ token: "t1", expiresAt: 1_000 });
      await inst.setGitCredential({ token: "t1", expiresAt: 1_000 });
      await inst.setGitCredential({ token: "stale", expiresAt: 900 });
      expect(await inst.readGitCredential()).toEqual({ token: "t1", expiresAt: 1_000 });
      await inst.setGitCredential({ token: "t2", expiresAt: 2_000 });
      expect(await inst.readGitCredential()).toEqual({ token: "t2", expiresAt: 2_000 });
      // 同じ expiresAt の別トークンは採用しない（先着）
      await inst.setGitCredential({ token: "t3", expiresAt: 2_000 });
      expect((await inst.readGitCredential())?.token).toBe("t2");
    });
  });

  it("不正な値（空・空白や制御文字を含む・長すぎる・expiresAt が数でない）は拒否する", async () => {
    await runInDO(sandbox("cred-invalid"), async (inst) => {
      for (const bad of [
        { token: "", expiresAt: 1 },
        { token: "a b", expiresAt: 1 },
        { token: "a\nb", expiresAt: 1 },
        { token: "x".repeat(5000), expiresAt: 1 },
        { token: "ok", expiresAt: Number.NaN },
        { token: "ok", expiresAt: "1" },
        { token: 1, expiresAt: 1 },
        null,
      ]) {
        await expect(inst.setGitCredential(bad)).rejects.toThrow(/invalid/);
      }
      expect(await inst.readGitCredential()).toBeUndefined();
    });
  });

  it("別のタスクの SandboxDO に暗号文をコピーしても復号できない（用途とタスクに紐づく）", async () => {
    const stolen = await runInDO(sandbox("cred-victim"), async (inst) => {
      await inst.setGitCredential({ token: "ghs_victim", expiresAt: 9_000 });
      return inst.ctx.storage.kv.get("git_credential");
    });
    await runInDO(sandbox("cred-attacker"), async (inst) => {
      inst.ctx.storage.kv.put("git_credential", stolen);
      expect(await inst.readGitCredential()).toBeUndefined();
    });
  });

  it("terminate で削除され、以後は読めず、預けることもできない", async () => {
    await runInDO(sandbox("cred-terminate"), async (inst) => {
      inst.maybeContainer = () => new GitContainer(() => ({}));
      await inst.setGitCredential({ token: "ghs_gone", expiresAt: 9_000 });
      await inst.terminate();
      expect(inst.ctx.storage.kv.get("git_credential")).toBeUndefined();
      expect(await inst.readGitCredential()).toBeUndefined();
      await expect(
        inst.setGitCredential({ token: "ghs_again", expiresAt: 99_000 }),
      ).rejects.toThrow(/terminated/);
    });
  });

  it("期限（deadline）で自分で止まるときも削除する", async () => {
    await runInDO(sandbox("cred-deadline"), async (inst) => {
      inst.maybeContainer = () => new GitContainer(() => ({}));
      inst.ctx.storage.kv.put("spec", spec({ deadlineAt: Date.now() - 1 }));
      await inst.setGitCredential({ token: "ghs_expiring", expiresAt: 9_000 });
      await inst.alarm();
      expect(inst.ctx.storage.kv.get("git_credential")).toBeUndefined();
    });
  });

  it("鍵が無い・不正なら預けられない（fail-closed）", async () => {
    await runInDO(sandbox("cred-nokey"), async (inst) => {
      inst.env = { ...inst.env, TOKEN_ENC_KEY: "" };
      await expect(inst.setGitCredential({ token: "t", expiresAt: 1 })).rejects.toThrow(
        /TOKEN_ENC_KEY/,
      );
    });
  });
});

describe("SandboxDO: prepareWorkspace（作業ブランチの checkout）", () => {
  /** HEAD が無い（作業ツリー無し）→ clone → merge-base の応答を台本にする */
  const fresh = (over: (argv: string[]) => Reply | undefined = () => undefined) =>
    new GitContainer((argv) => {
      const o = over(argv);
      if (o) return o;
      const a = gitArgs(argv);
      if (a[0] === "rev-parse" && a.includes("HEAD") && a.includes("--verify"))
        return { exitCode: 128 };
      return {};
    });

  it("常にリモートの作業ブランチを clone して checkout し、base_sha が祖先であることを確かめる", async () => {
    const c = fresh();
    await runInDO(sandbox("prep-ok"), async (inst) => {
      inst.maybeContainer = () => c;
      await inst.prepareWorkspace(spec());
    });
    const cloneCall = c.calls.find((a) => a[0] === "git" && a.includes("clone"));
    expect(cloneCall).toEqual([
      "git",
      "clone",
      "-q",
      "--branch",
      "agent/task-x",
      "https://github.com/acme/hello.git",
      "/workspace",
    ]);
    expect(cloneCall).not.toContain("--depth");
    expect(c.calls.map(gitArgs)).toContainEqual(["merge-base", "--is-ancestor", BASE, "HEAD"]);
    // clone の後に base_sha を checkout して作業ブランチを切る旧来の経路は使わない
    expect(c.calls.some((a) => a.includes("--detach"))).toBe(false);
  });

  it("base_sha が作業ブランチの祖先でなければ失敗する（fail-closed）", async () => {
    const c = fresh((argv) => (gitArgs(argv)[0] === "merge-base" ? { exitCode: 1 } : undefined));
    await runInDO(sandbox("prep-ancestor"), async (inst) => {
      inst.maybeContainer = () => c;
      await expect(inst.prepareWorkspace(spec())).rejects.toThrow(/base/);
    });
  });

  it("merge-base 自体が失敗（exit 128 など）しても失敗する", async () => {
    const c = fresh((argv) =>
      gitArgs(argv)[0] === "merge-base" ? { exitCode: 128, stderr: "fatal" } : undefined,
    );
    await runInDO(sandbox("prep-mb-error"), async (inst) => {
      inst.maybeContainer = () => c;
      await expect(inst.prepareWorkspace(spec())).rejects.toThrow(/merge-base/);
    });
  });

  it("リモートに作業ブランチが無ければ clone が失敗して止まる", async () => {
    const c = fresh((argv) =>
      argv.includes("clone")
        ? { exitCode: 128, stderr: "warning: Remote branch agent/task-x not found" }
        : undefined,
    );
    await runInDO(sandbox("prep-nobranch"), async (inst) => {
      inst.maybeContainer = () => c;
      await expect(inst.prepareWorkspace(spec())).rejects.toThrow(/git clone failed/);
    });
    expect(c.calls.some((a) => gitArgs(a)[0] === "merge-base")).toBe(false);
  });

  it("既に作業ブランチにいるなら何もしない（ローカルの commit を壊さない）", async () => {
    const c = new GitContainer((argv) => {
      const a = gitArgs(argv);
      if (a[0] === "rev-parse" && a.includes("--abbrev-ref")) return { stdout: "agent/task-x\n" };
      return {};
    });
    await runInDO(sandbox("prep-idempotent"), async (inst) => {
      inst.maybeContainer = () => c;
      await inst.prepareWorkspace(spec());
    });
    expect(
      c.calls.some((a) => a.includes("clone") || a.includes("switch") || a.includes("fetch")),
    ).toBe(false);
  });

  it("再起動のメッセージは「最後に push したチェックポイントから再 clone した」旨を伝える", async () => {
    await runInDO(sandbox("prep-message"), async (inst) => {
      inst.ensureRunning = async () => true;
      const err = await inst.runningOrThrowRestarted().catch((e: Error) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toMatch(/last pushed checkpoint/);
      expect(err.message).not.toMatch(/base commit/);
    });
  });
});
