import { env, runInDurableObject } from "cloudflare:test";

// sandbox-do-promote.test.ts と sandbox-do-clef-scale.test.ts が共有する、コンテナと Clef の fake と補助。
// vitest 上では ctx.container が無いので maybeContainer を fake に差し替える（snapshotContainer と containerSnapshot での起動に対応）。

export const SHA = "a".repeat(40);
export const CA_CERT = "/etc/cloudflare/certs/cloudflare-containers-ca.crt";
export const IMAGE = `registry.cloudflare.com/acct/rovo-agent-sandboxdo-workspace@sha256:${"b".repeat(64)}`;
export const HEAVY = ["pnpm", "test"];
export const BUILD = ["pnpm", "build"];
// Clef が軽いと判断するが、isLightCommand の表には無い（Clef を呼ぶ）コマンド
export const LIGHT = ["node", "--version"];
/** 子（bash ツール）が実行したコマンド。Clef の判断の対象になる（Sandbox 自身の内部の exec には付けない） */
export const AGENT = { origin: "agent_command" } as const;

// biome-ignore lint/suspicious/noExplicitAny: private メンバーを差し替えるテスト
export type Inst = any;
export const runInDO = runInDurableObject as unknown as (
  stub: unknown,
  fn: (inst: Inst) => Promise<void>,
) => Promise<void>;
export const sandboxStub = (name: string) =>
  (env.SANDBOX_DO as DurableObjectNamespace).getByName(name);

export const spec = (extra: Record<string, unknown> = {}) => ({
  repository: "acme/hello",
  baseSha: SHA,
  initialSha: SHA,
  branch: "agent/task-x",
  deadlineAt: Date.now() + 3_600_000,
  ...extra,
});

type Reply = { code?: number; out?: string } | undefined;

/** コンテナの fake。操作の順序を events に残す（start / snapshot / destroy / exec） */
export class FakeContainer {
  running = false;
  images = { workspace: IMAGE };
  startCalls: Record<string, unknown>[] = [];
  snapshotCalls: unknown[] = [];
  destroyCalls = 0;
  intercepts = 0;
  inactivityMs: number[] = [];
  execLog: string[][] = [];
  events: string[] = [];
  /** 今動いているコンテナの大きさ */
  currentInstance = "";
  /** この大きさの containerSnapshot 起動は同期的に投げる */
  failStartFor = new Set<string>();
  /** この大きさのコンテナでは CA 証明書が読めない */
  noCertFor = new Set<string>();
  /** この大きさのコンテナでは、作業ツリーの状態が元と違う */
  mismatchFor = new Set<string>();
  /** 作業ツリーの状態の読み取りを失敗させる */
  stateUnreadable = false;
  /** true にすると、同じ名前のスナップショットの 2 回目は失敗する（名前の重複の扱いが未確認なので、2 回目の昇格が名前で落ちないことを確かめる） */
  rejectDuplicateSnapshotNames = false;
  numberedSnapshotIds = false;
  /** 取ったスナップショットの名前 */
  snapshotNames = new Set<string>();
  /** snapshotContainer の結果 */
  snapshotResult: { id: string; size: number } | Error | "hang" = { id: "snap-promote", size: 1 };
  /** undefined にすると、snapshotContainer が無いランタイムを模せる */
  snapshotContainer: ((options?: { name?: string }) => Promise<unknown>) | undefined = (o) =>
    this.snap(o);
  /** 追加の応答 */
  handler: (argv: string[]) => Reply = () => undefined;
  /** snapshotContainer の途中で呼ばれる */
  onSnapshot: (() => Promise<void>) | undefined;
  /** destroy の途中で呼ばれる（止まる前） */
  onDestroy: (() => Promise<void>) | undefined;
  /** exec の応答の前に呼ばれる */
  onExec: ((argv: string[]) => Promise<void>) | undefined;
  /** 大きさの判断をする Clef の fake（setup が env.AI に差し込む） */
  clef = new FakeClef();

  start(options: Record<string, unknown>) {
    this.startCalls.push(options);
    const instance = String(options.instance);
    this.events.push(
      `start:${options.containerSnapshot ? "snapshot" : "image"}:${instance}${
        options.containerSnapshot ? `:${(options.containerSnapshot as { id: string }).id}` : ""
      }`,
    );
    if (options.containerSnapshot && options.image) throw new TypeError("both image and snapshot");
    if (options.containerSnapshot && this.failStartFor.has(instance)) {
      throw new Error("start boom");
    }
    this.running = true;
    this.currentInstance = instance;
  }
  async destroy() {
    this.destroyCalls += 1;
    this.events.push("destroy");
    await this.onDestroy?.();
    this.running = false;
  }
  /** 設定すると setInactivityTimeout がこの例外で失敗する */
  inactivityError: Error | undefined;
  async setInactivityTimeout(ms: number) {
    this.inactivityMs.push(ms);
    this.events.push(`inactivity:${ms}`);
    if (this.inactivityError) throw this.inactivityError;
  }
  /** monitor() の promise の settle 用（start のたびに 1 つ増える。テストが resolve / reject する） */
  monitors: { resolve: () => void; reject: (e: unknown) => void }[] = [];
  monitor(): Promise<void> {
    this.events.push("monitor");
    return new Promise<void>((resolve, reject) => {
      this.monitors.push({ resolve, reject });
    });
  }
  async interceptOutboundHttps() {
    this.intercepts += 1;
  }
  async interceptAllOutboundHttp() {}
  async exec(argv: string[]) {
    this.execLog.push(argv);
    this.events.push(`exec:${argv.join(" ")}`);
    await this.onExec?.(argv);
    const stream = (t: string) =>
      new ReadableStream<Uint8Array>({
        start(c) {
          if (t) c.enqueue(new TextEncoder().encode(t));
          c.close();
        },
      });
    let reply: Reply = this.handler(argv);
    if (reply === undefined) {
      if (argv[0] === "test" && argv[2] === CA_CERT) {
        reply = { code: this.noCertFor.has(this.currentInstance) ? 1 : 0 };
      } else if (argv[0] === "bash" && argv[3] === "rovo-baseline") reply = { out: "1:1\n" };
      else if (argv[0] === "bash" && argv[3] === "rovo-reaper") reply = { out: "clean\n" };
      else if (argv[0] === "bash" && argv[3] === "rovo-promote-state") {
        if (this.stateUnreadable) reply = { code: 1 };
        else {
          const dirty = this.mismatchFor.has(this.currentInstance) ? "?? other.txt" : " M a.ts";
          reply = { out: `${"c".repeat(40)}\n${dirty}\nhash-of-diff  -\n` };
        }
      } else if (argv[0] === "git" && argv.includes("rev-parse") && argv.includes("--verify")) {
        reply = { code: 1 }; // 最初の起動: 作業ツリーが無い → clone へ
      } else reply = {};
    }
    return {
      stdout: stream(reply.out ?? ""),
      stderr: stream(""),
      exitCode: Promise.resolve(reply.code ?? 0),
    };
  }
  private async snap(options?: { name?: string }) {
    if (options === undefined) throw new TypeError("options is required");
    this.snapshotCalls.push(options);
    this.events.push("snapshot");
    if (!this.running) throw new Error("container is not running");
    if (this.rejectDuplicateSnapshotNames && options.name && this.snapshotNames.has(options.name)) {
      throw new Error("snapshot name already exists");
    }
    if (options.name) this.snapshotNames.add(options.name);
    await this.onSnapshot?.();
    if (this.snapshotResult === "hang") return new Promise<never>(() => {});
    if (this.snapshotResult instanceof Error) throw this.snapshotResult;
    // numberedSnapshotIds のときは、スナップショットごとに別の id（昇格のたびに別のスナップショットから起動することを確かめられる）
    const id = this.numberedSnapshotIds
      ? `${this.snapshotResult.id}-${this.snapshotCalls.length}`
      : this.snapshotResult.id;
    return { ...this.snapshotResult, id, ...(options.name ? { name: options.name } : {}) };
  }
  /** 元のコマンド（重い・軽い）を実行した位置。ユーザーのコマンドは cwd を持つ（内部の exec と見分ける） */
  indexOfEvent(prefix: string): number {
    return this.events.findIndex((e) => e.startsWith(prefix));
  }
}

/** Clef の応答（answers.<id> が score / choice / noul）。重い確率 = P(2)+P(3) になるように作る */
export function clefResponse(p: { heavy: number; fast4: number }, inputTokens = 900) {
  return {
    answers: {
      weight: {
        type: "score",
        score: p.heavy >= 0.5 ? 2 : 0,
        probabilities: {
          "0": (1 - p.heavy) / 2,
          "1": (1 - p.heavy) / 2,
          "2": p.heavy / 2,
          "3": p.heavy / 2,
        },
        confidence: 0.9,
      },
      size: {
        type: "choice",
        choice: "standard-3",
        probabilities: { "standard-2": 0.2, "standard-3": 0.5, "standard-4": 0.3 },
        confidence: 0.8,
      },
      beyond2: { type: "noul", noul: p.fast4 },
    },
    usage: { input_tokens: inputTokens },
  };
}

export type ClefCall = {
  model: string;
  state: Record<string, unknown>;
  options: unknown;
};

/**
 * Clef の fake（env.AI の代わり）。state の command の文字列で台本を決める。これはテストの台本で、本番に規則は無い。
 * 既定: "build" を含むと重く 4 vCPU でも速い / "test" を含むと重く 4 vCPU までは要らない / それ以外は軽い。
 */
export class FakeClef {
  calls: ClefCall[] = [];
  /** 応答の台本。Error を返すと AI.run が例外を投げ、"hang" は返らない */
  answer: (
    state: Record<string, unknown>,
    model: string,
  ) => { heavy: number; fast4: number } | Error | "hang" = (state) => {
    const command = String(state.command ?? "");
    if (command.includes("build")) return { heavy: 0.95, fast4: 0.9 };
    if (command.includes("test")) return { heavy: 0.95, fast4: 0.1 };
    return { heavy: 0.02, fast4: 0.02 };
  };
  async run(model: string, input: { state: string }, options: unknown) {
    const state = JSON.parse(input.state) as Record<string, unknown>;
    this.calls.push({ model, state, options });
    const a = this.answer(state, model);
    if (a === "hang") return new Promise(() => {});
    if (a instanceof Error) throw a;
    return clefResponse(a);
  }
}

export function setup(inst: Inst, vars: Record<string, unknown> = {}) {
  const fake = new FakeContainer();
  inst.maybeContainer = () => fake;
  inst.depsCacheEnabled = () => false;
  inst.env = {
    ...inst.env,
    SANDBOX_MAX_INSTANCE: "standard-4",
    AI_GATEWAY_ID: "gw",
    AI: fake.clef,
    ...vars,
  };
  return fake;
}

/** console.warn の行を集める（理由コードのログ） */
export async function capturingWarn<T>(
  fn: () => Promise<T>,
): Promise<{ value: T; lines: string[] }> {
  const lines: string[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => {
    lines.push(a.map(String).join(" "));
  };
  try {
    return { value: await fn(), lines };
  } finally {
    console.warn = orig;
  }
}
