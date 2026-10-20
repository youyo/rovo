import { describe, expect, it } from "vitest";
import { GitHubRepoApi } from "../../../src/github";
import { json, routerFetch } from "./helpers";

const SHA = "a".repeat(40);
const TREE = "b".repeat(40);
const BLOB = "c".repeat(40);

function api(routes: Parameters<typeof routerFetch>[0]) {
  const r = routerFetch(routes);
  const a = new GitHubRepoApi({
    token: "ghs_tok",
    repository: "acme/widgets",
    apiBase: "https://api.github.test",
    fetch: r.fetch,
  });
  return { a, ...r };
}

describe("GitHubRepoApi.getTree（D14: ルート直下の lockfile の blob SHA を読む）", () => {
  it("tree の直下の項目（path・mode・type・sha）と truncated を返す", async () => {
    const { a, calls } = api({
      [`GET /repos/acme/widgets/git/trees/${TREE}`]: () =>
        json({
          sha: TREE,
          truncated: false,
          tree: [
            { path: "package-lock.json", mode: "100644", type: "blob", sha: BLOB, size: 10 },
            { path: "src", mode: "040000", type: "tree", sha: SHA },
          ],
        }),
    });
    expect(await a.getTree(TREE)).toEqual({
      truncated: false,
      entries: [
        { path: "package-lock.json", mode: "100644", type: "blob", sha: BLOB },
        { path: "src", mode: "040000", type: "tree", sha: SHA },
      ],
    });
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer ghs_tok");
    // ルート直下だけ（recursive は付けない）
    expect(new URL(calls[0]?.url ?? "").search).toBe("");
  });

  it("recursive: true なら ?recursive=1 を付ける", async () => {
    const { a, calls } = api({
      [`GET /repos/acme/widgets/git/trees/${TREE}`]: () =>
        json({
          truncated: true,
          tree: [{ path: "packages/a/package.json", mode: "100644", type: "blob", sha: BLOB }],
        }),
    });
    const r = await a.getTree(TREE, { recursive: true });
    expect(r.truncated).toBe(true);
    expect(r.entries[0]?.path).toBe("packages/a/package.json");
    expect(new URL(calls[0]?.url ?? "").search).toBe("?recursive=1");
  });

  it("signal を渡すと fetch に伝わる（既定では付けない）", async () => {
    const { a, calls } = api({
      [`GET /repos/acme/widgets/git/trees/${TREE}`]: [
        () => json({ tree: [] }),
        () => json({ tree: [] }),
      ],
    });
    await a.getTree(TREE);
    const ctl = new AbortController();
    ctl.abort();
    await a.getTree(TREE, { signal: ctl.signal });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.signal.aborted).toBe(false);
    expect(calls[1]?.signal.aborted).toBe(true);
  });

  it("形が違う項目は読み飛ばす。tree が配列でなければ unexpected response", async () => {
    const { a } = api({
      [`GET /repos/acme/widgets/git/trees/${TREE}`]: [
        () =>
          json({
            tree: [{ path: 1 }, null, { path: "x", mode: "100644", type: "blob", sha: BLOB }],
          }),
        () => json({ tree: "nope" }),
      ],
    });
    expect((await a.getTree(TREE)).entries).toEqual([
      { path: "x", mode: "100644", type: "blob", sha: BLOB },
    ]);
    await expect(a.getTree(TREE)).rejects.toMatchObject({ status: 200 });
  });

  it("404 / 5xx は GitHubApiError", async () => {
    const { a } = api({
      [`GET /repos/acme/widgets/git/trees/${TREE}`]: () => json({ message: "x" }, { status: 502 }),
    });
    await expect(a.getTree(TREE)).rejects.toMatchObject({ status: 502 });
  });
});
