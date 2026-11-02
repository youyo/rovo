import { describe, expect, it } from "vitest";
import { DEPS_BUILD_TIMEOUT_MS } from "../../src/deps-cache";
import { DEPS_LANG_TOTAL_MS } from "../../src/deps-lang";
import {
  BOOT_ATTEMPT_MS,
  BOOT_DESTROY_MS,
  BOOT_MAX_ATTEMPTS,
  CLONE_TIMEOUT_MS,
  DEPS_ENSURE_WAIT_MS,
  DEPS_RESTORE_TIMEOUT_MS,
  ENSURE_READY_TIMEOUT_MS,
  PM_PREPARE_TIMEOUT_MS,
  SANDBOX_SETUP_WORST_MS,
  SETUP_BOOT_WORST_MS,
  SETUP_WORKSPACE_WORST_MS,
} from "../../src/setup-budget";

// AgentDO の ensureReady の待ち（ENSURE_READY_TIMEOUT_MS）は、SandboxDO.boot の最悪の合計を必ず上回る。
// 下回ると、まだ進んでいる起動を時間切れにして MAX_SETUP_ATTEMPTS（3 回）に数えてしまう。
describe("setup-budget: ensureReady の待ちと起動の最悪の合計", () => {
  it("合計は、依存キャッシュの待ち・起動・clone・Node の依存の復元・言語の依存・パッケージマネージャの用意の和", () => {
    expect(SANDBOX_SETUP_WORST_MS).toBe(
      DEPS_ENSURE_WAIT_MS +
        SETUP_BOOT_WORST_MS +
        SETUP_WORKSPACE_WORST_MS +
        DEPS_RESTORE_TIMEOUT_MS +
        DEPS_LANG_TOTAL_MS +
        PM_PREPARE_TIMEOUT_MS,
    );
  });

  it("ENSURE_READY_TIMEOUT_MS は合計を上回る", () => {
    expect(ENSURE_READY_TIMEOUT_MS).toBeGreaterThan(SANDBOX_SETUP_WORST_MS);
  });

  it("部品の下限: 起動は試行 x (待ち + 破棄)、clone は少なくとも 1 回分、言語の導入は 2 言語分の上限以下", () => {
    expect(SETUP_BOOT_WORST_MS).toBeGreaterThanOrEqual(
      BOOT_MAX_ATTEMPTS * (BOOT_ATTEMPT_MS + BOOT_DESTROY_MS),
    );
    expect(SETUP_WORKSPACE_WORST_MS).toBeGreaterThanOrEqual(CLONE_TIMEOUT_MS);
    expect(DEPS_ENSURE_WAIT_MS).toBeGreaterThan(DEPS_BUILD_TIMEOUT_MS);
  });

  it("言語の依存の枠は、Python と Go を別々に 5 分ずつ（10 分）取るより短い", () => {
    expect(DEPS_LANG_TOTAL_MS).toBeLessThan(10 * 60_000);
  });
});
