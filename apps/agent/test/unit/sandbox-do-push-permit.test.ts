import { describe, expect, it } from "vitest";
import { SHA as INITIAL, runInDO, sandboxStub, setup, spec } from "./support/sandbox-promote-fake";

// 自動の push の許可証（ExecOptions.pushPermit）: exec の間だけ SandboxDO に預かられ、終わったら（失敗・時間切れでも）必ず消える。
// OutboundGateway は readPushPermit で読む。ワーカーの bash（pushPermit 無し）の exec の間は、許可証は無い。

const SHA = "d".repeat(40);
const REF = "refs/heads/agent/task-x";
const PUSH = ["git", "push", "https://github.com/acme/hello.git", `${SHA}:${REF}`];

describe("SandboxDO: push の許可証", () => {
  it("pushPermit 付きの exec の間だけ読め、終わったら消える", async () => {
    await runInDO(sandboxStub("permit-lifecycle"), async (inst) => {
      const fake = setup(inst);
      await inst.ensureReady(spec());
      expect(await inst.readPushPermit()).toBeUndefined();
      const during: unknown[] = [];
      fake.onExec = async (argv) => {
        if (argv.includes("push")) during.push(await inst.readPushPermit());
      };
      await inst.exec(PUSH, { pushPermit: { ref: REF, newSha: SHA } });
      expect(during).toEqual([{ ref: REF, newSha: SHA }]);
      expect(await inst.readPushPermit()).toBeUndefined();
      expect(inst.ctx.storage.kv.get("push_permit")).toBeUndefined();
    });
  });

  it("exec が失敗（例外）しても消える", async () => {
    await runInDO(sandboxStub("permit-throw"), async (inst) => {
      const fake = setup(inst);
      await inst.ensureReady(spec());
      fake.onExec = async (argv) => {
        if (argv.includes("push")) throw new Error("boom");
      };
      await expect(inst.exec(PUSH, { pushPermit: { ref: REF, newSha: SHA } })).rejects.toThrow();
      expect(await inst.readPushPermit()).toBeUndefined();
      expect(inst.ctx.storage.kv.get("push_permit")).toBeUndefined();
    });
  });

  it("pushPermit の無い exec（ワーカーの bash・検証コマンド）の間は、許可証が無い", async () => {
    await runInDO(sandboxStub("permit-none"), async (inst) => {
      const fake = setup(inst);
      await inst.ensureReady(spec());
      const during: unknown[] = [];
      fake.onExec = async (argv) => {
        if (argv.some((a) => a.includes("push"))) during.push(await inst.readPushPermit());
      };
      await inst.exec(["bash", "-lc", "git push origin HEAD"], { origin: "agent_command" });
      await inst.exec(["git", "push"], { origin: "verification" });
      // Clef の判断の exec など、push を含む exec が増えても、どれも許可証は無い
      expect(during.length).toBeGreaterThanOrEqual(2);
      expect(during.every((p) => p === undefined)).toBe(true);
    });
  });

  it("期限切れは undefined（exec の時間切れ + 猶予を過ぎたら無効）", async () => {
    await runInDO(sandboxStub("permit-expired"), async (inst) => {
      setup(inst);
      await inst.ensureReady(spec());
      inst.ctx.storage.kv.put("push_permit", { ref: REF, newSha: SHA, expiresAt: Date.now() - 1 });
      expect(await inst.readPushPermit()).toBeUndefined();
      inst.ctx.storage.kv.put("push_permit", {
        ref: REF,
        newSha: SHA,
        expiresAt: Date.now() + 60_000,
      });
      expect(await inst.readPushPermit()).toEqual({ ref: REF, newSha: SHA });
    });
  });

  it("terminate すると許可証も消え、読めない", async () => {
    await runInDO(sandboxStub("permit-terminate"), async (inst) => {
      setup(inst);
      await inst.ensureReady(spec());
      inst.ctx.storage.kv.put("push_permit", {
        ref: REF,
        newSha: SHA,
        expiresAt: Date.now() + 60_000,
      });
      await inst.terminate();
      expect(inst.ctx.storage.kv.get("push_permit")).toBeUndefined();
      expect(await inst.readPushPermit()).toBeUndefined();
    });
  });

  it("形が不正な許可証（ref・newSha）の exec は実行しない", async () => {
    await runInDO(sandboxStub("permit-invalid"), async (inst) => {
      const fake = setup(inst);
      await inst.ensureReady(spec());
      const before = fake.execLog.length;
      for (const bad of [
        { ref: "agent/task-x", newSha: SHA },
        { ref: REF, newSha: "HEAD" },
        { ref: REF, newSha: "" },
      ]) {
        await expect(inst.exec(PUSH, { pushPermit: bad })).rejects.toThrow(/permit/);
      }
      expect(fake.execLog.length).toBe(before);
    });
  });

  it("自動の push（許可証付き）が通ったら、その SHA を最後に push した先頭として残す。失敗したら残さない", async () => {
    await runInDO(sandboxStub("permit-pushed-head"), async (inst) => {
      const fake = setup(inst);
      await inst.ensureReady(spec());
      fake.handler = (argv) => (argv.includes("push") ? { code: 1 } : undefined);
      await inst.exec(PUSH, { pushPermit: { ref: REF, newSha: SHA } });
      expect(inst.ctx.storage.kv.get("pushed_head")).toBeUndefined();
      fake.handler = () => undefined;
      await inst.exec(PUSH, { pushPermit: { ref: REF, newSha: SHA } });
      expect(inst.ctx.storage.kv.get("pushed_head")).toBe(SHA);
      // 許可証の無い exec（ワーカーの bash）は、成功しても記録しない
      const other = "e".repeat(40);
      await inst.exec(["git", "push", "origin", `${other}:${REF}`], { origin: "agent_command" });
      expect(inst.ctx.storage.kv.get("pushed_head")).toBe(SHA);
    });
  });
});

describe("SandboxDO: OutboundGateway の props", () => {
  it("積み足し（continuation）では branchTaskId に根の id を入れる。taskId（トークンと許可証の読み出し）は自分の名前のまま", async () => {
    await runInDO(sandboxStub("props-cont"), async (inst) => {
      const fake = setup(inst);
      // clone の後の HEAD は initialSha（積み足しの門番 3 を通る）
      fake.handler = (argv) =>
        argv.includes("rev-parse") && !argv.includes("--verify") && argv.at(-1) === "HEAD"
          ? { out: `${INITIAL}\n` }
          : undefined;
      const seen: unknown[] = [];
      const orig = inst.outboundProps.bind(inst);
      inst.outboundProps = (s: unknown) => {
        const p = orig(s);
        seen.push(p);
        return p;
      };
      await inst.ensureReady(
        spec({ branch: "agent/task-r1", continuation: { of: "p1", root: "r1" } }),
      );
      expect(seen.length).toBeGreaterThan(0);
      for (const p of seen) {
        expect(p).toEqual({
          repo: { owner: "acme", name: "hello" },
          task: "agent/task-r1",
          taskId: "props-cont",
          branchTaskId: "r1",
        });
      }
    });
  });

  it("continuation の無いタスクは branchTaskId を持たない（今のまま）", async () => {
    await runInDO(sandboxStub("props-legacy"), async (inst) => {
      setup(inst);
      const seen: unknown[] = [];
      const orig = inst.outboundProps.bind(inst);
      inst.outboundProps = (s: unknown) => {
        const p = orig(s);
        seen.push(p);
        return p;
      };
      await inst.ensureReady(spec());
      expect(seen.length).toBeGreaterThan(0);
      for (const p of seen) {
        expect(p).toEqual({
          repo: { owner: "acme", name: "hello" },
          task: "agent/task-x",
          taskId: "props-legacy",
        });
      }
    });
  });
});
