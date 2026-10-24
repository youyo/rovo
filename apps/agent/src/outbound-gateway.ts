import { WorkerEntrypoint } from "cloudflare:workers";
import { type AuditFields, audit } from "@rovo/audit";
import type { GitCredential } from "./agent/types";
import { parseReceivePackHead, type ReceivePackRejectCode } from "./git-pkt";
import { decideOutbound, type GitRoute, gitRoute, type PolicyDenyCode } from "./outbound-policy";
import type { PushPermit } from "./sandbox-port";

export interface OutboundGatewayProps {
  /** clone / push を許す唯一のリポジトリ。未設定なら github.com へは何も通さない。 */
  repo?: { owner: string; name: string };
  /** 作業ブランチ名（認証済みの値）。違反の監査には使わない（taskId だけを出す）。 */
  task?: string;
  /**
   * このコンテナのタスク ID（SandboxDO の名前）。トークンの読み出しと、push を許す ref
   * （`refs/heads/agent/task-<taskId>`）の決定に使う。リクエストの path や本文からは取らない。
   */
  taskId: string;
}

export type { GitCredential, PushPermit };

/**
 * このファイルが自分で出す違反コードの全部（policy の判定と receive-pack の解析のコードは別に持つ）。
 * denied() / fail() の引数の型にしてあるので、足し忘れるとコンパイルが通らない。
 */
export const GATEWAY_DENY_CODES = [
  "body_too_large",
  "content_encoding",
  "content_type",
  "credential_unavailable",
  "no_body",
  "head_timeout",
  "truncated_head",
  "ref_not_allowed",
  "push_not_permitted",
  "read_error",
] as const;
export type GatewayDenyCode = (typeof GATEWAY_DENY_CODES)[number];
type DenyCode = GatewayDenyCode | PolicyDenyCode | ReceivePackRejectCode;

/** git-receive-pack（push）のリクエスト本文の上限。 */
export const MAX_RECEIVE_PACK_BYTES = 50 * 1024 * 1024;
/** push の 1 リクエスト（レスポンスの読み切りまで）の時間の上限。 */
export const RECEIVE_PACK_TIMEOUT_MS = 5 * 60_000;
/** push の本文の先頭（コマンド部）が届くまでの時間の上限。 */
export const RECEIVE_PACK_HEAD_TIMEOUT_MS = 30_000;

/** git-upload-pack のリクエスト本文の上限。通常の want/have のやり取りは数十 KiB に収まる。 */
export const MAX_REQUEST_BODY_BYTES = 8 * 1024 * 1024;
/** 上流への 1 リクエスト（レスポンスの読み切りまで）の時間の上限。 */
export const UPSTREAM_TIMEOUT_MS = 10 * 60_000;

/** 転送先の分類。ログにはホスト名そのものでなくこれを残す。 */
export function classifyDestination(host: string): "github" | "registry" | "other" {
  const h = host.toLowerCase();
  if (h === "github.com") return "github";
  if (h === "registry.npmjs.org" || h === "pypi.org" || h === "files.pythonhosted.org")
    return "registry";
  return "other";
}

/**
 * テスト用の転送先 URL。pathname を origin に連結せず、URL オブジェクトへ個別に代入する
 * （`//host/x` で始まる pathname が転送先を置き換えるのを防ぐ）。origin は必ず転送先と一致させる。
 */
export function buildTestUpstreamUrl(upstream: string, source: URL): URL {
  const out = new URL(upstream);
  out.pathname = source.pathname;
  out.search = source.search;
  if (out.origin !== new URL(upstream).origin) throw new Error("upstream origin mismatch");
  return out;
}

/** リクエスト本文を上限付きにする。超えたらストリームをエラーにして上流への送信を止める。 */
export function limitBody(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
): ReadableStream<Uint8Array> {
  let seen = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > maxBytes) throw new Error("request body too large");
        controller.enqueue(chunk);
      },
    }),
  );
}

/** コンテナから上流へ渡してよいリクエストヘッダ。Authorization / Cookie / Host などは渡さない。 */
const FORWARD_HEADERS = [
  "accept",
  "accept-encoding",
  "accept-language",
  "content-type",
  "content-encoding",
  "user-agent",
  "git-protocol",
  "if-none-match",
  "if-modified-since",
  "range",
  "cache-control",
  "pragma",
];
/** receive-pack（push）では転送しない。push は protocol v0 だけで、本文の gzip も受けない。 */
const RECEIVE_PACK_DROP = new Set(["content-encoding", "git-protocol"]);

/** 転送用ヘッダを許可リストで組み立て直す。push を指定すると push では不要なヘッダも落とす。 */
export function buildUpstreamHeaders(source: Headers, opts: { push?: boolean } = {}): Headers {
  const out = new Headers();
  for (const name of FORWARD_HEADERS) {
    if (opts.push && RECEIVE_PACK_DROP.has(name)) continue;
    const v = source.get(name);
    if (v !== null) out.set(name, v);
  }
  return out;
}

/** GitHub の Installation Token を HTTP Basic で渡す形（ユーザー名は x-access-token 固定）。 */
export function basicAuthorization(token: string): string {
  return `Basic ${btoa(`x-access-token:${token}`)}`;
}

export interface OutboundDeps {
  props: OutboundGatewayProps;
  /** SandboxDO からトークンを読む。taskId は props のものだけを渡す。 */
  readCredential(taskId: string): Promise<GitCredential | undefined>;
  /**
   * SandboxDO から、いま自動の push が走っているときの許可証（ref と newSha）を読む。無ければ undefined。
   * receive-pack は、これと本文のコマンドが一致するときだけ認証を付ける。taskId は props のものだけを渡す。
   */
  readPushPermit(taskId: string): Promise<PushPermit | undefined>;
  fetchUpstream(url: string, init: RequestInit): Promise<Response>;
  now(): number;
  /**
   * 違反（outbound_denied）の監査の出し先。省略すると @rovo/audit の audit() で console.log に 1 行の JSON を出す。
   * 渡されるのは許可したフィールド（taskId / caller / reason / dest）だけ。
   */
  audit?(event: "outbound_denied", fields: AuditFields): void;
  /** E2E 用: 許可した通信だけを偽サーバーへ向ける。 */
  testUpstream?: string;
  limits?: {
    receivePackMaxBytes?: number;
    headTimeoutMs?: number;
    upstreamTimeoutMs?: number;
    receivePackTimeoutMs?: number;
  };
}

const text = (status: number, body: string) => new Response(`${body}\n`, { status });

function denied(
  deps: OutboundDeps,
  url: URL,
  code: DenyCode,
  status = 403,
  body = `rovo: outbound request denied (${code})`,
): Response {
  // path・query・本文・ホスト名は残さない（トークンなどが含まれうる）。固定コード・taskId・宛先の分類だけを記録する。
  const fields: AuditFields = {
    taskId: deps.props.taskId,
    caller: "child",
    reason: code,
    dest: classifyDestination(url.hostname),
  };
  try {
    if (deps.audit) deps.audit("outbound_denied", fields);
    else audit("outbound_denied", fields);
  } catch {
    // 監査の出力の失敗で、拒否の応答を変えない
  }
  return text(status, body);
}

/** タスクに許す push 先の ref。props の taskId だけから作る。 */
function allowedRef(taskId: string): string | undefined {
  return /^[A-Za-z0-9_-]+$/.test(taskId) ? `refs/heads/agent/task-${taskId}` : undefined;
}

/** 有効なトークンを Authorization の値にする。無い・期限切れ・読み出し失敗は undefined（= 401）。 */
async function authorization(deps: OutboundDeps): Promise<string | undefined> {
  const taskId = deps.props.taskId;
  if (!taskId) return undefined;
  try {
    const cred = await deps.readCredential(taskId);
    if (!cred?.token || !(cred.expiresAt > deps.now())) return undefined;
    return basicAuthorization(cred.token);
  } catch {
    return undefined;
  }
}

/** push の許可証を読む。無い・読み出し失敗は undefined（= 拒否）。 */
async function readPermit(deps: OutboundDeps): Promise<PushPermit | undefined> {
  const taskId = deps.props.taskId;
  if (!taskId) return undefined;
  try {
    return await deps.readPushPermit(taskId);
  } catch {
    return undefined;
  }
}

type HeadResult =
  | { ok: true; body: ReadableStream<Uint8Array>; newSha: string }
  | { ok: false; code: DenyCode; status: number };

/**
 * receive-pack の本文のコマンド部を flush まで読んで検証する。検証できたら、読んだ分と残りをつなぎ直した
 * ストリームを返す（packfile はストリームのまま流す）。検証できなければ本文は捨てる。
 */
async function readReceivePackHead(
  body: ReadableStream<Uint8Array> | null,
  expectedRef: string,
  headTimeoutMs: number,
): Promise<HeadResult> {
  if (!body) return { ok: false, code: "no_body", status: 403 };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let buf = new Uint8Array(0);
  let newSha = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), headTimeoutMs);
  });
  const fail = (code: DenyCode, status = 403): HeadResult => {
    void reader.cancel().catch(() => {});
    return { ok: false, code, status };
  };
  try {
    for (;;) {
      const next = await Promise.race([reader.read(), timeout]);
      if (next === "timeout") return fail("head_timeout", 408);
      if (next.done) return fail("truncated_head");
      chunks.push(next.value);
      size += next.value.byteLength;
      const merged = new Uint8Array(size);
      let o = 0;
      for (const c of chunks) {
        merged.set(c, o);
        o += c.byteLength;
      }
      buf = merged;
      const head = parseReceivePackHead(buf);
      if (head.kind === "need_more") continue;
      if (head.kind === "reject") return fail(head.code);
      if (head.command.ref !== expectedRef) return fail("ref_not_allowed");
      newSha = head.command.newSha;
      break;
    }
  } catch {
    return fail("read_error");
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  // 読んだ分を先頭に戻して、残りをそのまま流す
  let sent = false;
  const joined = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!sent) {
        sent = true;
        controller.enqueue(buf);
        return;
      }
      const r = await reader.read();
      if (r.done) controller.close();
      else controller.enqueue(r.value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return { ok: true, body: joined, newSha };
}

/**
 * Sandbox のコンテナからの外向き通信 1 件を処理する（判定 → 認証の注入 → 上流への転送）。
 * 判定を通ったものにだけ認証を付ける。receive-pack は本文のコマンド部を検証してから転送を始める。
 */
export async function handleOutbound(request: Request, deps: OutboundDeps): Promise<Response> {
  const { props } = deps;
  const upgrade =
    request.headers.has("upgrade") ||
    (request.headers.get("connection") ?? "").toLowerCase().includes("upgrade");
  const workRef = allowedRef(props.taskId);
  const decision = decideOutbound(
    { method: request.method, url: request.url, upgrade },
    { repo: props.repo, branch: workRef?.slice("refs/heads/".length) },
  );
  const url = new URL(request.url);
  if (!decision.allow) return denied(deps, url, decision.code);

  const route: GitRoute | undefined = gitRoute(request.method, url);
  const push = route === "receive-pack" || route === "receive-pack-advert";
  const headers = buildUpstreamHeaders(request.headers, { push });
  const limits = deps.limits ?? {};
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  const maxBody =
    route === "receive-pack"
      ? (limits.receivePackMaxBytes ?? MAX_RECEIVE_PACK_BYTES)
      : MAX_REQUEST_BODY_BYTES;
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (hasBody && declared > maxBody) {
    return denied(deps, url, "body_too_large", 413, "rovo: request body too large");
  }

  let body: ReadableStream<Uint8Array> | null = null;
  if (route === "receive-pack") {
    if (request.headers.has("content-encoding")) return denied(deps, url, "content_encoding");
    if (
      (request.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() !==
      "application/x-git-receive-pack-request"
    ) {
      return denied(deps, url, "content_type");
    }
    // 検証が済むまで、認証も転送もしない
    const head = await readReceivePackHead(
      request.body,
      workRef ?? "",
      limits.headTimeoutMs ?? RECEIVE_PACK_HEAD_TIMEOUT_MS,
    );
    if (!head.ok) return denied(deps, url, head.code, head.status);
    // 自動の push（SandboxDO が秘密の検査を通した commit）だけを通す。ワーカーが bash から直接送る push は許可証が無いので拒否する。
    // 許可証は ref と newSha の両方が一致したときだけ有効（認証を付ける前に確かめる）
    const permit = await readPermit(deps);
    if (
      !permit ||
      permit.ref !== workRef ||
      permit.newSha.toLowerCase() !== head.newSha.toLowerCase()
    ) {
      void head.body.cancel().catch(() => {});
      return denied(deps, url, "push_not_permitted");
    }
    body = limitBody(head.body, maxBody);
  } else if (hasBody && request.body) {
    body = limitBody(request.body, maxBody);
  }

  if (route !== undefined) {
    const auth = await authorization(deps);
    if (auth === undefined) {
      if (body) void body.cancel().catch(() => {});
      return denied(
        deps,
        url,
        "credential_unavailable",
        401,
        "rovo: git credential is not available",
      );
    }
    headers.set("authorization", auth);
  }

  const init: RequestInit = {
    method: request.method,
    headers,
    body,
    signal: AbortSignal.timeout(
      route === "receive-pack"
        ? (limits.receivePackTimeoutMs ?? RECEIVE_PACK_TIMEOUT_MS)
        : (limits.upstreamTimeoutMs ?? UPSTREAM_TIMEOUT_MS),
    ),
    // 自動で追うと次の行き先が判定を通らない。3xx はそのままコンテナへ返し、再度ここを通させる。
    redirect: "manual",
  };
  if (deps.testUpstream) {
    headers.set("x-original-host", url.hostname);
    return deps.fetchUpstream(buildTestUpstreamUrl(deps.testUpstream, url).href, init);
  }
  return deps.fetchUpstream(`https://${url.hostname}${url.pathname}${url.search}`, init);
}

/**
 * Sandbox のコンテナからの外向き通信をすべて受け、ホストごとに許可・拒否を判定する。
 * 許可判定は outbound-policy.ts の純粋関数、処理本体は handleOutbound。拒否は 403 を返し、違反として記録する。
 * 宛先は request.url のホストで決め、上流は HTTPS 固定・redirect 手動で自前に組み立てて送る。
 */
export class OutboundGateway extends WorkerEntrypoint<Env, OutboundGatewayProps> {
  override async fetch(request: Request): Promise<Response> {
    const env = this.env;
    const props = this.ctx.props ?? { taskId: "" };
    return handleOutbound(request, {
      props,
      readCredential: async (taskId) => {
        // taskId は props のものだけ。SandboxDO は同じ Worker のバインディングで引く（コンテナからは届かない）
        const stub = env.SANDBOX_DO.getByName(taskId) as unknown as {
          readGitCredential(): Promise<GitCredential | undefined>;
        };
        return stub.readGitCredential();
      },
      readPushPermit: async (taskId) => {
        const stub = env.SANDBOX_DO.getByName(taskId) as unknown as {
          readPushPermit(): Promise<PushPermit | undefined>;
        };
        return stub.readPushPermit();
      },
      fetchUpstream: (url, init) => fetch(url, init),
      now: () => Date.now(),
      audit: (event, fields) => {
        const record = audit(event, fields);
        // E2E 専用: 記録はタスクの SandboxDO に残す（本番では何もしない）。待たず、失敗は握りつぶす
        if (record !== null && env.ENVIRONMENT === "test" && props.taskId) {
          const stub = env.SANDBOX_DO.getByName(props.taskId) as unknown as {
            testRecordAudit(record: unknown): Promise<void>;
          };
          this.ctx.waitUntil(stub.testRecordAudit(record).catch(() => undefined));
        }
      },
      testUpstream: env.ENVIRONMENT === "test" && env.TEST_UPSTREAM ? env.TEST_UPSTREAM : undefined,
    });
  }
}
