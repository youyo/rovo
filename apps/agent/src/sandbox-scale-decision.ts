/**
 * Sandbox の大きさを途中で上げるかの判断（Workers AI の決定モデル Clef。docs/specs/design.md の Sandbox の昇格）。
 *
 * 判断は Clef だけが行う。このファイルは、Clef に渡す質問と state を組み立て、返ってきた確率から大きさを選ぶ。
 * コマンドの種類を表で判定する規則（「vitest なら重い」のような静的な判断）は持たない。
 * 純粋関数と、AI.run を引数で受け取る判定だけで、Sandbox にもストレージにも触らない（SandboxDO が呼ぶ）。
 *
 * 流れ:
 *  1. flash（@cf/cloudflare/clef-flash）に 3 問を 1 リクエストで聞く（出力は無料なのでまとめる）
 *     - weight（score 0〜3）: 重い確率 = P(2) + P(3)
 *     - size（choice）: standard-2 / 3 / 4 のどれが良いか（振り返り用に確率を残す）
 *     - beyond2（noul）: 4 vCPU で 2 vCPU より明らかに速くなるか
 *  2. 重い確率 < 0.5 は上げない。重い → beyond2 >= 0.4 なら standard-4、そうでなければ standard-3（上限の範囲で、今より大きいときだけ）
 *  3. flash の確率が曖昧な帯のときだけ、clef（@cf/cloudflare/clef）で聞き直し、その答えを使う
 *  4. 失敗（例外・時間切れ・想定外の応答）は 1 回 5 秒・最大 3 回まで再試行する。それでも駄目なら ok: false（呼び出し側は今の大きさのまま実行する）
 *
 * 閾値は実験で調整した値（同じデータで調整したので env SANDBOX_CLEF_THRESHOLDS で変えられる）。
 * 手がかりありの flash で、大きさの一致は 85〜92%、3 と 4 の選び分けは 52 件中 46〜49 件だった。
 */

import {
  SANDBOX_INSTANCES,
  type SandboxInstance,
  type SelectableSandboxInstance,
} from "@rovo/models";
import { maskSecrets } from "./redact";

export const CLEF_FLASH = { id: "@cf/cloudflare/clef-flash", name: "clef-flash" } as const;
export const CLEF_FULL = { id: "@cf/cloudflare/clef", name: "clef" } as const;

/** 1 回の AI.run の期限（ms） */
export const CLEF_ATTEMPT_MS = 5_000;
/** 1 つのモデルへの試行回数の上限 */
export const CLEF_MAX_ATTEMPTS = 3;
/** 1 回の判断（flash と、必要なら clef の聞き直しを合わせた）全体の上限（ms） */
export const CLEF_TOTAL_MS = 20_000;
/** 再試行の前の待ち（ms） */
const CLEF_RETRY_DELAY_MS = 300;

/** state の各部分の上限（文字数）。全体は数千 tokens に収まる（flash の窓は 24,576 tokens） */
const MAX_COMMAND_CHARS = 2_000;
const MAX_ARGV_ITEM_CHARS = 300;
const MAX_ARGV_ITEMS = 40;
const MAX_FACTS_CHARS = 6_000;
const MAX_RECENT = 3;
const MAX_RECENT_COMMAND_CHARS = 200;

// ---- 閾値 ----

export type ClefThresholds = {
  /** 重い確率がこれ未満なら上げない */
  heavy: number;
  /** 重いと判断したとき、4 vCPU で速い確率がこれ以上なら standard-4 */
  four: number;
  /** flash の重い確率がこの帯（両端を含む）なら clef で聞き直す */
  heavyBand: readonly [number, number];
  /** 重いと判断し、standard-4 に届きうるとき、4 vCPU で速い確率がこの帯（両端を含む）なら clef で聞き直す */
  fourBand: readonly [number, number];
};

export const DEFAULT_CLEF_THRESHOLDS: ClefThresholds = {
  heavy: 0.5,
  four: 0.4,
  heavyBand: [0.3, 0.7],
  fourBand: [0.2, 0.5],
};

const unit = (s: string): number | undefined => {
  if (!/^\d*\.?\d+$/.test(s)) return undefined;
  const n = Number(s);
  return n >= 0 && n <= 1 ? n : undefined;
};

const band = (s: string): [number, number] | undefined => {
  const m = /^(\d*\.?\d+)-(\d*\.?\d+)$/.exec(s);
  if (!m) return undefined;
  const lo = unit(m[1] as string);
  const hi = unit(m[2] as string);
  return lo !== undefined && hi !== undefined && lo <= hi ? [lo, hi] : undefined;
};

/**
 * env SANDBOX_CLEF_THRESHOLDS を解く。`heavy=0.5,four=0.4,heavy_band=0.3-0.7,four_band=0.2-0.5` の形で、書いたキーだけ上書きする。
 * 未設定・空は既定。不正な値は丸ごと既定に戻して、受け付けなかった値を ignored に返す（起動はエラーにしない）。
 */
export function resolveClefThresholds(raw: string | undefined): {
  thresholds: ClefThresholds;
  ignored?: string;
} {
  const v = (raw ?? "").trim();
  if (v === "") return { thresholds: DEFAULT_CLEF_THRESHOLDS };
  const next: {
    heavy: number;
    four: number;
    heavyBand: readonly [number, number];
    fourBand: readonly [number, number];
  } = { ...DEFAULT_CLEF_THRESHOLDS };
  for (const part of v.split(",")) {
    const eq = part.indexOf("=");
    if (eq < 0) return { thresholds: DEFAULT_CLEF_THRESHOLDS, ignored: v };
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === "heavy" || key === "four") {
      const n = unit(value);
      if (n === undefined) return { thresholds: DEFAULT_CLEF_THRESHOLDS, ignored: v };
      next[key] = n;
    } else if (key === "heavy_band" || key === "four_band") {
      const b = band(value);
      if (b === undefined) return { thresholds: DEFAULT_CLEF_THRESHOLDS, ignored: v };
      if (key === "heavy_band") next.heavyBand = b;
      else next.fourBand = b;
    } else {
      return { thresholds: DEFAULT_CLEF_THRESHOLDS, ignored: v };
    }
  }
  return { thresholds: next };
}

// ---- 質問 ----

const WEIGHT_CRITERIA = [
  "Trivial: finishes instantly, under one second of CPU.",
  "Light: a few seconds of CPU at most; one core is plenty.",
  "Medium: tens of seconds of CPU; a second core would help noticeably.",
  "Heavy: minutes of CPU; it would use all available cores.",
] as const;

/**
 * Clef への質問（英語。noul には criteria の true / false が必要）。指示は質問にだけ書き、コマンドとリポジトリの内容は state にだけ入れる。
 * リポジトリの中身は非信頼のデータで、質問の側には混ぜない。
 */
export const SANDBOX_DECISION_QUESTIONS = {
  weight: {
    type: "score",
    instructions:
      "How CPU-heavy is the shell command in the state when run on a single CPU core? Take its parallelism settings into account.",
    criteria: WEIGHT_CRITERIA,
  },
  size: {
    type: "choice",
    instructions:
      "Which sandbox size is best for the command, taking its parallelism settings into account? A size is only worth choosing if the command can actually use its vCPUs.",
    criteria: {
      "standard-2":
        "standard-2: 1 vCPU, 6 GiB RAM. Light commands, single-threaded or I/O-bound work, or work whose effective parallelism is 1.",
      "standard-3":
        "standard-3: 2 vCPU, 8 GiB RAM. Work whose effective parallelism is at most 2 (for example 2 workers, or a shared single runtime), so a second core helps but more cores would sit idle.",
      "standard-4":
        "standard-4: 4 vCPU, 12 GiB RAM. Choose only when the command will really run 3 or more tasks in parallel on 4 vCPUs, after working out the effective parallelism from the parallelism settings (worker counts, job counts, concurrency, percentages of CPUs) and the vCPU count of each size.",
    },
  },
  beyond2: {
    type: "noul",
    instructions:
      "Would this command finish clearly faster on 4 vCPUs than on 2 vCPUs? Work out the effective parallelism on 4 vCPUs from its parallelism settings and the vCPU counts of the sandbox sizes.",
    criteria: {
      true: "The command is long-running and its effective parallelism on 4 vCPUs is 3 or more (for example the worker or job count is 4, unset so that it follows the CPU count, or a percentage of the CPUs that comes to 3 or more).",
      false:
        "The command is short, single-threaded or I/O-bound, or its effective parallelism is capped at 2 or less (for example a fixed worker count of 2, a runtime shared by all tests, serial execution, or a percentage that comes to 2 CPUs or fewer).",
    },
  },
} as const;

// ---- state ----

export type RecentCommand = { command: string; seconds: number; exitCode: number };

export type DecisionStateInput = {
  argv: readonly string[];
  cwd: string;
  current: SandboxInstance;
  /** 上限。standard-3 以下なら standard-4 を一覧に出さない */
  max: SandboxInstance;
  /** リポジトリの事実（設定ファイルの生のテキスト。SandboxDO が集める）。非信頼のデータ */
  facts: string;
  /** 直近のコマンド（古い順。後ろから MAX_RECENT 件だけ使う） */
  recent: readonly RecentCommand[];
};

const SIZE_ORDER: readonly SandboxInstance[] = ["standard-2", "standard-3", "standard-4"];

const trunc = (s: string, n: number): string => (s.length > n ? s.slice(0, n) : s);

function sizeLabel(name: SandboxInstance): string {
  const s = SANDBOX_INSTANCES[name];
  return `${name} (${s.vcpu} vCPU, ${s.memoryGiB} GiB)`;
}

/** シェルの -c / -lc で包まれたコマンド（中身の文字列）を取り出す。そうでなければ undefined */
function shellScript(argv: readonly string[]): string | undefined {
  const [prog, flag, script] = argv;
  if (argv.length !== 3 || prog === undefined || flag === undefined) return undefined;
  const base = prog.slice(prog.lastIndexOf("/") + 1);
  if (!["bash", "sh", "zsh", "dash"].includes(base)) return undefined;
  return /^-[a-z]*c[a-z]*$/.test(flag) && typeof script === "string" ? script : undefined;
}

/**
 * Clef に渡す state（JSON）。事実だけを入れる（どのファイルが大事かの判断は Clef に任せる）。
 * 秘密らしい値は伏せ、長いものは切り詰める。N=8 の履歴は逆効果だったので、直近は 3 件。
 */
export function buildDecisionState(input: DecisionStateInput): string {
  const script = shellScript(input.argv);
  const command = trunc(maskSecrets(script ?? input.argv.join(" ")), MAX_COMMAND_CHARS);
  const maxVcpu = SANDBOX_INSTANCES[input.max].vcpu;
  const sizes: Record<string, { vcpu: number; memory_gib: number }> = {};
  for (const name of SIZE_ORDER) {
    const s = SANDBOX_INSTANCES[name];
    if (s.vcpu <= maxVcpu || name === input.current) {
      sizes[name] = { vcpu: s.vcpu, memory_gib: s.memoryGiB };
    }
  }
  const state: Record<string, unknown> = {
    command,
    ...(script === undefined
      ? {
          argv: input.argv
            .slice(0, MAX_ARGV_ITEMS)
            .map((a) => trunc(maskSecrets(a), MAX_ARGV_ITEM_CHARS)),
        }
      : {}),
    cwd: trunc(input.cwd, 300),
    current_sandbox: sizeLabel(input.current),
    sandbox_sizes: sizes,
    repository_facts: trunc(maskSecrets(input.facts), MAX_FACTS_CHARS),
    recent_commands: input.recent.slice(-MAX_RECENT).map((r) => ({
      command: trunc(maskSecrets(r.command), MAX_RECENT_COMMAND_CHARS),
      seconds: r.seconds,
      exit_code: r.exitCode,
    })),
  };
  return JSON.stringify(state);
}

// ---- 応答の解釈と選択 ----

/** Clef の 3 問への答え（確率）。choice は [standard-2, standard-3, standard-4] */
export type ClefAnswers = {
  /** 重い確率 = P(2) + P(3) */
  heavy: number;
  /** 4 vCPU で 2 vCPU より明らかに速い確率 */
  fast4: number;
  choice?: [number, number, number];
};

const prob = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1 ? v : undefined;

/** AI.run の応答から 3 問の答えを読む。想定外の形・範囲外の確率は undefined（呼び出し側が再試行する） */
export function parseClefAnswers(response: unknown): ClefAnswers | undefined {
  if (typeof response !== "object" || response === null) return undefined;
  const answers = (response as { answers?: unknown }).answers;
  if (typeof answers !== "object" || answers === null) return undefined;
  const a = answers as Record<string, unknown>;
  const weight = a.weight as { probabilities?: Record<string, unknown> } | undefined;
  const p2 = prob(weight?.probabilities?.["2"]);
  const p3 = prob(weight?.probabilities?.["3"]);
  const fast4 = prob((a.beyond2 as { noul?: unknown } | undefined)?.noul);
  if (p2 === undefined || p3 === undefined || fast4 === undefined) return undefined;
  const heavy = Math.min(1, p2 + p3);
  const cp = (a.size as { probabilities?: Record<string, unknown> } | undefined)?.probabilities;
  const c2 = prob(cp?.["standard-2"]);
  const c3 = prob(cp?.["standard-3"]);
  const c4 = prob(cp?.["standard-4"]);
  return {
    heavy,
    fast4,
    ...(c2 !== undefined && c3 !== undefined && c4 !== undefined ? { choice: [c2, c3, c4] } : {}),
  };
}

export type PickContext = {
  current: SandboxInstance;
  max: SandboxInstance;
  thresholds: ClefThresholds;
};

const vcpu = (n: SandboxInstance): number => SANDBOX_INSTANCES[n].vcpu;

/**
 * 確率から、上げる先を選ぶ。上げないときは null。
 * 先は standard-3 か standard-4 で、上限を超えず、今の大きさより大きいときだけ（上げるだけ。下げない）。
 */
export function pickTarget(
  a: Pick<ClefAnswers, "heavy" | "fast4">,
  ctx: PickContext,
): SelectableSandboxInstance | null {
  if (a.heavy < ctx.thresholds.heavy) return null;
  let want: SelectableSandboxInstance =
    a.fast4 >= ctx.thresholds.four ? "standard-4" : "standard-3";
  if (vcpu(want) > vcpu(ctx.max)) want = ctx.max as SelectableSandboxInstance;
  return vcpu(want) > vcpu(ctx.current) ? want : null;
}

const within = (v: number, [lo, hi]: readonly [number, number]): boolean => v >= lo && v <= hi;

/** 4 vCPU の確率が判断を左右しうるか（重いと判断し、standard-4 に届きうる） */
function fourMatters(a: Pick<ClefAnswers, "heavy">, ctx: PickContext): boolean {
  return a.heavy >= ctx.thresholds.heavy && vcpu(ctx.max) >= 4 && vcpu(ctx.current) < 4;
}

/** flash の答えが曖昧で、clef で聞き直すべきか */
export function isAmbiguous(a: Pick<ClefAnswers, "heavy" | "fast4">, ctx: PickContext): boolean {
  if (within(a.heavy, ctx.thresholds.heavyBand)) return true;
  return fourMatters(a, ctx) && within(a.fast4, ctx.thresholds.fourBand);
}

// ---- 判定（AI.run を呼ぶ） ----

export type DecideDeps = {
  ai: Ai;
  /** AI Gateway の ID。空なら AI.run を呼ばない */
  gatewayId: string;
  /** AI Gateway の metadata（taskId など。文字列だけ） */
  metadata: Record<string, string>;
  thresholds?: ClefThresholds;
  /** テストで差し替える */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  attemptMs?: number;
  totalMs?: number;
};

export type DecideInput = {
  /** buildDecisionState の結果 */
  state: string;
  current: SandboxInstance;
  max: SandboxInstance;
};

export type DecisionProbs = {
  heavy: number;
  fast4: number;
  choice?: [number, number, number];
};

export type DecisionResult =
  | {
      ok: true;
      /** 上げる先。上げないなら null */
      target: SelectableSandboxInstance | null;
      /** 答えを使ったモデル */
      model: "flash" | "clef";
      probs?: DecisionProbs;
      /** AI.run を呼んだ回数（成功した呼び出しの数。再試行は数えない） */
      clefCalls: number;
      /** clef で聞き直そうとして失敗し、flash の答えを使った */
      clefFailed?: boolean;
      /** Clef を呼ばなかった（今の大きさが上限以上） */
      skipped?: true;
      /** 判断にかかった時間（ms） */
      ms: number;
    }
  | {
      ok: false;
      /** 固定のコード（例外の文面は返さない） */
      reason: "ai_gateway_id_missing" | "ai_run_failed" | "unexpected_response" | "timeout";
      ms: number;
    };

type QueryOutcome =
  | { ok: true; answers: ClefAnswers }
  | { ok: false; reason: "ai_run_failed" | "unexpected_response" | "timeout" };

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** promise を ms まで待つ。超えたら "timeout"（promise は放置する） */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), Math.max(0, ms));
  });
  promise.catch(() => {});
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 大きさの判断。ok: false のときは、呼び出し側が今の大きさのまま実行する（fail-soft）。
 * 今の大きさが上限以上なら、Clef を呼ばずに「上げない」を返す。
 */
export async function decideSandboxSize(
  deps: DecideDeps,
  input: DecideInput,
): Promise<DecisionResult> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;
  const attemptMs = deps.attemptMs ?? CLEF_ATTEMPT_MS;
  const totalMs = deps.totalMs ?? CLEF_TOTAL_MS;
  const thresholds = deps.thresholds ?? DEFAULT_CLEF_THRESHOLDS;
  const started = now();
  const elapsed = () => now() - started;
  const ctx: PickContext = { current: input.current, max: input.max, thresholds };

  if (vcpu(input.current) >= vcpu(input.max)) {
    return { ok: true, target: null, model: "flash", clefCalls: 0, skipped: true, ms: 0 };
  }
  if (!deps.gatewayId) return { ok: false, reason: "ai_gateway_id_missing", ms: 0 };

  // @cf/cloudflare/clef-flash は型定義（AiModels）にまだないので、最小限の型に落として呼ぶ
  const run = (
    deps.ai as unknown as {
      run(model: string, input: unknown, options?: unknown): Promise<unknown>;
    }
  ).run.bind(deps.ai);

  let clefCalls = 0;
  const query = async (model: typeof CLEF_FLASH | typeof CLEF_FULL): Promise<QueryOutcome> => {
    let reason: "ai_run_failed" | "unexpected_response" | "timeout" = "ai_run_failed";
    for (let attempt = 1; attempt <= CLEF_MAX_ATTEMPTS; attempt++) {
      const remaining = totalMs - elapsed();
      if (remaining <= 0) return { ok: false, reason: "timeout" };
      try {
        const res = await withTimeout(
          run(
            model.id,
            { model: model.name, state: input.state, questions: SANDBOX_DECISION_QUESTIONS },
            { gateway: { id: deps.gatewayId, metadata: deps.metadata } },
          ),
          Math.min(attemptMs, remaining),
        );
        if (res === "timeout") {
          reason = "timeout";
        } else {
          clefCalls += 1;
          const answers = parseClefAnswers(res);
          if (answers) return { ok: true, answers };
          reason = "unexpected_response";
        }
      } catch {
        // 例外の文面は残さない（固定のコードだけ）
        reason = "ai_run_failed";
      }
      if (attempt < CLEF_MAX_ATTEMPTS && totalMs - elapsed() > CLEF_RETRY_DELAY_MS) {
        await sleep(CLEF_RETRY_DELAY_MS);
      }
    }
    return { ok: false, reason };
  };

  const flash = await query(CLEF_FLASH);
  if (!flash.ok) return { ok: false, reason: flash.reason, ms: elapsed() };
  const f = flash.answers;

  if (!isAmbiguous(f, ctx)) {
    return {
      ok: true,
      target: pickTarget(f, ctx),
      model: "flash",
      probs: f,
      clefCalls,
      ms: elapsed(),
    };
  }

  const full = await query(CLEF_FULL);
  if (full.ok) {
    return {
      ok: true,
      target: pickTarget(full.answers, ctx),
      model: "clef",
      probs: full.answers,
      clefCalls,
      ms: elapsed(),
    };
  }
  // clef で聞き直せなかった: flash の答えを使う。3 と 4 で迷う（4 の確率が曖昧な帯）ときは standard-3 に倒す
  // （4 に上げ損ねても損は小さい。CPU は使った分だけ課金される）
  const prudent = fourMatters(f, ctx) && within(f.fast4, thresholds.fourBand);
  let target = pickTarget(f, ctx);
  if (prudent && target === "standard-4") {
    target = vcpu(input.current) < vcpu("standard-3") ? "standard-3" : null;
  }
  return {
    ok: true,
    target,
    model: "flash",
    probs: f,
    clefCalls,
    clefFailed: true,
    ms: elapsed(),
  };
}
