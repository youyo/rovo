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

/**
 * task_start の sandbox_instance に指定できる大きさ（lite を除く）。lite（256 MiB）は npm ci / npm test がメモリ不足で落ちた実績があり、
 * タスクが選べないようにする（env の既定としては従来どおり書ける）。gateway の入力の検証と sandbox_instances_list の selectable が、ここから導く。
 */
export const SELECTABLE_SANDBOX_INSTANCES = [
  "standard-1",
  "standard-2",
  "standard-3",
  "standard-4",
] as const satisfies readonly SandboxInstance[];

export type SelectableSandboxInstance = (typeof SELECTABLE_SANDBOX_INSTANCES)[number];

export function isSelectableSandboxInstance(v: unknown): v is SelectableSandboxInstance {
  return (SELECTABLE_SANDBOX_INSTANCES as readonly unknown[]).includes(v);
}

/** 選べる大きさのうち、max（含む）までの名前を小さい順に返す。上限より大きい名前は含めない（ワーカーに見せる説明の組み立て用） */
export function selectableSandboxInstancesUpTo(max: SandboxInstance): SelectableSandboxInstance[] {
  return SELECTABLE_SANDBOX_INSTANCES.filter(
    (name) => SANDBOX_INSTANCES[name].vcpu <= SANDBOX_INSTANCES[max].vcpu,
  );
}

/**
 * Clef による昇格の上限の既定（standard-4）。Sandbox は小さく始めて、コマンドの前に Clef（Workers AI の決定モデル）が
 * 「この大きさで足りるか」を判断し、足りなければ上限まで（2 → 3 → 4 と何回でも）上げる。上げるだけで、下げない。
 * 運用者が上限を決める（env SANDBOX_MAX_INSTANCE）。
 *
 * standard-4 が速くなるかは負荷の並列の仕方による。本番のベンチマーク（2026-10-22）で、CPU だけの並列処理は standard-3 で 2.0 倍、
 * standard-4 で 3.5〜3.9 倍速くなった。一方、1 つの workerd を共有する gateway の vitest は standard-3 で 1.42 倍、standard-4 でも
 * 1.48 倍で頭打ちだった。以前ここに書いていた「4 vCPU にしても速くならない」は、この vitest 固有の結果で、一般には当てはまらない。
 * 並列の手がかり（ワーカー数など）を見て 3 と 4 を選ぶのは Clef の仕事で、CPU は使った分だけ課金されるので、4 に上げ損ねる損は小さい。
 */
export const DEFAULT_MAX_SANDBOX_INSTANCE: SelectableSandboxInstance = "standard-4";

/**
 * env SANDBOX_MAX_INSTANCE を解く。未設定・空・off / none は無効（instance: null。Clef による昇格をしない）。
 * タスクが選べる 4 種類（lite を除く）だけ有効で、それ以外は無効にして、受け付けなかった値を ignored に返す
 * （起動はエラーにしない。デプロイ設定の生成器は不正な値をエラーにする）。
 */
export function resolveMaxSandboxInstance(raw: string | undefined): {
  instance: SelectableSandboxInstance | null;
  ignored?: string;
} {
  const v = (raw ?? "").trim();
  const lower = v.toLowerCase();
  if (v === "" || lower === "off" || lower === "none") return { instance: null };
  if (isSelectableSandboxInstance(v)) return { instance: v };
  return { instance: null, ignored: v };
}

/**
 * 昇格の引き金（usage.sandbox_promotions[].trigger。固定の値）。
 * - clef: コマンドの前に Clef（Workers AI の決定モデル）が上げると判断した
 * - agent / rule / verification: 古いタスクの記録を読むために残す（ワーカーの sandbox_scale_up・重いコマンドの規則・検証コマンドの heavy。今は使わない。
 *   rule のときの一致した表の名前（rule_match）も、古い記録としてだけ gateway が読む）
 */
export const SANDBOX_PROMOTION_TRIGGERS = ["agent", "rule", "verification", "clef"] as const;
export type SandboxPromotionTrigger = (typeof SANDBOX_PROMOTION_TRIGGERS)[number];

export function isSandboxPromotionTrigger(v: unknown): v is SandboxPromotionTrigger {
  return (SANDBOX_PROMOTION_TRIGGERS as readonly unknown[]).includes(v);
}

/**
 * Sandbox の昇格を見送った・失敗した理由の固定コード（usage.sandbox_promotion_reason。任意の文字列・例外の文面は公開しない）。
 * - fixed_instance: task_start で sandbox_instance を明示した（そのタスクの間は固定）
 * - already_large: 古いタスクの記録を読むために残す（起動した大きさがすでに昇格先以上。今は、上限に達していれば Clef を呼ばないので付かない）
 * - state_unreadable: 作業ツリーの状態を読めなかった（昇格前後の比較ができない）
 * - snapshot_unsupported: スナップショットに対応しないランタイム（snapshotContainer が無い）
 * - snapshot_failed: スナップショットの取得に失敗・時間切れ
 * - start_failed: 昇格先の起動に失敗した（同じスナップショットから元の大きさで起動し直した）
 * - cert_missing: 昇格先で HTTPS 傍受の CA 証明書が読めなかった（同上）
 * - workspace_mismatch: 昇格先で作業ツリー（HEAD・未 commit の変更）が元と違った（同上）
 * - fallback_failed: 元の大きさでの起動し直しにも失敗した（image からの再起動 = 作業ツリーの作り直しに乗せる）
 */
export const SANDBOX_PROMOTION_REASONS = [
  "fixed_instance",
  "already_large",
  "state_unreadable",
  "snapshot_unsupported",
  "snapshot_failed",
  "start_failed",
  "cert_missing",
  "workspace_mismatch",
  "fallback_failed",
] as const;

export type SandboxPromotionReason = (typeof SANDBOX_PROMOTION_REASONS)[number];

export function isSandboxPromotionReason(v: unknown): v is SandboxPromotionReason {
  return (SANDBOX_PROMOTION_REASONS as readonly unknown[]).includes(v);
}

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

/** sandbox_instances_list の 1 件。値は上の表と sandboxUsdPerHour から作る（数値を二重に持たない）。 */
export type SandboxInstanceInfo = {
  name: SandboxInstance;
  vcpu: number;
  memory_gib: number;
  disk_gb: number;
  usd_per_hour: number;
  /** task_start で sandbox_instance を省略したときの大きさ */
  default: boolean;
  /** task_start の sandbox_instance に指定できるか（lite は false） */
  selectable: boolean;
  /** Clef が自動で上げる上限か（コマンドの前に「足りない」と判断すると、ここまで 2 → 3 → 4 と上がる。無効にしているデプロイでは、どれも false） */
  auto_scale_max: boolean;
};

export function listSandboxInstances(
  defaultInstance: SandboxInstance = DEFAULT_SANDBOX_INSTANCE,
  maxInstance: SandboxInstance | null = DEFAULT_MAX_SANDBOX_INSTANCE,
): SandboxInstanceInfo[] {
  return (Object.keys(SANDBOX_INSTANCES) as SandboxInstance[]).map((name) => {
    const s = sandboxInstanceSpec(name);
    return {
      name,
      vcpu: s.vcpu,
      memory_gib: s.memoryGiB,
      disk_gb: s.diskGB,
      usd_per_hour: sandboxUsdPerHour(name),
      default: name === defaultInstance,
      selectable: isSelectableSandboxInstance(name),
      auto_scale_max: name === maxInstance,
    };
  });
}
