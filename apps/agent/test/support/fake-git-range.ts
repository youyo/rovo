import type { ExecHandler } from "./fake-sandbox";

/**
 * git の最小のモデル。commit の列と、今のベース（最後に push できた SHA）から、
 * `git diff [--numstat] <base>..HEAD` の出力を作る。git_commit の push 前の検査（scanRangeForSecrets）を試すための台本。
 * - git add -A / commit: pending のファイルを 1 つの commit にする
 * - git push: pushOk なら base を HEAD に進める
 * 子が bash で作った commit は commitDirect、git reset --soft は resetSoft で再現する。
 */
export interface FakeFile {
  path: string;
  /** 追加された行（バイナリなら binary: true にして内容は見ない） */
  lines?: string[];
  binary?: boolean;
}

interface FakeCommit {
  sha: string;
  files: FakeFile[];
}

interface Override {
  exitCode?: number;
  truncated?: boolean;
  timedOut?: boolean;
  stdout?: string;
  stderr?: string;
}

const shaOf = (n: number) => n.toString(16).padStart(40, "0");

export function fakeGitRange(opts: { base?: string } = {}) {
  const base = opts.base ?? shaOf(1);
  const commits: FakeCommit[] = [{ sha: base, files: [] }];
  let counter = 1;
  let pushBase = base;
  const state = {
    pending: [] as FakeFile[],
    pushOk: true,
    /** 範囲の diff / numstat の出力を差し替える（大きすぎる・失敗の再現） */
    rangeDiff: undefined as Override | undefined,
    rangeNumstat: undefined as Override | undefined,
    /** 範囲の diff / numstat に渡された argv */
    rangeArgs: [] as string[][],
    pushes: [] as string[][],
  };
  const head = () => commits[commits.length - 1] as FakeCommit;
  const inRange = () => {
    const from = commits.findIndex((c) => c.sha === pushBase);
    return commits.slice(from + 1).flatMap((c) => c.files);
  };
  const commitFiles = (files: FakeFile[]) => {
    counter += 1;
    commits.push({ sha: shaOf(counter), files });
    return head().sha;
  };
  const numstat = () =>
    inRange()
      .map((f) => (f.binary ? `-\t-\t${f.path}` : `${f.lines?.length ?? 0}\t0\t${f.path}`))
      .join("\n");
  const diff = () =>
    inRange()
      .map((f) => {
        if (f.binary) {
          return `diff --git a/${f.path} b/${f.path}\nBinary files /dev/null and b/${f.path} differ\n`;
        }
        const n = f.lines?.length ?? 0;
        return [
          `diff --git a/${f.path} b/${f.path}`,
          "new file mode 100644",
          "--- /dev/null",
          `+++ b/${f.path}`,
          `@@ -0,0 +1,${n} @@`,
          ...(f.lines ?? []).map((l) => `+${l}`),
          "",
        ].join("\n");
      })
      .join("");

  const handler: ExecHandler = (argv) => {
    if (argv[0] !== "git") return {};
    const sub = argv.find((a) => !a.startsWith("-") && a !== "git" && !a.includes("="));
    if (sub === "diff" && argv.includes("--cached")) {
      return { exitCode: state.pending.length > 0 ? 1 : 0 };
    }
    if (sub === "diff" && argv.some((a) => a.includes(".."))) {
      state.rangeArgs.push(argv);
      const o = argv.includes("--numstat") ? state.rangeNumstat : state.rangeDiff;
      if (o) return o;
      return { stdout: argv.includes("--numstat") ? numstat() : diff() };
    }
    if (sub === "commit") {
      commitFiles(state.pending);
      state.pending = [];
      return {};
    }
    if (sub === "rev-parse") return { stdout: `${head().sha}\n` };
    if (sub === "push") {
      state.pushes.push(argv);
      if (!state.pushOk) return { exitCode: 1, stderr: "remote: rejected" };
      pushBase = head().sha;
      return {};
    }
    return {};
  };

  return {
    handler,
    state,
    base,
    head: () => head().sha,
    /** 作業ツリーの変更（次の git_commit が commit にする） */
    stage: (...files: FakeFile[]) => {
      state.pending.push(...files);
    },
    /** 子が bash で自分で作った commit（git_commit を通らない） */
    commitDirect: (...files: FakeFile[]) => commitFiles(files),
    /** git reset --soft の再現（HEAD を steps 個戻し、戻した分の変更は pending に戻る） */
    resetSoft: (steps = 1) => {
      const dropped = commits.splice(commits.length - steps);
      state.pending = dropped.flatMap((c) => c.files);
    },
  };
}
