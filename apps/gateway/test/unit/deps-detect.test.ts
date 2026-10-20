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
const P = "9".repeat(40);
const W = "8".repeat(40);
const pkg = () => blob("package.json", P);

const sha256Hex = async (text: string) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

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
  const options: unknown[] = [];
  return {
    calls,
    options,
    api: {
      async getCommit(sha: string) {
        calls.push(`commit:${sha}`);
        if (opts.commitError) throw opts.commitError;
        return { sha, treeSha: TREE };
      },
      async getTree(sha: string, opt?: { recursive?: boolean }) {
        calls.push(`tree:${sha}`);
        options.push(opt);
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
      packageJsonSha: B3,
      workspaceSha: null,
      manifestsSha: null,
    });
    // base_sha のコミット → その tree（再帰。入れ子の package.json の SHA も読む）の 2 回
    expect(f.calls).toEqual([`commit:${BASE}`, `tree:${TREE}`]);
    expect(f.options).toEqual([{ recursive: true, signal: expect.any(AbortSignal) }]);
  });

  it("pnpm-lock.yaml → pnpm install --frozen-lockfile、yarn.lock → yarn install --frozen-lockfile", async () => {
    expect(
      await detectDeps(fakeApi({ entries: [pkg(), blob("pnpm-lock.yaml", B1)] }).api, 1, BASE),
    ).toMatchObject({
      lockfilePath: "pnpm-lock.yaml",
      installCommand: "pnpm install --frozen-lockfile",
    });
    expect(
      await detectDeps(fakeApi({ entries: [pkg(), blob("yarn.lock", B2)] }).api, 1, BASE),
    ).toMatchObject({
      lockfilePath: "yarn.lock",
      installCommand: "yarn install --frozen-lockfile",
    });
  });

  it("複数あれば pnpm → npm → yarn の順に優先する", async () => {
    const all = [
      pkg(),
      blob("yarn.lock", B3),
      blob("package-lock.json", B2),
      blob("pnpm-lock.yaml", B1),
    ];
    expect(await detectDeps(fakeApi({ entries: all }).api, 1, BASE)).toMatchObject({
      lockfilePath: "pnpm-lock.yaml",
    });
    expect(
      await detectDeps(fakeApi({ entries: [all[0] as Entry, all[2] as Entry] }).api, 1, BASE),
    ).toMatchObject({
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
    const f = fakeApi({ entries: [pkg(), blob("package-lock.json", B1)] });
    expect(await detectDeps(f.api, 0, BASE)).toBeNull();
    expect(await detectDeps(f.api, Number.NaN, BASE)).toBeNull();
    expect(f.calls).toEqual([]);
  });

  it("ルートの package.json が無ければ null（鍵を作れない）", async () => {
    expect(
      await detectDeps(fakeApi({ entries: [blob("package-lock.json", B1)] }).api, 1, BASE),
    ).toBeNull();
  });

  it("pnpm-workspace.yaml があればその blob SHA を workspaceSha に載せる", async () => {
    const d = await detectDeps(
      fakeApi({ entries: [pkg(), blob("pnpm-lock.yaml", B1), blob("pnpm-workspace.yaml", W)] }).api,
      1,
      BASE,
    );
    expect(d).toMatchObject({ packageJsonSha: P, workspaceSha: W, manifestsSha: null });
  });

  it("入れ子の package.json（workspace の各パッケージ）は path と SHA の一覧の sha256 を manifestsSha に載せる。順序に依らず、node_modules の中は含めない", async () => {
    const a = blob("packages/a/package.json", B2);
    const b = blob("apps/web/package.json", B3);
    const nm = blob("node_modules/x/package.json", B1);
    const base = [pkg(), blob("pnpm-lock.yaml", B1)];
    const expected = await sha256Hex(
      JSON.stringify([
        ["apps/web/package.json", B3],
        ["packages/a/package.json", B2],
      ]),
    );
    const d1 = await detectDeps(fakeApi({ entries: [...base, a, b, nm] }).api, 1, BASE);
    const d2 = await detectDeps(fakeApi({ entries: [...base, nm, b, a] }).api, 1, BASE);
    expect(d1?.manifestsSha).toBe(expected);
    expect(d2?.manifestsSha).toBe(expected);
    // 入れ子の package.json が 1 つ変わると別の値
    const changed = await detectDeps(
      fakeApi({ entries: [...base, blob("packages/a/package.json", B1), b] }).api,
      1,
      BASE,
    );
    expect(changed?.manifestsSha).not.toBe(expected);
    // package.json 以外の入れ子のファイルは見ない
    const other = await detectDeps(
      fakeApi({ entries: [...base, a, b, blob("packages/a/README.md", B1)] }).api,
      1,
      BASE,
    );
    expect(other?.manifestsSha).toBe(expected);
  });

  it("tree の取得が期限内に終わらなければ null（キャッシュなしで続ける）。signal も渡す", async () => {
    let signal: AbortSignal | undefined;
    const api = {
      async getCommit(sha: string) {
        return { sha, treeSha: TREE };
      },
      getTree(_sha: string, opt?: { recursive?: boolean; signal?: AbortSignal }) {
        signal = opt?.signal;
        return new Promise<never>(() => {});
      },
    };
    expect(await detectDeps(api, 1, BASE, 30)).toBeNull();
    expect(signal).toBeDefined();
  });

  it("tree が切り詰められた（truncated）ら null（一部の package.json を読めていない鍵は作らない）", async () => {
    const f = fakeApi({ entries: [pkg(), blob("package-lock.json", B1)], truncated: true });
    expect(await detectDeps(f.api, 1, BASE)).toBeNull();
  });
});
