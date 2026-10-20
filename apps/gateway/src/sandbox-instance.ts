import { resolveSandboxInstance, SANDBOX_INSTANCES, type SandboxInstance } from "@rovo/models";

/**
 * agent が報告した Sandbox の大きさ（usage の instance）を、packages/models の表にある名前に絞る。
 * 表に無い・文字列でない値は undefined（任意の文字列を公開・保存しない。単価の計算にも使わない）。
 */
export function sandboxInstanceName(v: unknown): SandboxInstance | undefined {
  return typeof v === "string" && Object.hasOwn(SANDBOX_INSTANCES, v)
    ? (v as SandboxInstance)
    : undefined;
}

/**
 * このデプロイの既定の大きさ（env の SANDBOX_INSTANCE。agent と同じ値をデプロイの設定が両方へ入れる）。
 * 未設定・不正な値は既定（standard-2）。agent と同じ resolveSandboxInstance で解く。
 */
export function defaultSandboxInstanceOf(env: { SANDBOX_INSTANCE?: string }): SandboxInstance {
  return resolveSandboxInstance(env.SANDBOX_INSTANCE).instance;
}
