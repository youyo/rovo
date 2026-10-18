import { WorkerEntrypoint } from "cloudflare:workers";
import { decideOutbound } from "./outbound-policy";

export interface OutboundGatewayProps {
  /** clone を許す唯一のリポジトリ。未設定なら github.com へは何も通さない。 */
  repo?: { owner: string; name: string };
  /** 違反ログに残す識別子（作業ブランチ名など。利用者の入力ではなく認証済みの値）。 */
  task?: string;
}

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

/** 違反ログの 1 行。固定のコード、task、宛先の分類だけで、path・query・本文は残さない。 */
export function formatViolationLog(v: { code: string; task?: string; category: string }): string {
  return `outbound denied: code=${v.code} task=${v.task ?? "-"} dest=${v.category}`;
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

/** 転送用ヘッダを許可リストで組み立て直す。 */
export function buildUpstreamHeaders(source: Headers): Headers {
  const out = new Headers();
  for (const name of FORWARD_HEADERS) {
    const v = source.get(name);
    if (v !== null) out.set(name, v);
  }
  return out;
}

/**
 * Sandbox のコンテナからの外向き通信をすべて受け、ホストごとに許可・拒否を判定する。
 * 許可判定は outbound-policy.ts の純粋関数。拒否は 403 を返し、違反として記録する。
 * 宛先は request.url のホストで決め、上流は HTTPS 固定・redirect 手動で自前に組み立てて送る。
 */
export class OutboundGateway extends WorkerEntrypoint<Env, OutboundGatewayProps> {
  override async fetch(request: Request): Promise<Response> {
    const upgrade =
      request.headers.has("upgrade") ||
      (request.headers.get("connection") ?? "").toLowerCase().includes("upgrade");
    const decision = decideOutbound(
      { method: request.method, url: request.url, upgrade },
      { repo: this.ctx.props?.repo },
    );
    const url = new URL(request.url);
    if (!decision.allow) {
      // path・query・本文は残さない（トークンなどが含まれうる）。固定コードと宛先の分類だけを記録する。
      console.warn(
        formatViolationLog({
          code: decision.code,
          task: this.ctx.props?.task,
          category: classifyDestination(url.hostname),
        }),
      );
      return new Response(`rovo: outbound request denied (${decision.code})\n`, { status: 403 });
    }
    const headers = buildUpstreamHeaders(request.headers);
    const hasBody = request.method !== "GET" && request.method !== "HEAD";
    const declared = Number(request.headers.get("content-length") ?? "0");
    if (hasBody && declared > MAX_REQUEST_BODY_BYTES) {
      console.warn(
        formatViolationLog({
          code: "body_too_large",
          task: this.ctx.props?.task,
          category: classifyDestination(url.hostname),
        }),
      );
      return new Response("rovo: request body too large\n", { status: 413 });
    }
    const init: RequestInit = {
      method: request.method,
      headers,
      body: hasBody && request.body ? limitBody(request.body, MAX_REQUEST_BODY_BYTES) : null,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      // 自動で追うと次の行き先が判定を通らない。3xx はそのままコンテナへ返し、再度ここを通させる。
      redirect: "manual",
    };
    // E2E 用: 許可した通信だけを偽サーバーへ向ける（判定そのものは本物のまま通す）。
    if (this.env.ENVIRONMENT === "test" && this.env.TEST_UPSTREAM) {
      headers.set("x-original-host", url.hostname);
      return fetch(buildTestUpstreamUrl(this.env.TEST_UPSTREAM, url), init);
    }
    return fetch(`https://${url.hostname}${url.pathname}${url.search}`, init);
  }
}
