import { describe, expect, it } from "vitest";
import { GitHubApiError } from "../../src/github";
import { detectDeps } from "../../src/github/deps";

// D14: base_sha 時点のルート直下の lockfile から、依存関係のキャッシュの指定（TaskSpec.deps）を作る。
// 失敗（GitHub の API のエラーを含む）は例外にせず null（キャッシュなし）。

const BASE = "a".repeat(40);
const TREE = "b".repeat(40);
const B1 = "1".repeat(40);
const B2 = "2".repeat(40);
const B3 = "3".repeat(40);

type Entry = { path: string; mode: string; type: string; sha: string };
const blob = (path: string, sha: string, mode = "100644"): Entry => ({
  path,
  mode,
  type: "blob",
  sha,
});

function fakeApi(opts: {
  entries?: Entry[];
  truncated?: boolean;
  commitError?: Error;
  treeError?: Error;
}) {
  const calls: string[] = [];
  return {
    calls,
    api: {
      async getCommit(sha: string) {
        calls.push(`commit:${sha}`);
        if (opts.commitError) throw opts.commitError;
        return { sha, treeSha: TREE };
      },
      async getTree(sha: string) {
        calls.push(`tree:${sha}`);
        if (opts.treeError) throw opts.treeError;
        return { truncated: opts.truncated ?? false, entries: opts.entries ?? [] };
      },
    },
  };
}

describe("detectDeps", () => {
  it("package-lock.json があれば npm ci。blob SHA と repository_id を載せる", async () => {
    const f = fakeApi({ entries: [blob("package.json", B3), blob("package-lock.json", B1)] });
    expect(await detectDeps(f.api, 4242, BASE)).toEqual({
      repositoryId: 4242,
      lockfilePath: "package-lock.json",
      blobSha: B1,
      installCommand: "npm ci",
    });
    // base_sha のコミット → その tree（ルート直下だけ）の 2 回
    expect(f.calls).toEqual([`commit:${BASE}`, `tree:${TREE}`]);
  });

  it("pnpm-lock.yaml → pnpm install --frozen-lockfile、yarn.lock → yarn install --frozen-lockfile", async () => {
    expect(
      await detectDeps(fakeApi({ entries: [blob("pnpm-lock.yaml", B1)] }).api, 1, BASE),
    ).toMatchObject({
      lockfilePath: "pnpm-lock.yaml",
      installCommand: "pnpm install --frozen-lockfile",
    });
    expect(
      await detectDeps(fakeApi({ entries: [blob("yarn.lock", B2)] }).api, 1, BASE),
    ).toMatchObject({
      lockfilePath: "yarn.lock",
      installCommand: "yarn install --frozen-lockfile",
    });
  });

  it("複数あれば pnpm → npm → yarn の順に優先する", async () => {
    const all = [blob("yarn.lock", B3), blob("package-lock.json", B2), blob("pnpm-lock.yaml", B1)];
    expect(await detectDeps(fakeApi({ entries: all }).api, 1, BASE)).toMatchObject({
      lockfilePath: "pnpm-lock.yaml",
    });
    expect(await detectDeps(fakeApi({ entries: all.slice(0, 2) }).api, 1, BASE)).toMatchObject({
      lockfilePath: "package-lock.json",
    });
  });

  it("lockfile が無ければ null（ルート以外の lockfile は対象外）", async () => {
    expect(
      await detectDeps(fakeApi({ entries: [blob("package.json", B1)] }).api, 1, BASE),
    ).toBeNull();
    expect(
      await detectDeps(
        fakeApi({ entries: [{ path: "apps", mode: "040000", type: "tree", sha: B1 }] }).api,
        1,
        BASE,
      ),
    ).toBeNull();
  });

  it("blob でないもの・シンボリックリンク・SHA の形が不正なものは lockfile として扱わない", async () => {
    const bad = [
      { path: "pnpm-lock.yaml", mode: "040000", type: "tree", sha: B1 },
      blob("package-lock.json", B1, "120000"),
      blob("yarn.lock", "not-a-sha"),
    ];
    expect(await detectDeps(fakeApi({ entries: bad }).api, 1, BASE)).toBeNull();
  });

  it("GitHub の API の失敗は例外にせず null（キャッシュなしで続ける）", async () => {
    const e502 = new GitHubApiError({ status: 502, what: "get commit" });
    expect(await detectDeps(fakeApi({ commitError: e502 }).api, 1, BASE)).toBeNull();
    expect(await detectDeps(fakeApi({ treeError: e502 }).api, 1, BASE)).toBeNull();
    expect(await detectDeps(fakeApi({ treeError: new Error("boom") }).api, 1, BASE)).toBeNull();
  });

  it("repository_id が正の整数でなければ null", async () => {
    const f = fakeApi({ entries: [blob("package-lock.json", B1)] });
    expect(await detectDeps(f.api, 0, BASE)).toBeNull();
    expect(await detectDeps(f.api, Number.NaN, BASE)).toBeNull();
    expect(f.calls).toEqual([]);
  });
});
