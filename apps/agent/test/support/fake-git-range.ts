import type { ExecHandler } from "./fake-sandbox";

/**
 * git の最小のモデル。commit の列と、リモートにある SHA（push に成功した SHA）から、
 * `git log -p/--numstat <head> --not <base>`（commit ごとの検査）と `git diff [--numstat] <base>..HEAD`（2 つの木の差分）の出力を作る。
 * git_commit の push 前の検査（scanUnpushedForSecrets）を試すための台本。
 * - git add -A / commit: pending のファイルを 1 つの commit にする
 * - git push: pushOk なら base を HEAD に進める
 * 子が bash で作った commit は commitDirect、git reset --soft は resetSoft で再現する。
 * 本物の git と同じく、後の commit で消したファイル（deleted）は、木の差分には出ないが、足した commit の log には出る。
 */
export interface FakeFile {
  path: string;
  /** 追加された行（バイナリなら binary: true にして内容は見ない） */
  lines?: string[];
  binary?: boolean;
  /** この commit で消す（追加行は無い） */
  deleted?: boolean;
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

/** 1 つのファイルの追加行の diff（新規ファイルとして） */
function fileDiff(f: FakeFile): string {
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
}

const numstatLine = (f: FakeFile) =>
  f.binary ? `-\t-\t${f.path}` : `${f.lines?.length ?? 0}\t${f.deleted ? 1 : 0}\t${f.path}`;

export function fakeGitRange(opts: { base?: string } = {}) {
  const base = opts.base ?? shaOf(1);
  const commits: FakeCommit[] = [{ sha: base, files: [] }];
  let counter = 1;
  let pushBase = base;
  const state = {
    pending: [] as FakeFile[],
    pushOk: true,
    /** 範囲の diff / numstat の出力を差し替える（大きすぎる・失敗の再現）。log の -p と --numstat それぞれに効く */
    rangeDiff: undefined as Override | undefined,
    rangeNumstat: undefined as Override | undefined,
    /** 範囲の log（commit ごとの検査）に渡された argv */
    rangeArgs: [] as string[][],
    /** 2 つの木の差分（git diff A..B）に渡された argv。今の検査はこれを使わない */
    treeDiffArgs: [] as string[][],
    pushes: [] as string[][],
  };
  const head = () => commits[commits.length - 1] as FakeCommit;
  /** from から辿れない commit（from が無い・見つからないときは全部。ルートは空） */
  const after = (from: string | undefined) => {
    const i = from === undefined ? -1 : commits.findIndex((c) => c.sha === from);
    return commits.slice(i + 1);
  };
  /** commit の列を適用した木（path → ファイル）。消したものは無い */
  const tree = (cs: FakeCommit[]) => {
    const t = new Map<string, FakeFile>();
    for (const c of cs) {
      for (const f of c.files) {
        if (f.deleted) t.delete(f.path);
        else t.set(f.path, f);
      }
    }
    return t;
  };
  const commitFiles = (files: FakeFile[]) => {
    counter += 1;
    commits.push({ sha: shaOf(counter), files });
    return head().sha;
  };
  /** git diff base..HEAD（2 つの木の差分）: base の木と HEAD の木で違うファイルだけ */
  const treeDiff = (numstat: boolean) => {
    const from = tree(commits.slice(0, commits.findIndex((c) => c.sha === pushBase) + 1));
    const changed = [...tree(commits).values()].filter((f) => from.get(f.path) !== f);
    return numstat ? changed.map(numstatLine).join("\n") : changed.map(fileDiff).join("");
  };
  /** git log -p / --numstat head --not base: commit ごとに、区切りの行（U+0001 と SHA）と、その commit の変更 */
  const logOutput = (numstat: boolean, from: string | undefined) =>
    after(from)
      .map((c) => {
        const files = c.files.filter((f) => numstat || !f.deleted);
        return `\u0001${c.sha}\n\n${numstat ? files.map(numstatLine).join("\n") : files.map(fileDiff).join("")}\n`;
      })
      .join("");

  const handler: ExecHandler = (argv) => {
    if (argv[0] !== "git") return {};
    const sub = argv.find((a) => !a.startsWith("-") && a !== "git" && !a.includes("="));
    if (sub === "diff" && argv.includes("--cached")) {
      return { exitCode: state.pending.length > 0 ? 1 : 0 };
    }
    if (sub === "log") {
      state.rangeArgs.push(argv);
      const numstat = argv.includes("--numstat");
      const o = numstat ? state.rangeNumstat : state.rangeDiff;
      if (o) return o;
      // 基準（--not <sha>）が無いとき（初回）は全部の commit
      const i = argv.indexOf("--not");
      return { stdout: logOutput(numstat, i >= 0 ? argv[i + 1] : undefined) };
    }
    if (sub === "diff" && argv.some((a) => a.includes(".."))) {
      state.treeDiffArgs.push(argv);
      return { stdout: treeDiff(argv.includes("--numstat")) };
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
    /** 2 つの木の差分（git diff <pushBase>..HEAD）の出力。足して消した秘密が見えないことの確認用 */
    treeDiff: () => treeDiff(false),
  };
}
