import {
  resolveHeavySandboxInstance,
  resolveSandboxInstance,
  SANDBOX_INSTANCES,
  type SandboxInstance,
} from "@rovo/models";

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

/**
 * 重いコマンド（テスト・ビルドなど）の初回に、Sandbox が自動で昇格する先（env の SANDBOX_HEAVY_INSTANCE。agent と同じ値をデプロイの設定が両方へ入れる）。
 * 未設定・空・off / none・不正な値は null（昇格しない。sandbox_instances_list に promotion_target を付けない）。agent と同じ resolveHeavySandboxInstance で解く。
 */
export function heavySandboxInstanceOf(env: {
  SANDBOX_HEAVY_INSTANCE?: string;
}): SandboxInstance | null {
  return resolveHeavySandboxInstance(env.SANDBOX_HEAVY_INSTANCE).instance;
}
