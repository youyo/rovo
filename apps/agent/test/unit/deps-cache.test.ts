import { describe, expect, it } from "vitest";
import { DEPS_INSTALLS, depsCacheKey, depsSnapshotName, parseDepsSpec } from "../../src/deps-cache";

const SHA = "a".repeat(40);
const base = {
  repositoryId: 4242,
  lockfilePath: "package-lock.json",
  blobSha: SHA,
  installCommand: "npm ci",
  packageJsonSha: "d".repeat(40),
  workspaceSha: null,
  manifestsSha: null,
};
const IMAGE =
  "registry.cloudflare.com/acct/rovo-agent-sandboxdo-workspace@sha256:" + "b".repeat(64);

describe("parseDepsSpec", () => {
  it("lockfile のルート直下の 3 種類と、表どおりの導入コマンドだけを受け付ける", () => {
    expect(parseDepsSpec(base)).toEqual(base);
    expect(
      parseDepsSpec({
        ...base,
        lockfilePath: "pnpm-lock.yaml",
        installCommand: "pnpm install --frozen-lockfile",
      }),
    ).toMatchObject({ lockfilePath: "pnpm-lock.yaml" });
    expect(
      parseDepsSpec({
        ...base,
        lockfilePath: "yarn.lock",
        installCommand: "yarn install --frozen-lockfile",
      }),
    ).toMatchObject({ lockfilePath: "yarn.lock" });
  });

  it("packageJsonSha は必須。workspaceSha / manifestsSha は省略か null か SHA。形が違えば null", () => {
    const { packageJsonSha: _omit, ...noPkg } = base;
    expect(parseDepsSpec(noPkg)).toBeNull();
    expect(parseDepsSpec({ ...base, packageJsonSha: "zz" })).toBeNull();
    // 省略は null として扱う
    const { workspaceSha: _w, manifestsSha: _m, ...minimal } = base;
    expect(parseDepsSpec(minimal)).toEqual(base);
    const full = { ...base, workspaceSha: "e".repeat(40), manifestsSha: "f".repeat(64) };
    expect(parseDepsSpec(full)).toEqual(full);
    expect(parseDepsSpec({ ...base, workspaceSha: "zz" })).toBeNull();
    expect(parseDepsSpec({ ...base, manifestsSha: 1 })).toBeNull();
  });

  it("null / 未指定 / 形が違うものは null（キャッシュなし）", () => {
    expect(parseDepsSpec(null)).toBeNull();
    expect(parseDepsSpec(undefined)).toBeNull();
    expect(parseDepsSpec("x")).toBeNull();
    expect(parseDepsSpec({ ...base, blobSha: "zz" })).toBeNull();
    expect(parseDepsSpec({ ...base, repositoryId: "1" })).toBeNull();
    expect(parseDepsSpec({ ...base, repositoryId: 0 })).toBeNull();
  });

  it("ルート以外のパスと、表に無い導入コマンド（任意のコマンド）は受け付けない", () => {
    expect(parseDepsSpec({ ...base, lockfilePath: "sub/package-lock.json" })).toBeNull();
    expect(parseDepsSpec({ ...base, lockfilePath: "../package-lock.json" })).toBeNull();
    expect(parseDepsSpec({ ...base, installCommand: "npm ci && curl evil" })).toBeNull();
    // lockfile と導入コマンドの組が合わない
    expect(parseDepsSpec({ ...base, installCommand: "pnpm install --frozen-lockfile" })).toBeNull();
  });

  it("導入の argv は表に固定されている", () => {
    expect(DEPS_INSTALLS["package-lock.json"].argv).toEqual(["npm", "ci"]);
    expect(DEPS_INSTALLS["pnpm-lock.yaml"].argv).toEqual([
      "corepack",
      "pnpm",
      "install",
      "--frozen-lockfile",
    ]);
  });
});

describe("depsCacheKey", () => {
  it("同じ入力なら同じ 64 桁の 16 進数", async () => {
    const a = await depsCacheKey(base, IMAGE);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await depsCacheKey({ ...base }, IMAGE)).toBe(a);
  });

  it("鍵の版は v2。入力は repository_id・lockfile・blob SHA・導入のコマンド・package.json・pnpm-workspace.yaml・入れ子の package.json・イメージの順", async () => {
    const input = JSON.stringify([
      "rovo-deps-cache-v2",
      base.repositoryId,
      base.lockfilePath,
      base.blobSha,
      base.installCommand,
      base.packageJsonSha,
      base.workspaceSha,
      base.manifestsSha,
      IMAGE,
    ]);
    const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
    const expected = [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
    expect(await depsCacheKey(base, IMAGE)).toBe(expected);
  });

  it("package.json・pnpm-workspace.yaml・入れ子の package.json の SHA が変わると別の鍵（postinstall を差し替えたブランチと共有しない）", async () => {
    const k = await depsCacheKey(base, IMAGE);
    const others = await Promise.all([
      depsCacheKey({ ...base, packageJsonSha: "1".repeat(40) }, IMAGE),
      depsCacheKey({ ...base, workspaceSha: "2".repeat(40) }, IMAGE),
      depsCacheKey({ ...base, manifestsSha: "3".repeat(64) }, IMAGE),
    ]);
    for (const o of others) expect(o).not.toBe(k);
    expect(new Set(others).size).toBe(others.length);
  });

  it("repository_id・lockfile のパス・blob SHA・導入のコマンド・イメージのどれが変わっても別の鍵", async () => {
    const k = await depsCacheKey(base, IMAGE);
    const others = await Promise.all([
      depsCacheKey({ ...base, repositoryId: 4243 }, IMAGE),
      depsCacheKey(
        { ...base, lockfilePath: "yarn.lock", installCommand: "yarn install --frozen-lockfile" },
        IMAGE,
      ),
      depsCacheKey({ ...base, blobSha: "c".repeat(40) }, IMAGE),
      depsCacheKey({ ...base, installCommand: "npm ci --ignore-scripts" }, IMAGE),
      depsCacheKey(base, `${IMAGE}x`),
    ]);
    for (const o of others) expect(o).not.toBe(k);
    expect(new Set(others).size).toBe(others.length);
  });

  it("区切りの曖昧さで衝突しない（フィールドの境界をずらしても別の鍵）", async () => {
    const a = await depsCacheKey({ ...base, installCommand: "npm ci" }, "x y");
    const b = await depsCacheKey({ ...base, installCommand: "npm ci x" }, "y");
    expect(a).not.toBe(b);
  });
});

describe("depsSnapshotName", () => {
  it("deps- + 鍵の先頭 16 桁", () => {
    expect(depsSnapshotName("0123456789abcdef".repeat(4))).toBe("deps-0123456789abcdef");
  });
});
