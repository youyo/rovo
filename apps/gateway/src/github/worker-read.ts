import { maskSecrets } from "@rovo/audit";
import { wrapUntrusted } from "@rovo/web-format";

/**
 * ワーカーの read_issue / read_pr（#157）。AgentDO が github_read の依頼をイベントに積み、TaskDO が取り込みのときに
 * タスクのリポジトリだけを Installation Token で読んで、整形した文を返す。token は AgentDO にも Sandbox にも渡さない。
 *
 * - 呼ぶのは GET の 4 つだけ（issues/{n}・issues/{n}/comments・pulls/{n}・pulls/{n}/files）。応答に含まれる URL はたどらない
 * - 返す文は maskSecrets を通し、wrapUntrusted（ツールの結果の非信頼の囲み）で囲む
 * - 長さの上限: 本文 20,000 文字・コメント 1 件 4,000 文字・全体 60,000 文字。切ったら切ったと書く
 * - エラーは固定の文だけ（GitHub の応答の本文・例外の文は入れない）
 */

export const MAX_BODY_CHARS = 20_000;
export const MAX_COMMENT_CHARS = 4_000;
export const MAX_OUTPUT_CHARS = 60_000;
/** include_comments で返すコメントの数（新しい順の最大） */
export const MAX_COMMENTS = 30;
/** include_files で返すファイルの数 */
export const MAX_FILES = 100;

export const ISSUES_PERMISSION_MESSAGE =
  "the GitHub App does not have the issues permission on this repository; ask the client to paste the issue text";

export type WorkerReadTool = "read_issue" | "read_pr";

export interface WorkerReadRequest {
  tool: WorkerReadTool;
  number: number;
  includeComments: boolean;
  includeFiles: boolean;
}

export interface WorkerReadResult {
  text: string;
  isError: boolean;
}

export interface WorkerReadDeps {
  /** タスクのリポジトリ用の Installation Token。返す文にもエラーにも入れない */
  token: string;
  /** タスクのリポジトリ（owner/name）。ワーカーからは受け取らない */
  repository: string;
  apiBase: string;
  fetch?: typeof fetch;
  /** token が issues: read を持つか（installation が承認しているときだけ true） */
  issuesPermission: boolean;
}

const REQUEST_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export function isIssueNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v > 0;
}

/** AgentDO の github_read イベントの data を検査する。形が違えば undefined（repository などの余計な項目は捨てる） */
export function parseWorkerReadRequest(
  d: Record<string, unknown>,
): { requestId: string; request: WorkerReadRequest } | undefined {
  if (typeof d.request_id !== "string" || !REQUEST_ID_RE.test(d.request_id)) return undefined;
  if (d.tool !== "read_issue" && d.tool !== "read_pr") return undefined;
  if (!isIssueNumber(d.number)) return undefined;
  return {
    requestId: d.request_id,
    request: {
      tool: d.tool,
      number: d.number,
      includeComments: d.include_comments === true,
      includeFiles: d.include_files === true,
    },
  };
}

class ReadFailure extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function errorResult(tool: WorkerReadTool, message: string): WorkerReadResult {
  return { isError: true, text: `[${tool}] ${message}` };
}

async function getJson(d: WorkerReadDeps, path: string, what: string): Promise<unknown> {
  const doFetch = d.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  let res: Response;
  try {
    res = await doFetch(`${d.apiBase.replace(/\/+$/, "")}${path}`, {
      method: "GET",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${d.token}`,
        "x-github-api-version": "2022-11-28",
        "user-agent": "rovo-gateway",
      },
      // 応答に含まれる URL（Location を含む）はたどらない
      redirect: "manual",
    });
  } catch {
    throw new ReadFailure("github_error (network)");
  }
  if (res.status === 404) {
    await res.body?.cancel().catch(() => undefined);
    throw new ReadFailure(`not_found: ${what} was not found in this repository`);
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    const limited =
      res.status === 429 ||
      (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0");
    throw new ReadFailure(
      `${limited ? "github_rate_limited" : "github_error"} (HTTP ${res.status})`,
    );
  }
  try {
    return await res.json();
  } catch {
    throw new ReadFailure(`github_error (HTTP ${res.status}, unexpected response)`);
  }
}

type Obj = Record<string, unknown>;

function obj(v: unknown): Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Obj) : {};
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** 1 行の値（改行を詰め、秘密を伏せ、長さを切る） */
function line(v: unknown, max = 300): string {
  const s = maskSecrets(str(v).replace(/[\r\n]+/g, " "));
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function nonNegInt(v: unknown): number | undefined {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : undefined;
}

/** 伏せてから切る（切ってから伏せると、秘密のパターンが途中で切れて素通りする） */
function clip(text: string, max: number, what: string): string {
  const masked = maskSecrets(text);
  if (masked.length <= max) return masked;
  return `${masked.slice(0, max)}\n[truncated: the ${what} is longer than ${max} characters]`;
}

function labelsOf(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((l) => (typeof l === "string" ? l : str(obj(l).name)))
    .filter((s) => s !== "")
    .map((s) => line(s, 100));
}

function headerLines(kind: "Issue" | "Pull request", n: number, o: Obj): string[] {
  const labels = labelsOf(o.labels);
  return [
    `${kind} #${n}: ${line(o.title, 1_000)}`,
    `State: ${line(o.state, 50)}`,
    `Author: ${line(obj(o.user).login, 100)}`,
    `Labels: ${labels.length > 0 ? labels.join(", ") : "(none)"}`,
    `Created: ${line(o.created_at, 50)}`,
    `Updated: ${line(o.updated_at, 50)}`,
  ];
}

function bodyLines(o: Obj): string[] {
  const body = str(o.body);
  return ["", "Body:", body === "" ? "(empty)" : clip(body, MAX_BODY_CHARS, "body")];
}

/** 最新のコメント 30 件まで（issue の comments の数から最後のページを決めて、新しいものを読む） */
async function commentLines(d: WorkerReadDeps, n: number, total: number | undefined) {
  const path = `/repos/${d.repository}/issues/${n}/comments`;
  const per = MAX_COMMENTS;
  let items: unknown[] = [];
  if (total === undefined) {
    const page = await getJson(d, `${path}?per_page=${per}&page=1`, "the comments");
    items = Array.isArray(page) ? page : [];
  } else if (total > 0) {
    const last = Math.max(1, Math.ceil(total / per));
    const pages = last > 1 && total % per !== 0 ? [last - 1, last] : [last];
    for (const p of pages) {
      const page = await getJson(d, `${path}?per_page=${per}&page=${p}`, "the comments");
      if (Array.isArray(page)) items = items.concat(page);
    }
  }
  const shown = items.slice(-MAX_COMMENTS);
  const count = total ?? shown.length;
  const out = [
    "",
    count > shown.length
      ? `Comments (latest ${shown.length} of ${count}, oldest first):`
      : `Comments (${shown.length}):`,
  ];
  if (shown.length === 0) out.push("(none)");
  for (const c of shown) {
    const co = obj(c);
    out.push(
      "",
      `--- ${line(obj(co.user).login, 100)} at ${line(co.created_at, 50)}`,
      clip(str(co.body), MAX_COMMENT_CHARS, "comment"),
    );
  }
  return out;
}

async function fileLines(d: WorkerReadDeps, n: number, total: number | undefined) {
  const page = await getJson(
    d,
    `/repos/${d.repository}/pulls/${n}/files?per_page=${MAX_FILES}&page=1`,
    "the changed files",
  );
  const files = (Array.isArray(page) ? page : []).slice(0, MAX_FILES);
  const count = total ?? files.length;
  const out = [
    "",
    count > files.length
      ? `Changed files (showing ${files.length} of ${count}; the diff is not included):`
      : `Changed files (${files.length}; the diff is not included):`,
  ];
  if (files.length === 0) out.push("(none)");
  for (const f of files) {
    const fo = obj(f);
    // patch（差分の本文）は返さない
    out.push(
      `- ${line(fo.filename, 500)} ${line(fo.status, 30)} +${nonNegInt(fo.additions) ?? 0} -${nonNegInt(fo.deletions) ?? 0}`,
    );
  }
  return out;
}

/** 囲んだ全体が MAX_OUTPUT_CHARS に収まるよう、本文の末尾を切って切ったことを書く */
function finish(tool: WorkerReadTool, body: string): WorkerReadResult {
  const whole = wrapUntrusted(tool, body);
  if (whole.length <= MAX_OUTPUT_CHARS) return { isError: false, text: whole };
  const note = `\n[truncated: the output is longer than ${MAX_OUTPUT_CHARS} characters]`;
  let keep = body.length - (whole.length - MAX_OUTPUT_CHARS) - note.length;
  for (;;) {
    const text = wrapUntrusted(tool, `${body.slice(0, Math.max(0, keep))}${note}`);
    if (text.length <= MAX_OUTPUT_CHARS) return { isError: false, text };
    keep -= text.length - MAX_OUTPUT_CHARS;
  }
}

/** タスクのリポジトリの issue / PR を読み、ワーカーに渡す文を作る（GET だけ）。失敗は固定の文の isError */
export async function readForWorker(
  d: WorkerReadDeps,
  req: WorkerReadRequest,
): Promise<WorkerReadResult> {
  const tool = req.tool;
  if (!isIssueNumber(req.number)) {
    return errorResult(tool, "invalid_number: number must be a positive integer");
  }
  if (tool === "read_issue" && !d.issuesPermission) {
    return errorResult(tool, ISSUES_PERMISSION_MESSAGE);
  }
  const n = req.number;
  try {
    if (tool === "read_issue") {
      const o = obj(await getJson(d, `/repos/${d.repository}/issues/${n}`, `issue #${n}`));
      const lines = [...headerLines("Issue", n, o)];
      if (o.pull_request !== undefined) lines.push("Note: this number is a pull request");
      lines.push(...bodyLines(o));
      if (req.includeComments) lines.push(...(await commentLines(d, n, nonNegInt(o.comments))));
      return finish(tool, lines.join("\n"));
    }
    const o = obj(await getJson(d, `/repos/${d.repository}/pulls/${n}`, `pull request #${n}`));
    const lines = [
      ...headerLines("Pull request", n, o),
      `Base: ${line(obj(o.base).ref, 300)}`,
      `Head: ${line(obj(o.head).ref, 300)}`,
      `Merged: ${o.merged === true ? "yes" : "no"}`,
      `Draft: ${o.draft === true ? "yes" : "no"}`,
      ...bodyLines(o),
    ];
    if (req.includeFiles) lines.push(...(await fileLines(d, n, nonNegInt(o.changed_files))));
    if (req.includeComments) lines.push(...(await commentLines(d, n, nonNegInt(o.comments))));
    return finish(tool, lines.join("\n"));
  } catch (e) {
    if (e instanceof ReadFailure) return errorResult(tool, e.code);
    return errorResult(tool, "github_error (unexpected)");
  }
}
