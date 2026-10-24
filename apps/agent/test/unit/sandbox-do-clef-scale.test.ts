import { describe, expect, it } from "vitest";

// Sandbox の昇格を Clef に一本化したあとの、SandboxDO の判断まわり: 上げるだけで何回でも上げられる（2 → 3 → 4）、Clef の失敗は fail-soft、
// 判断ごとの記録（usage の振り返り用）と集計、state に入れる事実（リポジトリの設定ファイル）と直近のコマンド。
// 昇格の手順そのもの（スナップショット → 停止 → 起動 → 確認）と fail-soft の各経路は sandbox-do-promote.test.ts。
import {
  AGENT,
  BUILD,
  capturingWarn,
  HEAVY,
  IMAGE,
  LIGHT,
  runInDO,
  sandboxStub,
  setup,
  spec,
} from "./support/sandbox-promote-fake";

describe("SandboxDO: 何回でも上げられる（2 → 3 → 4。下げない）", () => {
  it("4 vCPU まで要らないコマンドで standard-3、4 vCPU でも速いコマンドで standard-4 に上がる。スナップショットの名前は毎回違う。作り直しは最終の大きさで起動する", async () => {
    await runInDO(sandboxStub("clef-two-steps"), async (inst) => {
      const fake = setup(inst);
      fake.rejectDuplicateSnapshotNames = true;
      fake.numberedSnapshotIds = true;
      await inst.ensureReady(spec());

      await inst.exec(HEAVY, AGENT); // 重い・4 vCPU までは要らない → standard-3
      expect(fake.currentInstance).toBe("standard-3");
      await inst.exec(BUILD, AGENT); // 重い・4 vCPU でも速い → standard-4
      expect(fake.currentInstance).toBe("standard-4");
      expect(fake.snapshotCalls).toHaveLength(2);
      expect(new Set(fake.snapshotNames).size).toBe(2);
      // 2 回目は 1 回目の後のコンテナ（standard-3）のスナップショットから standard-4 を起動する
      const starts = fake.startCalls as Record<string, unknown>[];
      expect(starts.map((s) => s.instance)).toEqual(["standard-2", "standard-3", "standard-4"]);
      expect(starts[2]?.containerSnapshot).toEqual({ id: "snap-promote-2" });

      const m = await inst.metrics();
      expect(m.instance).toBe("standard-2");
      expect(m.promotedTo).toBe("standard-4");
      expect(m.promotions?.map((p: { to: string; trigger: string }) => [p.to, p.trigger])).toEqual([
        ["standard-3", "clef"],
        ["standard-4", "clef"],
      ]);
      expect(m.promotedAt).toBe(m.promotions?.[0]?.at);
      expect(m.restarts).toBe(0);

      // 落ちて作り直されたら、最終の大きさで起動する
      fake.running = false;
      await expect(inst.exec(LIGHT, AGENT)).rejects.toThrow(/restarted/);
      expect(fake.startCalls.at(-1)).toMatchObject({ image: IMAGE, instance: "standard-4" });
    });
  });

  it("standard-2 から重い・4 vCPU でも速いコマンドで、一度に standard-4 へ上がる（途中の standard-3 を経ない）", async () => {
    await runInDO(sandboxStub("clef-direct-4"), async (inst) => {
      const fake = setup(inst);
      await inst.ensureReady(spec());
      await inst.exec(BUILD, AGENT);
      expect(fake.currentInstance).toBe("standard-4");
      expect(fake.snapshotCalls).toHaveLength(1);
    });
  });

  it("今の大きさが standard-3 のとき、standard-3 で足りるコマンドは上げない（下げもしない）。standard-4 が上限なら以降は Clef を呼ばない", async () => {
    await runInDO(sandboxStub("clef-no-downgrade"), async (inst) => {
      const fake = setup(inst);
      await inst.ensureReady(spec());
      await inst.exec(HEAVY, AGENT); // → standard-3
      const asked = fake.clef.calls.length;
      await inst.exec(HEAVY, AGENT); // 聞く。standard-3 で足りる → 何もしない
      expect(fake.clef.calls.length).toBe(asked + 1);
      expect(fake.snapshotCalls).toHaveLength(1);
      await inst.exec(BUILD, AGENT); // → standard-4（上限）
      const atMax = fake.clef.calls.length;
      await inst.exec(BUILD, AGENT);
      await inst.exec(LIGHT, AGENT);
      expect(fake.clef.calls.length).toBe(atMax); // 上限なので呼ばない
      expect(fake.currentInstance).toBe("standard-4");
    });
  });

  it("上限（SANDBOX_MAX_INSTANCE）が standard-3 なら、standard-4 を選ばず standard-3 まで", async () => {
    await runInDO(sandboxStub("clef-max-3"), async (inst) => {
      const fake = setup(inst, { SANDBOX_MAX_INSTANCE: "standard-3" });
      await inst.ensureReady(spec());
      await inst.exec(BUILD, AGENT);
      expect(fake.currentInstance).toBe("standard-3");
      const asked = fake.clef.calls.length;
      await inst.exec(BUILD, AGENT);
      expect(fake.clef.calls.length).toBe(asked); // 上限に達した
      // state の大きさの一覧にも standard-4 を出さない
      expect(Object.keys(fake.clef.calls[0]?.state.sandbox_sizes as object)).toEqual([
        "standard-2",
        "standard-3",
      ]);
    });
  });

  it("3 → 4 の昇格に失敗したら、同じスナップショットで今の大きさ（standard-3）に起動し直す。standard-2 には戻らない", async () => {
    await runInDO(sandboxStub("clef-fail-3-to-4"), async (inst) => {
      const fake = setup(inst);
      await inst.ensureReady(spec());
      await inst.exec(HEAVY, AGENT);
      fake.failStartFor.add("standard-4");
      const r = await inst.exec(BUILD, AGENT);
      expect(r.exitCode).toBe(0);
      expect(fake.currentInstance).toBe("standard-3");
      const m = await inst.metrics();
      expect(m.promotedTo).toBe("standard-3");
      expect(m.promotionReason).toBe("start_failed");
      expect(m.promotionFailures).toEqual([{ trigger: "clef", reason: "start_failed" }]);
    });
  });

  it("失敗した昇格は、次のコマンドでまた Clef に聞いて試せる（回数の上限は無い）", async () => {
    await runInDO(sandboxStub("clef-retry-promotion"), async (inst) => {
      const fake = setup(inst);
      fake.snapshotResult = new Error("boom");
      await inst.ensureReady(spec());
      await inst.exec(HEAVY, AGENT);
      expect(fake.currentInstance).toBe("standard-2");
      fake.snapshotResult = { id: "snap-promote", size: 1 };
      await inst.exec(HEAVY, AGENT);
      expect(fake.currentInstance).toBe("standard-3");
    });
  });
});

describe("SandboxDO: Clef の失敗は fail-soft（今の大きさのまま実行する）", () => {
  it("例外が続いても（再試行しても）コマンドは動く。失敗は集計に数え、判断の記録に failed を付ける。警告のログは固定のコードだけ", async () => {
    await runInDO(sandboxStub("clef-fail"), async (inst) => {
      const fake = setup(inst);
      fake.clef.answer = () => new Error("secret upstream detail");
      await inst.ensureReady(spec());
      const { value: r, lines } = await capturingWarn(
        async () => (await inst.exec(HEAVY, AGENT)) as { exitCode: number },
      );
      expect(r.exitCode).toBe(0);
      expect(fake.clef.calls).toHaveLength(3); // 最大 3 回
      expect(fake.snapshotCalls).toHaveLength(0);
      expect(lines.join("\n")).toContain("sandbox_scale_decision_failed: ai_run_failed");
      expect(lines.join("\n")).not.toContain("secret upstream detail");
      const m = await inst.metrics();
      expect(m.scaleStats).toMatchObject({ decisions: 1, raised: 0, clefFailures: 1 });
      expect(m.scaleDecisions?.[0]).toMatchObject({ from: "standard-2", to: null, failed: true });
      expect(m.scaleDecisions?.[0]).not.toHaveProperty("heavy");
      // スナップショットなど昇格の失敗の内訳には混ぜない
      expect(m.promotionFailures).toBeUndefined();
      expect(m.promotionReason).toBeUndefined();
    });
  });

  it("1 回目が失敗して 2 回目に成功すれば、その答えを使う", async () => {
    await runInDO(sandboxStub("clef-retry"), async (inst) => {
      const fake = setup(inst);
      let n = 0;
      const base = fake.clef.answer;
      fake.clef.answer = (state, model) => {
        n += 1;
        return n === 1 ? new Error("boom") : base(state, model);
      };
      await inst.ensureReady(spec());
      await inst.exec(HEAVY, AGENT);
      expect(fake.clef.calls).toHaveLength(2);
      expect(fake.currentInstance).toBe("standard-3");
      expect((await inst.metrics()).scaleStats?.clefFailures ?? 0).toBe(0);
    });
  });

  it("flash の答えが曖昧なときだけ clef で聞き直す。記録の model は clef", async () => {
    await runInDO(sandboxStub("clef-ambiguous"), async (inst) => {
      const fake = setup(inst);
      fake.clef.answer = (_state, model) =>
        model.endsWith("clef-flash") ? { heavy: 0.3, fast4: 0.9 } : { heavy: 0.9, fast4: 0.1 };
      await inst.ensureReady(spec());
      await inst.exec(HEAVY, AGENT);
      expect(fake.clef.calls.map((c) => c.model)).toEqual([
        "@cf/cloudflare/clef-flash",
        "@cf/cloudflare/clef",
      ]);
      expect(fake.currentInstance).toBe("standard-3");
      expect((await inst.metrics()).scaleDecisions?.[0]).toMatchObject({
        model: "clef",
        to: "standard-3",
      });
    });
  });

  it("閾値は env（SANDBOX_CLEF_THRESHOLDS）で変えられる。不正な値は既定に戻して警告する", async () => {
    await runInDO(sandboxStub("clef-thresholds"), async (inst) => {
      const fake = setup(inst, { SANDBOX_CLEF_THRESHOLDS: "heavy=0.99" });
      await inst.ensureReady(spec());
      await inst.exec(HEAVY, AGENT);
      expect(fake.snapshotCalls).toHaveLength(0); // 重い確率 0.95 < 0.99
    });
    await runInDO(sandboxStub("clef-thresholds-bad"), async (inst) => {
      const fake = setup(inst, { SANDBOX_CLEF_THRESHOLDS: "heavy=banana" });
      await inst.ensureReady(spec());
      const { lines } = await capturingWarn(() => inst.exec(HEAVY, AGENT));
      expect(fake.currentInstance).toBe("standard-3");
      expect(lines.join("\n")).toContain("SANDBOX_CLEF_THRESHOLDS");
    });
  });
});

describe("SandboxDO: 判断ごとの記録と集計（usage の振り返り用）", () => {
  it("判断ごとに、大きさ・確率・モデル・Clef の所要・コマンドの実行時間と終了コード・argv[0] だけを残す。argv の全体は残さない", async () => {
    await runInDO(sandboxStub("clef-log"), async (inst) => {
      const fake = setup(inst);
      fake.handler = (argv) => (argv[0]?.endsWith("failing") ? { code: 3 } : undefined);
      await inst.ensureReady(spec());
      await inst.exec(["/usr/bin/failing", "--token=SECRET-ARGV-VALUE", "other"], AGENT);
      await inst.exec(HEAVY, AGENT);
      const m = await inst.metrics();
      const [a, b] = m.scaleDecisions ?? [];
      expect(a).toMatchObject({
        from: "standard-2",
        to: null,
        heavy: 0.02,
        fast4: 0.02,
        choice: [0.2, 0.5, 0.3],
        model: "flash",
        cmd: "failing",
        exitCode: 3,
      });
      expect(typeof a.at).toBe("number");
      expect(typeof a.clefMs).toBe("number");
      expect(typeof a.cmdMs).toBe("number");
      expect(b).toMatchObject({
        from: "standard-2",
        to: "standard-3",
        heavy: 0.95,
        fast4: 0.1,
        cmd: "pnpm",
        exitCode: 0,
      });
      expect(JSON.stringify(m)).not.toContain("SECRET-ARGV-VALUE");
      expect(m.scaleStats).toEqual({
        decisions: 2,
        raised: 1,
        clefFailures: 0,
        slowNotRaised: 0,
        skippedLight: 0,
      });
    });
  });

  it("cmd は argv[0] の basename を短く切ったもの", async () => {
    await runInDO(sandboxStub("clef-cmd"), async (inst) => {
      setup(inst);
      await inst.ensureReady(spec());
      await inst.exec([`/opt/${"x".repeat(80)}/tool-${"y".repeat(80)}`], AGENT);
      const m = await inst.metrics();
      expect(String(m.scaleDecisions?.[0]?.cmd).length).toBeLessThanOrEqual(24);
      expect(m.scaleDecisions?.[0]?.cmd).toMatch(/^tool-y/);
    });
  });

  it("bash -c の形（ワーカーの bash ツール・検証コマンド）は、コマンド文字列の先頭の語を cmd に残す（文字列の全体は残さない）", async () => {
    await runInDO(sandboxStub("clef-cmd-bash"), async (inst) => {
      setup(inst);
      await inst.ensureReady(spec());
      await inst.exec(
        ["bash", "-c", "cd app && FOO=secret-env timeout 600 pnpm test --reporter x"],
        AGENT,
      );
      await inst.exec(["/bin/sh", "-lc", "vitest run"], AGENT);
      const m = await inst.metrics();
      const [a, b] = m.scaleDecisions ?? [];
      expect([a?.cmd, b?.cmd]).toEqual(["pnpm", "vitest"]);
      expect(JSON.stringify(m)).not.toContain("secret-env");
      expect(JSON.stringify(m)).not.toContain("--reporter");
    });
  });

  it("上げなかったのに長くかかったコマンドを数える（上げたコマンドや、短いコマンドは数えない）", async () => {
    await runInDO(sandboxStub("clef-slow"), async (inst) => {
      const fake = setup(inst);
      inst.slowCommandMs = 30;
      const slow = async (argv: string[]) => {
        if (argv[0] === "sleepy" || argv[0] === "pnpm") await new Promise((r) => setTimeout(r, 60));
      };
      fake.onExec = slow;
      await inst.ensureReady(spec());
      await inst.exec(["sleepy"], AGENT); // 軽いと判断・長い → 数える
      await inst.exec(LIGHT, AGENT); // 軽い・短い
      await inst.exec(HEAVY, AGENT); // 上げた（長くても数えない）
      const m = await inst.metrics();
      expect(m.scaleStats).toMatchObject({ decisions: 3, raised: 1, slowNotRaised: 1 });
    });
  });

  it("明らかに軽いコマンドは Clef を呼ばず、skippedLight を数える（判断の記録は増やさない）。重いコマンド・迷う形は今までどおり呼ぶ", async () => {
    await runInDO(sandboxStub("clef-skip-light"), async (inst) => {
      const fake = setup(inst);
      await inst.ensureReady(spec());
      await inst.exec(["bash", "-c", "git status && ls"], AGENT);
      await inst.exec(["bash", "-c", "cat a | head -3"], { origin: "verification" });
      expect(fake.clef.calls.length).toBe(0);
      let m = await inst.metrics();
      expect(m.scaleStats).toEqual({
        decisions: 0,
        raised: 0,
        clefFailures: 0,
        slowNotRaised: 0,
        skippedLight: 2,
      });
      expect(m.scaleDecisions).toBeUndefined();
      await inst.exec(["bash", "-c", "ls && pnpm build"], AGENT); // 迷う形 → 聞く
      expect(fake.clef.calls.length).toBe(1);
      m = await inst.metrics();
      expect(m.scaleStats).toMatchObject({ decisions: 1, skippedLight: 2 });
    });
  });

  it("記録は直近 50 件まで（古い方から捨てる）。集計は捨てずに数え続ける。記録の大きさは小さいまま", async () => {
    await runInDO(sandboxStub("clef-cap"), async (inst) => {
      setup(inst);
      await inst.ensureReady(spec());
      for (let i = 0; i < 55; i++) await inst.exec(["node", String(i)], AGENT);
      const m = await inst.metrics();
      expect(m.scaleDecisions).toHaveLength(50);
      expect(m.scaleStats?.decisions).toBe(55);
      expect(JSON.stringify(m.scaleDecisions).length).toBeLessThan(12_000);
    });
  });

  it("Clef を呼ばなかったタスク（固定・無効・内部の exec だけ）には記録も集計も付かない", async () => {
    await runInDO(sandboxStub("clef-no-record"), async (inst) => {
      setup(inst);
      await inst.ensureReady(spec());
      await inst.exec(HEAVY);
      const m = await inst.metrics();
      expect(m.scaleDecisions).toBeUndefined();
      expect(m.scaleStats).toBeUndefined();
    });
  });
});

describe("SandboxDO: Clef に渡す state（リポジトリの事実と直近のコマンド）", () => {
  const FACTS = "# .: files present: pnpm-lock.yaml\n## vitest.config.ts\nmaxWorkers: 2\n";
  const factsCalls = (fake: { execLog: string[][] }) =>
    fake.execLog.filter((a) => a[0] === "node" && a[1] === "-e");

  it("コマンドの cwd のリポジトリの事実（設定ファイルの生のテキスト）を、コンテナ内のスクリプトで集めて state に入れる", async () => {
    await runInDO(sandboxStub("clef-facts"), async (inst) => {
      const fake = setup(inst);
      fake.handler = (argv) => (argv[0] === "node" ? { out: FACTS } : undefined);
      await inst.ensureReady(spec());
      await inst.exec(HEAVY, { ...AGENT, cwd: "/workspace/packages/a" });
      expect(fake.clef.calls[0]?.state.repository_facts).toBe(FACTS);
      const call = factsCalls(fake)[0] as string[];
      expect(call[3]).toBe("/workspace/packages/a");
    });
  });

  it("同じ cwd の事実はタスクの中で覚えて集め直さない。cwd が違えば集める。古くなったら作り直す", async () => {
    await runInDO(sandboxStub("clef-facts-cache"), async (inst) => {
      const fake = setup(inst);
      fake.handler = (argv) => (argv[0] === "node" ? { out: FACTS } : undefined);
      await inst.ensureReady(spec());
      await inst.exec(LIGHT, AGENT);
      await inst.exec(LIGHT, AGENT);
      expect(factsCalls(fake)).toHaveLength(1);
      await inst.exec(LIGHT, { ...AGENT, cwd: "/workspace/other" });
      expect(factsCalls(fake)).toHaveLength(2);
      // 期限（10 分）を過ぎたら作り直す
      const kv = inst.ctx.storage.kv;
      const entries = kv.get("scale_facts") as { cwd: string; at: number; text: string }[];
      kv.put(
        "scale_facts",
        entries.map((e) => ({ ...e, at: e.at - 11 * 60_000 })),
      );
      await inst.exec(LIGHT, AGENT);
      expect(factsCalls(fake)).toHaveLength(3);
    });
  });

  it("事実を集められなかったら空のまま Clef に聞く（コマンドは止めない）。覚えないので次回また試す", async () => {
    await runInDO(sandboxStub("clef-facts-fail"), async (inst) => {
      const fake = setup(inst);
      fake.handler = (argv) => (argv[0] === "node" ? { code: 1 } : undefined);
      await inst.ensureReady(spec());
      const r = await inst.exec(HEAVY, AGENT);
      expect(r.exitCode).toBe(0);
      expect(fake.clef.calls[0]?.state.repository_facts).toBe("");
      expect(fake.currentInstance).toBe("standard-3");
      await inst.exec(LIGHT, AGENT);
      expect(factsCalls(fake)).toHaveLength(2);
    });
  });

  it("直近 3 件のコマンド（コマンド・所要秒・終了コード）を state に入れる。古いものは入れない", async () => {
    await runInDO(sandboxStub("clef-recent"), async (inst) => {
      const fake = setup(inst);
      fake.handler = (argv) => (argv[0] === "failing" ? { code: 1 } : undefined);
      await inst.ensureReady(spec());
      await inst.exec(["node", "one"], AGENT);
      await inst.exec(["node", "two"], AGENT);
      await inst.exec(["failing"], AGENT);
      await inst.exec(["node", "four"], AGENT);
      await inst.exec(["node", "five"], AGENT);
      const recent = fake.clef.calls[4]?.state.recent_commands as {
        command: string;
        seconds: number;
        exit_code: number;
      }[];
      expect(recent.map((r) => r.command)).toEqual(["node two", "failing", "node four"]);
      expect(recent.map((r) => r.exit_code)).toEqual([0, 1, 0]);
      expect(recent.every((r) => typeof r.seconds === "number")).toBe(true);
      expect(fake.clef.calls[0]?.state.recent_commands).toEqual([]);
    });
  });
});
