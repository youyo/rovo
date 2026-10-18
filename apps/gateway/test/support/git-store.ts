import { execFileSync } from "node:child_process";
import type { CommitStore, FakeCommit, RefStore, RepoStore } from "./fake-github-app";

/**
 * 偽 GitHub の Git Data API の保存先を、偽 git の bare リポジトリへの実 git 操作にする（通しの E2E 用）。
 * こうすると、TaskDO が偽 GitHub の API で作った初期コミット・ブランチと、AgentDO / SandboxDO が
 * 偽 git（git http-backend）へ clone / push するものが、同じリポジトリの同じ SHA になる。
 * Node 専用（node:child_process）。
 */

const git = (dir: string, args: string[], input?: string): string =>
  execFileSync("git", ["--git-dir", dir, ...args], {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    ...(input !== undefined ? { input } : {}),
  });

const SHA = /^[0-9a-f]{40}$/;

const isoOf = (unix: string) => new Date(Number(unix) * 1000).toISOString().replace(/\.\d+Z$/, "Z");

function parsePerson(line: string): { name: string; email: string; date: string } {
  const m = /^(?:author|committer) (.*) <(.*)> (\d+) [+-]\d{4}$/.exec(line);
  if (!m) throw new Error(`unparsable person line: ${line}`);
  return { name: m[1] as string, email: m[2] as string, date: isoOf(m[3] as string) };
}

const unix = (iso: string) => Math.floor(Date.parse(iso) / 1000);

function commitText(c: FakeCommit): string {
  const id = (p: { name: string; email: string; date: string }) =>
    `${p.name} <${p.email}> ${unix(p.date)} +0000`;
  return [
    `tree ${c.tree}`,
    ...c.parents.map((p) => `parent ${p}`),
    `author ${id(c.author)}`,
    `committer ${id(c.committer)}`,
    "",
    c.message,
  ].join("\n");
}

export function gitRepoStore(dir: string): RepoStore {
  const commits: CommitStore = {
    get(sha) {
      if (!SHA.test(sha)) return undefined;
      let raw: string;
      try {
        raw = git(dir, ["cat-file", "commit", sha]);
      } catch {
        return undefined;
      }
      const sep = raw.indexOf("\n\n");
      const head = raw.slice(0, sep).split("\n");
      const message = raw.slice(sep + 2).replace(/\n$/, "");
      const tree = head.find((l) => l.startsWith("tree "))?.slice(5) ?? "";
      const parents = head.filter((l) => l.startsWith("parent ")).map((l) => l.slice(7));
      const author = parsePerson(head.find((l) => l.startsWith("author ")) ?? "");
      const committer = parsePerson(head.find((l) => l.startsWith("committer ")) ?? "");
      return { sha, tree, parents, message, author, committer };
    },
    set(sha, c) {
      // 別名（短縮形など）の登録は無視する。実体の SHA が一致することだけ確かめる。
      if (sha !== c.sha) return;
      const written = git(
        dir,
        ["hash-object", "-t", "commit", "-w", "--stdin"],
        commitText(c),
      ).trim();
      if (written !== sha) throw new Error(`git store: sha mismatch ${written} != ${sha}`);
    },
    has(sha) {
      if (!SHA.test(sha)) return false;
      try {
        git(dir, ["cat-file", "-e", `${sha}^{commit}`]);
        return true;
      } catch {
        return false;
      }
    },
  };
  const refs: RefStore = {
    get(ref) {
      try {
        return git(dir, ["rev-parse", "--verify", "-q", ref]).trim() || undefined;
      } catch {
        return undefined;
      }
    },
    set(ref, sha) {
      git(dir, ["update-ref", ref, sha]);
    },
    has(ref) {
      return refs.get(ref) !== undefined;
    },
    delete(ref) {
      try {
        git(dir, ["update-ref", "-d", ref]);
      } catch {
        // 無ければ何もしない
      }
    },
  };
  return { commits, refs };
}
