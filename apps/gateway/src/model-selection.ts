/**
 * task_start で model を省略したときの、モデルの自動選択（Workers AI の決定モデル Clef）。
 *
 * 判断は Clef だけが行う。このファイルは、Clef に渡す質問と state を組み立て、返ってきた確率からモデルを選ぶ。
 * Sandbox の大きさの判断（apps/agent/src/sandbox-scale-decision.ts）と同じ流儀で、
 * 純粋関数と、AI.run を引数で受け取る判定だけで、DO にもストレージにも触らない（task_start が TaskDO を作る前に呼ぶ）。
 *
 * 流れ:
 *  1. 候補 = env AUTO_MODEL_CANDIDATES ∩ 使えるモデル（AGENT_MODELS・プロバイダーのキーがあるもの）。
 *     等級（haiku < sonnet < opus < fable。費用の安い順）が分かる Anthropic のモデルだけ。同じ等級は先に書いたほう 1 つ。
 *     候補が 1 つ以下なら Clef を呼ばない。
 *  2. flash（@cf/cloudflare/clef-flash）に 1 問を聞く。score で、段の数 = 候補の数（各段の criteria は仕事の性質で書く。モデル名は書かない）。
 *     答えの確率から「その段以上」の累積確率を作り、閾値以上のうちいちばん重い段を選ぶ。
 *  3. 累積確率が曖昧な帯にある段があるときだけ、clef（@cf/cloudflare/clef）で聞き直し、段ごとに大きいほうで決める
 *     （軽く見積もって失敗する損のほうが、重く見積もって費用が増える損より大きい。sizing と同じ非対称）。
 *  4. 失敗（例外・時間切れ・想定外の応答・候補外の段の答え）は 1 回 1.5 秒・最大 2 回まで。全体は 3 秒。
 *     それでも駄目なら既定のモデル。task_start は失敗させない（呼び出し側は必ず model を受け取る）。
 *
 * 候補外のモデルを選ぶことは構造上ない（Clef が返すのは段の確率で、段 → 候補の対応はこちらが持つ）。段の数と合わない応答は fallback_invalid。
 * 閾値は実験で調整した値（docs/specs/design.md の「モデルの自動選択」）。env AUTO_MODEL_CLEF_THRESHOLDS で変えられる。
 */

import { maskSecrets } from "@rovo/audit";
import { z } from "zod";

export const CLEF_FLASH = { id: "@cf/cloudflare/clef-flash", name: "clef-flash" } as const;
export const CLEF_FULL = { id: "@cf/cloudflare/clef", name: "clef" } as const;

/** 1 回の AI.run の期限（ms）。task_start は同期の MCP 呼び出しなので短くする */
export const SELECT_ATTEMPT_MS = 1_500;
/** 1 つのモデルへの試行回数の上限 */
export const SELECT_MAX_ATTEMPTS = 2;
/** 1 回の選択（flash と、必要なら clef の聞き直しを合わせた）全体の上限（ms） */
export const SELECT_TOTAL_MS = 3_000;
/** 再試行の前の待ち（ms） */
const RETRY_DELAY_MS = 150;

// ---- 記録 ----

/** 選び方の理由（固定のコード。例外の文面や指示文は入れない） */
export const MODEL_SELECTION_REASONS = [
  "explicit",
  "single_candidate",
  "no_candidates",
  "clef_flash",
  "clef_cascade",
  "fallback_unconfigured",
  "fallback_timeout",
  "fallback_error",
  "fallback_invalid",
] as const;
export type ModelSelectionReason = (typeof MODEL_SELECTION_REASONS)[number];

/**
 * タスクに持たせる記録。scores は、段ごとの「その段以上の重さ」と判断した確率（最も安い段は常に 1 なので入れない。候補のモデル id がキー）。
 * RPC・SQLite に保存するので、JSON に落とせる値だけ。
 */
export const modelSelectionSchema = z.object({
  mode: z.enum(["auto", "explicit"]),
  chosen: z.string().min(1).max(100),
  reason: z.enum(MODEL_SELECTION_REASONS),
  scores: z.record(z.string().max(100), z.number().min(0).max(1)).optional(),
  latency_ms: z.number().int().min(0).max(600_000).optional(),
});
export type ModelSelection = z.infer<typeof modelSelectionSchema>;

// ---- 候補 ----

export type ModelClass = "haiku" | "sonnet" | "opus" | "fable";
/** 費用の安い順 */
const CLASS_ORDER: readonly ModelClass[] = ["haiku", "sonnet", "opus", "fable"];

export type Candidate = { id: string; cls: ModelClass };

/**
 * モデルの等級。Anthropic の id から決まる。openai/*・workers-ai/*・知らない id は undefined（自動では選ばない）。
 * 他社のモデルを haiku 〜 opus の 4 段に当てはめる根拠が無く、Workers AI のモデルは「キー不要の代わり」で役割が違う。
 */
export function classOf(modelId: string): ModelClass | undefined {
  if (!modelId.startsWith("anthropic/")) return undefined;
  for (const cls of CLASS_ORDER) if (modelId.includes(cls)) return cls;
  return undefined;
}

/** env AUTO_MODEL_CANDIDATES の既定（未設定のとき）。fable は既定に入れない（極端に重い作業は env で足す） */
export const DEFAULT_AUTO_MODEL_CANDIDATES =
  "anthropic/claude-haiku-5-5,anthropic/claude-sonnet-5-5,anthropic/claude-opus-5-5";

/** env AUTO_MODEL_CANDIDATES（カンマ区切り）。空白・空要素・重複を除く */
export function parseCandidates(raw: string | undefined): string[] {
  const out: string[] = [];
  for (const part of (raw ?? "").split(",")) {
    const id = part.trim();
    if (id !== "" && !out.includes(id)) out.push(id);
  }
  return out;
}

/** 候補: env の id ∩ 使えるモデル。等級が分かるものだけ、同じ等級は先に書いたほう 1 つ、費用の安い順 */
export function eligibleCandidates(
  envIds: readonly string[],
  allowed: readonly string[],
  isAvailable: (id: string) => boolean,
): Candidate[] {
  const byClass = new Map<ModelClass, Candidate>();
  for (const id of envIds) {
    const cls = classOf(id);
    if (cls === undefined || byClass.has(cls)) continue;
    if (!allowed.includes(id) || !isAvailable(id)) continue;
    byClass.set(cls, { id, cls });
  }
  return CLASS_ORDER.flatMap((cls) => byClass.get(cls) ?? []);
}

// ---- 閾値 ----

export type SelectThresholds = {
  /** 「その段以上」の累積確率がこれ以上のうち、いちばん重い段を選ぶ */
  up: number;
  /** 累積確率がこの帯（下端を含み、上端を含まない）にある段があれば、clef で聞き直す */
  band: readonly [number, number];
};

export const DEFAULT_SELECT_THRESHOLDS: SelectThresholds = { up: 0.5, band: [0.3, 0.7] };

const unit = (s: string): number | undefined => {
  if (!/^\d*\.?\d+$/.test(s)) return undefined;
  const n = Number(s);
  return n >= 0 && n <= 1 ? n : undefined;
};

/**
 * env AUTO_MODEL_CLEF_THRESHOLDS を解く。`up=0.5,band=0.3-0.7` の形で、書いたキーだけ上書きする。
 * 未設定・空は既定。不正な値は丸ごと既定に戻して、受け付けなかった値を ignored に返す（起動はエラーにしない）。
 */
export function resolveSelectThresholds(raw: string | undefined): {
  thresholds: SelectThresholds;
  ignored?: string;
} {
  const v = (raw ?? "").trim();
  if (v === "") return { thresholds: DEFAULT_SELECT_THRESHOLDS };
  const next = { ...DEFAULT_SELECT_THRESHOLDS };
  const bad = { thresholds: DEFAULT_SELECT_THRESHOLDS, ignored: v };
  for (const part of v.split(",")) {
    const eq = part.indexOf("=");
    if (eq < 0) return bad;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === "up") {
      const n = unit(value);
      if (n === undefined) return bad;
      next.up = n;
    } else if (key === "band") {
      const m = /^(\d*\.?\d+)-(\d*\.?\d+)$/.exec(value);
      const lo = m ? unit(m[1] as string) : undefined;
      const hi = m ? unit(m[2] as string) : undefined;
      if (lo === undefined || hi === undefined || lo > hi) return bad;
      next.band = [lo, hi];
    } else {
      return bad;
    }
  }
  return { thresholds: next };
}

// ---- 質問 ----

/**
 * 各等級の仕事の性質（criteria）。モデル名・「既定」は書かない（質問は仕事の重さだけを聞く）。
 * 最も安い段には「それより軽いもの」、最も重い段には「それより重いもの」を含める（候補が 2 つのときでも全体を覆うため）。
 */
const CLASS_CRITERIA: Record<ModelClass, string> = {
  haiku:
    "Mechanical or small change: one file or a few lines, such as fixing a typo, changing wording, bumping a version, editing a config value, or applying a routine, fully specified edit. No design decisions and little or no new logic.",
  sonnet:
    "Ordinary implementation: a feature or bug fix that spans several files, follows patterns already in the codebase, and needs tests to be written. The approach is clear from the instructions.",
  opus: "Heavy work: needs design decisions, a broad refactor across many modules, finding the root cause of a bug whose cause is unknown, or careful reasoning about concurrency, security or data integrity.",
  fable:
    "Extremely heavy work: a large, open-ended effort that combines architecture, many interacting subsystems and hard debugging or research, where mistakes are costly and the path is not obvious.",
};

/** Clef への質問（英語）。段の数は候補の数、並びは費用の安い順 */
export function buildSelectionQuestions(candidates: readonly Candidate[]) {
  const last = candidates.length - 1;
  const criteria = candidates.map((c, i) => {
    const text = CLASS_CRITERIA[c.cls];
    if (i === 0 && last > 0) return `${text} (Anything simpler than this also belongs here.)`;
    if (i === last && last > 0) return `${text} (Anything heavier than this also belongs here.)`;
    return text;
  });
  return {
    tier: {
      type: "score",
      instructions:
        "How demanding is the coding task described in the state? Judge by the nature of the work (scope, need for design or investigation, risk), not by how long the text is.",
      criteria,
    },
  } as const;
}

// ---- state ----

export type SelectionTask = {
  title: string;
  instructions: string;
  acceptance_criteria: readonly string[];
  verification_commands: readonly { argv: readonly string[] }[];
  /** owner/name。Clef には名前だけ渡す */
  repository: string;
};

// state の各部分の上限（文字数）。全体は約 1 万文字以下で、clef-flash の窓（24,576 tokens）に十分収まる。
// 窓を超えるとエラーになる（黙って切られない）ので、長い指示は先頭と末尾を残して切る
// （clef に回す案もあるが、clef は遅く、同期の呼び出しの上限（3 秒）に収まらない。長い指示の意図は先頭と末尾にある）
const MAX_INSTRUCTIONS_HEAD = 3_500;
const MAX_INSTRUCTIONS_TAIL = 1_500;
const MAX_CRITERIA_ITEMS = 15;
const MAX_CRITERIA_CHARS = 250;
const MAX_COMMANDS = 5;
const MAX_COMMAND_CHARS = 150;
const MAX_TITLE_CHARS = 200;

const trunc = (s: string, n: number): string => (s.length > n ? s.slice(0, n) : s);

function cutInstructions(text: string): string {
  const keep = MAX_INSTRUCTIONS_HEAD + MAX_INSTRUCTIONS_TAIL;
  if (text.length <= keep) return text;
  const omitted = text.length - keep;
  return `${text.slice(0, MAX_INSTRUCTIONS_HEAD)}\n[... ${omitted} characters omitted ...]\n${text.slice(text.length - MAX_INSTRUCTIONS_TAIL)}`;
}

/** Clef に渡す state（JSON）。指示文は呼び出し元が書いたもの（非信頼ではない）だが、質問の側には混ぜず state にだけ入れる */
export function buildSelectionState(task: SelectionTask): string {
  const slash = task.repository.indexOf("/");
  return JSON.stringify({
    title: maskSecrets(trunc(task.title, MAX_TITLE_CHARS)),
    // 秘密らしい値は伏せる（指示文に貼られた token が Workers AI に渡らないように。既知の形式だけ）
    instructions: maskSecrets(cutInstructions(task.instructions)),
    instructions_chars: task.instructions.length,
    acceptance_criteria: task.acceptance_criteria
      .slice(0, MAX_CRITERIA_ITEMS)
      .map((c) => maskSecrets(trunc(c, MAX_CRITERIA_CHARS))),
    verification_commands: task.verification_commands
      .slice(0, MAX_COMMANDS)
      .map((c) => maskSecrets(trunc(c.argv.join(" "), MAX_COMMAND_CHARS))),
    repository: task.repository.slice(slash + 1),
  });
}

// ---- 応答の解釈と選択 ----

const prob = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1 ? v : undefined;

/**
 * AI.run の応答から、段ごとの「その段以上」の累積確率を読む（先頭は常に 1）。
 * 段の数が合わない（足りない・多い）・確率が範囲外・合計が 1 から離れている・形が違う応答は undefined。
 */
export function parseTierScores(response: unknown, tiers: number): number[] | undefined {
  if (typeof response !== "object" || response === null) return undefined;
  const answers = (response as { answers?: unknown }).answers;
  if (typeof answers !== "object" || answers === null) return undefined;
  const tier = (answers as { tier?: unknown }).tier;
  if (typeof tier !== "object" || tier === null) return undefined;
  const probs = (tier as { probabilities?: unknown }).probabilities;
  if (typeof probs !== "object" || probs === null) return undefined;
  const keys = Object.keys(probs);
  if (keys.length !== tiers) return undefined;
  const p: number[] = [];
  for (let i = 0; i < tiers; i++) {
    const v = prob((probs as Record<string, unknown>)[String(i)]);
    if (v === undefined) return undefined;
    p.push(v);
  }
  const sum = p.reduce((a, b) => a + b, 0);
  if (sum < 0.8 || sum > 1.2) return undefined;
  const cum: number[] = new Array(tiers).fill(0);
  let acc = 0;
  for (let i = tiers - 1; i >= 0; i--) {
    acc += p[i] as number;
    cum[i] = Math.min(1, acc);
  }
  cum[0] = 1;
  return cum;
}

/** 累積確率が閾値以上のうち、いちばん重い段。どれも届かなければ最も安い段 */
export function pickTier(cum: readonly number[], th: SelectThresholds): number {
  for (let k = cum.length - 1; k >= 1; k--) if ((cum[k] as number) >= th.up) return k;
  return 0;
}

/** 累積確率が曖昧な帯（下端を含み、上端を含まない）にある段が 1 つでもあるか（最も安い段は常に 1 なので数えない） */
export function isAmbiguous(cum: readonly number[], th: SelectThresholds): boolean {
  for (let k = 1; k < cum.length; k++) {
    const v = cum[k] as number;
    if (v >= th.band[0] && v < th.band[1]) return true;
  }
  return false;
}

// ---- 判定（AI.run を呼ぶ） ----

export type SelectDeps = {
  /** Workers AI のバインディング。無ければ Clef を呼ばない */
  ai: { run(model: string, input: unknown, options?: unknown): Promise<unknown> } | undefined;
  /** AI Gateway の ID。空なら Clef を呼ばない（agent の昇格の判断・web と同じ fail closed。fallback_unconfigured） */
  gatewayId?: string;
  /** AI Gateway の metadata（文字列だけ） */
  metadata?: Record<string, string>;
  thresholds?: SelectThresholds;
  /** テストで差し替える */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  attemptMs?: number;
  totalMs?: number;
};

export type SelectInput = {
  candidates: readonly Candidate[];
  /** 失敗したときのモデル（resolveModel が省略時に決めた既定） */
  fallback: string;
  task: SelectionTask;
};

export type ModelChoice = { model: string; selection: ModelSelection };

type Failure = "fallback_timeout" | "fallback_error" | "fallback_invalid";
type Outcome = { ok: true; cum: number[] } | { ok: false; reason: Failure };

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

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * モデルを選ぶ。必ず model を返す（失敗は fallback）。例外は投げない。
 * 候補が 1 つ以下なら Clef を呼ばない。
 */
export async function selectModel(deps: SelectDeps, input: SelectInput): Promise<ModelChoice> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;
  const attemptMs = deps.attemptMs ?? SELECT_ATTEMPT_MS;
  const totalMs = deps.totalMs ?? SELECT_TOTAL_MS;
  const thresholds = deps.thresholds ?? DEFAULT_SELECT_THRESHOLDS;
  const started = now();
  const elapsed = () => now() - started;
  const { candidates } = input;

  const done = (model: string, reason: ModelSelectionReason, scores?: number[]): ModelChoice => ({
    model,
    selection: {
      mode: "auto",
      chosen: model,
      reason,
      ...(scores !== undefined
        ? {
            scores: Object.fromEntries(
              candidates.slice(1).map((c, i) => [c.id, round3(scores[i + 1] as number)]),
            ),
          }
        : {}),
      latency_ms: elapsed(),
    },
  });

  if (candidates.length === 0) return done(input.fallback, "no_candidates");
  if (candidates.length === 1) return done((candidates[0] as Candidate).id, "single_candidate");
  const ai = deps.ai;
  if (!ai || !deps.gatewayId) return done(input.fallback, "fallback_unconfigured");

  const state = buildSelectionState(input.task);
  const questions = buildSelectionQuestions(candidates);
  const options = { gateway: { id: deps.gatewayId, metadata: deps.metadata ?? {} } };

  const query = async (model: typeof CLEF_FLASH | typeof CLEF_FULL): Promise<Outcome> => {
    let reason: Failure = "fallback_error";
    for (let attempt = 1; attempt <= SELECT_MAX_ATTEMPTS; attempt++) {
      const remaining = totalMs - elapsed();
      if (remaining <= 0) return { ok: false, reason: "fallback_timeout" };
      try {
        const res = await withTimeout(
          ai.run(model.id, { model: model.name, state, questions }, options),
          Math.min(attemptMs, remaining),
        );
        if (res === "timeout") {
          reason = "fallback_timeout";
        } else {
          const cum = parseTierScores(res, candidates.length);
          if (cum) return { ok: true, cum };
          reason = "fallback_invalid";
        }
      } catch {
        // 例外の文面は残さない（固定のコードだけ）
        reason = "fallback_error";
      }
      if (attempt < SELECT_MAX_ATTEMPTS && totalMs - elapsed() > RETRY_DELAY_MS) {
        await sleep(RETRY_DELAY_MS);
      }
    }
    return { ok: false, reason };
  };

  const flash = await query(CLEF_FLASH);
  if (!flash.ok) {
    console.warn("model_select_failed", flash.reason);
    return done(input.fallback, flash.reason);
  }
  if (!isAmbiguous(flash.cum, thresholds)) {
    return done(
      (candidates[pickTier(flash.cum, thresholds)] as Candidate).id,
      "clef_flash",
      flash.cum,
    );
  }

  const full = await query(CLEF_FULL);
  if (!full.ok) {
    // clef で聞き直せなかった: flash の答えを使う
    console.warn("model_select_clef_failed", full.reason);
    return done(
      (candidates[pickTier(flash.cum, thresholds)] as Candidate).id,
      "clef_flash",
      flash.cum,
    );
  }
  // 段ごとに大きいほうの確率で決める（軽く見積もる損のほうが大きい）
  const merged = flash.cum.map((v, k) => Math.max(v, full.cum[k] as number));
  return done((candidates[pickTier(merged, thresholds)] as Candidate).id, "clef_cascade", merged);
}
