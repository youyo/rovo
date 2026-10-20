// 依存関係のキャッシュ（D14。Containers のスナップショット）の、純粋な部分: 入力の検証・導入のコマンドの表・鍵の計算。
// 入出力を伴う処理は deps-cache-do.ts（状態の管理）と sandbox-do.ts（作成と復元）にある。

/** gateway が base_sha 時点のルート直下の lockfile から作って TaskSpec に載せる、依存関係の指定。 */
export interface DepsSpec {
  /** GitHub のリポジトリの数値 ID（名前の変更・移管で鍵が変わらないように） */
  repositoryId: number;
  /** ルート直下の lockfile の名前。v1 はルート直下の 3 種類だけ */
  lockfilePath: string;
  /** base_sha 時点の lockfile の blob SHA（git の blob のハッシュ。中身が同じなら同じ） */
  blobSha: string;
  /** 導入のコマンド（表示用。DEPS_INSTALLS の表にある文字列と一致するものだけ受け付ける） */
  installCommand: string;
}

/**
 * lockfile ごとの導入のコマンド。任意のコマンドは受け付けず、この表にある固定の argv だけを実行する。
 * pnpm / yarn は Dockerfile に入っていないので corepack 経由で呼ぶ（Node 24 のイメージに入っている。
 * 取得先は registry.npmjs.org で、外向き通信の許可に既にある）。
 */
export const DEPS_INSTALLS = {
  "pnpm-lock.yaml": {
    command: "pnpm install --frozen-lockfile",
    argv: ["corepack", "pnpm", "install", "--frozen-lockfile"],
  },
  "package-lock.json": { command: "npm ci", argv: ["npm", "ci"] },
  "yarn.lock": {
    command: "yarn install --frozen-lockfile",
    argv: ["corepack", "yarn", "install", "--frozen-lockfile"],
  },
} as const;

export type DepsLockfile = keyof typeof DEPS_INSTALLS;

/** usage に出す結果。hit: キャッシュから起動 / miss: 使えず今までどおり / built: 作って使った / disabled: 対象外 */
export type DepsCacheStatus = "hit" | "miss" | "built" | "disabled";

/**
 * 「使えなかった」理由の固定コード（ログの deps_cache_miss: <reason>）。値は入力や例外の文面を含まない。
 * 型にしてあるので、足し忘れるとコンパイルが通らない。
 */
export const DEPS_MISS_REASONS = [
  "ensure_failed",
  "ensure_timeout",
  "build_failed",
  "build_timeout",
  "cooldown",
  "snapshot_unsupported",
  "snapshot_failed",
  "restore_failed",
  "cert_missing",
  "move_failed",
  "invalid_deps",
] as const;
export type DepsMissReason = (typeof DEPS_MISS_REASONS)[number];

const BLOB_SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/** 受け取った deps を検証して返す。形が違う・表に無い・ルート以外・組が合わないものは null（キャッシュなし）。 */
export function parseDepsSpec(v: unknown): DepsSpec | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const { repositoryId, lockfilePath, blobSha, installCommand } = o;
  if (
    typeof repositoryId !== "number" ||
    !Number.isSafeInteger(repositoryId) ||
    repositoryId <= 0
  ) {
    return null;
  }
  if (typeof lockfilePath !== "string" || !Object.hasOwn(DEPS_INSTALLS, lockfilePath)) return null;
  if (typeof blobSha !== "string" || !BLOB_SHA.test(blobSha)) return null;
  if (
    typeof installCommand !== "string" ||
    installCommand !== DEPS_INSTALLS[lockfilePath as DepsLockfile].command
  ) {
    return null;
  }
  return { repositoryId, lockfilePath, blobSha, installCommand };
}

/**
 * キャッシュの鍵: sha256(repository_id, lockfile のパス, blob SHA, 導入のコマンド, イメージの参照)。
 * JSON の配列にしてから hash するので、フィールドの境界は曖昧にならない。イメージの参照は digest 付き
 * （container.images.workspace）なので、イメージが変わると別の鍵になる（スナップショットはイメージに結び付く）。
 */
export async function depsCacheKey(deps: DepsSpec, image: string): Promise<string> {
  const input = JSON.stringify([
    "rovo-deps-cache-v1",
    deps.repositoryId,
    deps.lockfilePath,
    deps.blobSha,
    deps.installCommand,
    image,
  ]);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** スナップショットの名前（一覧の API が無いので、人が見分けるための名前。識別は id で行う）。 */
export function depsSnapshotName(key: string): string {
  return `deps-${key.slice(0, 16)}`;
}

/** 依存関係を置く場所。タスクのコンテナでは、clone の後にここから /workspace へ戻す。 */
export const DEPS_CACHE_DIR = "/opt/deps-cache";

/** 作るのに許す時間（ms）。超えたら失敗として扱い、タスクは今までどおり image から起動する。 */
export const DEPS_BUILD_TIMEOUT_MS = 10 * 60_000;
/** 作るのに失敗した鍵を、作り直さずに待つ時間（ms）。 */
export const DEPS_FAILED_COOLDOWN_MS = 60_000;
/** 復元に失敗した（スナップショットが使えなかった）鍵を、作り直さずに待つ時間（ms）。壊れ続けるときに毎回作り直さない */
export const DEPS_RESTORE_FAILED_COOLDOWN_MS = 10 * 60_000;

/** SandboxDO（タスク）→ DepsCacheDO(key).ensure の依頼。 */
export interface DepsEnsureRequest {
  /** depsCacheKey の値（DepsCacheDO の名前と一致すること） */
  key: string;
  deps: DepsSpec;
  /** owner/name */
  repository: string;
  baseSha: string;
  /** 依頼したタスクの作業ブランチ。作成用のコンテナの外向き通信の判定に使う（clone だけを行う） */
  branch: string;
  /** 依頼したタスクの ID。clone の認証（Installation Token の注入）は、このタスクの SandboxDO が持つ資格で行う */
  taskId: string;
}

export type DepsEnsureResult =
  | {
      ok: true;
      snapshotId: string;
      size: number;
      /** この呼び出しが作ったか（待っただけ・既にあったなら false） */
      built: boolean;
      /** 作った場合の所要時間（ms）。Sandbox の時間として呼び出し元が数える */
      buildMs: number;
    }
  | { ok: false; reason: DepsMissReason };

/** DepsCacheDO → 作成用の SandboxDO(deps-<key>).buildDepsSnapshot の依頼。 */
export interface DepsBuildRequest extends DepsEnsureRequest {
  timeoutMs: number;
}

export type DepsBuildResult =
  | { ok: true; snapshotId: string; size: number; buildMs: number }
  | { ok: false; reason: DepsMissReason };
