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

  it("読み取り専用トークン（apiRead）も暗号化して一緒に保存し、読み出すと元に戻る", async () => {
    await runInDO(sandbox("cred-apiread"), async (inst) => {
      await inst.setGitCredential({
        token: "ghs_git_value",
        expiresAt: 5_000,
        apiRead: { token: "ghs_read_value", expiresAt: 5_100 },
      });
      expect(await inst.readGitCredential()).toEqual({
        token: "ghs_git_value",
        expiresAt: 5_000,
        apiRead: { token: "ghs_read_value", expiresAt: 5_100 },
      });
      const raw = JSON.stringify(inst.ctx.storage.kv.get("git_credential"));
      expect(raw).not.toContain("ghs_read_value");
      expect(raw).not.toContain("ghs_git_value");
      // 更新で apiRead が無ければ、古い apiRead は残さない
      await inst.setGitCredential({ token: "ghs_git_2", expiresAt: 6_000 });
      expect(await inst.readGitCredential()).toEqual({ token: "ghs_git_2", expiresAt: 6_000 });
    });
  });

  it("apiRead が不正な形なら、apiRead だけを捨てて git の token は預ける（fail-soft）", async () => {
    await runInDO(sandbox("cred-apiread-bad"), async (inst) => {
      for (const [i, bad] of [
        { token: "", expiresAt: 1 },
        { token: "a b", expiresAt: 1 },
        { token: "ok", expiresAt: Number.NaN },
        "ghs_string",
        null,
      ].entries()) {
        await inst.setGitCredential({ token: `ghs_g${i}`, expiresAt: 1_000 + i, apiRead: bad });
        expect(await inst.readGitCredential()).toEqual({
          token: `ghs_g${i}`,
          expiresAt: 1_000 + i,
        });
      }
    });
  });

  it("apiRead の暗号文を git の token の位置にコピーしても復号できない（用途ごとに AAD が違う）", async () => {
    await runInDO(sandbox("cred-apiread-swap"), async (inst) => {
      await inst.setGitCredential({
        token: "ghs_git_value",
        expiresAt: 5_000,
        apiRead: { token: "ghs_read_value", expiresAt: 5_000 },
      });
      const stored = inst.ctx.storage.kv.get("git_credential");
      expect(stored.readCt).toBeTypeOf("string");
      inst.ctx.storage.kv.put("git_credential", { ...stored, ct: stored.readCt });
      expect(await inst.readGitCredential()).toBeUndefined();
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

  describe("task_review（checkout の指定）: PR の head を detached で取り出す", () => {
    const HEAD = "c".repeat(40);
    const reviewSpec = () =>
      spec({
        baseSha: HEAD,
        initialSha: HEAD,
        branch: "pull/7/head",
        checkout: { pullNumber: 7, sha: HEAD },
      });

    it("作業ツリーが無ければ clone（checkout しない）→ refs/pull/<n>/head を取り出す → head を detached で checkout", async () => {
      let head = "";
      const c = new GitContainer((argv) => {
        const a = gitArgs(argv);
        if (a[0] === "rev-parse" && a.includes("--verify"))
          return head ? { stdout: `${head}\n` } : { exitCode: 128 };
        if (a[0] === "rev-parse" && a.includes("HEAD")) return { stdout: `${head}\n` };
        if (a[0] === "checkout") head = HEAD;
        return {};
      });
      await runInDO(sandbox("prep-review"), async (inst) => {
        inst.maybeContainer = () => c;
        await inst.prepareWorkspace(reviewSpec());
      });
      const cloneCall = c.calls.find((a) => a[0] === "git" && a.includes("clone"));
      expect(cloneCall).toEqual([
        "git",
        "clone",
        "-q",
        "--no-checkout",
        "https://github.com/acme/hello.git",
        "/workspace",
      ]);
      const sub = c.calls.map(gitArgs);
      expect(sub).toContainEqual([
        "fetch",
        "-q",
        "origin",
        "+refs/pull/7/head:refs/remotes/origin/pull/7/head",
      ]);
      expect(sub).toContainEqual(["checkout", "-q", "--detach", HEAD]);
      // 作業ブランチの経路（--branch・base の祖先の確認）は使わない
      expect(cloneCall).not.toContain("--branch");
      expect(sub.some((a) => a[0] === "merge-base")).toBe(false);
    });

    it("すでに head を取り出していれば何もしない", async () => {
      const c = new GitContainer((argv) => {
        const a = gitArgs(argv);
        if (a[0] === "rev-parse") return { stdout: `${HEAD}\n` };
        return {};
      });
      await runInDO(sandbox("prep-review-idem"), async (inst) => {
        inst.maybeContainer = () => c;
        await inst.prepareWorkspace(reviewSpec());
      });
      expect(c.calls.some((a) => a.includes("clone") || a.includes("fetch"))).toBe(false);
    });

    it("取り出した HEAD が head と違えば失敗する（fail-closed）", async () => {
      const c = new GitContainer((argv) => {
        const a = gitArgs(argv);
        if (a[0] === "rev-parse" && a.includes("--verify")) return { exitCode: 128 };
        if (a[0] === "rev-parse") return { stdout: `${"d".repeat(40)}\n` };
        return {};
      });
      await runInDO(sandbox("prep-review-mismatch"), async (inst) => {
        inst.maybeContainer = () => c;
        await expect(inst.prepareWorkspace(reviewSpec())).rejects.toThrow(/pull request head/);
      });
    });
  });

  describe("積み足し（continuation）: clone / switch の直後に HEAD が initialSha と一致することを確かめる（門番 3）", () => {
    const PUSHED = "e".repeat(40);
    const OTHER = "f".repeat(40);
    const contSpec = (over: Record<string, unknown> = {}) =>
      spec({
        baseSha: INITIAL,
        initialSha: INITIAL,
        branch: "agent/task-r1",
        continuation: { of: "p1", root: "r1" },
        ...over,
      });
    const isHeadRead = (a: string[]) => a.length === 2 && a[0] === "rev-parse" && a[1] === "HEAD";
    /** 作業ツリーが無い → clone。rev-parse HEAD の応答を台本にする */
    const freshAt = (head: Reply, over: (a: string[]) => Reply | undefined = () => undefined) =>
      fresh((argv) => {
        const a = gitArgs(argv);
        const o = over(a);
        if (o) return o;
        if (isHeadRead(a)) return head;
        return undefined;
      });

    it("clone の後の HEAD が initialSha なら通る（rev-parse HEAD で確かめる）", async () => {
      const c = freshAt({ stdout: `${INITIAL}\n` });
      await runInDO(sandbox("prep-cont-ok"), async (inst) => {
        inst.maybeContainer = () => c;
        await inst.prepareWorkspace(contSpec());
      });
      expect(c.calls.map(gitArgs)).toContainEqual(["rev-parse", "HEAD"]);
    });

    it("clone の後の HEAD が initialSha と違えば（人や他の push でブランチが進んでいた）branch_moved で失敗する。実際の HEAD を載せる", async () => {
      const c = freshAt({ stdout: `${OTHER}\n` });
      await runInDO(sandbox("prep-cont-moved"), async (inst) => {
        inst.maybeContainer = () => c;
        const err = await inst.prepareWorkspace(contSpec()).catch((e: Error) => e);
        expect(err).toBeInstanceOf(Error);
        expect(err.message).toMatch(/^branch_moved/);
        expect(err.message).toContain(OTHER);
      });
    });

    it("rev-parse HEAD が失敗したら（判定できない）失敗側に倒す", async () => {
      const c = freshAt({ exitCode: 128, stderr: "fatal" });
      await runInDO(sandbox("prep-cont-revparse-fail"), async (inst) => {
        inst.maybeContainer = () => c;
        await expect(inst.prepareWorkspace(contSpec())).rejects.toThrow(/branch_moved|rev-parse/);
      });
    });

    it("作業ツリーはあるが作業ブランチが無い（fetch して switch -c）ときも、HEAD が initialSha と違えば失敗する", async () => {
      const at = (head: string) =>
        new GitContainer((argv) => {
          const a = gitArgs(argv);
          if (a[0] === "rev-parse" && a.includes("--abbrev-ref")) return { stdout: "HEAD\n" };
          if (a[0] === "rev-parse" && a.includes(`refs/heads/agent/task-r1`))
            return { exitCode: 1 };
          if (isHeadRead(a)) return { stdout: `${head}\n` };
          return {};
        });
      const bad = at(OTHER);
      await runInDO(sandbox("prep-cont-fetch-moved"), async (inst) => {
        inst.maybeContainer = () => bad;
        await expect(inst.prepareWorkspace(contSpec())).rejects.toThrow(/branch_moved/);
      });
      expect(bad.calls.map(gitArgs)).toContainEqual([
        "switch",
        "-q",
        "-c",
        "agent/task-r1",
        "--no-track",
        "origin/agent/task-r1",
      ]);
      const good = at(INITIAL);
      await runInDO(sandbox("prep-cont-fetch-ok"), async (inst) => {
        inst.maybeContainer = () => good;
        await inst.prepareWorkspace(contSpec());
      });
    });

    it("ローカルにある作業ブランチへ switch したときも確かめる（initialSha を含まなければ失敗）", async () => {
      const at = (mergeBase: number) =>
        new GitContainer((argv) => {
          const a = gitArgs(argv);
          if (a[0] === "rev-parse" && a.includes("--abbrev-ref")) return { stdout: "HEAD\n" };
          if (a[0] === "merge-base") return { exitCode: mergeBase };
          if (isHeadRead(a)) return { stdout: `${OTHER}\n` };
          return {};
        });
      const bad = at(1);
      await runInDO(sandbox("prep-cont-switch-bad"), async (inst) => {
        inst.maybeContainer = () => bad;
        await expect(inst.prepareWorkspace(contSpec())).rejects.toThrow(/branch_moved/);
      });
      expect(bad.calls.map(gitArgs)).toContainEqual(["switch", "-q", "agent/task-r1"]);
      expect(bad.calls.map(gitArgs)).toContainEqual([
        "merge-base",
        "--is-ancestor",
        INITIAL,
        "HEAD",
      ]);
      const errored = at(128);
      await runInDO(sandbox("prep-cont-switch-error"), async (inst) => {
        inst.maybeContainer = () => errored;
        await expect(inst.prepareWorkspace(contSpec())).rejects.toThrow();
      });
      const good = at(0);
      await runInDO(sandbox("prep-cont-switch-ok"), async (inst) => {
        inst.maybeContainer = () => good;
        await inst.prepareWorkspace(contSpec());
      });
    });

    it("このタスクの自動の push が通ったあとの作り直し（再 clone）では、最後に push した SHA と一致すれば通る", async () => {
      const ok = freshAt({ stdout: `${PUSHED}\n` });
      await runInDO(sandbox("prep-cont-pushed"), async (inst) => {
        inst.maybeContainer = () => ok;
        inst.ctx.storage.kv.put("pushed_head", PUSHED);
        await inst.prepareWorkspace(contSpec());
      });
      // 自分の push の後にリモートが別の SHA（initialSha に戻された場合も含む）なら失敗する
      for (const [i, head] of [OTHER, INITIAL].entries()) {
        const c = freshAt({ stdout: `${head}\n` });
        await runInDO(sandbox(`prep-cont-pushed-moved-${i}`), async (inst) => {
          inst.maybeContainer = () => c;
          inst.ctx.storage.kv.put("pushed_head", PUSHED);
          await expect(inst.prepareWorkspace(contSpec())).rejects.toThrow(/branch_moved/);
        });
      }
    });

    it("continuation の無いタスクは今のまま（rev-parse HEAD の一致は見ない）", async () => {
      const c = freshAt({ stdout: `${OTHER}\n` });
      await runInDO(sandbox("prep-cont-legacy"), async (inst) => {
        inst.maybeContainer = () => c;
        await inst.prepareWorkspace(spec());
      });
      expect(c.calls.map(gitArgs).some(isHeadRead)).toBe(false);
    });

    it("continuation の形が不正（branch が根と違う・root の形・initialSha !== baseSha・task_review との併用）なら ensureReady が拒否する", async () => {
      const bads = [
        contSpec({ branch: "agent/task-other" }),
        contSpec({ branch: "agent/task-a/b", continuation: { of: "p1", root: "a/b" } }),
        contSpec({ continuation: { of: "p 1", root: "r1" } }),
        contSpec({ continuation: null }),
        contSpec({ baseSha: BASE }),
        contSpec({ checkout: { pullNumber: 1, sha: INITIAL } }),
      ];
      for (const [i, bad] of bads.entries()) {
        await runInDO(sandbox(`prep-cont-invalid-${i}`), async (inst) => {
          inst.maybeContainer = () => fresh();
          await expect(inst.ensureReady(bad), JSON.stringify(bad)).rejects.toThrow(/continuation/);
          expect(inst.ctx.storage.kv.get("spec")).toBeUndefined();
        });
      }
    });
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
