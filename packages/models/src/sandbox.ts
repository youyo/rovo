/**
 * Sandbox コンテナの大きさと単価（D13）。依存のない純粋なファイルにしてある（scripts/deploy-config-lib.mjs が
 * Node の型除去でそのまま読む。enum・namespace など型除去で消せない構文は使わない）。
 */
/**
 * Cloudflare Containers の名前付きインスタンス（https://developers.cloudflare.com/containers/platform/pricing/ 、
 * scheduling_policy=durable_object では `ctx.container.start({ instance })` で指定する）。
 * rovo が受け付けるのはこの 5 種類だけ（カスタムの {vcpu, memoryMib, diskMb} は扱わない）。
 */
export const SANDBOX_INSTANCES = {
  lite: { vcpu: 1 / 16, memoryGiB: 0.25, diskGB: 2 },
  "standard-1": { vcpu: 1 / 2, memoryGiB: 4, diskGB: 8 },
  "standard-2": { vcpu: 1, memoryGiB: 6, diskGB: 12 },
  "standard-3": { vcpu: 2, memoryGiB: 8, diskGB: 16 },
  "standard-4": { vcpu: 4, memoryGiB: 12, diskGB: 20 },
} as const;

export type SandboxInstance = keyof typeof SANDBOX_INSTANCES;

/** 既定は standard-2（1 vCPU、6 GiB、12 GB）。lite（256 MiB）では npm ci / npm test が遅く、メモリ不足で落ちた。 */
export const DEFAULT_SANDBOX_INSTANCE: SandboxInstance = "standard-2";

export function sandboxInstanceSpec(instance: SandboxInstance): {
  vcpu: number;
  memoryGiB: number;
  diskGB: number;
} {
  return { ...SANDBOX_INSTANCES[instance] };
}

/**
 * env SANDBOX_INSTANCE を解く。未設定・空は既定。名前付きの 5 種類以外は既定に戻して、受け付けなかった値を ignored に返す
 * （起動はエラーにしない。MODEL_EFFORTS と同じ流儀。呼び出し側がログに出す。デプロイ設定の生成器は不正な値をエラーにする）。
 */
export function resolveSandboxInstance(raw: string | undefined): {
  instance: SandboxInstance;
  ignored?: string;
} {
  const v = (raw ?? "").trim();
  if (v === "") return { instance: DEFAULT_SANDBOX_INSTANCE };
  if (Object.hasOwn(SANDBOX_INSTANCES, v)) return { instance: v as SandboxInstance };
  return { instance: DEFAULT_SANDBOX_INSTANCE, ignored: v };
}

/**
 * Containers の単価（USD。2026-10-05 時点。料金改定のときはここだけ直す）。CPU は稼働分 / vCPU 秒、メモリは GiB 秒、ディスクは GB 秒。
 */
export const SANDBOX_PRICE = {
  cpuPerVcpuSec: 0.00002,
  memoryPerGiBSec: 0.0000025,
  diskPerGBSec: 0.00000007,
} as const;

/**
 * インスタンスの 1 時間あたりの推定費用（USD）。CPU を 100% 稼働とみなした上限側で、月の無料枠は差し引かない。
 * 少なく数えないよう、小数 4 桁に切り上げる。
 */
export function sandboxUsdPerHour(instance: SandboxInstance): number {
  const s = SANDBOX_INSTANCES[instance];
  const exact =
    3600 *
    (s.vcpu * SANDBOX_PRICE.cpuPerVcpuSec +
      s.memoryGiB * SANDBOX_PRICE.memoryPerGiBSec +
      s.diskGB * SANDBOX_PRICE.diskPerGBSec);
  return Math.ceil(exact * 10_000 - 1e-6) / 10_000;
}
