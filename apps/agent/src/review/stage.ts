/**
 * レビューの段（docs/specs/worker-review.md の②③）の手順。Sandbox とモデルは呼び出し側（AgentDO）が差し込むので、
 * ここは順番と再試行の規則だけを持つ（task_review と worker_review の両方から呼ぶ部品）。
 *   1. runReviewCommands: review_commands を先頭から順に、失敗しても止めずに全部流す（段の時間の上限を過ぎたら残りを飛ばす）
 *   2. runReviewModel: レビューのモデルを呼ぶ。読み取りの道具（read_file / list_files / search）を往復させてから JSON を返させる
 *      （往復は REVIEW_MAX_TOOL_ROUNDS 回まで。上限に達したら道具を外して 1 回だけ「JSON だけ」と求める）。
 *      失敗・形の違う答えは 1 回だけ再試行する
 *   3. reviewWarnings: 段の結果から warnings の固定コードを作る
 *   4. workerReviewWarnings: worker_review の結果の分類（件数から warnings の固定コードを作る）
 */
import type { ReviewCommandResult, ReviewInput } from "./input";
import { REVIEW_JSON_ONLY_RETRY, REVIEW_TOOLS_CLOSED_NOTICE } from "./input";
import { parseReviewResponse, type ReviewVerdict } from "./output";
import type { ReviewToolDef, ReviewToolRunner } from "./tools";

/** レビューの段全体の時間の上限（review_commands の合計とモデルの待ちを含む。初版は 15 分） */
export const REVIEW_STAGE_LIMIT_MS = 15 * 60_000;
/** レビューのモデルの出力の上限（トークン）。予算の予約もこの値で見積もる */
export const REVIEW_MAX_OUTPUT_TOKENS = 8_000;
/** レビューのモデル 1 回の呼び出しを待つ上限（consult と同じ 120 秒） */
export const REVIEW_MODEL_TIMEOUT_MS = 120_000;
/** 道具の往復（道具を呼ぶ応答 1 つ = 1 往復）の上限。超えても JSON が出なければ、道具を外して 1 回だけ「JSON だけ」と求める */
export const REVIEW_MAX_TOOL_ROUNDS = 20;
/** 1 つの応答で実行する道具の呼び出しの上限（超えた分はエラーの結果を返す） */
export const REVIEW_MAX_TOOL_CALLS_PER_ROUND = 8;
/**
 * 道具の結果の累計の上限（UTF-8 のバイト数）。モデルの文脈の窓を道具の結果で溢れさせないため、
 * 超えたらそれ以上の往復を待たずに、道具を外して JSON を求める
 */
export const REVIEW_TOOL_RESULT_TOTAL_MAX_BYTES = 256 * 1024;
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

export interface ReviewToolCall {
  id: string;
  name: string;
  arguments: unknown;
}

/**
 * モデルに渡すメッセージ。user は text ブロックの並び（先頭は固定の見出し）。
 * assistant の toolCalls は、その応答で呼んだ道具。tool はその結果（呼び出しごとに 1 件。伏せ字・囲み済みの文字列）
 */
export type ReviewMessage =
  | { role: "user"; blocks: string[] }
  | { role: "assistant"; text: string; toolCalls?: ReviewToolCall[] }
  | {
      role: "tool";
      results: { id: string; name: string; text: string; isError: boolean }[];
    };

/**
 * モデル 1 回の結果。truncated は出力の上限で切れた（JSON が閉じていない）こと。toolCalls はモデルが呼んだ道具。
 * 失敗: model_error（5xx など。再試行してよい）/ model_rejected（4xx。直らない）/ timeout / budget（予算に収まらない）
 */
export type ModelCallResult =
  | { ok: true; text: string; truncated: boolean; toolCalls?: ReviewToolCall[] }
  | { ok: false; code: "model_error" | "model_rejected" | "timeout" | "budget" };

/**
 * レビューのモデルを呼ぶ口（AgentDO が AI Gateway と予算につなぐ。費用の計上もそちら。呼ぶ前に、それまでに使った額と残りを確かめる）。
 * tools を渡したときだけ、モデルに道具の定義を渡す（渡さなければ道具なし）。
 */
export interface ModelCaller {
  call(req: {
    system: string;
    messages: ReviewMessage[];
    tools?: ReviewToolDef[];
  }): Promise<ModelCallResult>;
}

export type ReviewFailureCode =
  | "diff_unavailable"
  | "model_error"
  | "model_rejected"
  | "timeout"
  | "budget"
  | "invalid_response"
  | "tool_rounds_exceeded";

/** 往復の途中の会話。予算の延長の承認のあとに、ここから続ける（呼び出し側が保存する） */
export interface ReviewTranscript {
  messages: ReviewMessage[];
  /** 使った往復の数 */
  rounds: number;
  /** 道具の結果の累計（UTF-8 のバイト数） */
  toolBytes: number;
}

export type ReviewModelOutcome =
  | {
      ok: true;
      verdict: ReviewVerdict;
      droppedUnknownPath: number;
      cut: { mustFix: number; suggestions: number };
    }
  | {
      ok: false;
      code: ReviewFailureCode;
      /** budget で打ち切ったとき（道具つきのときだけ）。承認されたらここから続ける */
      resume?: ReviewTranscript;
    };

export interface RunReviewModelOptions {
  /** 道具の口。渡さなければ道具なしの 1 回呼び（再試行つき） */
  tools?: ReviewToolRunner;
  /** 予算の延長のあとの続き */
  resume?: ReviewTranscript;
  /** 往復の上限（テスト用。既定は REVIEW_MAX_TOOL_ROUNDS） */
  maxRounds?: number;
}

const TOO_MANY_CALLS = `Skipped: at most ${REVIEW_MAX_TOOL_CALLS_PER_ROUND} tool calls are run per turn. Call fewer tools at a time.`;
const utf8Length = (s: string) => new TextEncoder().encode(s).length;

/**
 * 道具の定義を渡さない依頼のために、会話の中の道具の呼び出し・結果を文字にたたむ
 * （プロバイダーによっては、道具の定義の無い依頼に道具のブロックを含められない）。連続する user は 1 つにまとめる。
 */
function withoutToolBlocks(messages: ReviewMessage[]): ReviewMessage[] {
  const out: ReviewMessage[] = [];
  const pushUser = (blocks: string[]) => {
    const last = out.at(-1);
    if (last?.role === "user") last.blocks = [...last.blocks, ...blocks];
    else out.push({ role: "user", blocks });
  };
  for (const m of messages) {
    if (m.role === "user") pushUser([...m.blocks]);
    else if (m.role === "tool") {
      pushUser(
        m.results.map((r) => `Result of ${r.name}${r.isError ? " (error)" : ""}:\n${r.text}`),
      );
    } else {
      const calls = (m.toolCalls ?? []).map(
        (c) => `[called tool ${c.name} with ${JSON.stringify(c.arguments)}]`,
      );
      const text = [m.text, ...calls].filter((t) => t !== "").join("\n");
      out.push({ role: "assistant", text: text === "" ? "(no text)" : text });
    }
  }
  return out;
}

/**
 * レビューのモデルを呼ぶ。道具（tools）があれば、モデルが JSON を返すまで道具を往復させる（1 往復 = 道具を呼ぶ応答 1 つ。
 * 上限 REVIEW_MAX_TOOL_ROUNDS 回、または道具の結果の累計が上限を超えたら、道具を外して 1 回だけ「JSON だけ」と求め、
 * それでも JSON にならなければ tool_rounds_exceeded）。
 * 1 回の呼び出しの失敗（model_error / timeout）は同じ依頼をもう 1 回、形の違う答えは「JSON だけを返す」と 1 回だけ再要求する
 * （再要求では道具を使わせない）。4xx（model_rejected）と予算不足（budget）は再試行しない。
 * 予算は呼び出し側（ModelCaller）が各呼び出しの前に確かめ、足りなければ budget を返す。
 */
export async function runReviewModel(
  caller: ModelCaller,
  input: ReviewInput,
  options: RunReviewModelOptions = {},
): Promise<ReviewModelOutcome> {
  const tools = options.tools;
  const maxRounds = options.maxRounds ?? REVIEW_MAX_TOOL_ROUNDS;
  const state: ReviewTranscript = options.resume
    ? {
        messages: [...options.resume.messages],
        rounds: options.resume.rounds,
        toolBytes: options.resume.toolBytes,
      }
    : { messages: [{ role: "user", blocks: input.blocks }], rounds: 0, toolBytes: 0 };
  const parse = (r: { text: string; truncated: boolean }) =>
    r.truncated
      ? ({ ok: false, code: "not_json" } as const)
      : parseReviewResponse(r.text, input.paths);
  const done = (p: ReturnType<typeof parse>, code: ReviewFailureCode): ReviewModelOutcome =>
    p.ok
      ? { ok: true, verdict: p.verdict, droppedUnknownPath: p.droppedUnknownPath, cut: p.cut }
      : { ok: false, code };
  const fail = (code: ReviewFailureCode): ReviewModelOutcome =>
    code === "budget" && tools
      ? { ok: false, code, resume: { ...state, messages: [...state.messages] } }
      : { ok: false, code };
  /** 失敗（model_error / timeout）なら同じ依頼をもう 1 回 */
  const callWithRetry = async (req: Parameters<ModelCaller["call"]>[0]) => {
    const a = await caller.call(req);
    if (a.ok || a.code === "model_rejected" || a.code === "budget") return a;
    return caller.call(req);
  };

  for (;;) {
    const toolsOpen =
      tools !== undefined &&
      state.rounds < maxRounds &&
      state.toolBytes <= REVIEW_TOOL_RESULT_TOTAL_MAX_BYTES;

    // 往復の上限（または道具の結果の上限）: 道具を外して、1 回だけ「JSON だけ」と求める
    if (tools && !toolsOpen) {
      const r = await callWithRetry({
        system: input.system,
        messages: withoutToolBlocks([
          ...state.messages,
          { role: "user", blocks: [REVIEW_TOOLS_CLOSED_NOTICE, REVIEW_JSON_ONLY_RETRY] },
        ]),
      });
      if (!r.ok) return fail(r.code);
      return done(parse(r), "tool_rounds_exceeded");
    }

    const r = await callWithRetry({
      system: input.system,
      messages: [...state.messages],
      ...(tools ? { tools: tools.definitions } : {}),
    });
    if (!r.ok) return fail(r.code);

    // 道具を呼んだ応答: 順に実行して、結果を会話に足し、もう 1 往復
    const calls = r.toolCalls ?? [];
    if (tools && !r.truncated && calls.length > 0) {
      const results: { id: string; name: string; text: string; isError: boolean }[] = [];
      for (const [i, c] of calls.entries()) {
        const res =
          i < REVIEW_MAX_TOOL_CALLS_PER_ROUND
            ? await tools.run({ name: c.name, arguments: c.arguments })
            : { text: TOO_MANY_CALLS, isError: true };
        results.push({ id: c.id, name: c.name, text: res.text, isError: res.isError });
        state.toolBytes += utf8Length(res.text);
      }
      state.messages.push({ role: "assistant", text: r.text, toolCalls: calls });
      state.messages.push({ role: "tool", results });
      state.rounds += 1;
      continue;
    }

    const parsed = parse(r);
    if (parsed.ok) return done(parsed, "invalid_response");
    // 形の違う答え: 「JSON だけ」と 1 回だけ再要求する（道具は使わせない）
    const b = await caller.call({
      system: input.system,
      messages: withoutToolBlocks([
        ...state.messages,
        { role: "assistant", text: r.text },
        { role: "user", blocks: [REVIEW_JSON_ONLY_RETRY] },
      ]),
    });
    return b.ok ? done(parse(b), "invalid_response") : fail(b.code);
  }
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

/**
 * worker_review の結果の分類（docs/specs/worker-review.md「直し切れなかったとき」の表のうち、修正の回が無い行）。
 * レビューが得られたときだけ件数から決める（失敗・予算で飛ばしたときの review_failed / review_skipped_budget は reviewWarnings が出す）。
 * - must_fix が 1 件以上（直さない）: review_must_fix_unaddressed: <件数>
 * - must_fix が 0 件で suggestions がある: review_suggestions: <件数>
 * - どちらも 0 件: なし
 */
export function workerReviewWarnings(s: {
  failure: ReviewFailureCode | undefined;
  mustFixCount: number;
  suggestionCount: number;
}): string[] {
  if (s.failure !== undefined) return [];
  if (s.mustFixCount > 0) return [`review_must_fix_unaddressed: ${s.mustFixCount}`];
  if (s.suggestionCount > 0) return [`review_suggestions: ${s.suggestionCount}`];
  return [];
}

/** 再実行の 1 本が通ったか（終了コード 0・タイムアウトなし・飛ばしていない） */
export function commandPassed(r: ReviewCommandResult): boolean {
  return r.exitCode === 0 && !r.timedOut && r.skipped !== true;
}

/**
 * worker_review の結果の分類のうち、修正の回がある行（docs/specs/worker-review.md「直し切れなかったとき」の表）。
 * verification_commands が通って完了にするときだけ呼ぶ（通らずに試行を使い切ったときは従来どおり FAILED で、ここは通らない）。
 * - 修正の commit が無いまま完了を申告した: review_must_fix_unaddressed: <件数>
 * - 修正した・review_commands の再実行が通った: なし（修正したことは review の fixApplied で分かる）
 * - 修正した・review_commands の再実行が失敗した: 失敗したコマンドごとに review_commands_failed_after_fix: <コマンド>
 */
export function workerReviewFixWarnings(s: {
  mustFixCount: number;
  fixApplied: boolean;
  recheck: readonly ReviewCommandResult[];
}): string[] {
  if (!s.fixApplied) return [`review_must_fix_unaddressed: ${s.mustFixCount}`];
  return s.recheck
    .filter((r) => !commandPassed(r))
    .map((r) => `review_commands_failed_after_fix: ${r.argv.join(" ").slice(0, 200)}`);
}
