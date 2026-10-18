import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { gitCommitSha } from "../support/fake-github-app";
import { gitRepoStore } from "../support/git-store";

// 通しの E2E で偽 GitHub の Git Data API が使う、実 git のリポジトリ上の保存先。
let root: string;
let bare: string;
let baseSha: string;
const git = (cwd: string, env: Record<string, string>, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...env } }).trim();

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "rovo-git-store-"));
  const work = join(root, "work");
  execFileSync("git", ["init", "-q", "-b", "main", work]);
  writeFileSync(join(work, "a.txt"), "a\n");
  const id = {
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@e",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@e",
  };
  git(work, id, "add", "-A");
  git(work, id, "commit", "-q", "-m", "init");
  baseSha = git(work, id, "rev-parse", "HEAD");
  bare = join(root, "r.git");
  execFileSync("git", ["clone", "-q", "--bare", work, bare]);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("gitRepoStore", () => {
  it("コミットを読める（親・tree・author の日時）", () => {
    const c = gitRepoStore(bare).commits.get(baseSha);
    expect(c?.sha).toBe(baseSha);
    expect(c?.parents).toEqual([]);
    expect(c?.tree).toMatch(/^[0-9a-f]{40}$/);
    expect(c?.message).toBe("init");
    expect(c?.author.name).toBe("t");
  });

  it("未知の SHA・短縮形は undefined / false", () => {
    const s = gitRepoStore(bare);
    expect(s.commits.get("0".repeat(40))).toBeUndefined();
    expect(s.commits.get(baseSha.slice(0, 7))).toBeUndefined();
    expect(s.commits.has("0".repeat(40))).toBe(false);
  });

  it("書いたコミットの SHA は gitCommitSha と一致し、実 git の commit-tree とも一致する（決定的）", async () => {
    const s = gitRepoStore(bare);
    const base = s.commits.get(baseSha);
    if (!base) throw new Error("no base");
    const who = { name: "rovo", email: "rovo@example.test", date: "2026-10-18T10:00:00Z" };
    const body = {
      tree: base.tree,
      parents: [baseSha],
      message: "rovo: start task X",
      author: who,
      committer: who,
    };
    const sha = await gitCommitSha(body);
    s.commits.set(sha, { sha, ...body });
    expect(s.commits.has(sha)).toBe(true);
    expect(s.commits.get(sha)).toMatchObject({ parents: [baseSha], message: body.message });
    // 本物の git が同じ入力から作るコミットと同じ SHA
    const env = {
      GIT_AUTHOR_NAME: who.name,
      GIT_AUTHOR_EMAIL: who.email,
      GIT_AUTHOR_DATE: `${Date.parse(who.date) / 1000} +0000`,
      GIT_COMMITTER_NAME: who.name,
      GIT_COMMITTER_EMAIL: who.email,
      GIT_COMMITTER_DATE: `${Date.parse(who.date) / 1000} +0000`,
    };
    const real = execFileSync(
      "git",
      ["--git-dir", bare, "commit-tree", base.tree, "-p", baseSha, "-F", "-"],
      // メッセージは末尾に改行を足さずそのまま渡す（GitHub の Git Data API と同じ）
      { encoding: "utf8", input: body.message, env: { ...process.env, ...env } },
    ).trim();
    expect(real).toBe(sha);
  });

  it("ref の作成・取得・削除", () => {
    const s = gitRepoStore(bare);
    expect(s.refs.has("refs/heads/agent/task-1")).toBe(false);
    s.refs.set("refs/heads/agent/task-1", baseSha);
    expect(s.refs.get("refs/heads/agent/task-1")).toBe(baseSha);
    expect(s.refs.has("refs/heads/agent/task-1")).toBe(true);
    s.refs.delete("refs/heads/agent/task-1");
    expect(s.refs.get("refs/heads/agent/task-1")).toBeUndefined();
    s.refs.delete("refs/heads/agent/task-1");
  });
});
