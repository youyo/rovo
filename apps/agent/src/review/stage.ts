/**
 * レビューの段（docs/specs/worker-review.md の②③）の手順。Sandbox とモデルは呼び出し側（AgentDO）が差し込むので、
 * ここは順番と再試行の規則だけを持つ（task_review と、後の worker_review の両方から呼ぶ部品）。
 *   1. runReviewCommands: review_commands を先頭から順に、失敗しても止めずに全部流す（段の時間の上限を過ぎたら残りを飛ばす）
 *   2. runReviewModel: レビューのモデルを呼ぶ（ツールなし）。失敗・形の違う答えは 1 回だけ再試行する
 *   3. reviewWarnings: 段の結果から warnings の固定コードを作る
 */
import type { ReviewCommandResult, ReviewInput } from "./input";
import { REVIEW_JSON_ONLY_RETRY } from "./input";
import { parseReviewResponse, type ReviewVerdict } from "./output";

/** レビューの段全体の時間の上限（review_commands の合計とモデルの待ちを含む。初版は 15 分） */
export const REVIEW_STAGE_LIMIT_MS = 15 * 60_000;
/** レビューのモデルの出力の上限（トークン）。予算の予約もこの値で見積もる */
export const REVIEW_MAX_OUTPUT_TOKENS = 8_000;
/** レビューのモデル 1 回の呼び出しを待つ上限（consult と同じ 120 秒） */
export const REVIEW_MODEL_TIMEOUT_MS = 120_000;
/** review_commands の 1 本の既定の時間（verification_commands と同じ 10 分） */
const DEFAULT_COMMAND_TIMEOUT_SECONDS = 600;

export interface ReviewCommand {
  argv: string[];
  cwd?: string;
  timeoutSeconds?: number;
}

/** review_commands を流す口（AgentDO が Sandbox につなぐ） */
export interface CommandRunner {
  now(): number;
  /** cancel・期限・終端などで止めるなら true（以後のコマンドを流さない） */
  stopped(): boolean;
  /** Sandbox を起動して PR の head を取り出す。失敗は throw（コマンドを流せない） */
  prepare(): Promise<void>;
  run(
    cmd: ReviewCommand,
    timeoutMs: number,
  ): Promise<{ exitCode: number; timedOut: boolean; output: string }>;
}

export interface ReviewCommandsOutcome {
  results: ReviewCommandResult[];
  /** Sandbox を用意できず、コマンドを流せなかった */
  unavailable: boolean;
  /** 段の時間の上限で、残りのコマンドを飛ばした */
  timedOut: boolean;
  /** 止められた（cancel など） */
  stopped: boolean;
}

export async function runReviewCommands(
  runner: CommandRunner,
  commands: readonly ReviewCommand[],
  deadlineAt: number,
): Promise<ReviewCommandsOutcome> {
  const out: ReviewCommandsOutcome = {
    results: [],
    unavailable: false,
    timedOut: false,
    stopped: false,
  };
  if (commands.length === 0) return out;
  if (runner.stopped()) return { ...out, stopped: true };
  try {
    await runner.prepare();
  } catch {
    return { ...out, unavailable: true };
  }
  for (const cmd of commands) {
    if (runner.stopped()) return { ...out, stopped: true };
    const remaining = deadlineAt - runner.now();
    if (remaining <= 0) {
      out.timedOut = true;
      out.results.push({
        argv: cmd.argv,
        exitCode: -1,
        timedOut: false,
        output: "",
        skipped: true,
      });
      continue;
    }
    const timeoutMs = Math.min(
      (cmd.timeoutSeconds ?? DEFAULT_COMMAND_TIMEOUT_SECONDS) * 1000,
      remaining,
    );
    const startedAt = runner.now();
    try {
      const r = await runner.run(cmd, timeoutMs);
      out.results.push({
        argv: cmd.argv,
        exitCode: r.exitCode,
        timedOut: r.timedOut,
        output: r.output,
        durationMs: Math.max(0, runner.now() - startedAt),
      });
    } catch (e) {
      out.results.push({
        argv: cmd.argv,
        exitCode: -1,
        timedOut: false,
        output: `rovo could not run this command in the sandbox: ${e instanceof Error ? e.name : "error"}`,
        durationMs: Math.max(0, runner.now() - startedAt),
      });
    }
  }
  if (runner.stopped()) out.stopped = true;
  return out;
}

/** モデルに渡すメッセージ。user は text ブロックの並び（先頭は固定の見出し） */
export type ReviewMessage =
  | { role: "user"; blocks: string[] }
  | { role: "assistant"; text: string };

/**
 * モデル 1 回の結果。truncated は出力の上限で切れた（JSON が閉じていない）こと。
 * 失敗: model_error（5xx など。再試行してよい）/ model_rejected（4xx。直らない）/ timeout / budget（予算に収まらない）
 */
export type ModelCallResult =
  | { ok: true; text: string; truncated: boolean }
  | { ok: false; code: "model_error" | "model_rejected" | "timeout" | "budget" };

/** レビューのモデルを呼ぶ口（AgentDO が AI Gateway と予算につなぐ。費用の計上もそちら） */
export interface ModelCaller {
  call(req: { system: string; messages: ReviewMessage[] }): Promise<ModelCallResult>;
}

export type ReviewFailureCode =
  | "model_error"
  | "model_rejected"
  | "timeout"
  | "budget"
  | "invalid_response";

export type ReviewModelOutcome =
  | {
      ok: true;
      verdict: ReviewVerdict;
      droppedUnknownPath: number;
      cut: { mustFix: number; suggestions: number };
    }
  | { ok: false; code: ReviewFailureCode };

/**
 * レビューのモデルを呼ぶ。呼び出しは最大 2 回: 失敗（model_error / timeout）なら同じ依頼をもう 1 回、
 * 形の違う答えなら「JSON だけを返す」と再要求する。4xx（model_rejected）と予算不足（budget）は再試行しない。
 */
export async function runReviewModel(
  caller: ModelCaller,
  input: ReviewInput,
): Promise<ReviewModelOutcome> {
  const first: ReviewMessage[] = [{ role: "user", blocks: input.blocks }];
  const parse = (r: { text: string; truncated: boolean }) =>
    r.truncated
      ? ({ ok: false, code: "not_json" } as const)
      : parseReviewResponse(r.text, input.paths);
  const done = (p: ReturnType<typeof parse>): ReviewModelOutcome =>
    p.ok
      ? { ok: true, verdict: p.verdict, droppedUnknownPath: p.droppedUnknownPath, cut: p.cut }
      : { ok: false, code: "invalid_response" };

  const a = await caller.call({ system: input.system, messages: first });
  if (!a.ok) {
    if (a.code === "model_rejected" || a.code === "budget") return { ok: false, code: a.code };
    const b = await caller.call({ system: input.system, messages: first });
    return b.ok ? done(parse(b)) : { ok: false, code: b.code };
  }
  const parsed = parse(a);
  if (parsed.ok) return done(parsed);
  const b = await caller.call({
    system: input.system,
    messages: [
      ...first,
      { role: "assistant", text: a.text },
      { role: "user", blocks: [REVIEW_JSON_ONLY_RETRY] },
    ],
  });
  return b.ok ? done(parse(b)) : { ok: false, code: b.code };
}

/** 段の結果から、task_result の warnings に出す固定コードを作る */
export function reviewWarnings(s: {
  unavailable: boolean;
  timedOut: boolean;
  redacted: boolean;
  failure: ReviewFailureCode | undefined;
}): string[] {
  const out: string[] = [];
  if (s.unavailable) out.push("review_commands_unavailable");
  if (s.timedOut) out.push("review_timeout");
  if (s.redacted) out.push("review_redacted");
  if (s.failure === "budget") out.push("review_skipped_budget");
  else if (s.failure !== undefined) out.push(`review_failed: ${s.failure}`);
  return out;
}
