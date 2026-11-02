// Sandbox の起動（SandboxDO.boot）にかかる時間の上限と、AgentDO が ensureReady を待つ上限の関係。
// ENSURE_READY_TIMEOUT_MS は、起動の各段の最悪の合計を必ず上回る値にする（下回ると、まだ進んでいる起動を
// 時間切れにして MAX_SETUP_ATTEMPTS に数えてしまう）。関係は test/unit/setup-budget.test.ts が固定する。
import { DEPS_BUILD_TIMEOUT_MS } from "./deps-cache";
import { DEPS_LANG_TOTAL_MS } from "./deps-lang";

/** 1 回の git 操作（clone / fetch）の上限 */
export const CLONE_TIMEOUT_MS = 5 * 60_000;
/** git の clone / fetch 以外の 1 操作（find・checkout・rev-parse など）の上限 */
export const GIT_STEP_TIMEOUT_MS = 60_000;
/** pnpm / yarn の本体を用意する上限 */
export const PM_PREPARE_TIMEOUT_MS = 3 * 60_000;
/**
 * コンテナが ready になる（exec が応答する）までの 1 回あたりの期限。
 * 正常な起動は E2E の実測で ensureReady 全体が 0.9 秒前後（最大 0.92 秒、clone を含む）。その約 25 倍を見る。
 * 止まった起動は何分待っても進まないので、これを超えたら破棄して起動し直す。
 * 待ちは試行ごとに数える（前の試行の破棄にかかった時間で、次の試行の待ちを削らない）。
 */
export const BOOT_ATTEMPT_MS = 25_000;
export const BOOT_MAX_ATTEMPTS = 3;
/** setInactivityTimeout の呼び出し 1 回を待つ上限（ms）。返らなくても起動は進める（警告だけ） */
export const INACTIVITY_CALL_MS = BOOT_ATTEMPT_MS;
/**
 * 起動の途中で行う破棄の待ちの上限（1 回あたり）。通常の DESTROY_WAIT_MS（15 秒）より短くする。
 * 破棄が上限内に止まらなければ、そこで "container did not stop" として失敗する（残りの試行は行わない）。
 */
export const BOOT_DESTROY_MS = 10_000;
/** 起動の確認の exec（CA 証明書の確認・baseline の記録）1 回の上限 */
export const BOOT_CHECK_EXEC_MS = 10_000;

/**
 * 依存関係のキャッシュの ensure（作成を待つことがある）を待つ上限。作成の時間切れ + 余裕。
 * 作成の時間切れ DEPS_BUILD_TIMEOUT_MS の定義は apps/agent/src/deps-cache.ts にある。
 */
export const DEPS_ENSURE_WAIT_MS = DEPS_BUILD_TIMEOUT_MS + 60_000;
/** 退避した node_modules を作業ツリーへ戻す（同じファイルシステム内の mv）のに許す時間 */
export const DEPS_RESTORE_TIMEOUT_MS = 2 * 60_000;

/**
 * 起動（コンテナの start から ready まで）の最悪。復元の失敗で試行が 1 回増える（+1）。
 * 最初の破棄 + 各試行（setInactivityTimeout の待ち + ready の待ち + 破棄）+ CA 証明書の確認 + baseline の記録。
 */
export const SETUP_BOOT_WORST_MS =
  BOOT_DESTROY_MS +
  (BOOT_MAX_ATTEMPTS + 1) * (INACTIVITY_CALL_MS + BOOT_ATTEMPT_MS + BOOT_DESTROY_MS) +
  2 * BOOT_CHECK_EXEC_MS;
/**
 * 作業ツリーの用意（prepareWorkspace）の最悪。PR の head の取り出し（task_review）が一番長い:
 * 削除 + clone + fetch x 2（+1 回は SHA の直接取得）+ その他の git 操作（checkout・rev-parse など）6 回。
 */
export const SETUP_WORKSPACE_WORST_MS =
  GIT_STEP_TIMEOUT_MS + 3 * CLONE_TIMEOUT_MS + 6 * GIT_STEP_TIMEOUT_MS;

/** 起動の最悪の合計（上の各段は直列に走る。exec 1 回ごとの余裕は ENSURE_READY_MARGIN_MS に含める） */
export const SANDBOX_SETUP_WORST_MS =
  DEPS_ENSURE_WAIT_MS +
  SETUP_BOOT_WORST_MS +
  SETUP_WORKSPACE_WORST_MS +
  DEPS_RESTORE_TIMEOUT_MS +
  DEPS_LANG_TOTAL_MS +
  PM_PREPARE_TIMEOUT_MS;
/** exec の開始の待ち（EXEC_START_GRACE_MS）やストリームの後始末など、段ごとの小さな余裕の合計 */
export const ENSURE_READY_MARGIN_MS = 2 * 60_000;
/**
 * AgentDO が SandboxDO.ensureReady の RPC 1 回を待つ上限。起動の最悪の合計 + 余裕。
 * 返ってこない RPC は失敗として MAX_SETUP_ATTEMPTS に数える。
 * 注意: SandboxDO の RPC そのものが止まった（AgentDO の待ちのタイマーも DO の退避などで効かない）ときの実際の上限は、
 * ENSURE_READY_TIMEOUT_MS × MAX_SETUP_ATTEMPTS ではなく、タスクの期限（deadlineAt。最大 2 時間）になる。
 */
export const ENSURE_READY_TIMEOUT_MS = SANDBOX_SETUP_WORST_MS + ENSURE_READY_MARGIN_MS;
