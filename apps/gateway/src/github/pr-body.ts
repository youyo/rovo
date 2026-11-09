/**
 * PR 本文の rovo 管理範囲。目印（HTML コメント）で囲んだ部分だけを書き換え、外側は利用者の編集を残す。
 * モデルの要約・検証の出力・警告は信用しないデータなので、コードフェンスで囲み、長さを切る。
 */

/** 旧形式（タスク別になる前）の 1 組の目印。旧形式の PR では根の節として扱う。 */
export const LEGACY_BEGIN = "<!-- rovo:begin -->";
export const LEGACY_END = "<!-- rovo:end -->";
/** タスク別の目印の共通の前置き。`<!-- rovo:begin task=<id> -->` / `<!-- rovo:end task=<id> -->`。 */
export const MANAGED_BEGIN = "<!-- rovo:begin";
export const MANAGED_END = "<!-- rovo:end";
const TASK_ID_RE = /^[A-Za-z0-9_-]+$/;

function checkId(id: string): string {
  if (!TASK_ID_RE.test(id)) throw new Error("invalid task id for PR body marker");
  return id;
}
const beginMarker = (id: string) => `${MANAGED_BEGIN} task=${checkId(id)} -->`;
const endMarker = (id: string) => `${MANAGED_END} task=${checkId(id)} -->`;
const heading = (id: string, continuesTask?: string) => [
  `## rovo — task ${id}`,
  ...(continuesTask ? [`Continues task ${checkId(continuesTask)}`] : []),
];
/** GitHub の PR 本文の上限 */
export const MAX_PR_BODY_CHARS = 65_536;

/** 管理範囲の外側（利用者の編集）に残す余裕。この分を管理範囲の予算から引く。 */
const OUTSIDE_RESERVE = 4_000;
const TRUNC_NOTE = (n: number) => `\n…[truncated ${n} chars]`;

export interface PrCommandResult {
  argv: string[];
  exitCode: number;
  timedOut: boolean;
  output: string;
}

export interface PrReport {
  taskId: string;
  /** 積み足しのタスクのとき、元のタスクの id */
  continuesTask?: string;
  /** TaskDO の状態（COMPLETED など） */
  status: string;
  reason?: string;
  summary: string;
  verified: boolean;
  commitSha?: string;
  results: PrCommandResult[];
  warnings: string[];
  /** GitHub から読んだ PR の head。読めていなければ未指定 */
  headSha?: string | null;
  headMatches?: boolean | null;
  costUsd?: number;
}

function neutralize(text: string): string {
  // 目印を壊せる文字列を無害化する（空白幅ゼロ文字で分断）
  return text.replace(/<!--(\s*)rovo:/gi, "<!--$1rovo​:");
}

/** 信用しないテキストを、本文中の ``` より長いフェンスで囲む。maxChars を超えたら切る。 */
export function fenceUntrusted(text: string, maxChars: number): string {
  let body = neutralize(text.replace(/\r\n?/g, "\n")).trimEnd();
  if (body.length > maxChars) {
    const cut = body.length - maxChars;
    body = body.slice(0, maxChars) + TRUNC_NOTE(cut);
  }
  let longest = 0;
  for (const m of body.matchAll(/`+/g)) longest = Math.max(longest, m[0].length);
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}\n${body}\n${fence}`;
}

const SECTION_RE = /<!-- rovo:begin task=([A-Za-z0-9_-]+) -->[\s\S]*?<!-- rovo:end task=\1 -->/g;

/** 節を短い形（状態・検証・PR の head・summary の先頭 1 行）にする。minimal なら目印と見出しだけ。 */
function shrinkSection(section: string, id: string, minimal: boolean): string {
  const continues = section.match(/^Continues task ([A-Za-z0-9_-]+)$/m)?.[1];
  const lines = [beginMarker(id), ...heading(id, continues)];
  if (!minimal) {
    const pick = (re: RegExp) => section.match(re)?.[0];
    const status = pick(/^Status: .*$/m);
    const verification = pick(/^Verification: .*$/m);
    const head = pick(/^PR head: .*$/m);
    const sm = section.match(/^### Agent summary \(unverified\)\n\n(`{3,})\n(.*)$/m);
    const first = sm?.[2]?.trim();
    if (status) lines.push("", status);
    if (verification) lines.push(verification);
    if (head) lines.push(head);
    if (first) {
      lines.push("", "### Agent summary (unverified)", "", fenceUntrusted(first, 200));
    }
  }
  lines.push(endMarker(id));
  return lines.join("\n");
}

/**
 * 自分のタスクの節を新しい内容に置き換える。節の探し方:
 * 1. 自分の id の節があればその範囲だけ。
 * 2. 無く、根のタスクなら旧形式の 1 組、それも無ければ末尾。
 * 3. 無く、積み足しのタスクなら、最後の rovo の目印の直後（旧形式には触らない）。無ければ末尾。
 * 全体は MAX_PR_BODY_CHARS に収める（前の節を古い順に縮める）。
 */
export function applyManagedBlock(
  existing: string,
  block: string,
  taskId: string,
  opts: { isRoot: boolean },
): string {
  const begin = existing.indexOf(beginMarker(taskId));
  const endM = endMarker(taskId);
  const end = begin >= 0 ? existing.indexOf(endM, begin) : -1;
  let before: string;
  let after: string;
  if (begin >= 0 && end >= 0) {
    before = existing.slice(0, begin);
    after = existing.slice(end + endM.length);
  } else if (opts.isRoot && existing.includes(LEGACY_BEGIN)) {
    const lb = existing.indexOf(LEGACY_BEGIN);
    const le = existing.indexOf(LEGACY_END, lb + LEGACY_BEGIN.length);
    if (le >= 0) {
      before = existing.slice(0, lb);
      after = existing.slice(le + LEGACY_END.length);
    } else {
      before = existing === "" ? "" : `${existing}\n\n`;
      after = "";
    }
  } else if (!opts.isRoot) {
    let last = -1;
    for (const m of existing.matchAll(/<!-- rovo:end(?: task=[A-Za-z0-9_-]+)? -->/g)) {
      last = m.index + m[0].length;
    }
    if (last >= 0) {
      before = `${existing.slice(0, last)}\n\n`;
      after = existing.slice(last);
    } else {
      before = existing === "" ? "" : `${existing}\n\n`;
      after = "";
    }
  } else {
    before = existing === "" ? "" : `${existing}\n\n`;
    after = "";
  }
  let out = before + block + after;
  if (out.length <= MAX_PR_BODY_CHARS) return out;

  // 前の節を古い順に縮める（今の節は触らない）。まず短い形、次に目印と見出しだけ。
  for (const minimal of [false, true]) {
    const sections: { start: number; end: number; id: string }[] = [];
    for (const m of out.matchAll(SECTION_RE)) {
      const id = m[1] as string;
      if (id === taskId) continue;
      sections.push({ start: m.index, end: m.index + m[0].length, id });
    }
    // 後ろから置換して位置のずれを避けるため、結果を先に求める
    const replaced = new Map<number, string>();
    let total = out.length;
    for (const sec of sections) {
      if (total <= MAX_PR_BODY_CHARS) break;
      const text = out.slice(sec.start, sec.end);
      const short = shrinkSection(text, sec.id, minimal);
      if (short.length < text.length) {
        replaced.set(sec.start, short);
        total -= text.length - short.length;
      }
    }
    if (replaced.size > 0) {
      let rebuilt = "";
      let pos = 0;
      for (const sec of sections) {
        const r = replaced.get(sec.start);
        if (r === undefined) continue;
        rebuilt += out.slice(pos, sec.start) + r;
        pos = sec.end;
      }
      out = rebuilt + out.slice(pos);
    }
    if (out.length <= MAX_PR_BODY_CHARS) return out;
  }
  // それでも収まらない: 今の節を残し、外側の先頭側を切る
  const room = Math.max(0, MAX_PR_BODY_CHARS - block.length - 2);
  const cur = out.indexOf(block);
  const outsideBefore = cur >= 0 ? out.slice(0, cur) : before;
  return `${outsideBefore.slice(0, room)}\n\n${block}`.slice(0, MAX_PR_BODY_CHARS);
}

export function renderInitialBlock(taskId: string, opts?: { continuesTask?: string }): string {
  return [
    beginMarker(taskId),
    ...heading(taskId, opts?.continuesTask),
    "",
    `Status: **RUNNING** (task \`${neutralize(taskId)}\`)`,
    "",
    "This draft pull request is managed by rovo. The agent is working; this section is updated when the task finishes. Do not merge until it does.",
    endMarker(taskId),
  ].join("\n");
}

/** Draft にできなかったときの注記（管理範囲の外側。冒頭に置く）。 */
export const READY_FALLBACK_NOTE =
  "> **rovo is working on this branch. Do not merge until the task has finished.** (Draft pull requests are not available in this repository, so this is a regular pull request.)";

function cmdLabel(argv: string[]): string {
  // 改行・制御文字は 1 つの空白にして、インラインコードの 1 行に収める
  return neutralize(argv.join(" "))
    .replace(/[\p{Cc}\p{Zl}\p{Zp}\s]+/gu, " ")
    .trim()
    .replaceAll("`", "'")
    .slice(0, 200);
}

/** コンテナ由来の SHA は、40 / 64 桁の 16 進だけを通す。それ以外（Markdown のリンクなど）は捨てる。 */
function sha(v: string | null | undefined): string | undefined {
  return v !== undefined && v !== null && /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(v) ? v : undefined;
}

function render(r: PrReport, showCost: boolean, scale: number): string {
  const cap = (n: number) => Math.max(200, Math.floor(n * scale));
  const lines: string[] = [beginMarker(r.taskId), ...heading(r.taskId, r.continuesTask), ""];
  lines.push(`Status: **${r.status}** (task \`${neutralize(r.taskId)}\`)`);
  if (r.reason) lines.push("Reason:", "", fenceUntrusted(r.reason, cap(500)));
  lines.push("");
  const commitSha = sha(r.commitSha);
  const headSha = sha(r.headSha);
  lines.push(
    `Verification: ${r.verified ? "**passed**" : "**not verified**"}${
      commitSha ? ` at \`${commitSha}\`` : ""
    }`,
  );
  if (headSha) {
    lines.push(
      `PR head: \`${headSha}\`${r.headMatches === false ? " (**differs from the verified commit**)" : ""}`,
    );
  }
  if (showCost && r.costUsd !== undefined) lines.push(`Cost: $${r.costUsd.toFixed(2)}`);
  if (r.headMatches === false) {
    lines.push(
      "",
      "> Warning: the PR head moved after verification. Review the commits before merging.",
    );
  }

  const results = r.results.slice(0, 20);
  if (results.length > 0) {
    lines.push("", "### Verification commands");
    for (const c of results) {
      const state = c.timedOut ? "timed out" : `exit ${c.exitCode}`;
      lines.push("", `- \`${cmdLabel(c.argv)}\`: ${state}`);
      if (c.exitCode !== 0 || c.timedOut) lines.push("", fenceUntrusted(c.output, cap(3000)));
    }
  }

  const open: string[] = [];
  if (!r.verified) open.push("The result was not verified by the verification commands.");
  for (const c of results) {
    if (c.timedOut || c.exitCode !== 0)
      open.push(
        `\`${cmdLabel(c.argv)}\` did not pass (${c.timedOut ? "timed out" : `exit ${c.exitCode}`}).`,
      );
  }
  if (r.status !== "COMPLETED") open.push(`The task ended as ${r.status}.`);
  if (open.length > 0) {
    lines.push("", "### Open issues", ...open.map((o) => `- ${o}`));
  }

  if (r.warnings.length > 0) {
    lines.push("", "### Warnings");
    for (const w of r.warnings.slice(0, 50)) lines.push("", fenceUntrusted(w, cap(500)));
    if (r.warnings.length > 50) lines.push("", `…and ${r.warnings.length - 50} more`);
  }
  if (r.summary.trim() !== "") {
    lines.push("", "### Agent summary (unverified)", "", fenceUntrusted(r.summary, cap(8000)));
  }
  lines.push(endMarker(r.taskId));
  return lines.join("\n");
}

/** 終端の報告。全体が収まるまで、信用しないデータの切り詰めを強める。 */
export function renderReportBlock(r: PrReport, opts: { showCost: boolean }): string {
  const budget = MAX_PR_BODY_CHARS - OUTSIDE_RESERVE;
  for (const scale of [1, 0.5, 0.25, 0.1, 0]) {
    const out = render(r, opts.showCost, scale);
    if (out.length <= budget) return out;
  }
  return render({ ...r, summary: "", warnings: [], results: [] }, opts.showCost, 0).slice(
    0,
    budget,
  );
}
