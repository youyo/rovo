/**
 * PR 本文の rovo 管理範囲。目印（HTML コメント）で囲んだ部分だけを書き換え、外側は利用者の編集を残す。
 * モデルの要約・検証の出力・警告は信用しないデータなので、コードフェンスで囲み、長さを切る。
 */

export const MANAGED_BEGIN = "<!-- rovo:begin -->";
export const MANAGED_END = "<!-- rovo:end -->";
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

/** 管理範囲を新しい内容に置き換える。目印が無ければ末尾に足す。全体は MAX_PR_BODY_CHARS に収める。 */
export function applyManagedBlock(existing: string, block: string): string {
  const begin = existing.indexOf(MANAGED_BEGIN);
  const end = begin >= 0 ? existing.indexOf(MANAGED_END, begin + MANAGED_BEGIN.length) : -1;
  let out: string;
  if (begin >= 0 && end >= 0) {
    out = existing.slice(0, begin) + block + existing.slice(end + MANAGED_END.length);
  } else {
    out = existing === "" ? block : `${existing}\n\n${block}`;
  }
  if (out.length <= MAX_PR_BODY_CHARS) return out;
  // 外側が大きすぎる: 管理範囲を残し、外側の先頭側を切る
  const room = Math.max(0, MAX_PR_BODY_CHARS - block.length - 2);
  const outsideBefore = begin >= 0 && end >= 0 ? existing.slice(0, begin) : existing;
  return `${outsideBefore.slice(0, room)}\n\n${block}`.slice(0, MAX_PR_BODY_CHARS);
}

export function renderInitialBlock(taskId: string): string {
  return [
    MANAGED_BEGIN,
    "## rovo",
    "",
    `Status: **RUNNING** (task \`${neutralize(taskId)}\`)`,
    "",
    "This draft pull request is managed by rovo. The agent is working; this section is updated when the task finishes. Do not merge until it does.",
    MANAGED_END,
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
  const lines: string[] = [MANAGED_BEGIN, "## rovo", ""];
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
  lines.push(MANAGED_END);
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
