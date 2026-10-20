import type { DepsDto } from "../agent/contract";

// 依存関係のキャッシュ（D14）の指定を、base_sha 時点のルート直下の lockfile から作る。
// lockfile はルート直下だけ（モノレポの入れ子の lockfile は対象外）。優先順位は pnpm → npm → yarn。
// 鍵には lockfile に加えて、ルートの package.json・pnpm-workspace.yaml・入れ子の package.json（workspace の各パッケージ）の
// blob SHA も入れる（同じ lockfile でも scripts が違うブランチの node_modules を共有しないため）。
// 導入のコマンドの表は agent の deps-cache.ts（DEPS_INSTALLS）と同じ。agent は表にあるものだけを受け付ける。

const LOCKFILES = [
  { path: "pnpm-lock.yaml", command: "pnpm install --frozen-lockfile" },
  { path: "package-lock.json", command: "npm ci" },
  { path: "yarn.lock", command: "yarn install --frozen-lockfile" },
] as const;

const BLOB_SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/** detectDeps が使う GitHub API の部分（GitHubRepoApi の一部。テストで差し替える） */
export interface DepsApi {
  getCommit(sha: string): Promise<{ sha: string; treeSha: string }>;
  getTree(
    treeSha: string,
    opts?: { recursive?: boolean },
  ): Promise<{
    truncated: boolean;
    entries: { path: string; mode: string; type: string; sha: string }[];
  }>;
}

/** 通常のファイル（100644 / 100755）の blob だけ。ディレクトリ・シンボリックリンク・サブモジュールは対象外 */
function isRegularBlob(e: { mode: string; type: string; sha: string }): boolean {
  return e.type === "blob" && (e.mode === "100644" || e.mode === "100755") && BLOB_SHA.test(e.sha);
}

async function sha256Hex(text: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * ルート直下の lockfile から TaskSpec.deps を作る。lockfile またはルートの package.json が無ければ null。
 * tree は再帰で読み、切り詰められた（truncated）ときも null（一部の package.json を読めていない鍵は作らない）。
 * 読めなかった（GitHub の API のエラーなど）ときも例外にせず null を返す: キャッシュは最適化なので、
 * 失敗でタスクの開始を止めない。
 */
export async function detectDeps(
  api: DepsApi,
  repositoryId: number,
  baseSha: string,
): Promise<DepsDto | null> {
  if (!Number.isSafeInteger(repositoryId) || repositoryId <= 0) return null;
  try {
    const commit = await api.getCommit(baseSha);
    const tree = await api.getTree(commit.treeSha, { recursive: true });
    if (tree.truncated) return null;
    const rootFile = (name: string) =>
      tree.entries.find((e) => e.path === name && isRegularBlob(e))?.sha ?? null;
    for (const lock of LOCKFILES) {
      const lockSha = rootFile(lock.path);
      if (!lockSha) continue;
      const packageJsonSha = rootFile("package.json");
      if (!packageJsonSha) return null;
      // workspace の各パッケージの package.json（node_modules の中は除く）。パスで並べて、パスと SHA の一覧を hash する
      const nested = tree.entries
        .filter(
          (e) =>
            isRegularBlob(e) &&
            e.path.endsWith("/package.json") &&
            !e.path.split("/").includes("node_modules"),
        )
        .map((e) => [e.path, e.sha] as const)
        .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
      return {
        repositoryId,
        lockfilePath: lock.path,
        blobSha: lockSha,
        installCommand: lock.command,
        packageJsonSha,
        workspaceSha: rootFile("pnpm-workspace.yaml"),
        manifestsSha: nested.length > 0 ? await sha256Hex(JSON.stringify(nested)) : null,
      };
    }
    return null;
  } catch {
    return null;
  }
}
