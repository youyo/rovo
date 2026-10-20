import type { DepsDto } from "../agent/contract";

// 依存関係のキャッシュ（D14）の指定を、base_sha 時点のルート直下の lockfile から作る。
// v1 はルート直下だけ（モノレポの入れ子の lockfile は対象外）。優先順位は pnpm → npm → yarn。
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
  getTree(treeSha: string): Promise<{
    truncated: boolean;
    entries: { path: string; mode: string; type: string; sha: string }[];
  }>;
}

/**
 * ルート直下の lockfile から TaskSpec.deps を作る。lockfile が無ければ null。
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
    const tree = await api.getTree(commit.treeSha);
    for (const lock of LOCKFILES) {
      const entry = tree.entries.find((e) => e.path === lock.path);
      // 通常のファイル（100644 / 100755）の blob だけ。ディレクトリ・シンボリックリンク・サブモジュールは対象外
      if (
        entry &&
        entry.type === "blob" &&
        (entry.mode === "100644" || entry.mode === "100755") &&
        BLOB_SHA.test(entry.sha)
      ) {
        return {
          repositoryId,
          lockfilePath: lock.path,
          blobSha: entry.sha,
          installCommand: lock.command,
        };
      }
    }
    return null;
  } catch {
    return null;
  }
}
